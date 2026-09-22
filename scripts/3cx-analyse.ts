import { analyseThreeCxPayload } from '../src/services/threecx-mapper'
import fs from 'fs'
const p = JSON.parse(fs.readFileSync('data/3cx/vivalda-payload.json','utf8'))
const a = analyseThreeCxPayload(p)
console.log(`${a.company} | ${a.fqdn} | 3CX ${a.version} | backup ${a.backup_date}`)
console.log('\nCOUNTS'); for (const [k,v] of Object.entries(a.counts)) console.log(`  ${k.padEnd(22)} ${v}`)
console.log('\nTRUNKS'); a.trunks.forEach(t=>console.log(`  ${t.name} -> ${t.host} (reg: ${t.registration})`))
console.log(`\nBLOCKERS (${a.blockers.length})`); a.blockers.forEach(b=>console.log('  X '+b))
console.log(`\nWARNINGS (${a.warnings.length})`); a.warnings.forEach(w=>console.log('  ! '+w))
console.log(`\nNOTES (${a.notes.length})`); a.notes.forEach(n=>console.log('  - '+n))
console.log(`\nREADY: ${a.blockers.length===0}`)
