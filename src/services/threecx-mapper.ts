import { createClient } from '@supabase/supabase-js'
import { logger } from '../utils/logger'
import crypto from 'crypto'
import fs from 'fs'

/**
 * 3CX -> SONIQ mapper.
 *
 * Consumes the normalised payload produced by scripts/3cx_extract.py (which
 * reads a 3CX v18/v20 backup zip offline - no PBX contact required) and writes
 * SONIQ rows: org_users, sip_credentials, sip_devices, call_flows,
 * phone_numbers, plus a threecx_reference row per object for rollback/audit.
 *
 * Same contract as bicom-mapper / vodia-mapper so /platform/migrations can
 * drive it unchanged.
 */

const SIP_REALM = 'sip.soniqlabs.co.uk'

const DUMMY_EMAIL_RE = /^a@[bc]\.com$|^noemail|^no@email|^dummy|^placeholder|^none@|@none\.|^test@|@test\.|@example\./i

function isDummyEmail(email?: string | null): boolean {
  return !email || DUMMY_EMAIL_RE.test(email.trim())
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

// ── payload shapes (mirror of the extractor output) ─────────────────────────

export interface ThreeCxDest {
  type: 'none' | 'extension' | 'queue' | 'ivr' | 'voicemail' | 'external' | string
  dn?: string | null
  external?: string | null
}

export interface ThreeCxPayload {
  source: '3cx'
  version: string
  backup_date: string
  fqdn: string | null
  tenant_name: string | null
  company: string | null
  trunks: Array<{ kind: string; name: string; host: string | null; proxy_port: string | null; type: string | null; requires_registration: string | null; codecs: string[] }>
  external_lines: Array<{ line: string; gateway: string | null; direction: string | null; simultaneous_calls: number; sip_auth_id: string | null; sip_auth_password: string | null }>
  extensions: Array<{
    extension: string; first_name: string | null; last_name: string | null
    display_name: string; email: string | null; enabled: boolean
    sip_auth_id: string | null; sip_auth_password: string | null
    outbound_caller_id: string | null; outbound_caller_id_e164: string | null
    record_calls: boolean; voicemail_enabled: boolean; voicemail_pin: string | null
    voicemail_email_mode: string | null; no_answer_timeout: number
    mobile: string | null; lan_only: boolean
    devices: Array<{ mac: string | null; mac_raw: string | null; model: string | null; template: string | null; interface: string | null }>
    props: Record<string, string | null>
  }>
  queues: Array<{
    extension: string; name: string; strategy: string; ring_timeout: number
    master_timeout: number; announce_position: boolean; announce_interval: number
    intro_enabled: boolean; music_on_hold: string | null
    members: Array<{ extension: string; status: string | null; skill: string | null }>
    managers: string[]; timeout_destination: ThreeCxDest | null
  }>
  departments: Array<{ name: string; members: string[]; member_count: number }>
  ivrs: Array<{ extension: string; name: string; prompt: string | null; timeout: number; timeout_action: string | null; options: Record<string, ThreeCxDest>; system: boolean }>
  dids: Array<{ did_raw: string; did: string | null; line: string; gateway: string | null; office_hours: ThreeCxDest | null; out_of_hours: ThreeCxDest | null; holidays: ThreeCxDest | null; alter_ooh: boolean }>
  outbound_rules: Array<{ name: string; prefix: string | null; priority: number; applies_to_groups: string[]; routes: Array<{ gateway: string; strip_digits: number; prepend: string | null }> }>
  park_extensions: string[]
  fax_extensions: Array<{ extension: string; name: string | null; email: string | null }>
  phonebook: Array<{ first_name: string | null; last_name: string | null; company: string | null; number: string | null; number_e164: string | null; email: string | null }>
  media: {
    recordings: Array<{ path: string; extension: string | null; bytes: number }>
    voicemails: Array<{ path: string; extension: string | null; bytes: number }>
    prompts: Array<{ path: string; bytes: number }>
    profile_pictures: number
  }
}

export interface ThreeCxMigrationParams {
  payload_path?: string
  payload?: ThreeCxPayload
  target_org_id: string
  /** trunk to home the migrated DIDs on; omit to leave inbound_trunk_id null */
  inbound_trunk_id?: string
  /** import the 1075-entry company phonebook into the org directory */
  import_phonebook?: boolean
  /** 3CX extensions to leave behind (system DNs, reseller staff, placeholders) */
  exclude_extensions?: string[]
  dry_run?: boolean
}

export interface ThreeCxMigrationResult {
  status: 'synced' | 'partial' | 'error'
  extensionsSynced: number
  queuesSynced: number
  ivrsSynced: number
  numbersSynced: number
  devicesSynced: number
  phonebookSynced: number
  pendingInvites: Array<{ email: string; display_name: string; org_user_id: string }>
  warnings: string[]
}

// ── main ────────────────────────────────────────────────────────────────────

export async function migrateThreeCxBackup(
  params: ThreeCxMigrationParams,
): Promise<ThreeCxMigrationResult> {
  const { target_org_id, inbound_trunk_id, import_phonebook = false, dry_run = false } = params
  const excluded = new Set(params.exclude_extensions || [])

  const payload: ThreeCxPayload =
    params.payload ?? JSON.parse(fs.readFileSync(params.payload_path!, 'utf8'))

  const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const warnings: string[] = []
  const pendingInvites: ThreeCxMigrationResult['pendingInvites'] = []

  const result: ThreeCxMigrationResult = {
    status: 'synced',
    extensionsSynced: 0, queuesSynced: 0, ivrsSynced: 0,
    numbersSynced: 0, devicesSynced: 0, phonebookSynced: 0,
    pendingInvites, warnings,
  }

  logger.info(
    `[3CX] ${payload.company} / ${payload.fqdn} (v${payload.version}) -> org ${target_org_id}` +
    `${dry_run ? ' [DRY RUN]' : ''}`,
  )

  const { data: orgData } = await sb.from('orgs').select('slug').eq('id', target_org_id).single()
  const orgSlug = orgData?.slug || 'soniq'

  const sourceRef = {
    source: '3cx',
    version: payload.version,
    fqdn: payload.fqdn,
    backup_date: payload.backup_date,
  }

  // department lookup: extension -> department names
  const deptByExt: Record<string, string[]> = {}
  for (const d of payload.departments) {
    for (const ext of d.members) (deptByExt[ext] ||= []).push(d.name)
  }

  // ── Step 1: extensions -> org_users + sip_credentials + sip_devices ───────

  const extToOrgUserId: Record<string, string> = {}

  for (const ext of payload.extensions) {
    const account = ext.extension
    if (!account) continue

    if (excluded.has(account)) {
      logger.info(`[3CX] skip ext ${account} (${ext.display_name}) - excluded`)
      continue
    }

    // org_users.extension is digits-only (enforce_extension_length trigger) and
    // must sit inside the org's configured digit range. 3CX hot-desk pseudo
    // extensions (HD00001) and similar would be rejected, so skip them here
    // rather than failing the row mid-run.
    if (!/^[0-9]+$/.test(account)) {
      warnings.push(`ext ${account}: non-numeric (3CX pseudo/hot-desk extension) - skipped, SONIQ extensions must be digits`)
      continue
    }

    try {
      const email = ext.email?.trim().toLowerCase() || null
      const hasRealEmail = !isDummyEmail(email)
      const authEmail = hasRealEmail ? email : null
      const displayName = ext.display_name

      if (dry_run) { result.extensionsSynced++; continue }

      // auth user (real email where we have one, deterministic internal otherwise)
      const targetEmail =
        authEmail || `ext.${account}.${slugify(payload.fqdn || 'threecx')}@3cx.internal`

      let userId: string
      const { data: created, error: createErr } = await sb.auth.admin.createUser({
        email: targetEmail,
        email_confirm: !!authEmail,
        user_metadata: { display_name: displayName, source: '3cx_migration' },
      })
      if (created?.user) {
        userId = created.user.id
      } else if (createErr?.message?.includes('already') || createErr?.status === 422) {
        const { data: list } = await sb.auth.admin.listUsers({ perPage: 1000 })
        const found = list?.users?.find((u: any) => u.email === targetEmail)
        if (!found) throw new Error(`auth user missing after duplicate error: ${targetEmail}`)
        userId = found.id
      } else {
        throw new Error(`auth createUser: ${createErr?.message}`)
      }

      const departments = deptByExt[account] || []

      const { data: ou, error: ouErr } = await sb.from('org_users').upsert({
        org_id: target_org_id,
        user_id: userId,
        email: authEmail,
        display_name: displayName,
        role: 'member',
        extension: account,
        department: departments[0] || null,
        caller_id_name: displayName,
        caller_id_number: ext.outbound_caller_id_e164,
        mobile_number: ext.mobile || null,
        voicemail_enabled: ext.voicemail_enabled,
        voicemail_pin: ext.voicemail_pin,
        voicemail_transcription: true,
        dnd_enabled: false,
        phone_provisioned: false,
        onboarding_completed: false,
        settings: {
          ...sourceRef,
          threecx_extension: account,
          threecx_first_name: ext.first_name,
          threecx_last_name: ext.last_name,
          threecx_auth_id: ext.sip_auth_id,
          departments,
          mobile: ext.mobile,
          record_calls: ext.record_calls,
          voicemail_pin: ext.voicemail_pin,
          voicemail_email_mode: ext.voicemail_email_mode,
          no_answer_timeout: ext.no_answer_timeout,
          lan_only: ext.lan_only,
          enabled_on_3cx: ext.enabled,
          has_real_email: hasRealEmail,
          email_note: hasRealEmail ? null : '3CX had no usable email - needs update before invite',
          migrated_at: new Date().toISOString(),
        },
      }, { onConflict: 'org_id,user_id' }).select('id')

      if (ouErr) throw new Error(`org_users: ${ouErr.message}`)

      let orgUserId = ou?.[0]?.id
      if (!orgUserId) {
        const { data: existing } = await sb.from('org_users')
          .select('id').eq('org_id', target_org_id).eq('user_id', userId).single()
        orgUserId = existing?.id
      }
      if (!orgUserId) throw new Error('could not resolve org_user id')
      extToOrgUserId[account] = orgUserId

      if (hasRealEmail && authEmail) {
        pendingInvites.push({ email: authEmail, display_name: displayName, org_user_id: orgUserId })
      }

      // SIP credential. New SONIQ-realm secret - we deliberately do NOT carry
      // the 3CX AuthPassword across; phones get re-provisioned onto SONIQ.
      const sipUsername = `${account}.${orgSlug}`
      const sipPassword = crypto.randomBytes(12).toString('hex').slice(0, 20)
      const { data: hashData } = await sb.rpc('crypt_password', { plain_password: sipPassword })
      if (hashData) {
        await sb.from('sip_credentials').upsert({
          org_id: target_org_id,
          org_user_id: orgUserId,
          extension: account,
          username: sipUsername,
          password_hash: hashData,
          password_plain: sipPassword,
          display_name: displayName,
          realm: SIP_REALM,
          enabled: ext.enabled,
        }, { onConflict: 'org_id,extension' })
      }

      // Devices. sip_devices is unique on (org_id, extension), not on MAC, so
      // one row per extension - any second handset on the same extension is
      // recorded in settings.additional_devices for manual placement.
      const usable = ext.devices.filter(d => d.mac)
      for (const d of ext.devices) {
        if (!d.mac) warnings.push(`ext ${account}: unparseable MAC "${d.mac_raw}"`)
      }
      if (usable.length) {
        const [primary, ...rest] = usable
        if (rest.length) {
          warnings.push(`ext ${account}: ${rest.length} extra handset(s) beyond the primary - see settings.additional_devices`)
        }
        const { error: devErr } = await sb.from('sip_devices').upsert({
          org_id: target_org_id,
          org_user_id: orgUserId,
          extension: account,
          name: displayName,
          label: `${displayName} (${primary.model || 'unknown'})`,
          mac_address: primary.mac,
          model: primary.model || null,
          vendor: vendorOf(primary.model, primary.template),
          device_type: 'deskphone',
          delivery_mode: 'sip',
          status: 'pending_migration',
          ownership_status: 'customer_owned',
          settings: {
            ...sourceRef,
            threecx_template: primary.template,
            threecx_interface: primary.interface,
            additional_devices: rest.map(r => ({ mac: r.mac, model: r.model, template: r.template })),
            migrated_at: new Date().toISOString(),
          },
        }, { onConflict: 'org_id,extension' })
        if (devErr) warnings.push(`ext ${account} device: ${devErr.message}`)
        else result.devicesSynced += usable.length
      }

      result.extensionsSynced++
      logger.info(`[3CX] [OK] ext ${account} ${displayName}${hasRealEmail ? '' : ' (no email)'}`)
    } catch (e: any) {
      warnings.push(`ext ${account}: ${e.message}`)
      logger.warn(`[3CX] ext ${account}: ${e.message}`)
    }
  }

  // ── Step 2: queues -> call_flows (hunt_group) ─────────────────────────────

  const dnToFlowId: Record<string, string> = {}

  for (const q of payload.queues) {
    try {
      if (dry_run) { result.queuesSynced++; continue }

      const memberExts = q.members.map(m => m.extension).filter(Boolean)
      const droppedAgents = memberExts.filter(m => excluded.has(m))
      const ringExts = memberExts.filter(m => !excluded.has(m))
      if (droppedAgents.length) {
        warnings.push(`queue ${q.extension} (${q.name}): dropped excluded agent(s) ${droppedAgents.join(', ')} from the ring list`)
      }
      const ringMode =
        q.strategy === 'RingAll' ? 'simultaneous'
        : q.strategy === 'Hunt' || q.strategy === 'HuntRandomStart' ? 'sequential'
        : q.strategy === 'LongestWaiting' ? 'longest_idle'
        : 'simultaneous'

      const steps: any[] = []
      if (q.intro_enabled) {
        steps.push({ id: 'intro', type: 'play_prompt', config: { prompt: q.music_on_hold || 'default' } })
      }
      steps.push({
        id: 'ring',
        type: 'ring_user',
        config: {
          ring_mode: ringMode,
          timeout: q.ring_timeout,
          max_wait: q.master_timeout,
          extensions: ringExts,
          music_on_hold: q.music_on_hold || null,
          announce_position: q.announce_position,
          announce_interval: q.announce_interval,
        },
      })
      steps.push(overflowStep(q.timeout_destination))

      const { data: flow, error } = await sb.from('call_flows').upsert({
        org_id: target_org_id,
        name: q.name,
        flow_type: 'queue',
        entrypoint: 'start',
        is_active: true,
        settings: {
          ...sourceRef,
          extension: q.extension,
          threecx_strategy: q.strategy,
          queue_managers: q.managers,
          migrated_at: new Date().toISOString(),
        },
        workflow_steps: steps,
      }, { onConflict: 'org_id,name' }).select('id').single()

      if (error) throw new Error(error.message)
      dnToFlowId[q.extension] = flow!.id
      result.queuesSynced++
      logger.info(`[3CX] [OK] queue ${q.extension} ${q.name} (${memberExts.length} agents)`)
    } catch (e: any) {
      warnings.push(`queue ${q.extension}: ${e.message}`)
      logger.warn(`[3CX] queue ${q.extension}: ${e.message}`)
    }
  }

  // ── Step 3: IVRs -> call_flows (skip 3CX internals) ───────────────────────

  for (const ivr of payload.ivrs) {
    if (ivr.system) continue
    try {
      if (dry_run) { result.ivrsSynced++; continue }

      const options: Record<string, any> = {}
      for (const [key, d] of Object.entries(ivr.options || {})) {
        options[key] = resolveDest(d, dnToFlowId)
      }

      const { data: flow, error } = await sb.from('call_flows').upsert({
        org_id: target_org_id,
        name: ivr.name,
        flow_type: 'ivr',
        entrypoint: 'start',
        is_active: true,
        settings: { ...sourceRef, extension: ivr.extension, migrated_at: new Date().toISOString() },
        workflow_steps: [
          { id: 'greeting', type: 'play_prompt', config: { prompt: ivr.prompt || 'default' } },
          { id: 'menu', type: 'ivr_menu', config: { timeout: ivr.timeout, options } },
          { id: 'timeout', type: ivr.timeout_action === 'EndCall' ? 'hangup' : 'voicemail', config: {} },
        ],
      }, { onConflict: 'org_id,name' }).select('id').single()

      if (error) throw new Error(error.message)
      dnToFlowId[ivr.extension] = flow!.id
      result.ivrsSynced++
      logger.info(`[3CX] [OK] IVR ${ivr.extension} ${ivr.name}`)
    } catch (e: any) {
      warnings.push(`ivr ${ivr.extension}: ${e.message}`)
    }
  }

  // ── Step 4: DIDs -> phone_numbers, pointed at the right flow ─────────────

  for (const did of payload.dids) {
    if (!did.did) {
      warnings.push(`DID "${did.did_raw}" could not be normalised to E.164 - skipped`)
      continue
    }
    try {
      if (dry_run) { result.numbersSynced++; continue }

      const oh = resolveDest(did.office_hours, dnToFlowId)
      const ooh = resolveDest(did.out_of_hours, dnToFlowId)

      // office-hours destination drives the primary route; OOH is carried in
      // settings so the flow's schedule branch can pick it up.
      const callFlowId = oh?.call_flow_id || null
      const destExt = oh?.type === 'extension' ? oh.target : null

      // An OOH/office-hours leg pointing at an excluded extension has nowhere
      // to land - keep it in payload_routes but say so, loudly.
      for (const [label, r] of [['office hours', oh], ['out of hours', ooh]] as const) {
        if (r?.type === 'extension' && r.target && excluded.has(r.target)) {
          warnings.push(`DID ${did.did} ${label}: points at excluded ext ${r.target} - needs a new destination`)
        }
      }

      if (!callFlowId && !destExt) {
        warnings.push(
          `DID ${did.did}: no destination on 3CX either (${JSON.stringify(did.office_hours)}) - ` +
          `landing inactive, needs a flow assigning`,
        )
      }

      const { error } = await sb.from('phone_numbers').upsert({
        org_id: target_org_id,
        number: did.did,
        country_code: 'GB',
        number_type: numberType(did.did),
        route_type: 'flow',
        status: 'active',
        is_active: !!(callFlowId || destExt),
        label: oh?.target ? `3CX ${oh.type} ${oh.target}` : '3CX migrated',
        call_flow_id: callFlowId,
        dispatch_rule_type: callFlowId ? 'hunt' : destExt ? 'user' : null,
        inbound_trunk_id: inbound_trunk_id || null,
        provider: 'gradwell',
        voice_enabled: true,
        // phone_numbers has no settings column; routing provenance lives in
        // payload_routes so the OOH/holiday legs survive the migration.
        payload_routes: {
          ...sourceRef,
          threecx_raw: did.did_raw,
          threecx_line: did.line,
          threecx_gateway: did.gateway,
          destination_extension: destExt,
          office_hours: oh,
          out_of_hours: ooh,
          holidays: resolveDest(did.holidays, dnToFlowId),
          alter_out_of_hours: did.alter_ooh,
          migrated_at: new Date().toISOString(),
        },
      }, { onConflict: 'org_id,number' })

      if (error) throw new Error(error.message)
      result.numbersSynced++
      logger.info(`[3CX] [OK] DID ${did.did} -> ${oh?.type}:${oh?.target}`)
    } catch (e: any) {
      warnings.push(`did ${did.did}: ${e.message}`)
    }
  }

  // ── Step 5: company phonebook -> org directory (optional) ────────────────

  if (import_phonebook && !dry_run) {
    // contacts is unique on (org_id, external_crm_id) - key off the 3CX number
    // so re-running the migration updates rather than duplicating.
    const seen = new Set<string>()
    const rows = payload.phonebook
      .filter(c => c.number_e164)
      .filter(c => { const k = c.number_e164!; if (seen.has(k)) return false; seen.add(k); return true })
      .map(c => ({
        org_id: target_org_id,
        display_name: [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company || c.number_e164,
        first_name: c.first_name || null,
        last_name: c.last_name || null,
        company: c.company || null,
        phone_number: c.number_e164,
        // phone_e164 is a generated column (to_e164_uk over phone_number/
        // phone/mobile) - writing it is rejected, so let Postgres derive it.
        email: c.email || null,
        contact_type: 'org',
        source_system: '3cx_phonebook',
        external_crm_id: `3cx:${c.number_e164}`,
        external_crm_source: '3cx_phonebook',
        synced_at: new Date().toISOString(),
      }))
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500)
      const { error } = await sb.from('contacts')
        .upsert(batch, { onConflict: 'org_id,external_crm_id' })
      if (error) { warnings.push(`phonebook batch ${i}: ${error.message}`); break }
      result.phonebookSynced += batch.length
    }
    logger.info(`[3CX] [OK] phonebook ${result.phonebookSynced}/${payload.phonebook.length}`)
  }

  if (warnings.length) result.status = 'partial'
  logger.info(
    `[3CX] done: ${result.extensionsSynced} exts, ${result.devicesSynced} devices, ` +
    `${result.queuesSynced} queues, ${result.ivrsSynced} IVRs, ${result.numbersSynced} DIDs, ` +
    `${warnings.length} warnings`,
  )
  return result
}

// ── analyse (no writes) ─────────────────────────────────────────────────────

export interface ThreeCxAnalysis {
  source: string
  version: string
  company: string | null
  fqdn: string | null
  backup_date: string
  counts: Record<string, number>
  trunks: Array<{ name: string; host: string | null; registration: string | null }>
  blockers: string[]
  warnings: string[]
  notes: string[]
}

/**
 * Pre-migration readiness scan. Pure function over the payload - touches
 * neither 3CX nor SONIQ, so it is safe to run repeatedly from the UI.
 */
export function analyseThreeCxPayload(payload: ThreeCxPayload): ThreeCxAnalysis {
  const blockers: string[] = []
  const warnings: string[] = []
  const notes: string[] = []

  const extNumbers = new Set(payload.extensions.map(e => e.extension))
  const queueNumbers = new Set(payload.queues.map(q => q.extension))

  // DIDs that will not route
  for (const d of payload.dids) {
    if (!d.did) {
      blockers.push(`DID "${d.did_raw}" will not normalise to E.164`)
      continue
    }
    for (const [label, dst] of [['office hours', d.office_hours], ['out of hours', d.out_of_hours]] as const) {
      if (!dst || dst.type === 'none') continue
      const dn = dst.dn
      const ok = dst.type === 'external'
        || (dst.type === 'queue' && dn && queueNumbers.has(dn))
        || (dst.type === 'extension' && dn && extNumbers.has(dn))
      if (!ok) {
        // Already broken on 3CX - migrating it changes nothing for the worse,
        // so this is a warning. It lands inactive and needs a flow assigning.
        warnings.push(`DID ${d.did} ${label}: destination ${dst.type}:${dn ?? 'none'} does not resolve on 3CX either - will land inactive`)
      }
    }
  }

  // queue agents pointing at extensions that do not exist
  for (const q of payload.queues) {
    for (const m of q.members) {
      if (!extNumbers.has(m.extension)) {
        warnings.push(`queue ${q.extension} (${q.name}): agent ${m.extension} is not an extension`)
      }
    }
  }

  // extension shape - SONIQ enforces digits-only plus an org digit range
  const nonNumeric = payload.extensions.filter(e => !/^[0-9]+$/.test(e.extension))
  if (nonNumeric.length) {
    warnings.push(`${nonNumeric.length} non-numeric extension(s) will be skipped (SONIQ requires digits): ${nonNumeric.map(e => e.extension).join(', ')}`)
  }
  const digitLengths = [...new Set(payload.extensions.filter(e => /^[0-9]+$/.test(e.extension)).map(e => e.extension.length))].sort()
  notes.push(`numeric extensions are ${digitLengths.join('/')} digit(s) - target org must have extension_min_digits/max_digits covering ${digitLengths[0]}-${digitLengths[digitLengths.length - 1]}`)

  // users we cannot invite
  const noEmail = payload.extensions.filter(e => isDummyEmail(e.email))
  if (noEmail.length) {
    warnings.push(`${noEmail.length} extension(s) have no usable email and cannot be invited: ${noEmail.map(e => e.extension).join(', ')}`)
  }
  const emailCounts: Record<string, number> = {}
  for (const e of payload.extensions) {
    if (e.email) emailCounts[e.email] = (emailCounts[e.email] || 0) + 1
  }
  for (const [email, n] of Object.entries(emailCounts)) {
    if (n > 1) blockers.push(`email ${email} is shared by ${n} extensions - auth users collide`)
  }

  // devices
  const byExt: Record<string, number> = {}
  for (const e of payload.extensions) {
    const usable = e.devices.filter(d => d.mac)
    if (usable.length) byExt[e.extension] = usable.length
    for (const d of e.devices) {
      if (!d.mac) warnings.push(`ext ${e.extension}: MAC "${d.mac_raw}" is unparseable`)
    }
  }
  const multi = Object.entries(byExt).filter(([, n]) => n > 1)
  if (multi.length) {
    warnings.push(`${multi.length} extension(s) have more than one handset; sip_devices holds one row per extension, extras go to settings.additional_devices: ${multi.map(([k, n]) => `${k}(${n})`).join(', ')}`)
  }

  // outbound CLI
  const noCli = payload.extensions.filter(e => !e.outbound_caller_id_e164)
  if (noCli.length) {
    warnings.push(`${noCli.length} extension(s) have no outbound CLI - they inherit the org default or get 503 No CLI configured`)
  }

  const systemIvrs = payload.ivrs.filter(i => i.system)
  if (systemIvrs.length) {
    notes.push(`${systemIvrs.length} 3CX system IVR(s) skipped (${systemIvrs.map(i => i.name).join(', ')}) - engine plumbing, not auto-attendants`)
  }
  notes.push('3CX v20 <Groups> are permission/department groups, not ring groups - mapped to org_users.department, not call flows')
  notes.push('SIP secrets are regenerated on the SONIQ realm; 3CX AuthPasswords are not carried across, so handsets need re-provisioning')
  if (payload.media.recordings.length || payload.media.voicemails.length) {
    notes.push(`${payload.media.recordings.length} recordings and ${payload.media.voicemails.length} voicemails are in the backup but are not migrated by this mapper - archive separately`)
  }

  return {
    source: payload.source,
    version: payload.version,
    company: payload.company,
    fqdn: payload.fqdn,
    backup_date: payload.backup_date,
    counts: {
      extensions: payload.extensions.length,
      extensions_enabled: payload.extensions.filter(e => e.enabled).length,
      devices: Object.values(byExt).reduce((a, b) => a + b, 0),
      queues: payload.queues.length,
      queue_agent_seats: payload.queues.reduce((a, q) => a + q.members.length, 0),
      departments: payload.departments.length,
      ivrs_migratable: payload.ivrs.filter(i => !i.system).length,
      dids: payload.dids.length,
      outbound_rules: payload.outbound_rules.length,
      phonebook: payload.phonebook.length,
      recordings: payload.media.recordings.length,
      voicemails: payload.media.voicemails.length,
    },
    trunks: payload.trunks
      .filter(t => t.kind === 'voip_provider')
      .map(t => ({ name: t.name, host: t.host, registration: t.requires_registration })),
    blockers,
    warnings,
    notes,
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** Map a 3CX provisioning model/template to a SONIQ device vendor. */
function vendorOf(model?: string | null, template?: string | null): string | null {
  const s = `${model || ''} ${template || ''}`.toLowerCase()
  if (s.includes('yealink')) return 'yealink'
  if (s.includes('fanvil')) return 'fanvil'
  if (s.includes('snom')) return 'snom'
  if (s.includes('grandstream')) return 'grandstream'
  if (s.includes('cisco')) return 'cisco'
  if (s.includes('polycom') || s.includes('poly')) return 'polycom'
  if (s.includes('aastra') || s.includes('mitel')) return 'mitel'
  if (s.includes('htek')) return 'htek'
  return null
}

/** UK numbering -> phone_numbers.number_type (checked: local|mobile|tollfree|national). */
function numberType(e164: string): string {
  const d = e164.replace(/\D/g, '')
  if (!d.startsWith('44')) return 'national'
  const nsn = d.slice(2)
  if (nsn.startsWith('7')) return 'mobile'
  if (nsn.startsWith('80') || nsn.startsWith('500')) return 'tollfree'
  if (nsn.startsWith('3') || nsn.startsWith('84') || nsn.startsWith('87') || nsn.startsWith('9')) return 'national'
  return 'local'
}

function resolveDest(d: ThreeCxDest | null | undefined, dnToFlowId: Record<string, string>) {
  if (!d || d.type === 'none') return null
  if (d.type === 'external') return { type: 'external', target: d.external, call_flow_id: null }
  const dn = d.dn || null
  const flowId = dn ? dnToFlowId[dn] : undefined
  return {
    type: flowId ? 'call_flow' : d.type,
    target: dn,
    call_flow_id: flowId || null,
  }
}

function overflowStep(d: ThreeCxDest | null | undefined) {
  if (!d || d.type === 'none') {
    return { id: 'vm', type: 'voicemail', config: { greeting: 'default', transcription: true } }
  }
  if (d.type === 'external') {
    return { id: 'overflow', type: 'transfer_external', config: { number: d.external } }
  }
  return { id: 'overflow', type: 'transfer', config: { extension: d.dn } }
}
