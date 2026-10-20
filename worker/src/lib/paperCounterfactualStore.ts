import { advanceCounterfactualLot, openCounterfactualLot, EXIT_ARMS, type CounterfactualLot } from './paperCounterfactual'
export type StoredCounterfactualLot = { version: number; checksum: string; lot: CounterfactualLot }
const digest = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))))
  .map(v => v.toString(16).padStart(2, '0')).join('')

export async function readCounterfactualLot(db: D1Database, accountId: number, lotId: string): Promise<StoredCounterfactualLot | null> {
  const row = await db.prepare('SELECT version,state_sha,state_json FROM paper_counterfactual_lots_v1 WHERE account_id=? AND lot_id=?')
    .bind(accountId, lotId).first<{ version: number; state_sha: string; state_json: string }>()
  if (!row) return null
  const lot = JSON.parse(row.state_json) as CounterfactualLot
  if (await digest(row.state_json) !== row.state_sha || lot.accountId !== accountId || lot.lotId !== lotId)
    throw new Error('counterfactual_state_checksum_mismatch')
  return { version: row.version, checksum: row.state_sha, lot }
}

async function persist(db: D1Database, previous: StoredCounterfactualLot | null, lot: CounterfactualLot, evidence: unknown): Promise<StoredCounterfactualLot> {
  const version = previous ? previous.version + 1 : 0
  const json = JSON.stringify(lot), checksum = await digest(json)
  const evidenceJson = JSON.stringify(evidence), evidenceSha = await digest(evidenceJson)
  const openArms = EXIT_ARMS.filter(arm => lot.arms[arm].shares > 0).length
  const write = previous
    ? db.prepare(`UPDATE paper_counterfactual_lots_v1 SET version=?,state_sha=?,state_json=?,open_arms=?,observed_ms=?
        WHERE account_id=? AND lot_id=? AND version=? AND state_sha=?`)
      .bind(version, checksum, json, openArms, lot.lastObservedMs, lot.accountId, lot.lotId, previous.version, previous.checksum)
    : db.prepare(`INSERT INTO paper_counterfactual_lots_v1(account_id,lot_id,symbol,signal_ms,version,state_sha,state_json,open_arms,observed_ms)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,lot_id) DO NOTHING`)
      .bind(lot.accountId, lot.lotId, lot.symbol, lot.signalMs, version, checksum, json, openArms, lot.lastObservedMs)
  const receipt = db.prepare(`INSERT INTO paper_counterfactual_events_v1(account_id,lot_id,version,observed_ms,previous_sha,state_sha,evidence_sha,evidence_json)
    SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM paper_counterfactual_lots_v1 WHERE account_id=? AND lot_id=? AND version=? AND state_sha=?)
    ON CONFLICT(account_id,lot_id,version) DO NOTHING`)
    .bind(lot.accountId, lot.lotId, version, lot.lastObservedMs, previous?.checksum ?? null, checksum, evidenceSha, evidenceJson,
      lot.accountId, lot.lotId, version, checksum)
  const result = await db.batch([write, receipt])
  if (result.some(r => !r.success)) throw new Error('counterfactual_state_write_failed')
  const saved = await readCounterfactualLot(db, lot.accountId, lot.lotId)
  const event = await db.prepare('SELECT state_sha,evidence_sha,evidence_json FROM paper_counterfactual_events_v1 WHERE account_id=? AND lot_id=? AND version=?')
    .bind(lot.accountId, lot.lotId, version).first<{ state_sha: string; evidence_sha: string; evidence_json: string }>()
  if (!saved || saved.version !== version || saved.checksum !== checksum || event?.state_sha !== checksum
    || event.evidence_sha !== evidenceSha || await digest(event.evidence_json) !== evidenceSha)
    throw new Error('counterfactual_state_conflict')
  return saved
}
export async function recordCounterfactualEntry(db: D1Database, input: Parameters<typeof openCounterfactualLot>[0]) {
  const result = openCounterfactualLot(input)
  const evidence = JSON.stringify({ input, reason: result.reason, fill: result.fill }), checksum = await digest(evidence)
  const write = await db.prepare(`INSERT INTO paper_counterfactual_signals_v1(account_id,lot_id,observed_ms,reason,evidence_sha,evidence_json)
    VALUES(?,?,?,?,?,?) ON CONFLICT(account_id,lot_id,observed_ms) DO NOTHING`)
    .bind(input.accountId,input.lotId,input.nowMs,result.reason,checksum,evidence).run()
  const saved = await db.prepare('SELECT evidence_sha,evidence_json FROM paper_counterfactual_signals_v1 WHERE account_id=? AND lot_id=? AND observed_ms=?')
    .bind(input.accountId,input.lotId,input.nowMs).first<{ evidence_sha: string; evidence_json: string }>()
  if (!write.success || saved?.evidence_sha !== checksum || await digest(saved.evidence_json) !== checksum)
    throw new Error('counterfactual_signal_conflict')
  if (!result.lot) return { ...result, stored: null }
  return { ...result, stored: await persist(db, null, result.lot, { input, fill: result.fill }) }
}
export async function recordCounterfactualObservation(db: D1Database, previous: StoredCounterfactualLot, input: Parameters<typeof advanceCounterfactualLot>[1]) {
  const result = advanceCounterfactualLot(previous.lot, input)
  return { ...result, stored: await persist(db, previous, result.lot, { input, events: result.events }) }
}
