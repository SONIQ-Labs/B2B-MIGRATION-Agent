/**
 * bicom-v2/emit-voicemails.ts
 *
 * Migrates every voicemail MESSAGE per user from the Bicom media backfill
 * into R2 (soniq-voicemail bucket) + Supabase (voicemails table).
 *
 * Bicom layout:
 *   voicemail/t-{tenant_code}/{ext}/{FOLDER}/msg####.wav
 *   voicemail/t-{tenant_code}/{ext}/{FOLDER}/msg####.txt   (Asterisk metadata)
 *
 * Folders observed: INBOX, Old, Urgent, Family, Friends, Work, Cust1..Cust9.
 * We walk all of them and set is_read/is_urgent accordingly.
 *
 * CRITICAL: every voicemails row is written with source='bicom_import' so the
 * outbox/notification triggers (guarded via SQL migration) do NOT fire — no
 * push notifications to end-users about 400+ historical voicemails.
 */

import { promises as fs } from 'node:fs'
import { createReadStream, existsSync } from 'node:fs'
import * as path from 'node:path'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { sb, r2, R2_BUCKET_VMS, log } from './shared'
import { ResolverContext } from './destination-resolver'

export interface EmitVoicemailsParams {
  tenant_code: string
  target_org_id: string
  ctx: ResolverContext
  media_root?: string
  dry_run: boolean
}

export interface EmitVoicemailsResult {
  count: number
  users_with_vm: number
  bytes_uploaded: number
  skipped_missing_user: number
  skipped_missing_audio: number
  errors: string[]
}

const DEFAULT_MEDIA_ROOT = path.join(
  process.env.HOME ?? '/Users/davidsmith',
  'bicom-backfill/mt001-valuecomms/2026-09-14',
)

function folderFlags(folder: string): { is_read: boolean; is_urgent: boolean } {
  const f = folder.toLowerCase()
  if (f === 'inbox')  return { is_read: false, is_urgent: false }
  if (f === 'urgent') return { is_read: false, is_urgent: true  }
  return { is_read: true, is_urgent: false }
}

export interface BicomVMMeta {
  origmailbox?: string
  context?: string
  macrocontext?: string
  exten?: string
  rdnis?: string
  priority?: string
  callerchan?: string
  callerid?: string
  origdate?: string
  origtime?: string
  category?: string
  msg_id?: string
  flag?: string
  duration?: string
  transcript?: string
}

function parseBicomVMTxt(text: string): BicomVMMeta {
  const out: Record<string, string> = {}
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    if (!line || line.startsWith(';') || line.startsWith('[')) continue
    const idx = line.indexOf('=')
    if (idx <= 0) continue
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  return out
}

function splitCallerId(cid: string | undefined): { number: string; name?: string } {
  if (!cid) return { number: 'unknown' }
  const m = cid.match(/^"?([^"<]+?)"?\s*<([^>]+)>$/)
  if (m) return { name: m[1].trim(), number: m[2].trim() }
  return { number: cid.trim() }
}

export async function emitVoicemails(params: EmitVoicemailsParams): Promise<EmitVoicemailsResult> {
  const { tenant_code, target_org_id, ctx, dry_run } = params
  const root = params.media_root ?? DEFAULT_MEDIA_ROOT
  const sup = sb()

  const result: EmitVoicemailsResult = {
    count: 0, users_with_vm: 0, bytes_uploaded: 0,
    skipped_missing_user: 0, skipped_missing_audio: 0, errors: [],
  }

  const tenantVMDir = path.join(root, 'voicemail', `t-${tenant_code}`)
  if (!existsSync(tenantVMDir)) {
    log('emit-voicemails', `${tenant_code}: no VM dir at ${tenantVMDir}`)
    return result
  }

  const extDirs = await fs.readdir(tenantVMDir)
  log('emit-voicemails', `${tenant_code}: scanning ${extDirs.length} ext folders`)

  for (const ext of extDirs) {
    const extPath = path.join(tenantVMDir, ext)
    const stat = await fs.stat(extPath).catch(() => null)
    if (!stat?.isDirectory()) continue

    const userId = ctx.userIdByExt.get(ext)
    if (!userId) { result.skipped_missing_user++; continue }

    let userMsgCount = 0
    let folders: string[]
    try { folders = await fs.readdir(extPath) } catch { continue }

    for (const folder of folders) {
      const folderPath = path.join(extPath, folder)
      const fstat = await fs.stat(folderPath).catch(() => null)
      if (!fstat?.isDirectory()) continue
      const flags = folderFlags(folder)

      let files: string[]
      try { files = await fs.readdir(folderPath) } catch { continue }

      const txts = files.filter(f => /^msg\d+\.txt$/i.test(f))
      for (const txtFile of txts) {
        const msgBase = txtFile.replace(/\.txt$/i, '')
        const audioName = ['wav','WAV','gsm','mp3'].map(e => `${msgBase}.${e}`).find(a => files.includes(a))
        if (!audioName) { result.skipped_missing_audio++; continue }

        try {
          const meta = parseBicomVMTxt(await fs.readFile(path.join(folderPath, txtFile), 'utf8'))
          const audioPath = path.join(folderPath, audioName)
          const audioStat = await fs.stat(audioPath)
          const audioExt  = path.extname(audioName).slice(1).toLowerCase()
          const cid       = splitCallerId(meta.callerid)
          const storageKey = `bicom/${tenant_code}/${ext}/${folder.toLowerCase()}/${audioName}`

          if (!dry_run) {
            await r2().send(new PutObjectCommand({
              Bucket: R2_BUCKET_VMS,
              Key: storageKey,
              Body: createReadStream(audioPath),
              ContentType: audioExt === 'wav' ? 'audio/wav'
                        : audioExt === 'mp3' ? 'audio/mpeg' : 'audio/gsm',
              ContentLength: audioStat.size,
            }))
          }
          result.bytes_uploaded += audioStat.size

          const receivedAt = meta.origtime
            ? new Date(parseInt(meta.origtime, 10) * 1000).toISOString()
            : new Date().toISOString()
          const durationSecs = meta.duration ? parseInt(meta.duration, 10) : null

          if (!dry_run) {
            const { error } = await sup.from('voicemails').upsert({
              org_id: target_org_id,
              recipient_user_id: userId,
              recipient_extension: ext,
              caller_number: cid.number,
              caller_name: cid.name ?? null,
              bucket: R2_BUCKET_VMS,
              storage_key: storageKey,
              format: audioExt === 'wav' ? 'wav' : audioExt,
              duration_secs: durationSecs,
              file_size_bytes: audioStat.size,
              transcription: meta.transcript ?? null,
              is_read: flags.is_read,
              is_urgent: flags.is_urgent,
              received_at: receivedAt,
              source: 'bicom_import',
            }, { onConflict: 'bucket,storage_key' })
            if (error) {
              result.errors.push(`voicemails upsert ${ext}/${audioName}: ${error.message}`)
              continue
            }
          }
          result.count++
          userMsgCount++
        } catch (e) {
          result.errors.push(`${ext}/${folder}/${txtFile}: ${(e as Error).message}`)
        }
      }
    }
    if (userMsgCount > 0) {
      result.users_with_vm++
      log('emit-voicemails', `  ok ext ${ext.padEnd(6)} ${userMsgCount} messages`)
    }
  }

  log('emit-voicemails', `${tenant_code}: ${result.count} messages, ${result.users_with_vm} users, ${(result.bytes_uploaded / 1024 / 1024).toFixed(1)} MB`)
  return result
}
