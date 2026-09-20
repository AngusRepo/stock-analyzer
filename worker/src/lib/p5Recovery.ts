import { summarizeSellOrderLosses, type SellOrderRowForPnl } from './paperOrderAccounting'

export interface P5RecoveryRequest {
  request_id: string
  last_order_id: number
  cutoff_sell_id: number
  previous_rearm_id: number
  incident_ref: string
  repair_version: string
  validation_ref: string
  validation_sha256: string
  approved_by: string
}

const evidenceFields = ['request_id', 'incident_ref', 'repair_version', 'validation_ref', 'validation_sha256', 'approved_by'] as const

export async function previewP5Recovery(db: D1Database, accountId: number) {
  const anchor = await db.prepare(`SELECT
    COALESCE((SELECT MAX(id) FROM paper_orders WHERE account_id=?),0) AS last_order_id,
    COALESCE((SELECT MAX(id) FROM paper_orders WHERE account_id=? AND side='sell'),0) AS cutoff_sell_id,
    COALESCE((SELECT MAX(id) FROM paper_p5_rearms_v1 WHERE account_id=?),0) AS previous_rearm_id,
    COALESCE((SELECT MAX(cutoff_sell_id) FROM paper_p5_rearms_v1 WHERE account_id=?),0) AS active_cutoff_sell_id`)
    .bind(accountId, accountId, accountId, accountId).first<{
      last_order_id: number; cutoff_sell_id: number; previous_rearm_id: number; active_cutoff_sell_id: number
    }>()
  if (!anchor) throw new Error('p5_recovery_anchor_unavailable')
  const rows = await db.prepare(`SELECT price, shares, commission, tax, note FROM paper_orders
    WHERE account_id=? AND side='sell' AND id>? AND id<=? ORDER BY id DESC LIMIT 5`)
    .bind(accountId, anchor.active_cutoff_sell_id, anchor.cutoff_sell_id).all<SellOrderRowForPnl>()
  const summary = summarizeSellOrderLosses(rows.results ?? [])
  return { account_id: accountId, ...anchor, summary, p5_halted: summary.total >= 3 && summary.losses >= 3 }
}

/** Operator attests reviewed repair evidence; this is not an automated NAV/model approval. */
export async function applyP5Recovery(db: D1Database, accountId: number, request: P5RecoveryRequest) {
  for (const field of evidenceFields) {
    if (typeof request[field] !== 'string' || !request[field].trim() || request[field].length > 1000) {
      throw new Error('p5_recovery_missing_or_invalid_evidence:' + field)
    }
  }
  if (!/^[a-f0-9]{64}$/.test(request.validation_sha256)) throw new Error('p5_recovery_invalid_validation_sha256')
  for (const field of ['last_order_id', 'cutoff_sell_id', 'previous_rearm_id'] as const) {
    if (!Number.isSafeInteger(request[field]) || request[field] < 0) throw new Error('p5_recovery_invalid_anchor')
  }
  const values = [request.request_id, accountId, request.cutoff_sell_id, request.last_order_id,
    request.previous_rearm_id, request.incident_ref, request.repair_version, request.validation_ref,
    request.validation_sha256, request.approved_by]
  const columns = ['request_id', 'account_id', 'cutoff_sell_id', 'last_order_id', 'previous_rearm_id',
    'incident_ref', 'repair_version', 'validation_ref', 'validation_sha256', 'approved_by']
  const existing = await db.prepare('SELECT * FROM paper_p5_rearms_v1 WHERE request_id=?')
    .bind(request.request_id).first<Record<string, unknown>>()
  if (existing) {
    if (!columns.every((key, i) => existing[key] === values[i])) throw new Error('p5_recovery_request_id_conflict')
    return { written: false, receipt: existing }
  }
  const preview = await previewP5Recovery(db, accountId)
  if (!preview.p5_halted) throw new Error('p5_recovery_not_halted')
  if (preview.last_order_id !== request.last_order_id || preview.cutoff_sell_id !== request.cutoff_sell_id
    || preview.previous_rearm_id !== request.previous_rearm_id) throw new Error('p5_recovery_stale_preview')
  // Single atomic conditional INSERT: intervening orders or another re-arm invalidate this approval.
  const inserted = await db.prepare(`INSERT INTO paper_p5_rearms_v1 (${columns.join(',')})
    SELECT ?,?,?,?,?,?,?,?,?,? WHERE
    (SELECT COALESCE(MAX(id),0) FROM paper_orders WHERE account_id=?)=? AND
    (SELECT COALESCE(MAX(id),0) FROM paper_p5_rearms_v1 WHERE account_id=?)=?
    ON CONFLICT(request_id) DO NOTHING`)
    .bind(...values, accountId, request.last_order_id, accountId, request.previous_rearm_id).run()
  const receipt = await db.prepare('SELECT * FROM paper_p5_rearms_v1 WHERE request_id=?')
    .bind(request.request_id).first<Record<string, unknown>>()
  if (!receipt) throw new Error('p5_recovery_stale_preview')
  if (!columns.every((key, i) => receipt[key] === values[i])) throw new Error('p5_recovery_request_id_conflict')
  return { written: Number(inserted.meta.changes) === 1, receipt }
}
