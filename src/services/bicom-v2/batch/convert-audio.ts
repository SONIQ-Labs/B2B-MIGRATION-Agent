/**
 * bicom-v2/batch/convert-audio.ts
 *
 * Convert every non-PCM asset in phone_prompts (ulaw / alaw / gsm / sln /
 * g722) into 16-bit PCM WAV so the SBC's /play endpoint can decode them.
 * Bicom uses raw Asterisk codecs — the SBC's media server can't play those
 * directly, hence the 10-second silence on every migrated IVR/RG greeting.
 *
 *   For each phone_prompts row with a legacy codec:
 *     1. Fetch the raw bytes from R2
 *     2. Pipe through ffmpeg → PCM16 16 kHz mono WAV
 *     3. Upload the WAV to R2 at the same key but with a `.wav` extension
 *     4. Update phone_prompts.storage_key + format = 'wav'
 *     5. The mirror trigger keeps audio_assets in lockstep automatically
 *     6. Leave the original object in R2 (cheap; useful for audit / rollback)
 *
 * Sample rate choice — 16 kHz PCM16 mono is the SBC's native codec. The
 * source Bicom files are 8 kHz narrowband, so we upsample; that gives us a
 * WAV the SBC will happily play without any decode surprises.
 *
 *   Usage:
 *     pnpm tsx src/services/bicom-v2/batch/convert-audio.ts [--only <format[,format]>] [--limit N] [--dry-run]
 *
 *   Env:
 *     SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, R2_ENDPOINT,
 *     R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 */

import 'dotenv/config'
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync, existsSync, readFileSync, unlinkSync } from 'node:fs'
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { sb, r2, R2_BUCKET_PROMPTS, log } from '../shared'

const LEGACY_FORMATS = new Set(['ulaw', 'alaw', 'gsm', 'sln', 'sln16', 'g722'])
const TMP_DIR = '/tmp/soniq-audio-convert'
if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true })

/* ────────────────────────────────────────────────────────────────────────── */

interface PromptRow {
  id: string
  org_id: string
  name: string
  category: string
  bucket: string
  storage_key: string
  format: string
}

async function listPromptsNeedingConversion(only: string[] | null, limit: number | null): Promise<PromptRow[]> {
  const sup = sb()
  const targetFormats = only ?? Array.from(LEGACY_FORMATS)
  let q = sup.from('phone_prompts')
    .select('id, org_id, name, category, bucket, storage_key, format')
    .in('format', targetFormats)
    .order('created_at', { ascending: true })
  if (limit) q = q.limit(limit)
  const { data, error } = await q
  if (error) throw new Error(`phone_prompts read failed: ${error.message}`)
  return (data ?? []) as PromptRow[]
}

/**
 * ffmpeg call. `format` tells ffmpeg how to interpret the raw payload — Bicom
 * files are all headerless codec streams so we need the -f / -ar / -ac hints.
 */
function ffmpegInputArgsFor(format: string): string[] {
  switch (format) {
    case 'ulaw':  return ['-f', 'mulaw', '-ar', '8000',  '-ac', '1']
    case 'alaw':  return ['-f', 'alaw',  '-ar', '8000',  '-ac', '1']
    case 'gsm':   return ['-f', 'gsm',   '-ar', '8000',  '-ac', '1']
    case 'sln':   return ['-f', 's16le', '-ar', '8000',  '-ac', '1']
    case 'sln16': return ['-f', 's16le', '-ar', '16000', '-ac', '1']
    // g722's raw demuxer hardcodes 16 kHz — passing -ar is rejected as
    // "Option sample_rate not found". Just declare the container.
    case 'g722':  return ['-f', 'g722']
    default:      return []
  }
}

function convertLocal(srcPath: string, dstPath: string, srcFormat: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      '-y', '-hide_banner', '-loglevel', 'error',
      ...ffmpegInputArgsFor(srcFormat),
      '-i', srcPath,
      '-ar', '16000', '-ac', '1',
      '-acodec', 'pcm_s16le',
      dstPath,
    ]
    const p = spawn('ffmpeg', args)
    let stderr = ''
    p.stderr.on('data', c => { stderr += c.toString() })
    p.on('exit', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exit=${code}: ${stderr}`)))
    p.on('error', reject)
  })
}

async function fetchFromR2(key: string): Promise<Buffer> {
  const s3 = r2()
  const res = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET_PROMPTS, Key: key }))
  const chunks: Buffer[] = []
  for await (const chunk of res.Body as any) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

async function uploadToR2(key: string, buf: Buffer): Promise<number> {
  const s3 = r2()
  await s3.send(new PutObjectCommand({
    Bucket: R2_BUCKET_PROMPTS, Key: key, Body: buf,
    ContentType: 'audio/wav',
  }))
  return buf.byteLength
}

async function convertOne(row: PromptRow, dryRun: boolean): Promise<{ok: boolean; note: string; newKey?: string; newSize?: number}> {
  const stem = row.storage_key.replace(/\.[^.]+$/, '')     // strip old extension
  const newKey = `${stem}.wav`

  if (dryRun) {
    return { ok: true, note: `[dry-run] would convert ${row.storage_key} → ${newKey}` }
  }

  const srcPath = `${TMP_DIR}/${row.id}.${row.format}`
  const dstPath = `${TMP_DIR}/${row.id}.wav`

  try {
    // 1. Fetch from R2
    const buf = await fetchFromR2(row.storage_key)
    writeFileSync(srcPath, buf)

    // 2. ffmpeg → WAV
    await convertLocal(srcPath, dstPath, row.format)

    // 3. Upload the WAV back
    const wavBuf = readFileSync(dstPath)
    const newSize = await uploadToR2(newKey, wavBuf)

    // 4. Update phone_prompts. The mirror trigger updates audio_assets.
    //    Bicom stores each greeting in 5 codec formats as separate rows —
    //    all point at the same base name. First to convert wins the .wav
    //    storage_key; siblings hit the (org_id, category, storage_key)
    //    unique constraint. Delete the redundant row + its legacy R2 object.
    const sup = sb()
    const { error } = await sup.from('phone_prompts').update({
      storage_key: newKey,
      format: 'wav',
      file_size_bytes: newSize,
      updated_at: new Date().toISOString(),
    }).eq('id', row.id)
    if (error) {
      const msg = error.message || ''
      if (/duplicate key|unique constraint/i.test(msg)) {
        await sup.from('phone_prompts').delete().eq('id', row.id)
        try {
          const { DeleteObjectCommand } = await import('@aws-sdk/client-s3')
          await r2().send(new DeleteObjectCommand({ Bucket: R2_BUCKET_PROMPTS, Key: row.storage_key }))
        } catch { /* best-effort */ }
        return { ok: true, note: 'deduped (wav already exists via sibling codec)', newKey }
      }
      throw new Error(`phone_prompts update failed: ${msg}`)
    }

    return { ok: true, note: 'converted', newKey, newSize }
  } finally {
    // Clean up local scratch
    try { unlinkSync(srcPath) } catch {}
    try { unlinkSync(dstPath) } catch {}
  }
}

/* ────────────────────────────────────────────────────────────────────────── */

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const onlyIdx = args.indexOf('--only')
  const only = onlyIdx >= 0 ? args[onlyIdx + 1].split(',').map(s => s.trim()) : null
  const limitIdx = args.indexOf('--limit')
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : null
  const concurrencyIdx = args.indexOf('--concurrency')
  const concurrency = concurrencyIdx >= 0 ? parseInt(args[concurrencyIdx + 1], 10) : 8

  console.log(`[convert] dry_run=${dryRun} only=${only?.join(',') || 'all'} limit=${limit ?? 'none'} conc=${concurrency}`)

  const rows = await listPromptsNeedingConversion(only, limit)
  console.log(`[convert] ${rows.length} rows to convert`)
  if (!rows.length) return

  // Concurrent-ish processing with a semaphore
  let done = 0, ok = 0, failed = 0
  const errors: string[] = []
  const t0 = Date.now()

  async function worker() {
    while (true) {
      const row = rows.shift()
      if (!row) return
      try {
        const r = await convertOne(row, dryRun)
        if (r.ok) ok++
        else failed++
      } catch (e: any) {
        failed++
        const line = `${row.format} ${row.storage_key}: ${e?.message || e}`
        errors.push(line)
        try {
          const fs = await import('node:fs')
          fs.appendFileSync('/tmp/soniq-audio-convert/errors.txt', line + '\n')
        } catch {}
      }
      done++
      if (done % 25 === 0 || done === rows.length + done) {
        const rate = (done / ((Date.now() - t0) / 1000)).toFixed(1)
        console.log(`[convert] progress ${done} converted (ok=${ok} failed=${failed}) at ${rate}/s`)
      }
    }
  }

  const total = rows.length
  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`[convert] done in ${elapsed}s — ok=${ok} failed=${failed}`)
  if (errors.length) {
    console.log(`[convert] first 5 errors:`)
    errors.slice(0, 5).forEach(e => console.log(`  ${e}`))
  }
  writeFileSync('/tmp/soniq-audio-convert/errors.txt', errors.join('\n'))
}

main().catch(e => { console.error('[convert] fatal:', e); process.exit(1) })
