import { Router, Request, Response } from 'express'
import fs from 'fs'
import {
  migrateThreeCxBackup,
  analyseThreeCxPayload,
  ThreeCxPayload,
} from '../services/threecx-mapper'
import { logger } from '../utils/logger'

const router = Router()

/**
 * 3CX migrations are file-driven, not server-driven: there is no API to poll,
 * the source of truth is the backup zip. scripts/3cx_extract.py turns that zip
 * into a ~1MB normalised payload wherever the backup happens to live, and these
 * routes take the payload. That keeps a 1GB+ archive off the wire.
 */

function loadPayload(body: any): ThreeCxPayload {
  if (body?.payload) return body.payload as ThreeCxPayload
  if (body?.payload_path) {
    if (!fs.existsSync(body.payload_path)) throw new Error(`payload_path not found: ${body.payload_path}`)
    return JSON.parse(fs.readFileSync(body.payload_path, 'utf8')) as ThreeCxPayload
  }
  throw new Error('Provide either payload (JSON body) or payload_path')
}

// POST /threecx/analyse — readiness scan, no writes to 3CX or SONIQ
router.post('/analyse', async (req: Request, res: Response) => {
  try {
    const payload = loadPayload(req.body)
    if (payload.source !== '3cx') {
      return res.status(400).json({ error: `Unexpected payload source "${payload.source}" - expected "3cx"` })
    }
    const analysis = analyseThreeCxPayload(payload)
    res.json({
      ok: true,
      ready: analysis.blockers.length === 0,
      analysis,
    })
  } catch (e: any) {
    res.status(400).json({ error: e.message })
  }
})

// POST /threecx/migrate — write the payload into a SONIQ org
router.post('/migrate', async (req: Request, res: Response) => {
  const { target_org_id, inbound_trunk_id, import_phonebook, exclude_extensions, dry_run, force } = req.body
  if (!target_org_id) return res.status(400).json({ error: 'Missing target_org_id' })

  let payload: ThreeCxPayload
  try {
    payload = loadPayload(req.body)
  } catch (e: any) {
    return res.status(400).json({ error: e.message })
  }

  // Blockers stop a real run unless explicitly overridden; a dry run always
  // proceeds so the operator can see the full shape of what would land.
  const analysis = analyseThreeCxPayload(payload)
  if (analysis.blockers.length && !dry_run && !force) {
    return res.status(409).json({
      error: 'Migration has blockers - resolve them or pass force: true',
      blockers: analysis.blockers,
    })
  }

  // Dry runs are cheap and bounded, so answer inline. Real runs create auth
  // users one at a time and take minutes, so they go async.
  if (dry_run) {
    try {
      const result = await migrateThreeCxBackup({ payload, target_org_id, inbound_trunk_id, import_phonebook, exclude_extensions, dry_run: true })
      return res.json({ ok: true, status: 'dry_run_complete', result, analysis })
    } catch (e: any) {
      return res.status(500).json({ error: e.message })
    }
  }

  res.json({
    ok: true,
    status: 'in_progress',
    target_org_id,
    expected: analysis.counts,
    blockers_overridden: analysis.blockers.length ? analysis.blockers : undefined,
  })

  migrateThreeCxBackup({ payload, target_org_id, inbound_trunk_id, import_phonebook, exclude_extensions, dry_run: false })
    .then(r => logger.info(
      `[3CX] migration finished for org ${target_org_id}: ${r.status}, ` +
      `${r.extensionsSynced} exts, ${r.queuesSynced} queues, ${r.numbersSynced} DIDs, ` +
      `${r.warnings.length} warnings`,
    ))
    .catch(e => logger.error(`[3CX] migration failed for org ${target_org_id}: ${e.message}`))
})

export default router
