/**
 * bicom-v2/emit-dids.ts
 *
 * Migrates Bicom DIDs (DDIs) -> SONIQ phone_numbers with call_flow_id populated.
 *
 * DIDs whose destination is a User Extension (rather than an IVR/RG/queue) need
 * a small "simple_ring" flow to be created on the fly, since phone_numbers.
 * call_flow_id points to a flow, not directly to a user.
 */

import { BicomClientV2 } from './client'
import { sb, bicomRef, log, pnum, stepId, ukToE164 } from './shared'
import { ResolverContext } from './destination-resolver'

export interface EmitDidsParams {
  tenant_code: string
  target_org_id: string
  bicom_server_id: string
  client: BicomClientV2
  ctx: ResolverContext
  inbound_trunk_id?: string             // SONIQ trunk id to attribute DIDs to (optional)
  dry_run: boolean
}

export interface EmitDidsResult {
  count: number
  by_type: Record<string, number>
  synthesized_flows: number             // number of simple_ring flows we had to create
}

export async function emitDids(params: EmitDidsParams): Promise<EmitDidsResult> {
  const { tenant_code, target_org_id, bicom_server_id, client, ctx, inbound_trunk_id, dry_run } = params
  const sup = sb()

  const result: EmitDidsResult = { count: 0, by_type: {}, synthesized_flows: 0 }

  const dids = await client.listDIDs(bicom_server_id)
  log('emit-dids', `${tenant_code}: ${dids.length} DIDs`)

  for (const did of dids) {
    result.by_type[did.type] = (result.by_type[did.type] ?? 0) + 1

    // 1. Resolve the target flow id
    let callFlowId: string | null = null

    switch (did.type) {
      case 'IVR':
      case 'Ring Group':
      case 'Queue':
        callFlowId = ctx.flowIdByExt.get(did.ext) ?? null
        break

      case 'Extension': {
        // Create/reuse a simple_ring flow for this user
        const userId = ctx.userIdByExt.get(did.ext)
        if (userId) {
          callFlowId = await ensureUserDirectFlow({
            tenant_code, target_org_id, user_id: userId, ext: did.ext,
            display_label: did.name || `Direct to ${did.ext}`, dry_run,
          })
          result.synthesized_flows++
        }
        break
      }

      case 'Voicemail': {
        callFlowId = await ensureVoicemailFlow({
          tenant_code, target_org_id, ext: did.ext, ctx, dry_run,
        })
        result.synthesized_flows++
        break
      }

      default:
        log('emit-dids', `  ! ${did.number} type=${did.type} not migrated`)
        continue
    }

    if (!callFlowId && !dry_run) {
      log('emit-dids', `  ! ${did.number} -> ${did.type} ${did.ext}: could not resolve target flow`)
      continue
    }

    // 2. Classify UK number and DID type for the check constraints
    const e164 = ukToE164(did.number)
    const numberType     = classifyUkNumberType(e164)             // local | mobile | tollfree | national | consumer
    const dispatchType   = mapDispatchRuleType(did.type)          // ivr | ring_group | user | voicemail | external | hunt
    const routeType      = callFlowId ? 'flow' : 'external_trunk' // valid enum values

    if (!dry_run) {
      const { error } = await sup.from('phone_numbers').upsert({
        org_id: target_org_id,
        number: e164,
        country_code: 'GB',
        number_type: numberType,
        dispatch_rule_type: dispatchType,
        label: did.name || null,
        call_flow_id: callFlowId,
        status: did.status === 'enabled' ? 'active' : 'suspended',
        capabilities: { voice: true, sms: false, whatsapp: false },
        voice_enabled: true,
        vm_email_enabled: false,
        route_type: routeType,
        route_trunk_id: inbound_trunk_id ?? null,
        inbound_trunk_id: inbound_trunk_id ?? null,
        provider: 'bicom_migration',
        provider_number_id: did.id,
      }, { onConflict: 'org_id,number' })
      if (error) {
        // The `number` alone is globally unique too — a duplicate here means
        // this DID is registered against ANOTHER org (usually the platform master
        // for test / relay numbers). Skip cleanly rather than blowing up the tenant.
        if (/duplicate key.*phone_numbers_number_key/.test(error.message)) {
          log('emit-dids', `  ! ${e164} skipped: owned by another org (not this tenant's DID)`)
          continue
        }
        throw new Error(`phone_numbers upsert failed for ${did.number}: ${error.message}`)
      }
    }

    result.count++
    log('emit-dids', `  ok ${e164.padEnd(15)} -> ${did.type.padEnd(12)} ${did.ext} ${did.name ? `(${did.name})` : ''}`)
  }

  return result
}

/* ============================================================================
 * UK number classification for phone_numbers.number_type CHECK constraint.
 * Valid values: 'local' | 'mobile' | 'tollfree' | 'national' | 'consumer'
 * ============================================================================ */

function classifyUkNumberType(e164: string): 'local' | 'mobile' | 'tollfree' | 'national' | 'consumer' {
  const n = e164.replace(/^\+/, '')
  if (!n.startsWith('44')) return 'national'
  const body = n.slice(2)
  if (body.startsWith('7'))                                return 'mobile'
  if (body.startsWith('800') || body.startsWith('808') ||
      body.startsWith('500') || body.startsWith('0800'))    return 'tollfree'
  if (body.startsWith('1') || body.startsWith('2'))         return 'local'      // geographic
  return 'national'
}

/**
 * Bicom DID type -> SONIQ dispatch_rule_type.
 * Valid: 'ivr' | 'ring_group' | 'user' | 'voicemail' | 'external' | 'hunt'
 */
function mapDispatchRuleType(bicom: string): 'ivr' | 'ring_group' | 'user' | 'voicemail' | 'external' | 'hunt' {
  switch (bicom) {
    case 'IVR':                    return 'ivr'
    case 'Ring Group':             return 'ring_group'
    case 'Extension':              return 'user'
    case 'Voicemail':              return 'voicemail'
    case 'Queue':                  return 'hunt'
    case 'Call External Number':
    case 'External Number':        return 'external'
    default:                       return 'ivr'                    // safest default
  }
}

/* ============================================================================
 * Synthesized "simple_ring" flow for DIDs that route directly to a user
 * ============================================================================ */

async function ensureUserDirectFlow(params: {
  tenant_code: string
  target_org_id: string
  user_id: string
  ext: string
  display_label: string
  dry_run: boolean
}): Promise<string> {
  const { tenant_code, target_org_id, user_id, ext, display_label, dry_run } = params
  const sup = sb()

  const name = `Direct — ${display_label} (ext ${ext})`

  // Same working shape as the hunt_group ring step, just with a single-extension list.
  const steps = [
    {
      id: 'ring',
      type: 'ring_user',
      config: {
        label: display_label,
        timeout: 30,
        ring_mode: 'simultaneous',
        extensions: [ext],
        callerid_override: null,
      },
    },
    {
      id: 'vm',
      type: 'voicemail',
      config: {
        greeting: 'default',
        overflow_ext: null,
        transcription: true,
      },
    },
  ]

  if (dry_run) return `dry-run-flow-direct-${ext}`

  const { data, error } = await sup.from('call_flows').upsert({
    org_id: target_org_id,
    name,
    description: `Direct-to-user flow for ext ${ext}, migrated from Bicom tenant ${tenant_code}`,
    flow_type: 'simple_ring',
    workflow_steps: steps,
    settings: {
      alpha_tag: display_label,
      bicom_ref: bicomRef(tenant_code, 'did_direct', ext),
    },
    is_active: true,
  }, { onConflict: 'org_id,name' }).select('id').single()
  if (error) throw new Error(`user-direct flow upsert failed for ${ext}: ${error.message}`)
  return data!.id as string
}

async function ensureVoicemailFlow(params: {
  tenant_code: string
  target_org_id: string
  ext: string
  ctx: ResolverContext
  dry_run: boolean
}): Promise<string> {
  const { tenant_code, target_org_id, ext, dry_run } = params
  const sup = sb()

  const name = `Voicemail direct — ext ${ext}`
  const steps = [
    {
      id: 'vm',
      type: 'voicemail',
      config: {
        greeting: 'default',
        overflow_ext: ext,
        transcription: true,
      },
    },
  ]

  if (dry_run) return `dry-run-flow-vm-${ext}`

  const { data, error } = await sup.from('call_flows').upsert({
    org_id: target_org_id,
    name,
    description: `Voicemail direct flow for ext ${ext}, migrated from Bicom tenant ${tenant_code}`,
    flow_type: 'voicemail',
    workflow_steps: steps,
    settings: {
      alpha_tag: `Voicemail ${ext}`,
      bicom_ref: bicomRef(tenant_code, 'did_vm', ext),
    },
    is_active: true,
  }, { onConflict: 'org_id,name' }).select('id').single()
  if (error) throw new Error(`vm-direct flow upsert failed for ${ext}: ${error.message}`)
  return data!.id as string
}
