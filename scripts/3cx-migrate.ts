/**
 * One-shot runner for the Vivalda Group 3CX migration.
 *
 *   npx tsx scripts/3cx-migrate.ts --dry
 *   npx tsx scripts/3cx-migrate.ts
 */
import 'dotenv/config'
import fs from 'fs'
import { migrateThreeCxBackup, ThreeCxPayload } from '../src/services/threecx-mapper'

const PAYLOAD = 'data/3cx/vivalda-payload.json'
const TARGET_ORG = 'cecbd6e9-cde2-4453-879d-76fea0e63550' // Vivalda Group (parent: Envision)

// Left behind by request: 000 is Gradwell's own provisioning DN, 100-105 are
// Envision staff + Vivalda IT placeholders sitting inside the customer tenant.
const EXCLUDE = ['000', '100', '101', '102', '103', '104', '105']

async function main() {
  const dry = process.argv.includes('--dry')
  const payload: ThreeCxPayload = JSON.parse(fs.readFileSync(PAYLOAD, 'utf8'))

  const willMigrate = payload.extensions
    .filter(e => /^[0-9]+$/.test(e.extension) && !EXCLUDE.includes(e.extension))
  console.log(`payload      ${PAYLOAD}`)
  console.log(`target org   ${TARGET_ORG}`)
  console.log(`excluded     ${EXCLUDE.join(', ')}`)
  console.log(`extensions   ${willMigrate.length} of ${payload.extensions.length} will migrate`)
  console.log(`mode         ${dry ? 'DRY RUN' : 'LIVE'}\n`)

  const r = await migrateThreeCxBackup({
    payload,
    target_org_id: TARGET_ORG,
    exclude_extensions: EXCLUDE,
    import_phonebook: true,
    dry_run: dry,
  })

  console.log(`\nstatus       ${r.status}`)
  console.log(`extensions   ${r.extensionsSynced}`)
  console.log(`devices      ${r.devicesSynced}`)
  console.log(`queues       ${r.queuesSynced}`)
  console.log(`IVRs         ${r.ivrsSynced}`)
  console.log(`DIDs         ${r.numbersSynced}`)
  console.log(`phonebook    ${r.phonebookSynced}`)
  console.log(`invites      ${r.pendingInvites.length} queued (not sent)`)
  console.log(`\nwarnings (${r.warnings.length}):`)
  r.warnings.forEach(w => console.log('  ! ' + w))
}

main().catch(e => { console.error(e); process.exit(1) })
