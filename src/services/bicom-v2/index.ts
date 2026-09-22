/**
 * bicom-v2/index.ts
 *
 * The orchestrator. Given a Bicom tenant code + SONIQ org id, runs the full
 * migration pipeline in the correct dependency order:
 *
 *   1. Media (greetings, MOH, VM greetings)   → R2 + phone_prompts
 *   2. Extensions                             → org_users + sip_credentials
 *   3. Ring groups                            → ring_groups + hunt_group flows
 *   4. Queues                                 → call_queues + queue_members + queue flows
 *   5. IVRs (two-pass)                        → ivr flows w/ resolved dtmf_menu
 *   6. DIDs                                   → phone_numbers + simple_ring/vm flows
 *   7. Snapshot                               → bicom_migration_snapshots
 *
 * Idempotent — safe to re-run. Uses natural keys (`bicom_{tenant}_{kind}_{id}`)
 * in each entity's `metadata`, upserts on unique constraints.
 */

import { BicomClientV2 } from './client'
import { initResolverContext } from './destination-resolver'
import { emitPrompts, EmitPromptsResult } from './emit-prompts'
import { emitExtensions } from './emit-extensions'
import { emitRingGroups } from './emit-ring-groups'
import { emitQueues } from './emit-queues'
import { emitIvrs } from './emit-ivrs'
import { emitDids } from './emit-dids'
import { emitVoicemails } from './emit-voicemails'
import { sb, log } from './shared'

export interface MigrateBicomTenantV2Params {
  tenant_code: string                // Bicom tenant code, e.g. "216"
  target_org_id: string              // SONIQ org uuid
  server_url: string                 // "https://mt001.valuecomms.co.uk"
  api_key: string
  bicom_server_id: string            // numeric, e.g. "578"
  inbound_trunk_id?: string          // SONIQ trunk id to attribute DIDs to
  media_root?: string                // override for staged Bicom media path
  dry_run: boolean
}

export interface MigrateBicomTenantV2Result {
  tenant_code: string
  target_org_id: string
  started_at: string
  finished_at: string
  dry_run: boolean
  counts: {
    extensions: number
    ring_groups: number
    queues: number
    ivrs: number
    dids: number
    greetings: number
    moh: number
    vm_greetings: number
    voicemail_messages: number
    users_with_voicemail: number
    synthesized_flows: number
  }
  dids_by_type: Record<string, number>
  bytes_uploaded: number
  errors: string[]
}

export async function migrateBicomTenantV2(
  params: MigrateBicomTenantV2Params,
): Promise<MigrateBicomTenantV2Result> {
  const { tenant_code, target_org_id, server_url, api_key, bicom_server_id, dry_run } = params
  const started_at = new Date().toISOString()
  const errors: string[] = []

  log('migrate', `starting v2 migration for tenant ${tenant_code} → org ${target_org_id} (dry_run=${dry_run})`)

  const client = new BicomClientV2(server_url, api_key)

  // ---- Snapshot: record start ----
  let snapshotId: string | undefined
  if (!dry_run) {
    const { data } = await sb().from('bicom_migration_snapshots').insert({
      tenant_code, target_org_id,
      migration_version: 'v2',
      dry_run,
      status: 'in_progress',
      started_at,
    }).select('id').single()
    snapshotId = data?.id as string | undefined
  }

  // ---- 1. Prompts (greetings, MOH, VM greetings) ----
  let prompts: EmitPromptsResult
  try {
    prompts = await emitPrompts({
      tenant_code, target_org_id, media_root: params.media_root, dry_run,
    })
  } catch (e) {
    errors.push(`emit-prompts: ${(e as Error).message}`)
    prompts = {
      greetings: new Map(), moh: new Map(), vm_greetings: new Map(),
      uploaded_bytes: 0, skipped_missing: [],
    }
  }

  // ---- 2. Extensions ----
  const extResult = await emitExtensions({
    tenant_code, target_org_id, bicom_server_id, client,
    vm_greetings: prompts.vm_greetings,
    dry_run,
  })

  // ---- Seed resolver context ----
  const ivrs = await client.listIVRs(bicom_server_id)
  const ctx = initResolverContext(ivrs)
  for (const [ext, id] of extResult.userIdByExt) ctx.userIdByExt.set(ext, id)

  // ---- 3. Ring groups ----
  const rgResult = await emitRingGroups({
    tenant_code, target_org_id, bicom_server_id, client, ctx,
    greetings: prompts.greetings, dry_run,
  })

  // ---- 4. Queues ----
  const qResult = await emitQueues({
    tenant_code, target_org_id, bicom_server_id, client, ctx,
    greetings: prompts.greetings, moh: prompts.moh, dry_run,
  })

  // ---- 5. IVRs (two-pass — pass 1 creates shells that RG/Queue steps can reference) ----
  const ivrResult = await emitIvrs({
    tenant_code, target_org_id, bicom_server_id, client, ctx,
    greetings: prompts.greetings, dry_run,
  })

  // ---- 6. DIDs (needs every flow uuid to be present in ctx.flowIdByExt) ----
  const didResult = await emitDids({
    tenant_code, target_org_id, bicom_server_id, client, ctx,
    inbound_trunk_id: params.inbound_trunk_id, dry_run,
  })

  // ---- 7. Voicemail messages (source='bicom_import' so triggers do NOT fire) ----
  let vmResult
  try {
    vmResult = await emitVoicemails({
      tenant_code, target_org_id, ctx,
      media_root: params.media_root,
      dry_run,
    })
  } catch (e) {
    errors.push(`emit-voicemails: ${(e as Error).message}`)
    vmResult = { count: 0, users_with_vm: 0, bytes_uploaded: 0,
                 skipped_missing_user: 0, skipped_missing_audio: 0, errors: [] }
  }

  // ---- Snapshot: record completion ----
  const finished_at = new Date().toISOString()
  if (!dry_run && snapshotId) {
    await sb().from('bicom_migration_snapshots').update({
      status: errors.length ? 'completed_with_errors' : 'completed',
      finished_at,
      summary: {
        extensions: extResult.count,
        ring_groups: rgResult.count,
        queues: qResult.count,
        ivrs: ivrResult.count,
        dids: didResult.count,
        greetings: prompts.greetings.size,
        moh: prompts.moh.size,
        vm_greetings: prompts.vm_greetings.size,
        voicemail_messages: vmResult.count,
        users_with_voicemail: vmResult.users_with_vm,
        synthesized_flows: didResult.synthesized_flows,
        dids_by_type: didResult.by_type,
        bytes_uploaded: prompts.uploaded_bytes + vmResult.bytes_uploaded,
        errors: [...errors, ...vmResult.errors.slice(0, 20)],
      },
    }).eq('id', snapshotId)
  }

  const result: MigrateBicomTenantV2Result = {
    tenant_code, target_org_id, started_at, finished_at, dry_run,
    counts: {
      extensions: extResult.count,
      ring_groups: rgResult.count,
      queues: qResult.count,
      ivrs: ivrResult.count,
      dids: didResult.count,
      greetings: prompts.greetings.size,
      moh: prompts.moh.size,
      vm_greetings: prompts.vm_greetings.size,
      voicemail_messages: vmResult.count,
      users_with_voicemail: vmResult.users_with_vm,
      synthesized_flows: didResult.synthesized_flows,
    },
    dids_by_type: didResult.by_type,
    bytes_uploaded: prompts.uploaded_bytes + vmResult.bytes_uploaded,
    errors: [...errors, ...vmResult.errors.slice(0, 20)],
  }

  log('migrate', `\n=== v2 migration ${dry_run ? '(DRY RUN)' : ''} complete for tenant ${tenant_code} ===`)
  log('migrate', JSON.stringify(result.counts, null, 2))
  if (errors.length) log('migrate', `errors:`, errors)

  return result
}
