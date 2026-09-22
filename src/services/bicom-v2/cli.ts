#!/usr/bin/env tsx
/**
 * bicom-v2/cli.ts
 *
 * Usage:
 *   pnpm tsx src/services/bicom-v2/cli.ts \
 *     --tenant 216 \
 *     --org bebc33f1-851e-4f4f-aadd-127d4953f442 \
 *     --dry-run
 *
 * Required env:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   BICOM_URL (default: https://mt001.valuecomms.co.uk)
 *   BICOM_API_KEY
 *   R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY   (skip if not uploading media)
 *
 * Optional:
 *   --media-root <path>       (defaults to ~/bicom-backfill/mt001-valuecomms/2026-09-14)
 *   --inbound-trunk <uuid>    (SONIQ inbound trunk id to attribute DIDs to)
 *   --server-id <n>           (Bicom internal server id; auto-resolved from tenant code if omitted)
 */

import 'dotenv/config'
import { BicomClientV2 } from './client'
import { migrateBicomTenantV2 } from './index'

interface Args {
  tenant: string
  org: string
  dry_run: boolean
  media_root?: string
  inbound_trunk?: string
  server_id?: string
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = { dry_run: false }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    switch (a) {
      case '--tenant':         args.tenant = next(); break
      case '--org':            args.org = next(); break
      case '--dry-run':        args.dry_run = true; break
      case '--media-root':     args.media_root = next(); break
      case '--inbound-trunk':  args.inbound_trunk = next(); break
      case '--server-id':      args.server_id = next(); break
      case '--help':
      case '-h':               usage(); process.exit(0)
      default:
        console.error(`unknown arg: ${a}`); usage(); process.exit(2)
    }
  }
  if (!args.tenant || !args.org) { usage(); process.exit(2) }
  return args as Args
}

function usage(): void {
  console.error(`
Usage:
  pnpm tsx src/services/bicom-v2/cli.ts --tenant <code> --org <soniq_org_uuid> [--dry-run]

Optional:
  --media-root <path>        Local Bicom media backfill root
  --inbound-trunk <uuid>     SONIQ inbound trunk id to attribute DIDs to
  --server-id <n>            Bicom internal server id (auto-resolved from tenant code otherwise)
`)
}

async function main() {
  const args = parseArgs(process.argv)

  const server_url = process.env.BICOM_URL ?? 'https://mt001.valuecomms.co.uk'
  const api_key    = process.env.BICOM_API_KEY
  if (!api_key) throw new Error('BICOM_API_KEY env required')

  // Resolve server_id from tenant code if not provided
  let bicom_server_id = args.server_id
  if (!bicom_server_id) {
    const client = new BicomClientV2(server_url, api_key)
    const tenants = await client.listTenants()
    const t = tenants.find(x => x.tenantcode === args.tenant)
    if (!t) throw new Error(`tenant code ${args.tenant} not found on ${server_url}`)
    bicom_server_id = t.server_id
    console.log(`resolved tenant code ${args.tenant} to server_id ${bicom_server_id} (${t.name})`)
  }

  const result = await migrateBicomTenantV2({
    tenant_code: args.tenant,
    target_org_id: args.org,
    server_url, api_key,
    bicom_server_id,
    inbound_trunk_id: args.inbound_trunk,
    media_root: args.media_root,
    dry_run: args.dry_run,
  })

  console.log('\n' + JSON.stringify(result, null, 2))
  process.exit(result.errors.length ? 1 : 0)
}

main().catch(e => {
  console.error('MIGRATION FAILED:', e.message)
  console.error(e.stack)
  process.exit(1)
})
