/**
 * bicom-v2/batch/run-all.ts
 *
 * Sequential batch migration across every Bicom tenant.
 *
 *   1. Fetch tenant list from Bicom API              (pbxware.tenant.list)
 *   2. For each tenant:
 *        a. Resolve to a SONIQ org (by settings.bicom_tenant_code or by slug),
 *           creating one if missing.
 *        b. Run the bicom-v2 mapper on that tenant.
 *   3. Log a per-tenant result and continue on failure so one bad tenant
 *      doesn't stop the batch. Final summary at the end.
 *
 * Idempotent: safe to re-run — the mapper's sip_credentials step checks
 * existence before insert (never overwrites live handset creds), and every
 * other emitter upserts on natural keys.
 *
 *   Usage: npx tsx src/services/bicom-v2/batch/run-all.ts \
 *            [--inbound-trunk <uuid>] [--only <tenant_code[,tenant_code,...]>]
 *            [--skip <tenant_code[,tenant_code,...]>]
 *            [--dry-run]
 *
 * Env (same as the single-tenant CLI):
 *   BICOM_API_URL, BICOM_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY, R2 vars
 */

import 'dotenv/config'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { sb, log } from '../shared'
import { migrateBicomTenantV2, MigrateBicomTenantV2Result } from '../index'

/* ─── Config ─────────────────────────────────────────────────────────────── */

const BICOM_API_URL = process.env.BICOM_API_URL || 'https://mt001.valuecomms.co.uk/index.php'
const BICOM_API_KEY = process.env.BICOM_API_KEY || 'EQH4hSV8NH8U3pvB0wqOIufVFYB3s3hN'

const DEFAULT_INBOUND_TRUNK = process.env.MIGRATION_INBOUND_TRUNK_UUID
  || 'fa44452c-67cd-4542-9b32-7bf01946a02f'  // SONIQ SIP (Secondary) placeholder

const LOG_DIR = '/tmp/soniq-batch'
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true })

/* ─── Bicom API ──────────────────────────────────────────────────────────── */

interface BicomTenant {
  serverId:  string
  name:      string
  tenantcode: string
  ext_length: number
  country_code: number
}

async function fetchBicomTenants(): Promise<BicomTenant[]> {
  const url = `${BICOM_API_URL}?apikey=${BICOM_API_KEY}&action=pbxware.tenant.list`
  const r = await fetch(url)
  if (!r.ok) throw new Error(`tenant.list HTTP ${r.status}`)
  const j = await r.json() as Record<string, any>
  const out: BicomTenant[] = []
  for (const [serverId, info] of Object.entries(j)) {
    if (!info || typeof info !== 'object') continue
    out.push({
      serverId,
      name: String(info.name || '').trim(),
      tenantcode: String(info.tenantcode || '').trim(),
      ext_length: Number(info.ext_length || 4),
      country_code: Number(info.country_code || 44),
    })
  }
  out.sort((a, b) => a.tenantcode.localeCompare(b.tenantcode))
  return out
}

/* ─── Org resolution ─────────────────────────────────────────────────────── */

// All 130 existing Bicom-migrated business orgs sit under SONIQ master.
// New orgs created by the batch follow the same convention.
const SONIQ_MASTER_ORG_ID = 'a0000000-0000-0000-0000-000000000000'

function slugBaseFromName(name: string): string {
  return name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

async function findOrCreateOrg(t: BicomTenant): Promise<string> {
  const sup = sb()

  // Slug convention going forward = the tenant code itself (e.g. '216').
  // Numeric, unique, Bicom-native — trivial to look up from the SBC / helpers.
  const targetSlug = t.tenantcode

  // Common patch we apply to every matched-or-created org: settings tag +
  // extension range aligned to Bicom's ext_length. Without the range sync
  // the extension_* check constraint on org_users rejects any ext whose
  // digit count doesn't match — killed Active Signs (245) on ext 201.
  const patch = {
    settings_add: {
      bicom_tenant_code: t.tenantcode,
      bicom_server_id: t.serverId,
    },
    extension_min_digits: t.ext_length,
    extension_max_digits: t.ext_length,
  }

  async function tagAndReturn(orgId: string, currentSettings: any, note: string, alsoSlug?: string): Promise<string> {
    await sup.from('orgs').update({
      ...(alsoSlug ? { slug: alsoSlug } : {}),
      settings: { ...(currentSettings || {}), ...patch.settings_add,
                  ...(alsoSlug ? { legacy_slug: alsoSlug === targetSlug ? currentSettings?.legacy_slug ?? null : null } : {}) },
      extension_min_digits: patch.extension_min_digits,
      extension_max_digits: patch.extension_max_digits,
    }).eq('id', orgId)
    log('batch', `  ${note}`)
    return orgId
  }

  // Path 1 — settings.bicom_tenant_code
  const bySettings = await sup
    .from('orgs')
    .select('id, slug, settings')
    .filter('settings->>bicom_tenant_code', 'eq', t.tenantcode)
    .maybeSingle()
  if (bySettings.data?.id) {
    return tagAndReturn(bySettings.data.id, bySettings.data.settings,
      `org ${bySettings.data.slug} matched by bicom_tenant_code (ext_length=${t.ext_length})`)
  }

  // Path 2 — slug already equals the tenant code
  const bySlug = await sup
    .from('orgs')
    .select('id, slug, settings')
    .eq('slug', targetSlug)
    .maybeSingle()
  if (bySlug.data?.id) {
    return tagAndReturn(bySlug.data.id, bySlug.data.settings,
      `org ${bySlug.data.slug} matched by slug (ext_length=${t.ext_length})`)
  }

  // Path 3 — legacy slug ends with -<server_id> (e.g. 'value-communications-578')
  const slugBase = slugBaseFromName(t.name)
  const legacySlug = `${slugBase}-${t.serverId}`
  const byLegacy = await sup
    .from('orgs')
    .select('id, slug, settings')
    .eq('slug', legacySlug)
    .maybeSingle()
  if (byLegacy.data?.id) {
    // Preserve original slug for reference
    const enrichedSettings = { ...(byLegacy.data.settings as any || {}), legacy_slug: byLegacy.data.slug }
    return tagAndReturn(byLegacy.data.id, enrichedSettings,
      `org ${byLegacy.data.slug} → ${targetSlug} (legacy slug renamed, ext_length=${t.ext_length})`,
      targetSlug)
  }

  // Path 4 — name match (case-insensitive)
  const byName = await sup
    .from('orgs')
    .select('id, slug, name, settings')
    .eq('type', 'business')
    .ilike('name', t.name)
    .maybeSingle()
  if (byName.data?.id) {
    const enrichedSettings = { ...(byName.data.settings as any || {}), legacy_slug: byName.data.slug }
    return tagAndReturn(byName.data.id, enrichedSettings,
      `org ${byName.data.slug} → ${targetSlug} (name match, ext_length=${t.ext_length})`,
      targetSlug)
  }

  // No match — create fresh
  const { data, error } = await sup.from('orgs').insert({
    slug: targetSlug,
    name: t.name,
    type: 'business',
    parent_id: SONIQ_MASTER_ORG_ID,
    extension_min_digits: t.ext_length,
    extension_max_digits: t.ext_length,
    settings: {
      bicom_tenant_code: t.tenantcode,
      bicom_server_id: t.serverId,
      migrated_from: 'bicom',
      migrated_at: new Date().toISOString(),
    },
  }).select('id').single()
  if (error) throw new Error(`orgs insert failed for ${t.tenantcode}: ${error.message}`)
  log('batch', `  org created ${targetSlug} (ext_length=${t.ext_length})`)
  return data!.id as string
}

/* ─── Per-tenant runner ──────────────────────────────────────────────────── */

interface TenantResult {
  tenantcode: string
  name: string
  orgId?: string
  ok: boolean
  errors: string[]
  stats?: MigrateBicomTenantV2Result
  durationMs: number
}

async function runTenant(
  t: BicomTenant,
  opts: { inboundTrunk: string; dryRun: boolean },
): Promise<TenantResult> {
  const t0 = Date.now()
  const res: TenantResult = { tenantcode: t.tenantcode, name: t.name, ok: false, errors: [], durationMs: 0 }
  try {
    const orgId = await findOrCreateOrg(t)
    res.orgId = orgId

    const summary = await migrateBicomTenantV2({
      tenant_code:      t.tenantcode,
      target_org_id:    orgId,
      server_url:       'https://mt001.valuecomms.co.uk',
      api_key:          BICOM_API_KEY,
      bicom_server_id:  t.serverId,
      inbound_trunk_id: opts.inboundTrunk,
      dry_run:          opts.dryRun,
    })
    res.stats = summary
    res.ok = (summary.errors?.length ?? 0) === 0
    if (!res.ok) res.errors.push(...(summary.errors as string[]))
  } catch (e: any) {
    res.errors.push(e?.message || String(e))
  } finally {
    res.durationMs = Date.now() - t0
  }
  return res
}

/* ─── Main ───────────────────────────────────────────────────────────────── */

async function main() {
  const args = process.argv.slice(2)
  const arg = (k: string) => {
    const i = args.indexOf(k)
    return i >= 0 ? args[i + 1] : undefined
  }
  const flag = (k: string) => args.includes(k)

  const inboundTrunk = arg('--inbound-trunk') || DEFAULT_INBOUND_TRUNK
  const dryRun = flag('--dry-run')
  const only  = arg('--only')?.split(',').map(s => s.trim()).filter(Boolean)
  const skip  = arg('--skip')?.split(',').map(s => s.trim()).filter(Boolean) ?? []

  console.log(`[batch] starting — inbound_trunk=${inboundTrunk} dry_run=${dryRun} only=${only?.join(',') || 'all'} skip=${skip.join(',') || 'none'}`)

  const tenants = await fetchBicomTenants()
  console.log(`[batch] fetched ${tenants.length} tenants from Bicom`)

  const filtered = tenants.filter(t => {
    if (only && !only.includes(t.tenantcode)) return false
    if (skip.includes(t.tenantcode)) return false
    return true
  })
  console.log(`[batch] running ${filtered.length} tenant(s)`)

  const results: TenantResult[] = []
  for (let i = 0; i < filtered.length; i++) {
    const t = filtered[i]
    console.log(`\n[batch] ── ${i + 1}/${filtered.length}  tenant=${t.tenantcode}  server=${t.serverId}  name=${t.name}`)
    const r = await runTenant(t, { inboundTrunk, dryRun })
    results.push(r)
    const c = r.stats?.counts
    console.log(`[batch] ${r.ok ? 'ok' : 'FAIL'}  tenant=${t.tenantcode}  users=${c?.extensions ?? '-'}  rgs=${c?.ring_groups ?? '-'}  ivrs=${c?.ivrs ?? '-'}  dids=${c?.dids ?? '-'}  errors=${r.errors.length}  ${r.durationMs}ms`)
    if (r.errors.length) r.errors.forEach(e => console.log(`  ! ${e}`))

    writeFileSync(`${LOG_DIR}/results.json`, JSON.stringify(results, null, 2))
  }

  const ok = results.filter(r => r.ok).length
  const failed = results.length - ok
  console.log(`\n[batch] done — ${ok} ok, ${failed} failed`)
  if (failed) {
    console.log(`[batch] failing tenants:`)
    results.filter(r => !r.ok).forEach(r => console.log(`  ${r.tenantcode}  ${r.name}  errors=${r.errors.length}`))
  }
  console.log(`[batch] full results: ${LOG_DIR}/results.json`)
}

main().catch(e => { console.error('[batch] fatal:', e); process.exit(1) })
