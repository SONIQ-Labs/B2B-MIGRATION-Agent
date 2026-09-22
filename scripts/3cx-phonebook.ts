/** Phonebook-only re-run: contacts.phone_e164 is generated and rejected the first pass. */
import 'dotenv/config'
import fs from 'fs'
import { createClient } from '@supabase/supabase-js'

const ORG = 'cecbd6e9-cde2-4453-879d-76fea0e63550'
const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

async function main() {
  const p = JSON.parse(fs.readFileSync('data/3cx/vivalda-payload.json', 'utf8'))
  const seen = new Set<string>()
  const rows = p.phonebook
    .filter((c: any) => c.number_e164)
    .filter((c: any) => { if (seen.has(c.number_e164)) return false; seen.add(c.number_e164); return true })
    .map((c: any) => ({
      org_id: ORG,
      display_name: [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company || c.number_e164,
      first_name: c.first_name || null,
      last_name: c.last_name || null,
      company: c.company || null,
      phone_number: c.number_e164,
      email: c.email || null,
      contact_type: 'org',
      source_system: '3cx_phonebook',
      external_crm_id: `3cx:${c.number_e164}`,
      external_crm_source: '3cx_phonebook',
      synced_at: new Date().toISOString(),
    }))

  let done = 0
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500)
    const { error } = await sb.from('contacts').upsert(batch, { onConflict: 'org_id,external_crm_id' })
    if (error) { console.error(`batch ${i}: ${error.message}`); break }
    done += batch.length
  }
  console.log(`contacts imported: ${done} of ${p.phonebook.length} (${p.phonebook.length - rows.length} skipped: no number or duplicate)`)
}
main().catch(e => { console.error(e); process.exit(1) })
