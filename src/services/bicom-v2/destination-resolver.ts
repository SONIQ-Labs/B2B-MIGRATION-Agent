/**
 * bicom-v2/destination-resolver.ts
 *
 * Two jobs:
 *   1. Parse Bicom's DB-format destination strings ("rg::3000::::::::::::::::::").
 *      Only needed when reading from the SQL dumps directly; the API pre-resolves.
 *   2. Resolve a Bicom target (typed) into a SONIQ entity uuid, given the mapping
 *      tables the mapper builds as it goes.
 */

import { ResolvedDest } from './types'
import type { BicomIVRSummary } from './client'

/* ============================================================================
 * Prefix parsing — for when we're reading dumps rather than the API.
 * Grammar (observed across 130 tenants):
 *
 *   rg::<ext>::...           ring group
 *   aa::<ext>::...           auto attendant (IVR)
 *   qu::<ext>::...           queue
 *   ex::<ext>::...           extension (dial user directly)
 *   en::<ext>::...           enhanced service / entrypoint (?)  — always at IVR ext
 *   vm::<ext>::...           voicemail
 *   num::<number>::...       external number (E.164)
 *   hangup::                 hangup
 *
 * Suffix is a colon-separated bag of options (16 slots in practice, mostly empty).
 * ============================================================================ */

const BICOM_PREFIXES = {
  rg:      'ring_group',
  aa:      'ivr',
  qu:      'queue',
  ex:      'extension',
  en:      'ivr',           // 'en' has been observed only routing to IVR-shaped exts — treat as ivr
  vm:      'voicemail',
  num:     'external',
  external: 'external',
} as const

export interface ParsedBicomDest {
  type: keyof typeof BICOM_PREFIXES | 'hangup' | 'unknown'
  target?: string           // the ext or number after the prefix
  raw: string
}

/** Parse a Bicom destination string into a typed value. Never throws. */
export function parseBicomDestString(raw: string): ParsedBicomDest {
  if (!raw) return { type: 'unknown', raw: '' }

  // hangup has no target
  if (raw.startsWith('hangup::') || raw === 'hangup') {
    return { type: 'hangup', raw }
  }

  const m = raw.match(/^([a-z_]+)::([^:]*)/i)
  if (!m) return { type: 'unknown', raw }

  const prefix = m[1].toLowerCase() as keyof typeof BICOM_PREFIXES
  const target = m[2]
  if (prefix in BICOM_PREFIXES) return { type: prefix, target, raw }
  return { type: 'unknown', target, raw }
}

/* ============================================================================
 * API dest -> unified target
 *
 * The API expresses destinations as { destination: "Ring Group", value: "3000" }.
 * This helper maps that to the same shape we'd get from parseBicomDestString,
 * so downstream code can treat both sources identically.
 * ============================================================================ */

export function apiDestToParsed(
  destination: string | undefined,
  value: string | undefined,
): ParsedBicomDest {
  if (!destination) return { type: 'unknown', raw: '' }

  const raw = `${destination}::${value ?? ''}`
  switch (destination) {
    case 'Ring Group':          return { type: 'rg',  target: value, raw }
    case 'IVR':                 return { type: 'aa',  target: value, raw }
    case 'Queue':               return { type: 'qu',  target: value, raw }
    case 'Extension':           return { type: 'ex',  target: value, raw }
    case 'Voicemail':           return { type: 'vm',  target: value, raw }
    case 'Call External Number':return { type: 'num', target: value, raw }
    // Everything else — Directory, Remote Access, Fax to E-mail, CRM Routing —
    // is either skipped per migration scope or not seen in VC 216. Emit as unknown
    // so downstream can log + fall through to a safe default.
    default:                    return { type: 'unknown', target: value, raw }
  }
}

/* ============================================================================
 * The core resolver — turns a ParsedBicomDest into a fully-qualified ResolvedDest
 * pointing at concrete SONIQ entity uuids, using the mapping tables the mapper
 * has built up so far.
 *
 * Voicemail rule (per Jonny):  vm::EXT
 *   - if EXT is a user extension  -> voicemail_user (individual mailbox)
 *   - otherwise                    -> voicemail_group (mailbox tied to whatever
 *                                     matches EXT — usually a ring group or queue)
 * ============================================================================ */

export interface ResolverContext {
  /** ext_number -> soniq org_user id, populated during extension emit */
  userIdByExt: Map<string, string>

  /** ext_number -> soniq ring_groups.id, populated during ring group emit */
  ringGroupIdByExt: Map<string, string>

  /** ext_number -> soniq call_queues.id, populated during queue emit */
  queueIdByExt: Map<string, string>

  /**
   * ext_number -> soniq call_flows.id for the *flow that owns* this ext.
   * Populated during IVR/RG/queue flow emit. Enables nested-flow references
   * (e.g. "IVR digit 1 goes to Ring Group flow X").
   */
  flowIdByExt: Map<string, string>

  /** Known IVR exts on this tenant — used to distinguish IVRs from extensions when types are ambiguous. */
  ivrExts: Set<string>
}

export function resolveDest(dest: ParsedBicomDest, ctx: ResolverContext): ResolvedDest {
  switch (dest.type) {
    case 'hangup':
      return { kind: 'hangup' }

    case 'rg': {
      if (!dest.target) return { kind: 'unknown', raw: dest.raw }
      return {
        kind: 'ring_group',
        ext: dest.target,
        soniq_ring_group_id: ctx.ringGroupIdByExt.get(dest.target),
        soniq_flow_id: ctx.flowIdByExt.get(dest.target),
      }
    }

    case 'aa':
    case 'en': {
      if (!dest.target) return { kind: 'unknown', raw: dest.raw }
      return {
        kind: 'ivr',
        ext: dest.target,
        soniq_flow_id: ctx.flowIdByExt.get(dest.target),
      }
    }

    case 'qu': {
      if (!dest.target) return { kind: 'unknown', raw: dest.raw }
      return {
        kind: 'queue',
        ext: dest.target,
        soniq_queue_id: ctx.queueIdByExt.get(dest.target),
        soniq_flow_id: ctx.flowIdByExt.get(dest.target),
      }
    }

    case 'ex': {
      if (!dest.target) return { kind: 'unknown', raw: dest.raw }
      return {
        kind: 'extension',
        ext: dest.target,
        soniq_user_id: ctx.userIdByExt.get(dest.target),
      }
    }

    case 'vm': {
      if (!dest.target) return { kind: 'unknown', raw: dest.raw }
      const ext = dest.target
      const userId = ctx.userIdByExt.get(ext)
      if (userId) {
        // User VM box (ext matches a real user)
        return { kind: 'voicemail_user', ext, soniq_user_id: userId }
      }
      // Group VM box — tied to whichever entity carries this ext
      const rgId = ctx.ringGroupIdByExt.get(ext)
      const queueId = ctx.queueIdByExt.get(ext)
      return {
        kind: 'voicemail_group',
        ext,
        soniq_group_id: rgId,
        soniq_queue_id: queueId,
      }
    }

    case 'num':
    case 'external':
      return { kind: 'external', number: dest.target ?? '' }

    default:
      return { kind: 'unknown', raw: dest.raw }
  }
}

/* ============================================================================
 * Convenience: build the ctx from IVR/RG lists (used before the first flow pass).
 * ============================================================================ */

export function initResolverContext(ivrs: BicomIVRSummary[]): ResolverContext {
  return {
    userIdByExt: new Map(),
    ringGroupIdByExt: new Map(),
    queueIdByExt: new Map(),
    flowIdByExt: new Map(),
    ivrExts: new Set(ivrs.map(i => i.ext)),
  }
}
