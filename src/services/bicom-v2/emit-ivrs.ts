/**
 * bicom-v2/emit-ivrs.ts
 *
 * Bicom IVRs (auto-attendants) -> SONIQ call_flows (flow_type='ivr').
 *
 * Flow-reference pattern (matches the working "IVR Broadband" shape):
 *   - ONE dtmf_menu step per IVR
 *   - Digit branches to other flows via keys.type: "flow" + keys.id: <target flow uuid>
 *     (the interpreter follows this without needing an inline step)
 *   - Digit branches to a single user get an inline ring_user + vm pair
 *     (with branches routing to the inline step ids)
 *   - Hangup and external actions inline as small steps
 *
 * Two-pass because IVRs can reference each other (VC's "Divert" -> itself).
 */

import { BicomClientV2 } from './client'
import { sb, bicomRef, log, pnum } from './shared'
import { mapBicomOtimesToSoniqSchedule } from './schedule-mapper'
import { apiDestToParsed, resolveDest, ResolverContext } from './destination-resolver'
import { PromptRef } from './emit-prompts'

export interface EmitIvrsParams {
  tenant_code: string
  target_org_id: string
  bicom_server_id: string
  client: BicomClientV2
  ctx: ResolverContext
  greetings: Map<string, PromptRef>
  dry_run: boolean
}

export interface EmitIvrsResult {
  flowIdByExt: Map<string, string>
  count: number
}

export async function emitIvrs(params: EmitIvrsParams): Promise<EmitIvrsResult> {
  const { tenant_code, target_org_id, bicom_server_id, client, ctx, greetings, dry_run } = params
  const sup = sb()

  const result: EmitIvrsResult = { flowIdByExt: new Map(), count: 0 }

  const ivrs = await client.listIVRs(bicom_server_id)
  log('emit-ivrs', `${tenant_code}: ${ivrs.length} IVRs`)

  /* ---- PASS 1: create shells so IVRs can cross-reference each other ---- */
  for (const ivr of ivrs) {
    let flowId: string
    if (!dry_run) {
      const { data, error } = await sup.from('call_flows').upsert({
        org_id: target_org_id,
        name: ivr.name,                            // natural name — no " — IVR" suffix
        description: `IVR ${ivr.name} (ext ${ivr.ext}) migrated from Bicom tenant ${tenant_code}`,
        flow_type: 'ivr',
        workflow_steps: [],
        settings: { bicom_ref: bicomRef(tenant_code, 'ivr', ivr.id) },
        is_active: ivr.status === 'enabled',
      }, { onConflict: 'org_id,name' }).select('id').single()
      if (error) throw new Error(`ivr shell upsert failed for ${ivr.name}: ${error.message}`)
      flowId = data!.id as string
    } else {
      flowId = `dry-run-flow-ivr-${ivr.ext}`
    }
    result.flowIdByExt.set(ivr.ext, flowId)
    ctx.flowIdByExt.set(ivr.ext, flowId)
  }

  /* ---- PASS 2: fill in workflow_steps ---- */
  for (const ivr of ivrs) {
    const flowId = result.flowIdByExt.get(ivr.ext)!
    const otimes = await client.getIVROtimes(bicom_server_id, ivr.id)
    const schedule = mapBicomOtimesToSoniqSchedule(otimes, { timezone: 'Europe/London' })
    const greetRef = ivr.greeting ? greetings.get(ivr.greeting) : undefined

    // The single dtmf_menu step is the entry.
    const menuStep: {
      id: string; action: string;
      params: Record<string, unknown> & { keys: Record<string, unknown> };
      branches: Record<string, string>;
    } = {
      id: 'menu',
      action: 'dtmf_menu',
      params: {
        keys: {},
        timeout: 10,
        greeting_asset_id: greetRef?.id ?? null,
        greeting_text: greetRef ? '' : `Welcome to ${ivr.name}.`,
        greeting_voice_key: greetRef ? null : 'alice',
        timeout_action: 'repeat',
        timeout_max_repeats: pnum((otimes as any)?.aaloop, 3),
      },
      branches: {},
    }

    const steps: unknown[] = [menuStep]
    const inlined = new Set<string>()

    /* --- resolve each digit --- */
    for (const [digit, km] of Object.entries(ivr.keymap)) {
      const parsed   = apiDestToParsed(km.destination, km.value)
      const resolved = resolveDest(parsed, ctx)

      switch (resolved.kind) {
        case 'ring_group':
        case 'ivr':
        case 'queue': {
          // Reference the target flow directly — no inline duplication.
          const targetFlow = resolved.soniq_flow_id
          if (!targetFlow) {
            log('emit-ivrs', `  ! IVR ${ivr.ext} digit ${digit}: target ${resolved.ext} has no flow yet`)
            break
          }
          menuStep.params.keys[digit] = {
            id: targetFlow,
            type: 'flow',
            label: `${km.destination} ${km.value}`,
          }
          // No branches entry needed — interpreter follows keys.type=flow.
          break
        }

        case 'extension': {
          const userExt = resolved.ext
          const userId  = resolved.soniq_user_id
          menuStep.params.keys[digit] = {
            id: userId ?? null,
            type: 'user',
            label: `Extension ${userExt}`,
          }
          // Inline single-user ring + vm so the branch actually rings the user.
          const ringId = `ring-user-${userExt}`
          const vmId   = `vm-user-${userExt}`
          menuStep.branches[digit] = ringId
          if (!inlined.has(ringId)) {
            steps.push({
              id: ringId,
              type: 'ring_user',
              config: {
                label: `Extension ${userExt}`,
                timeout: 30,
                ring_mode: 'simultaneous',
                extensions: [userExt],
                callerid_override: null,
              },
            })
            inlined.add(ringId)
          }
          if (!inlined.has(vmId)) {
            steps.push({
              id: vmId,
              type: 'voicemail',
              config: {
                greeting: 'default',
                overflow_ext: null,
                transcription: true,
              },
            })
            inlined.add(vmId)
          }
          break
        }

        case 'voicemail_user':
        case 'voicemail_group': {
          const vmId = `vm-branch-${digit}`
          menuStep.params.keys[digit] = {
            id: null,
            type: 'voicemail',
            label: `Voicemail ${resolved.ext}`,
          }
          menuStep.branches[digit] = vmId
          if (!inlined.has(vmId)) {
            steps.push({
              id: vmId,
              type: 'voicemail',
              config: {
                greeting: 'default',
                overflow_ext: resolved.ext,
                transcription: true,
              },
            })
            inlined.add(vmId)
          }
          break
        }

        case 'hangup': {
          menuStep.params.keys[digit] = { type: 'hangup', label: 'Hang up' }
          menuStep.branches[digit] = 'hangup'
          if (!inlined.has('hangup')) {
            steps.push({ id: 'hangup', type: 'hangup', config: {} })
            inlined.add('hangup')
          }
          break
        }

        case 'external': {
          menuStep.params.keys[digit] = {
            type: 'external',
            number: resolved.number,
            label: `External ${resolved.number}`,
          }
          const dialId = `dial-${digit}`
          menuStep.branches[digit] = dialId
          if (!inlined.has(dialId)) {
            steps.push({
              id: dialId,
              type: 'dial_external',
              config: { number: resolved.number, timeout: 30 },
            })
            inlined.add(dialId)
          }
          break
        }

        default:
          log('emit-ivrs', `  ! IVR ${ivr.ext} digit ${digit}: unknown destination ${JSON.stringify(km)}`)
      }
    }

    /* --- operator (0) + no-input timeout ---
     * Bicom's operator ext catches the timeout / no-input.
     */
    if (ivr.operator) {
      const opUserId = ctx.userIdByExt.get(ivr.operator)
      if (opUserId) {
        const p = menuStep.params as Record<string, unknown>
        p.timeout_box_id   = opUserId
        p.timeout_box_type = 'user'
      }
    }

    if (!dry_run) {
      const { error } = await sup.from('call_flows').update({
        workflow_steps: steps,
        settings: {
          schedule,
          alpha_tag: ivr.name,
          bicom_ref: bicomRef(tenant_code, 'ivr', ivr.id),
        },
      }).eq('id', flowId)
      if (error) throw new Error(`ivr fill-in failed for ${ivr.name}: ${error.message}`)
    }

    result.count++
    log('emit-ivrs', `  ok IVR ${ivr.ext.padEnd(6)} ${ivr.name.padEnd(15)} keys=${Object.keys(menuStep.params.keys).length} steps=${steps.length}`)
  }

  return result
}
