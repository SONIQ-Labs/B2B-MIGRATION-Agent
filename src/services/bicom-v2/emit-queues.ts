/**
 * bicom-v2/emit-queues.ts
 *
 * Migrates Bicom Enhanced Ring Groups (queues) -> SONIQ call_queues +
 * queue_members + queue call_flows.
 *
 * VC 216 has no queues (returns []), but many other tenants do. Same two-step
 * pattern as ring groups: create the queue definition + a wrapper flow.
 */

import { BicomClientV2 } from './client'
import { sb, bicomRef, log, pnum, mapRingStrategy, stepId } from './shared'
import { mapBicomOtimesToSoniqSchedule } from './schedule-mapper'
import { ResolverContext } from './destination-resolver'
import { PromptRef } from './emit-prompts'

/**
 * Bicom queue strategies -> SONIQ call_queues.strategy allowed values.
 * SONIQ's check constraint accepts:
 *   round_robin | longest_idle | least_calls | random | fewest_calls | ring_all
 * Bicom sends Asterisk queue terms (ringall, rrmemory, leastrecent, ...).
 */
function mapQueueStrategy(bicom: string | undefined): string {
  const s = (bicom ?? '').toLowerCase()
  const m: Record<string, string> = {
    all:           'ring_all',
    ringall:       'ring_all',
    random:        'random',
    roundrobin:    'round_robin',
    rrmemory:      'round_robin',
    rrordered:     'round_robin',
    linear:        'round_robin',    // no direct SONIQ equivalent; ordered = round-robin closest
    leastrecent:   'longest_idle',
    fewestcalls:   'fewest_calls',
    wrandom:       'random',
  }
  return m[s] ?? 'ring_all'
}

export interface EmitQueuesParams {
  tenant_code: string
  target_org_id: string
  bicom_server_id: string
  client: BicomClientV2
  ctx: ResolverContext
  greetings: Map<string, PromptRef>
  moh: Map<string, PromptRef>
  dry_run: boolean
}

export interface EmitQueuesResult {
  queueIdByExt: Map<string, string>
  flowIdByExt:  Map<string, string>
  count: number
}

export async function emitQueues(params: EmitQueuesParams): Promise<EmitQueuesResult> {
  const { tenant_code, target_org_id, bicom_server_id, client, ctx, greetings, moh, dry_run } = params
  const sup = sb()

  const result: EmitQueuesResult = {
    queueIdByExt: new Map(),
    flowIdByExt:  new Map(),
    count: 0,
  }

  const queues = await client.listQueues(bicom_server_id)
  log('emit-queues', `${tenant_code}: ${queues.length} queues`)

  for (const q of queues) {
    // 1. Fetch members
    const members = await client.getQueueMembers(bicom_server_id, q.id)
    const memberRefs = members
      .map(m => ({
        org_user_id: ctx.userIdByExt.get(m.ext),
        extension: m.ext,
        penalty: pnum(m.penalty, 0),
      }))
      .filter(x => !!x.org_user_id)

    // 2. Opening times
    const otimes = await client.getQueueOtimes(bicom_server_id, q.id)
    const schedule = mapBicomOtimesToSoniqSchedule(otimes, { timezone: 'Europe/London' })

    // 3. MOH asset for hold music
    // call_queues.moh_asset_id FK targets `audio_assets`, NOT `phone_prompts`
    // where our migration uploads land. Two disjoint tables — the SONIQ MOH
    // catalogue is separate from the per-org prompt library. Null the queue's
    // MOH ref so it inherits from the org (moh_mode='inherit'); a follow-up
    // pass can copy the Bicom MOH file into audio_assets if we want queues
    // to override org MOH per queue. Not migration-critical for cutover.
    const mohRef: { id: string } | null = null

    // Ensure the queue extension is a string — Bicom's queue records the
    // extension as `number` (aliased to `ext` in the client wrapper). If
    // both are missing, fall back to the queue id so we don't crash on
    // padEnd/Map.set — a queue without an ext is a degenerate case but
    // shouldn't kill the whole tenant.
    const qExt = q.ext ?? q.id

    // 4. Insert call_queues row
    // Queue strategies live in a different domain than ring-group strategies:
    // call_queues.strategy CHECK constraint accepts only
    //   round_robin | longest_idle | least_calls | random | fewest_calls | ring_all
    // (no 'simultaneous' / 'linear'). Map Bicom's Asterisk-side terms into
    // that space; default to ring_all as the "everyone gets a shot" fallback.
    const strategy = mapQueueStrategy((q as any).strategy)
    let queueId: string
    if (!dry_run) {
      const { data, error } = await sup.from('call_queues').upsert({
        org_id: target_org_id,
        name: q.name,
        description: `Migrated from Bicom queue ${qExt}, tenant ${tenant_code}`,
        strategy,
        ring_timeout:  pnum((q as any).timeout, 30),
        wrap_up_time:  pnum((q as any).wrapuptime, 0),
        max_wait_seconds: pnum((q as any).maxlen, 3600),
        moh_asset_id: null,
        moh_mode: 'inherit' as const,
        announce_position: false,
        announce_wait_time: false,
        service_level_seconds: 30,
        is_active: true,
      }, { onConflict: 'org_id,name' }).select('id').single()
      if (error) throw new Error(`call_queues upsert failed for ${q.name}: ${error.message}`)
      queueId = data!.id as string
    } else {
      queueId = `dry-run-queue-${qExt}`
    }
    result.queueIdByExt.set(qExt, queueId)
    ctx.queueIdByExt.set(qExt, queueId)

    // 5. queue_members
    if (!dry_run && memberRefs.length) {
      for (const m of memberRefs) {
        const { error } = await sup.from('queue_members').upsert({
          org_id: target_org_id,
          queue_id: queueId,
          org_user_id: m.org_user_id,
          priority: 0,
          penalty: m.penalty,
          status: 'available',
          is_active: true,
        }, { onConflict: 'queue_id,org_user_id' })
        if (error) throw new Error(`queue_members upsert failed: ${error.message}`)
      }
    }

    // 6. Wrapper flow
    const steps: unknown[] = []
    const greetingName = (q as any).greeting
    if (greetingName) {
      const greetRef = greetings.get(greetingName)
      steps.push({
        id: stepId('greet'),
        action: 'tts_greeting',
        params: greetRef
          ? { greeting_asset_id: greetRef.id, message: '', voice_key: 'alice' }
          : { message: `Please hold for ${q.name}.`, voice_key: 'alice' },
        branches: {},
      })
    }
    steps.push({
      id: stepId('queue'),
      action: 'queue',
      params: { queue_id: queueId },
      branches: { no_answer: 'vm_fallback', timeout: 'vm_fallback' },
    })
    steps.push({
      id: 'vm_fallback',
      action: 'voicemail',
      params: { box_id: queueId, box_type: 'group' },
      branches: {},
    })

    let flowId: string
    if (!dry_run) {
      const { data, error } = await sup.from('call_flows').upsert({
        org_id: target_org_id,
        name: `${q.name} — Queue`,
        description: `Queue flow for ${q.name} (ext ${qExt}), migrated from Bicom tenant ${tenant_code}`,
        flow_type: 'queue',
        workflow_steps: steps,
        settings: { schedule, bicom_ref: bicomRef(tenant_code, 'queue', q.id) },
        moh_asset_id: null,
        moh_mode: 'inherit' as const,
        is_active: true,
      }, { onConflict: 'org_id,name' }).select('id').single()
      if (error) throw new Error(`call_flows upsert failed for queue ${q.name}: ${error.message}`)
      flowId = data!.id as string
    } else {
      flowId = `dry-run-flow-queue-${qExt}`
    }
    result.flowIdByExt.set(qExt, flowId)
    ctx.flowIdByExt.set(qExt, flowId)

    result.count++
    log('emit-queues', `  ok Queue ${qExt.padEnd(6)} ${q.name.padEnd(20)} members=${memberRefs.length} strat=${strategy}`)
  }

  return result
}
