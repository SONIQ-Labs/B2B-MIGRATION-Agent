/**
 * bicom-v2/schedule-mapper.ts
 *
 * Turns Bicom's per-entity Operation Times response into the SONIQ
 * call_flows.settings.schedule block observed in production flows.
 *
 * SONIQ schedule shape (from real flow inspection):
 *   {
 *     enabled: boolean,
 *     timezone: "Europe/London",
 *     days: [0,1,2,3,4,5,6],         // ISO days OPEN (0=Sun, 6=Sat) — union of open_days
 *     day_ranges: {                   // per-day open windows
 *       "1": [{start:"08:00", end:"17:00"}],
 *       "2": [...]
 *     },
 *     ranges: [{start:"09:00", end:"17:30"}],   // fallback single range if uniform
 *     open_time: "09:00",             // legacy single fields — keep for older flow consumers
 *     close_time: "17:30",
 *     ooh_voice: "alice",             // TTS voice for out-of-hours message
 *     ooh_message: "We are currently closed. Please call back...",
 *     ooh_moh_asset_id: null,
 *     closed_route: {                 // where to route out-of-hours calls
 *       type: "voicemail" | "flow" | "user" | "hangup",
 *       id: uuid,
 *       box_id: uuid, box_type: "user"|"group",
 *       label: "..."
 *     },
 *     holidays: [                     // specific date closures
 *       {
 *         date_from: "2023-12-22", date_to: "2023-12-22",
 *         time_from: "12:00", time_to: "23:55",
 *         destination_ext: "5050",
 *         description: ""
 *       }
 *     ],
 *     holiday_voice: "alice",
 *     holiday_message: "We are closed for the holiday..."
 *   }
 */

import type { BicomOtimes, BicomOtimesOpenDay, BicomOtimesClosedDate } from './client'

export interface SoniqScheduleRange {
  start: string
  end: string
}

export interface SoniqScheduleHoliday {
  date_from: string
  date_to: string
  time_from: string
  time_to: string
  destination_ext?: string
  description?: string
}

export interface SoniqClosedRoute {
  type: 'voicemail' | 'flow' | 'user' | 'hangup' | 'external'
  id?: string                         // uuid of target (flow / voicemail box / user)
  ext?: string                        // Bicom ext (pre-resolution; useful for logs)
  box_id?: string
  box_type?: 'user' | 'group'
  label?: string
}

export interface SoniqSchedule {
  enabled: boolean
  timezone: string
  days: number[]                      // ISO days OPEN
  day_ranges: Record<string, SoniqScheduleRange[]>
  ranges: SoniqScheduleRange[]        // convenience: uniform-across-days ranges when possible
  open_time?: string                  // legacy
  close_time?: string                 // legacy
  ooh_voice: string
  ooh_message: string
  ooh_moh_asset_id: string | null
  closed_route?: SoniqClosedRoute
  holidays: SoniqScheduleHoliday[]
  holiday_voice: string
  holiday_message: string
}

/* ============================================================================
 * Defaults — used when Bicom has no otimes at all, or as fill values.
 * ============================================================================ */

const DEFAULT_SCHEDULE: SoniqSchedule = {
  enabled: false,
  timezone: 'Europe/London',
  days: [1, 2, 3, 4, 5],
  day_ranges: {
    '1': [{ start: '09:00', end: '17:30' }],
    '2': [{ start: '09:00', end: '17:30' }],
    '3': [{ start: '09:00', end: '17:30' }],
    '4': [{ start: '09:00', end: '17:30' }],
    '5': [{ start: '09:00', end: '17:30' }],
  },
  ranges: [{ start: '09:00', end: '17:30' }],
  open_time: '09:00',
  close_time: '17:30',
  ooh_voice: 'alice',
  ooh_message: 'We are currently closed. Please call back during business hours, or leave a message.',
  ooh_moh_asset_id: null,
  holidays: [],
  holiday_voice: 'alice',
  holiday_message: 'We are closed for the holiday. Please call back on our next working day.',
}

/* ============================================================================
 * Bicom day-of-week numbering:
 *   Bicom uses Mon=1 .. Sun=7  (ISO-like but with Sun as 7).
 *   SONIQ uses Sun=0 .. Sat=6.
 * ============================================================================ */

function bicomDayToSoniq(bicomDay: string): number {
  const n = parseInt(bicomDay, 10)
  if (Number.isNaN(n)) return 1
  // Bicom Mon=1..Sun=7  ->  SONIQ Sun=0..Sat=6
  if (n === 7) return 0
  return n
}

/* ============================================================================
 * The mapper
 * ============================================================================ */

export interface MapScheduleOptions {
  timezone?: string
  fallbackClosedRoute?: SoniqClosedRoute
}

export function mapBicomOtimesToSoniqSchedule(
  otimes: BicomOtimes | null,
  opts: MapScheduleOptions = {},
): SoniqSchedule {
  const tz = opts.timezone ?? 'Europe/London'

  if (!otimes || otimes.status !== 'on') {
    return { ...DEFAULT_SCHEDULE, timezone: tz, enabled: false }
  }

  // Build day_ranges from open_days
  // Bicom quirk: each row's field is `days` (plural, comma-separated string
  // like "5,4,3,2,1") not `day`. Reading it as `d.day` silently returned the
  // first digit of the WHOLE row as a Number (i.e. NaN → default 1), which is
  // how every migrated flow ended up "open Mondays only" — Corin's test call
  // was rejected as out-of-hours on a Tuesday. Split on comma and iterate.
  const dayRanges: Record<string, SoniqScheduleRange[]> = {}
  const openDaysSet = new Set<number>()
  const openDays = otimes.open_days ?? []

  for (const d of openDays) {
    const daysField = (d as any).days ?? (d as any).day ?? ''
    const dayList = String(daysField)
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
    for (const bicomDay of dayList) {
      const soniqDay = bicomDayToSoniq(bicomDay)
      openDaysSet.add(soniqDay)
      const key = String(soniqDay)
      if (!dayRanges[key]) dayRanges[key] = []
      dayRanges[key].push({
        start: d.time_from,
        end: d.time_to,
      })
    }
  }

  // Union ranges across all days — if uniform, expose as top-level ranges[]
  const uniformRanges = detectUniformRanges(dayRanges)

  // Extract holidays from closed_dates
  const holidays: SoniqScheduleHoliday[] = (otimes.closed_dates ?? []).map(cd => ({
    date_from: cd.date_from,
    date_to: cd.date_to,
    time_from: cd.time_from,
    time_to: cd.time_to,
    destination_ext: cd.destination,
    description: cd.description,
  }))

  // Closed route — points at the default_dest when set, else the caller's fallback, else nothing
  let closedRoute: SoniqClosedRoute | undefined = undefined
  if (otimes.default_dest_ext) {
    closedRoute = {
      type: otimes.default_dest_is_vm === 'yes' ? 'voicemail' : 'flow',
      ext: otimes.default_dest_ext,
      label: `Bicom default destination (${otimes.default_dest_ext})`,
    }
  } else if (opts.fallbackClosedRoute) {
    closedRoute = opts.fallbackClosedRoute
  }

  // Days list — the days that have open windows
  const days = Array.from(openDaysSet).sort()

  return {
    enabled: true,
    timezone: tz,
    days: days.length ? days : DEFAULT_SCHEDULE.days,
    day_ranges: Object.keys(dayRanges).length ? dayRanges : DEFAULT_SCHEDULE.day_ranges,
    ranges: uniformRanges ?? DEFAULT_SCHEDULE.ranges,
    open_time: uniformRanges?.[0]?.start ?? DEFAULT_SCHEDULE.open_time,
    close_time: uniformRanges?.[uniformRanges.length - 1]?.end ?? DEFAULT_SCHEDULE.close_time,
    ooh_voice: DEFAULT_SCHEDULE.ooh_voice,
    ooh_message: DEFAULT_SCHEDULE.ooh_message,
    ooh_moh_asset_id: null,
    closed_route: closedRoute,
    holidays,
    holiday_voice: DEFAULT_SCHEDULE.holiday_voice,
    holiday_message: DEFAULT_SCHEDULE.holiday_message,
  }
}

/**
 * If every day's ranges are identical, return the shared range list.
 * Otherwise return null (per-day ranges have to be used).
 */
function detectUniformRanges(dayRanges: Record<string, SoniqScheduleRange[]>): SoniqScheduleRange[] | null {
  const keys = Object.keys(dayRanges)
  if (keys.length === 0) return null

  const first = dayRanges[keys[0]]
  const firstKey = JSON.stringify(first)
  for (let i = 1; i < keys.length; i++) {
    if (JSON.stringify(dayRanges[keys[i]]) !== firstKey) return null
  }
  return first
}

export { DEFAULT_SCHEDULE }
