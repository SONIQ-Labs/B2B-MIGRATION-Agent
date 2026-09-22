/**
 * bicom-v2/emit-ring-groups.ts
 *
 * Bicom ring groups -> SONIQ call_flows (flow_type='hunt_group').
 *
 * NO ring_groups resource rows are created — the group's behaviour (members,
 * ring strategy, timeout, caller-id override) lives directly on the flow's
 * ring step. Any pre-existing rows in the ring_groups table remain (kept for
 * backward compat with older UI code), but the mapper stops producing them.
 *
 * New step type `ring_multiple` — users chosen INLINE (extensions array) OR by
 * reference (group_id -> ring_groups row). Interpreter prefers whichever is
 * populated. Bicom migration always fills `extensions` inline; the empty
 * `group_id: null` field is left as a hook so Jonny (or a later UI step) can
 * convert an inline group to a shared resource without changing the schema.
 *
 *   [
 *     {
 *       "id": "ring",
 *       "type": "ring_multiple",                          // NEW: multi-ring with strategy
 *       "config": {
 *         "label": "Agincourt",                           // optional human name
 *         "timeout": 30,
 *         "ring_strategy": "simultaneous",                // simultaneous | linear | random | round_robin
 *         "extensions": ["2001", "2003"],                 // inline mode  ─┐
 *         "group_id": null,                               // OR resource  ─┴─ interpreter accepts either
 *         "callerid_override": "Agincourt %CALLERID%"
 *       }
 *     },
 *     { "id": "vm",
 *       "type": "voicemail",
 *       "config": { "greeting": "default", "overflow_ext": "6001", "transcription": true }
 *     }
 *   ]
 *
 * Distinct from `type: "ring_user"` (single-person picker in the UI, used for
 * personal direct-line DIDs) and from the legacy `type: "ring_group"` (which
 * required a pre-existing ring_groups resource selection).
 */

import { BicomClientV2, BicomRingGroupSummary, BicomRingGroupFull } from './client'
import { sb, bicomRef, log, pnum, mapRingStrategy } from './shared'
import { mapBicomOtimesToSoniqSchedule } from './schedule-mapper'
import { ResolverContext } from './destination-resolver'
import { PromptRef } from './emit-prompts'

export interface EmitRingGroupsParams {
  tenant_code: string
  target_org_id: string
  bicom_server_id: string
  client: BicomClientV2
  ctx: ResolverContext                            // must have userIdByExt populated
  greetings: Map<string, PromptRef>
  dry_run: boolean
}

export interface EmitRingGroupsResult {
  /** Map of Bicom RG ext -> SONIQ hunt_group call_flow id (used by IVR / DID emitters). */
  flowIdByExt: Map<string, string>
  /** Kept for backward compat with resolver context — same ids as flowIdByExt, since
   *  ring groups no longer have a separate resource. */
  ringGroupIdByExt: Map<string, string>
  count: number
}

export async function emitRingGroups(params: EmitRingGroupsParams): Promise<EmitRingGroupsResult> {
  const { tenant_code, target_org_id, bicom_server_id, client, ctx, greetings, dry_run } = params
  const sup = sb()

  const result: EmitRingGroupsResult = {
    flowIdByExt: new Map(),
    ringGroupIdByExt: new Map(),
    count: 0,
  }

  const rgs = await client.listRingGroups(bicom_server_id)
  log('emit-ring-groups', `${tenant_code}: ${rgs.length} ring groups`)

  // ── PASS 1 — create shell flows and populate ctx.ringGroupIdByExt ────────
  // A single-pass build meant that when RG 3001's steps were resolved, the
  // mapper hadn't seen RG 3005 yet, so `ctx.ringGroupIdByExt.has('3005')`
  // returned false and the overflow chain silently collapsed into a
  // voicemail step. Two-pass fixes this: every RG's uuid is in the context
  // before any RG's workflow_steps are computed, so cross-refs resolve
  // regardless of Bicom's iteration order.
  const rgConfigs = new Map<string, any>()   // rg.ext -> full config
  for (const rg of rgs) {
    const full = await client.getRingGroup(bicom_server_id, rg.id)
    if ('error' in full) {
      log('emit-ring-groups', `  skip RG ${rg.ext}: ${full.error}`)
      continue
    }
    rgConfigs.set(rg.ext, { rg, full })

    let flowId: string
    if (!dry_run) {
      // Shell: empty workflow_steps, we'll fill in pass 2. Use upsert so a
      // re-run doesn't create a second row — the natural key is (org_id,name).
      const { data, error } = await sup.from('call_flows').upsert({
        org_id: target_org_id,
        name: rg.name,
        description: `Hunt group ${rg.name} (ext ${rg.ext}) migrated from Bicom tenant ${tenant_code}`,
        flow_type: 'hunt_group',
        workflow_steps: [],
        settings: {
          alpha_tag: rg.name,
          bicom_ref: bicomRef(tenant_code, 'rg', rg.id),
          bicom_ext: rg.ext,
        },
        is_active: true,
      }, { onConflict: 'org_id,name' }).select('id').single()
      if (error) throw new Error(`call_flows shell upsert failed for RG ${rg.name}: ${error.message}`)
      flowId = data!.id as string
    } else {
      flowId = `dry-run-flow-rg-${rg.ext}`
    }
    result.flowIdByExt.set(rg.ext, flowId)
    result.ringGroupIdByExt.set(rg.ext, flowId)
    ctx.flowIdByExt.set(rg.ext, flowId)
    ctx.ringGroupIdByExt.set(rg.ext, flowId)
  }

  // ── PASS 2 — build workflow_steps with a fully-populated ctx ─────────────
  for (const [ext, { rg, full }] of rgConfigs) {

    // Members — take the extension numbers directly (interpreter uses these).
    const memberExts = rg.destinations
      .split(',')
      .map((s: string) => s.trim())
      .filter(Boolean)

    const opts = full.options
    const timeout = pnum(opts.timeout, 30)
    const ringMode = mapRingStrategy(opts.ring_strategy)
    const callerIdOverride = opts.callerid && opts.callerid.trim()
      ? opts.callerid.trim()
      : null

    // ---- Build the ring step ----
    // NEW step type `ring_multiple` — inline extensions + optional group_id
    // reference. Bicom migration always uses inline. group_id stays null and
    // acts as a hook for later "convert to shared resource" UI moves.
    const ringStep = {
      id: 'ring',
      type: 'ring_multiple',
      config: {
        label: rg.name,
        timeout,
        ring_strategy: ringMode,
        extensions: memberExts,
        group_id: null as string | null,
        callerid_override: callerIdOverride,
      },
    }

    // ---- Optional pre-ring greeting ----
    // Bicom ring groups can specify an intro sound (`options.greeting`,
    // sometimes `options.announcement` / `options.intro_sound` on older
    // configs). When set, callers hear it BEFORE the ring step. Missing this
    // was the bug on Ranger Lodge "Main" — SONIQ was skipping the
    // "greeting-newopen" file that played on Bicom.
    // Resolution rules:
    //   - Bicom stores the reference without an extension ("greeting-newopen")
    //   - `greetings` is keyed on the sans-extension basename by emit-prompts
    //   - Missing prompt is logged, NOT fatal — the ring still fires
    const introName = (opts.greeting ?? (opts as any).announcement
                       ?? (opts as any).intro_sound ?? '').trim()
    const steps: unknown[] = []
    if (introName) {
      const promptRef = greetings.get(introName)
      if (promptRef) {
        steps.push({
          id: 'intro',
          type: 'play_audio',
          config: {
            label: `Intro: ${introName}`,
            audio_asset_id: promptRef.id,
          },
        })
      } else {
        log('emit-ring-groups', `  ! RG ${rg.ext} references greeting "${introName}" but no matching prompt uploaded — flow will skip intro`)
      }
    }
    steps.push(ringStep)
    const lastDest = opts.last_dest && String(opts.last_dest).trim()
    const lastDestIsVm = String(opts.last_dest_vm ?? '').toLowerCase()
    const lastDestVmYes = lastDestIsVm === 'yes' || lastDestIsVm === '1' || lastDestIsVm === 'true'

    let overflowUserRingId: string | undefined
    let overflowFlowId: string | undefined
    let overflowResolved = false                        // true = a terminal step was pushed
    if (lastDest) {
      if (ctx.userIdByExt.has(lastDest)) {
        overflowUserRingId = `ring-overflow-${lastDest}`
        steps.push({
          id: overflowUserRingId,
          type: 'ring_user',
          config: {
            label: `Overflow to ext ${lastDest}`,
            timeout: 30,
            ring_mode: 'simultaneous',
            extensions: [lastDest],
            callerid_override: null,
          },
        })
        overflowResolved = true
      } else if (ctx.ringGroupIdByExt.has(lastDest)) {
        overflowFlowId = ctx.ringGroupIdByExt.get(lastDest)
        steps.push({
          id: `goto-${lastDest}`,
          type: 'goto_flow',
          config: {
            label: `Overflow to group ${lastDest}`,
            flow_id: overflowFlowId,
          },
        })
        overflowResolved = true                         // goto_flow doesn't return
      }
      // else: last_dest looks like a system VM box (Bicom's 6xxx range) or an
      // ext we haven't seen — fall through to the voicemail step below.
    }

    // Voicemail is the final safety net — only push if we haven't already
    // pushed a terminal step (goto_flow). last_dest_vm=yes on Bicom means
    // the destination was a VM box, so record `overflow_ext` for it.
    if (!overflowResolved) {
      steps.push({
        id: 'vm',
        type: 'voicemail',
        config: {
          greeting: 'default',
          overflow_ext: lastDest || null,
          is_group_vm: lastDestVmYes,                  // Bicom's group VM boxes (6xxx)
          transcription: true,
        },
      })
    }

    // ---- Opening times (schedule) come along on settings ----
    const otimes = await client.getRingGroupOtimes(bicom_server_id, rg.id)
    const schedule = mapBicomOtimesToSoniqSchedule(otimes, { timezone: 'Europe/London' })

    // ---- Update the pass-1 shell with the real steps + schedule ----
    const flowId = result.flowIdByExt.get(rg.ext)!
    if (!dry_run) {
      const { error } = await sup.from('call_flows').update({
        workflow_steps: steps,
        settings: {
          schedule,
          alpha_tag: rg.name,                           // pre-defined tag — flows across the org
                                                        // aggregate into a dropdown for CLI display
          bicom_ref: bicomRef(tenant_code, 'rg', rg.id),
          bicom_ext: rg.ext,
        },
      }).eq('id', flowId)
      if (error) throw new Error(`call_flows update failed for RG ${rg.name}: ${error.message}`)
    }

    result.count++
    log('emit-ring-groups', `  ok RG ${rg.ext.padEnd(6)} ${rg.name.padEnd(20)} members=${memberExts.length} mode=${ringMode} timeout=${timeout}s last_dest=${lastDest || '(none)'}`)
  }

  return result
}
