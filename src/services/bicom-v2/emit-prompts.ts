/**
 * bicom-v2/emit-prompts.ts
 *
 * Uploads greetings + music-on-hold from the local Bicom media backfill into
 * R2 under `bicom/{tenant_code}/{category}/{filename}`, then inserts
 * phone_prompts rows. Returns a lookup by original Bicom filename so IVR
 * emitter can attach `greeting_asset_id` to each dtmf_menu step.
 *
 * Assumes media backfill is staged at:
 *   ~/bicom-backfill/mt001-valuecomms/2026-09-14/{sounds,moh}/...
 * Adjust MEDIA_ROOT via env if the staging location is different.
 */

import { promises as fs } from 'node:fs'
import { createReadStream, existsSync } from 'node:fs'
import * as path from 'node:path'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { sb, r2, R2_BUCKET_PROMPTS, bicomRef, log } from './shared'

export interface PromptRef {
  id: string                    // soniq phone_prompts.id
  bicom_filename: string        // e.g. "greeting-jul-24-2025-16-01-34"
  storage_key: string           // e.g. "bicom/216/greetings/greeting-jul-24-2025.wav"
  category: 'greeting' | 'moh' | 'vm_greeting' | 'other'
}

export interface EmitPromptsParams {
  tenant_code: string
  target_org_id: string
  media_root?: string           // override for the ~/bicom-backfill/... path
  dry_run: boolean
}

export interface EmitPromptsResult {
  greetings: Map<string, PromptRef>   // by Bicom filename (no extension)
  moh: Map<string, PromptRef>
  vm_greetings: Map<string, PromptRef>
  uploaded_bytes: number
  skipped_missing: string[]
}

const DEFAULT_MEDIA_ROOT = path.join(
  process.env.HOME ?? '/Users/davidsmith',
  'bicom-backfill/mt001-valuecomms/2026-09-14',
)

/* ============================================================================
 * The per-tenant filesystem tree looks like:
 *   sounds/<tenant_code>/greeting-<date>.wav
 *   sounds/<tenant_code>/greeting-<date>.mp3
 *   moh/m-<tenant_code>/track01.wav ...
 *   voicemail/<tenant_code>/<ext>/greet.wav (per-user greeting)
 * ============================================================================ */

export async function emitPrompts(params: EmitPromptsParams): Promise<EmitPromptsResult> {
  const { tenant_code, target_org_id, dry_run } = params
  const root = params.media_root ?? DEFAULT_MEDIA_ROOT

  const result: EmitPromptsResult = {
    greetings: new Map(),
    moh: new Map(),
    vm_greetings: new Map(),
    uploaded_bytes: 0,
    skipped_missing: [],
  }

  const client = sb()

  // ------ greetings ------
  const greetingsDir = path.join(root, 'sounds', tenant_code)
  if (existsSync(greetingsDir)) {
    const files = await fs.readdir(greetingsDir)
    const audioFiles = files.filter(f => /\.(wav|mp3|gsm|g722|sln|alaw|ulaw)$/i.test(f))
    log('emit-prompts', `${tenant_code} greetings: ${audioFiles.length} files at ${greetingsDir}`)
    for (const f of audioFiles) {
      const filepath = path.join(greetingsDir, f)
      const nameNoExt = f.replace(/\.[^.]+$/, '')
      const ext = path.extname(f).slice(1).toLowerCase()
      const storage_key = `bicom/${tenant_code}/greetings/${f}`

      let uploadedBytes = 0
      if (!dry_run) {
        uploadedBytes = await uploadFileToR2(filepath, R2_BUCKET_PROMPTS, storage_key, mimeFor(ext))
        result.uploaded_bytes += uploadedBytes
      } else {
        const st = await fs.stat(filepath).catch(() => null)
        uploadedBytes = st?.size ?? 0
      }

      let promptId: string
      if (!dry_run) {
        const { data, error } = await client.from('phone_prompts').upsert({
          org_id: target_org_id,
          name: nameNoExt,
          category: 'greeting',
          bucket: R2_BUCKET_PROMPTS,
          storage_key,
          format: ext,
          file_size_bytes: uploadedBytes,
          description: `Bicom greeting migrated from tenant ${tenant_code}`,
        }, { onConflict: 'org_id,category,storage_key' }).select('id').single()
        if (error) throw new Error(`phone_prompts insert failed: ${error.message}`)
        promptId = data!.id as string
      } else {
        promptId = `dry-run-greeting-${nameNoExt}`
      }

      result.greetings.set(nameNoExt, {
        id: promptId,
        bicom_filename: nameNoExt,
        storage_key,
        category: 'greeting',
      })
    }
  } else {
    log('emit-prompts', `no greetings dir for tenant ${tenant_code} at ${greetingsDir} — skipping`)
  }

  // ------ music on hold ------
  const mohDir = path.join(root, 'moh', `m-${tenant_code}`)
  if (existsSync(mohDir)) {
    const files = await fs.readdir(mohDir)
    const audioFiles = files.filter(f => /\.(wav|mp3|gsm|g722|sln|alaw|ulaw)$/i.test(f))
    log('emit-prompts', `${tenant_code} MOH: ${audioFiles.length} files at ${mohDir}`)
    for (const f of audioFiles) {
      const filepath = path.join(mohDir, f)
      const nameNoExt = f.replace(/\.[^.]+$/, '')
      const ext = path.extname(f).slice(1).toLowerCase()
      const storage_key = `bicom/${tenant_code}/moh/${f}`

      let uploadedBytes = 0
      if (!dry_run) {
        uploadedBytes = await uploadFileToR2(filepath, R2_BUCKET_PROMPTS, storage_key, mimeFor(ext))
        result.uploaded_bytes += uploadedBytes
      } else {
        const st = await fs.stat(filepath).catch(() => null)
        uploadedBytes = st?.size ?? 0
      }

      let promptId: string
      if (!dry_run) {
        const { data, error } = await client.from('phone_prompts').upsert({
          org_id: target_org_id,
          name: nameNoExt,
          category: 'moh',
          bucket: R2_BUCKET_PROMPTS,
          storage_key,
          format: ext,
          file_size_bytes: uploadedBytes,
          description: `Bicom MOH migrated from tenant ${tenant_code}`,
        }, { onConflict: 'org_id,category,storage_key' }).select('id').single()
        if (error) throw new Error(`phone_prompts insert failed: ${error.message}`)
        promptId = data!.id as string
      } else {
        promptId = `dry-run-moh-${nameNoExt}`
      }

      result.moh.set(nameNoExt, {
        id: promptId,
        bicom_filename: nameNoExt,
        storage_key,
        category: 'moh',
      })
    }
  }

  // ------ per-user voicemail greetings ------
  // Bicom lays voicemails out at:  voicemail/t-{tenant_code}/{ext}/greet.wav
  //                                voicemail/t-{tenant_code}/{ext}/unavail.wav
  //                                voicemail/t-{tenant_code}/{ext}/busy.wav
  const vmDir = path.join(root, 'voicemail', `t-${tenant_code}`)
  if (existsSync(vmDir)) {
    const extDirs = await fs.readdir(vmDir)
    for (const extDir of extDirs) {
      const greetPath = path.join(vmDir, extDir, 'greet.wav')
      if (!existsSync(greetPath)) continue
      const storage_key = `bicom/${tenant_code}/vm_greetings/${extDir}/greet.wav`

      let uploadedBytes = 0
      if (!dry_run) {
        uploadedBytes = await uploadFileToR2(greetPath, R2_BUCKET_PROMPTS, storage_key, 'audio/wav')
        result.uploaded_bytes += uploadedBytes
      } else {
        const st = await fs.stat(greetPath).catch(() => null)
        uploadedBytes = st?.size ?? 0
      }

      let promptId: string
      if (!dry_run) {
        const { data, error } = await client.from('phone_prompts').upsert({
          org_id: target_org_id,
          name: `vm-greeting-${extDir}`,
          category: 'vm_greeting',
          bucket: R2_BUCKET_PROMPTS,
          storage_key,
          format: 'wav',
          file_size_bytes: uploadedBytes,
          description: `Bicom VM greeting for ext ${extDir} tenant ${tenant_code}`,
        }, { onConflict: 'org_id,category,storage_key' }).select('id').single()
        if (error) throw new Error(`phone_prompts insert failed: ${error.message}`)
        promptId = data!.id as string
      } else {
        promptId = `dry-run-vm-${extDir}`
      }

      result.vm_greetings.set(extDir, {
        id: promptId,
        bicom_filename: `vm-greeting-${extDir}`,
        storage_key,
        category: 'vm_greeting',
      })
    }
  }

  log('emit-prompts', `tenant ${tenant_code}: greetings=${result.greetings.size} moh=${result.moh.size} vm=${result.vm_greetings.size} bytes=${result.uploaded_bytes}`)
  return result
}

/* --- helpers --- */

async function uploadFileToR2(filepath: string, bucket: string, key: string, contentType: string): Promise<number> {
  const stat = await fs.stat(filepath)
  await r2().send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: createReadStream(filepath),
    ContentType: contentType,
    ContentLength: stat.size,
  }))
  return stat.size
}

function mimeFor(ext: string): string {
  switch (ext) {
    case 'wav': return 'audio/wav'
    case 'mp3': return 'audio/mpeg'
    case 'gsm': return 'audio/gsm'
    case 'g722': return 'audio/g722'
    case 'alaw':
    case 'ulaw':
    case 'sln':  return 'audio/basic'
    default:     return 'application/octet-stream'
  }
}
