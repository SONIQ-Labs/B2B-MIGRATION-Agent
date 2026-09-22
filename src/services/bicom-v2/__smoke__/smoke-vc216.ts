/**
 * bicom-v2/__smoke__/smoke-vc216.ts
 * Live smoke test against VC 216 — no writes to SONIQ.
 */

import { BicomClientV2 } from '../client'
import { apiDestToParsed, resolveDest, initResolverContext } from '../destination-resolver'
import { mapBicomOtimesToSoniqSchedule } from '../schedule-mapper'

const SERVER_URL = 'https://mt001.valuecomms.co.uk'
const API_KEY    = 'EQH4hSV8NH8U3pvB0wqOIufVFYB3s3hN'
const VC_SERVER  = '578'

async function main() {
  const c = new BicomClientV2(SERVER_URL, API_KEY)

  console.log('\n=== 1. tenant list ===')
  const tenants = await c.listTenants()
  console.log(`  ${tenants.length} tenants`)
  const vc = tenants.find(t => t.server_id === VC_SERVER)
  console.log(`  VC: ${vc?.name} (server_id=${vc?.server_id}, code=${vc?.tenantcode})`)

  console.log('\n=== 2. extensions ===')
  const exts = await c.listExtensions(VC_SERVER)
  console.log(`  ${exts.length} extensions`)
  for (const e of exts) console.log(`    ${e.ext.padEnd(6)} ${(e.name ?? '').padEnd(20)} ${e.ua_fullname ?? ''}`)

  console.log('\n=== 3. full config for first ext ===')
  if (exts.length) {
    const full = await c.getExtension(VC_SERVER, exts[0].id)
    if ('error' in full) {
      console.log(`    error: ${full.error}`)
    } else {
      console.log(`    ext ${full.ext} SIP username=${full.options.username} timezone=${full.options.ext_timezone}`)
      console.log(`    callerid: ${full.options.callerid}  ringtime=${full.options.ringtime}`)
      console.log(`    codecs: ${JSON.stringify(full.options.allow)}`)
    }
  }

  console.log('\n=== 4. IVRs ===')
  const ivrs = await c.listIVRs(VC_SERVER)
  for (const i of ivrs) {
    console.log(`  IVR ${i.ext.padEnd(6)} ${(i.name ?? '').padEnd(15)} greeting=${i.greeting}`)
    for (const [digit, km] of Object.entries(i.keymap)) {
      const parsed = apiDestToParsed(km.destination, km.value)
      console.log(`      ${digit} -> ${km.destination} ${km.value}   (parsed: type=${parsed.type} target=${parsed.target})`)
    }
  }

  console.log('\n=== 5. Ring Groups ===')
  const rgs = await c.listRingGroups(VC_SERVER)
  console.log(`  ${rgs.length} ring groups`)
  for (const rg of rgs.slice(0, 5)) {
    const full = await c.getRingGroup(VC_SERVER, rg.id)
    if ('error' in full) continue
    console.log(`  RG ${rg.ext.padEnd(6)} ${(rg.name ?? '').padEnd(20)} members=[${rg.destinations}] strategy=${full.options.ring_strategy} timeout=${full.options.timeout}s`)
  }

  console.log('\n=== 6. Queues (ERGs) ===')
  const ergs = await c.listQueues(VC_SERVER)
  console.log(`  ${ergs.length} queues`)

  console.log('\n=== 7. DIDs ===')
  const dids = await c.listDIDs(VC_SERVER)
  console.log(`  ${dids.length} DDIs`)
  for (const d of dids.slice(0, 6)) {
    console.log(`  ${d.number.padEnd(14)} -> ${d.type.padEnd(12)} ${d.ext}  ${d.name ? '('+d.name+')' : ''}`)
  }

  console.log('\n=== 8. otimes for IVR "Main" ===')
  const mainIvr = ivrs.find(i => i.name === 'Main')
  if (mainIvr) {
    const otimes = await c.getIVROtimes(VC_SERVER, mainIvr.id)
    console.log(`  status=${otimes?.status} default_dest=${otimes?.default_dest_ext} default_is_vm=${otimes?.default_dest_is_vm}`)
    console.log(`  ${otimes?.closed_dates?.length ?? 0} closed dates, ${otimes?.open_days?.length ?? 0} open_days`)
    const schedule = mapBicomOtimesToSoniqSchedule(otimes)
    console.log(`  SONIQ schedule: enabled=${schedule.enabled} tz=${schedule.timezone} days=${JSON.stringify(schedule.days)} holidays=${schedule.holidays.length}`)
    console.log(`    closed_route: ${JSON.stringify(schedule.closed_route)}`)
    console.log(`    first 2 holidays: ${JSON.stringify(schedule.holidays.slice(0, 2))}`)
  }

  console.log('\n=== 9. resolver test on IVR digit branches ===')
  const ctx = initResolverContext(ivrs)
  for (const rg of rgs) ctx.ringGroupIdByExt.set(rg.ext, `rg-uuid-${rg.ext}`)
  for (const ivr of ivrs) ctx.flowIdByExt.set(ivr.ext, `flow-uuid-${ivr.ext}`)
  for (const ext of exts) ctx.userIdByExt.set(ext.ext, `user-uuid-${ext.ext}`)
  for (const i of ivrs) {
    console.log(`  IVR ${i.ext} (${i.name}) digit branches:`)
    for (const [digit, km] of Object.entries(i.keymap)) {
      const parsed = apiDestToParsed(km.destination, km.value)
      const resolved = resolveDest(parsed, ctx)
      console.log(`    ${digit} -> ${JSON.stringify(resolved)}`)
    }
  }

  console.log('\n=== all endpoints returned successfully — mapper unblocked ===')
}

main().catch(e => {
  console.error('SMOKE TEST FAILED:', e.message)
  process.exit(1)
})
