/**
 * bicom-v2/emit-extensions.ts
 *
 * Bicom extensions -> SONIQ org_users + sip_credentials.
 *
 * CLI mapping (per Jonny — "list of allowed user CLIs and a default CLI"):
 *   Bicom source (ES > Caller ID configuration):
 *     - callerid                per-user override (empty = fall through)
 *     - default_callerid        tenant fallback
 *     - emergency_callerid      999/112
 *     - allowed_callerids       [{callerid, label, short_code}, ...]
 *
 *   SONIQ target:
 *     - org_users.caller_id_number   effective default (callerid || default_callerid)
 *     - org_users.caller_id_name     the user's display name
 *     - org_users.settings.{default_cli,allowed_clis,emergency_cli,bicom_ref}
 *     - phone_numbers.is_cli_eligible=true + cli_display_name=<label>
 *       for every DID appearing in any user's allowed_callerids on this tenant.
 */

import { BicomClientV2, BicomExtFullConfig, BicomCallerIDConfig, BicomAllowedCallerID } from './client'
import { sb, bicomRef, log, pnum, ukToE164 } from './shared'
import { PromptRef } from './emit-prompts'

export interface EmitExtensionsParams {
  tenant_code: string
  target_org_id: string
  bicom_server_id: string
  client: BicomClientV2
  /** Per-extension VM greetings (keyed on ext number). Only genuine
   *  user-recorded greeting.wav files land here — Bicom's default
   *  unavail.wav is intentionally NOT uploaded so the SONIQ TTS chain
   *  (org-level, per-tenant override) takes over for those users. */
  vm_greetings: Map<string, PromptRef>
  dry_run: boolean
}

export interface EmitExtensionsResult {
  userIdByExt: Map<string, string>
  sipCredIdByExt: Map<string, string>
  full_configs: Map<string, BicomExtFullConfig>
  cli_configs: Map<string, BicomCallerIDConfig>
  cli_eligible_numbers: Map<string, string>
  count: number
}

interface SoniqAllowedCli {
  number: string
  label: string
  short_code?: string
}

export async function emitExtensions(params: EmitExtensionsParams): Promise<EmitExtensionsResult> {
  const { tenant_code, target_org_id, bicom_server_id, client, vm_greetings, dry_run } = params
  const sup = sb()

  const result: EmitExtensionsResult = {
    userIdByExt: new Map(),
    sipCredIdByExt: new Map(),
    full_configs: new Map(),
    cli_configs: new Map(),
    cli_eligible_numbers: new Map(),
    count: 0,
  }

  const exts = await client.listExtensions(bicom_server_id)
  log('emit-extensions', `${tenant_code}: ${exts.length} extensions`)

  // Pre-fetch the org's ext-length policy so we can pre-filter oddball entries.
  // Bicom's ext list occasionally contains non-user rows (voicemail codes,
  // external-number placeholders like "760859") that fail the org's
  // extension_min/max_digits check and would kill the tenant otherwise.
  let allowedDigits: { min: number; max: number } | null = null
  if (!dry_run) {
    const { data: orgRow } = await sup.from('orgs')
      .select('extension_min_digits, extension_max_digits')
      .eq('id', target_org_id).maybeSingle()
    if (orgRow?.extension_min_digits && orgRow?.extension_max_digits) {
      allowedDigits = {
        min: orgRow.extension_min_digits as number,
        max: orgRow.extension_max_digits as number,
      }
    }
  }

  for (const ext of exts) {
    // Skip entries whose length falls outside the org's ext-digit policy.
    // These are almost always Bicom internals (VM boxes, external number
    // placeholders) that aren't real users; they'd only fail on insert
    // and drop the whole tenant.
    if (allowedDigits) {
      const n = String(ext.ext).length
      if (n < allowedDigits.min || n > allowedDigits.max) {
        log('emit-extensions', `  skip ${ext.ext}: length ${n} outside org policy (${allowedDigits.min}–${allowedDigits.max})`)
        continue
      }
    }
    const full = await client.getExtension(bicom_server_id, ext.id)
    if ('error' in full) {
      log('emit-extensions', `  skip ${ext.ext}: ext.configuration error: ${full.error}`)
      continue
    }
    result.full_configs.set(ext.ext, full)

    const cliCfg = await client.getExtCallerIDConfig(bicom_server_id, ext.id)
    let defaultCli: string | undefined
    let emergencyCli: string | undefined
    let allowedClis: SoniqAllowedCli[] = []
    if (!('error' in cliCfg)) {
      result.cli_configs.set(ext.ext, cliCfg)
      defaultCli   = firstNonEmpty(cliCfg.callerid, cliCfg.default_callerid)
      emergencyCli = firstNonEmpty(cliCfg.emergency_callerid, defaultCli)
      allowedClis  = normaliseAllowedList(cliCfg.allowed_callerids, defaultCli)

      for (const a of allowedClis) {
        const e164 = ukToE164(a.number)
        if (!result.cli_eligible_numbers.has(e164)) result.cli_eligible_numbers.set(e164, a.label)
      }
      if (defaultCli) {
        const e164 = ukToE164(defaultCli)
        if (!result.cli_eligible_numbers.has(e164)) result.cli_eligible_numbers.set(e164, `${tenant_code} default`)
      }
    } else {
      log('emit-extensions', `  ! ${ext.ext} CLI config missing (${cliCfg.error}); falling back to ext.callerid`)
    }

    const opts        = full.options
    const displayName = ext.name?.trim() || ext.ext
    const email       = ext.email && !ext.email.startsWith('Spare')
      ? ext.email
      : syntheticEmail(ext.ext, tenant_code)
    const sipUsername = opts.username ?? `${tenant_code}${ext.ext}`
    const sipPassword = opts.secret ?? ''

    let authUserId: string | undefined
    if (!dry_run) authUserId = await findOrCreateAuthUser(email, displayName)

    let orgUserId: string
    if (!dry_run) {
      // VM greeting linkage: only override the SONIQ default when we have a
      // genuine user-recorded greeting (Bicom `greet.wav`). If nothing was
      // uploaded, leave vm_greeting_asset_id NULL + vm_mode='inherit' so the
      // SONIQ TTS chain (org-level, per-tenant override) takes over — that
      // sounds better than Bicom's stock `unavail.wav` for the 50 users
      // that had one.
      const vmGreeting = vm_greetings.get(ext.ext)

      const orgUserPayload = {
        org_id: target_org_id,
        user_id: authUserId ?? null,
        display_name: displayName,
        email,
        extension: ext.ext,
        department: ext.department || null,
        caller_id_number: defaultCli ? ukToE164(defaultCli) : null,
        caller_id_name:   displayName,
        ...(vmGreeting ? {
          vm_greeting_asset_id: vmGreeting.id,
          vm_mode: 'audio' as const,
        } : {}),
        settings: {
          bicom_ref: bicomRef(tenant_code, 'ext', ext.id),
          bicom_ua: ext.ua_fullname,
          bicom_ringtime: pnum(opts.ringtime, 30),
          bicom_context: opts.context,
          bicom_timezone: opts.ext_timezone ?? 'Europe/London',
          default_cli: defaultCli ? ukToE164(defaultCli) : null,
          emergency_cli: emergencyCli ? ukToE164(emergencyCli) : null,
          allowed_clis: allowedClis.map(a => ({
            number: ukToE164(a.number),
            label: a.label,
            short_code: a.short_code,
          })),
        },
      }

      let { data, error } = await sup.from('org_users').upsert(orgUserPayload, { onConflict: 'org_id,extension' }).select('id').single()

      // Retry without user_id when either:
      //   • The linked auth.users is a super admin (SONIQ business rule: super
      //     admins can't have direct org membership).
      //   • Another org_user in the same org already owns that user_id
      //     (uniq constraint org_users_org_id_user_id_key). Happens when several
      //     Bicom extensions share an email (e.g. reception@foo, admin@foo).
      // In both cases the org_users row still gets created, just without the
      // auth link — the user can be re-linked from the UI later.
      if (error && (/Super admin/i.test(error.message)
                    || /org_users_org_id_user_id_key/i.test(error.message))) {
        log('emit-extensions', `  ! ${ext.ext} (${email}) can't hold direct auth link (${error.message.slice(0,80)}) — creating org_users without auth link`)
        const retry = await sup.from('org_users')
          .upsert({ ...orgUserPayload, user_id: null }, { onConflict: 'org_id,extension' })
          .select('id').single()
        data  = retry.data
        error = retry.error
      }

      if (error) throw new Error(`org_users upsert failed for ${ext.ext}: ${error.message}`)
      orgUserId = data!.id as string
    } else {
      orgUserId = `dry-run-user-${ext.ext}`
    }
    result.userIdByExt.set(ext.ext, orgUserId)

    if (sipPassword) {
      let credId: string
      if (!dry_run) {
        // NEVER overwrite an existing sip_credentials row — a working
        // phone's provisioned cred lives here (username + hash), and blowing
        // it away kills authentication for that handset until it re-provisions.
        // The correct move is: check first, only insert when nothing exists.
        // If the row is present, we treat that as authoritative and skip.
        const { data: existing } = await sup
          .from('sip_credentials')
          .select('id, username')
          .eq('org_id', target_org_id)
          .eq('extension', ext.ext)
          .maybeSingle()

        if (existing?.id) {
          credId = existing.id as string
          log('emit-extensions', `  keep existing sip_credentials for ext ${ext.ext}: username=${existing.username}`)
        } else {
          // NEW row — Bicom-native creds so the same handset auth works both
          // pre- and post-cutover. SONIQ stores plaintext in BOTH password_plain
          // and password_hash (same value) — the SBC's digest auth reads it
          // straight; a bcrypt hash would break auth entirely.
          const { data, error } = await sup.from('sip_credentials').insert({
            org_id: target_org_id,
            org_user_id: orgUserId,
            extension: ext.ext,
            username: sipUsername,                       // e.g. "2162001" (tenant+ext)
            password_hash: sipPassword,                  // same plaintext — NOT bcrypt
            password_plain: sipPassword,
            display_name: displayName,
            realm: 'sip.soniqlabs.co.uk',
            enabled: true,
          }).select('id').single()
          if (error) throw new Error(`sip_credentials insert failed for ${sipUsername}: ${error.message}`)
          credId = data!.id as string
        }
      } else {
        credId = `dry-run-sip-${sipUsername}`
      }
      result.sipCredIdByExt.set(ext.ext, credId)
    }

    result.count++
    const cliDisplay = defaultCli ? ukToE164(defaultCli) : '(no CLI)'
    log('emit-extensions', `  ok ${ext.ext.padEnd(6)} ${displayName.padEnd(20)} sip=${sipUsername}  default_cli=${cliDisplay}  allowed=${allowedClis.length}`)
  }

  if (!dry_run && result.cli_eligible_numbers.size > 0) {
    let flagged = 0
    for (const [e164, label] of result.cli_eligible_numbers) {
      const { error } = await sup.from('phone_numbers')
        .update({ is_cli_eligible: true, cli_display_name: label })
        .eq('org_id', target_org_id)
        .eq('number', e164)
      if (!error) flagged++
    }
    log('emit-extensions', `${tenant_code}: flagged ${flagged}/${result.cli_eligible_numbers.size} phone_numbers as CLI-eligible`)
  }

  return result
}

/* ================= helpers ================= */

function firstNonEmpty(...vals: (string | undefined)[]): string | undefined {
  for (const v of vals) if (v && v.trim()) return v.trim()
  return undefined
}

function normaliseAllowedList(
  raw: Record<string, BicomAllowedCallerID> | [] | undefined,
  defaultCli: string | undefined,
): SoniqAllowedCli[] {
  const out: SoniqAllowedCli[] = []
  if (raw && !Array.isArray(raw)) {
    for (const key of Object.keys(raw).sort((a,b) => Number(a) - Number(b))) {
      const v = raw[key]
      if (v?.callerid) out.push({ number: v.callerid, label: v.label ?? v.callerid, short_code: v.short_code })
    }
  }
  if (defaultCli && !out.some(x => x.number === defaultCli)) {
    out.unshift({ number: defaultCli, label: 'Default', short_code: undefined })
  }
  return out
}

async function findOrCreateAuthUser(email: string, displayName: string): Promise<string | undefined> {
  const sup = sb()
  try {
    const { data: created, error } = await sup.auth.admin.createUser({
      email, email_confirm: true,
      user_metadata: { display_name: displayName, source: 'bicom_migration' },
    })
    if (!error && created?.user?.id) return created.user.id
    const { data: list } = await sup.auth.admin.listUsers({ perPage: 1000 })
    return list.users.find(u => u.email?.toLowerCase() === email.toLowerCase())?.id
  } catch (e) {
    log('emit-extensions', `auth user upsert failed for ${email}:`, (e as Error).message)
    return undefined
  }
}

function syntheticEmail(ext: string, tenantCode: string): string {
  return `${ext}@bicom-${tenantCode}.migrated.soniqlabs.local`
}
