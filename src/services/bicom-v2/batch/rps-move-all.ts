/**
 * batch/rps-move-all.ts
 *
 * Move every MAC currently registered in our Yealink RPS enterprise account
 * onto the SONIQ server. Idempotent — MACs already on SONIQ are counted and
 * skipped without a re-registration call.
 *
 *   For each MAC in RPS:
 *     - if serverId already === SONIQ's → skip (already on SONIQ)
 *     - else → call addDevicesByMac with SONIQ serverId + provisioning URL
 *
 * The provisioning URL pattern is `${APP_URL}/api/provisioning/<MAC>.cfg`,
 * matching the format the existing register endpoint uses. Yealink treats
 * addDevicesByMac on an already-present MAC as an update, so this is the
 * one call needed to switch a device's server binding.
 *
 * A `settings.rps` block is written to matching sip_devices rows on success
 * so the admin UI reflects that RPS now points at SONIQ.
 *
 *   Usage:
 *     pnpm tsx src/services/bicom-v2/batch/rps-move-all.ts [--dry-run] [--limit N]
 *
 *   Env (loaded from soniqmail/.env.local for the Yealink creds):
 *     YEALINK_ACCESS_KEY_ID, YEALINK_ACCESS_KEY_SECRET,
 *     YEALINK_API_DOMAIN, YEALINK_RPS_SERVER_ID
 *     NEXT_PUBLIC_SITE_URL   (used for the provisioning URL)
 */

import 'dotenv/config'
import * as dotenv from 'dotenv'
import { readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { sb } from '../shared'

// Also load soniqmail's env for Yealink creds
try {
  const soniqEnv = readFileSync('/Users/davidsmith/Documents/GitHub/soniqmail/.env.local', 'utf8')
  dotenv.parse(soniqEnv) // parses only
  const parsed = dotenv.parse(soniqEnv)
  for (const [k, v] of Object.entries(parsed)) {
    if (!process.env[k]) process.env[k] = v
  }
} catch { /* env vars may already be set */ }

const APP_URL   = (process.env.NEXT_PUBLIC_SITE_URL || 'https://soniqmail.co.uk').replace(/\/$/, '')
const CLIENT_ID = clean(process.env.YEALINK_ACCESS_KEY_ID)
const CLIENT_SECRET = clean(process.env.YEALINK_ACCESS_KEY_SECRET)
const DOMAIN    = clean(process.env.YEALINK_API_DOMAIN, 'eu-api.ymcs.yealink.com')
const SERVER_ID = clean(process.env.YEALINK_RPS_SERVER_ID)

function clean(v?: string, def = ''): string {
  return (v ?? def).replace(/^["'\s]+|["'\s]+$/g, '').trim()
}

function normaliseMac(mac: string): string {
  return mac.replace(/[:.-]/g, '').toUpperCase()
}

function provisioningUrl(mac: string): string {
  return `${APP_URL}/api/provisioning/${normaliseMac(mac)}.cfg`
}

/* ── YMCS auth + request ─────────────────────────────────────────────────── */

let _token: string | null = null
let _tokenExp = 0

async function getToken(): Promise<string> {
  if (_token && Date.now() < _tokenExp - 60_000) return _token
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error('Yealink creds not loaded — check YEALINK_ACCESS_KEY_ID / SECRET')

  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')
  const res = await fetch(`https://${DOMAIN}/v2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/json',
      timestamp: Date.now().toString(),
      nonce: randomUUID().replace(/-/g, '').substring(0, 32),
    },
    body: JSON.stringify({ grant_type: 'client_credentials' }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Token error ${res.status}: ${text}`)
  const data = JSON.parse(text)
  _token = data.access_token
  _tokenExp = Date.now() + (data.expires_in || 3600) * 1000
  if (!_token) throw new Error('No access_token in response')
  return _token
}

async function ymcs<T = any>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: object): Promise<T> {
  const token = await getToken()
  const res = await fetch(`https://${DOMAIN}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      timestamp: Date.now().toString(),
      nonce: randomUUID().replace(/-/g, '').substring(0, 32),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  if (!res.ok && res.status !== 204) throw new Error(`YMCS ${method} ${path} → ${res.status}: ${text}`)
  return text ? JSON.parse(text) : ({} as T)
}

/* ── Enumerate every MAC, then move ──────────────────────────────────────── */

interface YmcsDevice {
  mac: string
  serverId?: string
  serverName?: string
  uniqueServerUrl?: string
  sn?: string
  model?: string
  status?: string
}

async function listAllDevices(): Promise<YmcsDevice[]> {
  const all: YmcsDevice[] = []
  let skip = 0
  const limit = 100
  while (true) {
    const res = await ymcs<{ data?: YmcsDevice[]; total?: number }>('POST', '/v2/rps/listDevices', {
      skip, limit, autoCount: true,
    })
    const rows = res.data ?? []
    all.push(...rows)
    console.log(`[rps] listed ${all.length}${res.total ? ` / ${res.total}` : ''}`)
    if (rows.length < limit) break
    skip += limit
    if (skip > 100_000) { console.warn('[rps] pagination safety cap hit'); break }
  }
  return all
}

async function moveOne(device: YmcsDevice & { id?: string }, dryRun: boolean): Promise<{ ok: boolean; note: string }> {
  const mac = normaliseMac(device.mac)
  const url = provisioningUrl(mac)

  if (dryRun) return { ok: true, note: `[dry-run] would PATCH device ${device.id} → serverId ${SERVER_ID}, url ${url}` }

  if (!device.id) return { ok: false, note: 'no device id (cannot PATCH)' }
  // PATCH /v2/rps/devices/{id} — the only endpoint that lets us re-bind an
  // already-registered device to a new serverId without needing SN. Returns
  // 204 No Content on success.
  await ymcs<any>('PATCH', `/v2/rps/devices/${device.id}`, {
    serverId: SERVER_ID,
    uniqueServerUrl: url,
  })

  // Reflect in sip_devices if a row exists for this MAC. Match either the
  // 12-char stripped form OR the colon-separated form so we hit whichever
  // shape the DB stores.
  try {
    const sup = sb()
    const colonMac = mac.match(/.{2}/g)!.join(':')
    await sup.from('sip_devices')
      .update({
        status: 'rps_registered',
        settings: { rps: { registered: true, url, registeredAt: new Date().toISOString(), serverId: SERVER_ID } },
      })
      .or(`mac_address.eq.${mac},mac_address.eq.${colonMac}`)
  } catch { /* best-effort */ }

  return { ok: true, note: 'rebound to SONIQ' }
}

/* ── main ────────────────────────────────────────────────────────────────── */

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const limitIdx = args.indexOf('--limit')
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : null

  console.log(`[rps] dry_run=${dryRun} SERVER_ID=${SERVER_ID} APP_URL=${APP_URL}`)
  console.log(`[rps] enumerating...`)

  const devices = await listAllDevices()
  console.log(`[rps] total devices in RPS: ${devices.length}`)

  const alreadyOnSoniq = devices.filter(d => d.serverId === SERVER_ID)
  const needsMove     = devices.filter(d => d.serverId !== SERVER_ID)
  console.log(`[rps]   already on SONIQ: ${alreadyOnSoniq.length}`)
  console.log(`[rps]   to move:          ${needsMove.length}`)

  // Distribution of source servers to move from
  const srcTally: Record<string, number> = {}
  for (const d of needsMove) {
    const key = d.serverName || d.serverId || '(unknown)'
    srcTally[key] = (srcTally[key] || 0) + 1
  }
  console.log(`[rps]   source distribution:`)
  for (const [name, n] of Object.entries(srcTally).sort((a, b) => b[1] - a[1])) {
    console.log(`         ${name.padEnd(40)} ${n}`)
  }

  const targets = limit ? needsMove.slice(0, limit) : needsMove
  if (!targets.length) { console.log(`[rps] nothing to do`); return }

  console.log(`[rps] moving ${targets.length} devices...`)
  let ok = 0, failed = 0, done = 0
  const errors: string[] = []
  const t0 = Date.now()

  for (const dev of targets) {
    try {
      const r = await moveOne(dev, dryRun)
      if (r.ok) ok++
      else { failed++; errors.push(`${dev.mac}: ${r.note}`) }
    } catch (e: any) {
      failed++
      errors.push(`${dev.mac}: ${e?.message || e}`)
    }
    done++
    if (done % 25 === 0 || done === targets.length) {
      const rate = (done / ((Date.now() - t0) / 1000)).toFixed(1)
      console.log(`[rps] progress ${done}/${targets.length} (ok=${ok} failed=${failed}) at ${rate}/s`)
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`[rps] done in ${elapsed}s — ok=${ok} failed=${failed}`)
  if (errors.length) {
    console.log(`[rps] first 10 errors:`)
    errors.slice(0, 10).forEach(e => console.log(`  ${e}`))
    writeFileSync('/tmp/soniq-rps-move.errors.txt', errors.join('\n'))
  }
}

main().catch(e => { console.error('[rps] fatal:', e); process.exit(1) })
