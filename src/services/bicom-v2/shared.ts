/**
 * bicom-v2/shared.ts
 *
 * Cross-emitter helpers: Supabase client, idempotency keys, E.164, small utils.
 * All emitters import from here to stay consistent.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { S3Client } from '@aws-sdk/client-s3'

/* ============================================================================
 * Supabase (SONIQ) — service-role for admin writes
 * ============================================================================ */

let _sb: SupabaseClient | null = null

export function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY env required')
  _sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  return _sb
}

/* ============================================================================
 * R2 — Cloudflare object storage
 * ============================================================================ */

let _r2: S3Client | null = null

export function r2(): S3Client {
  if (_r2) return _r2
  const endpoint  = process.env.R2_ENDPOINT
  const accessKey = process.env.R2_ACCESS_KEY_ID
  const secretKey = process.env.R2_SECRET_ACCESS_KEY
  if (!endpoint || !accessKey || !secretKey)
    throw new Error('R2_ENDPOINT + R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY env required')
  _r2 = new S3Client({
    region: 'auto',
    endpoint,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  })
  return _r2
}

export const R2_BUCKET_PROMPTS = 'soniq-phone-prompts'
export const R2_BUCKET_VMS     = 'soniq-voicemail'    // matches voicemails.bucket default

/* ============================================================================
 * Idempotency keys — stable natural refs so re-runs upsert instead of duplicate.
 * Stored in each entity's `metadata` jsonb (or a dedicated *_bicom_ref column
 * on tables we control).
 * ============================================================================ */

export function bicomRef(tenantCode: string, entityKind: string, bicomId: string): string {
  return `bicom_${tenantCode}_${entityKind}_${bicomId}`
}

/* ============================================================================
 * UK phone number → E.164
 * Bicom stores as "02032815890" or "443300436871" — needs +44 prefix.
 * ============================================================================ */

export function ukToE164(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (!digits) return raw
  if (digits.startsWith('44')) return `+${digits}`
  if (digits.startsWith('0'))  return `+44${digits.slice(1)}`
  if (digits.startsWith('+'))  return digits
  return `+44${digits}`   // reasonable default for UK-only migration
}

/* ============================================================================
 * Bicom ring_strategy → SONIQ strategy
 * ============================================================================ */

export function mapRingStrategy(bicom: string | undefined): string {
  if (!bicom) return 'simultaneous'
  const s = bicom.toLowerCase()
  const map: Record<string, string> = {
    all:            'simultaneous',
    ringall:        'simultaneous',
    linear:         'linear',
    random:         'random',
    roundrobin:     'round_robin',
    leastrecent:    'least_recent',
    fewestcalls:    'fewest_calls',
    rrmemory:       'round_robin',
    rrordered:      'round_robin',
  }
  return map[s] ?? 'simultaneous'
}

/* ============================================================================
 * Small utils
 * ============================================================================ */

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

export function log(prefix: string, ...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.log(`[${prefix}]`, ...args)
}

export function pnum(v: string | undefined | null, dflt = 0): number {
  if (v === undefined || v === null || v === '') return dflt
  const n = Number(v)
  return Number.isFinite(n) ? n : dflt
}

export function stepId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}
