/**
 * Insert 3CX CDR NDJSON into the SONIQ `cdr` table.
 *
 * Every row carries source='3cx_import', which the trigger guards use to keep
 * enrichment, rating, webhooks and the Ably -> post-call-intelligence ->
 * Hindsight/contact_memory chain inert. The script refuses to run if any row
 * says otherwise.
 *
 *   npx tsx scripts/3cx-cdr-import.ts data/3cx/cdr-week.ndjson [--dry]
 */
import 'dotenv/config'
import fs from 'fs'
import { createClient } from '@supabase/supabase-js'

const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

async function main() {
  const file = process.argv[2]
  const dry = process.argv.includes('--dry')
  if (!file) { console.error('usage: 3cx-cdr-import.ts <ndjson> [--dry]'); process.exit(1) }

  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l))

  // Hard safety gate — an unguarded source would fire per-row http_post to the
  // enrichment function and write a billing_cdr row per answered call.
  const bad = rows.filter(r => r.source !== '3cx_import')
  if (bad.length) {
    console.error(`REFUSING: ${bad.length} row(s) without source='3cx_import'`)
    process.exit(1)
  }

  console.log(`rows      ${rows.length}`)
  console.log(`window    ${rows[0].initiated_at} .. ${rows[rows.length - 1].initiated_at}`)
  console.log(`mode      ${dry ? 'DRY RUN' : 'LIVE'}\n`)
  if (dry) return

  let inserted = 0, dupes = 0, failed = 0
  for (let i = 0; i < rows.length; i += 200) {
    const batch = rows.slice(i, i + 200)
    const { error } = await sb.from('cdr').insert(batch)
    if (!error) { inserted += batch.length; continue }
    if ((error as any).code === '23505') {
      for (const r of batch) {
        const { error: e2 } = await sb.from('cdr').insert(r)
        if (!e2) inserted++
        else if ((e2 as any).code === '23505') dupes++
        else { failed++; if (failed < 5) console.error(`  ${r.call_id}: ${e2.message}`) }
      }
    } else {
      console.error(`batch ${i}: ${error.message}`)
      failed += batch.length
    }
    process.stdout.write(`\r  ${inserted} inserted, ${dupes} dupes, ${failed} failed`)
  }
  console.log(`\n\ninserted  ${inserted}\ndupes     ${dupes}\nfailed    ${failed}`)
}

main().catch(e => { console.error(e); process.exit(1) })
