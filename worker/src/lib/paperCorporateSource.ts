import type { Bindings } from '../types'
import { paperDomainDatabase } from './paperDomainDatabase'
import { controllerPostJson } from './controllerClient'
import { paperExecutionNow, scopedPaperAccountId } from './paperExecutionScope'
import { validateCorporateSnapshot, type CorporateActionSnapshot } from './paperCorporateActions'
import { readCorporateCashDiscoveryDates } from './paperCorporateOpeningBasis'

/** Existing formal account is 1; private accounts consume their sealed source
 * in the host and may never call this publisher or mutate the shared KV key. */
export async function ensurePaperCorporateSource(env: Bindings, sessionDate: string): Promise<void> {
  if (scopedPaperAccountId() !== null) throw new Error('private_corporate_source_publish_forbidden')
  const key = `market:corporate_actions:v1:${sessionDate}`
  const old = await env.KV.get(key)
  if (old !== null) {
    validateCorporateSnapshot(JSON.parse(old), sessionDate, paperExecutionNow())
    return
  }
  const db = paperDomainDatabase(env)
  const [positions, rights] = await Promise.all([
    db.prepare('SELECT symbol FROM paper_positions WHERE account_id=1 AND shares>0').all<{ symbol: string }>(),
    db.prepare('SELECT symbol,action_id FROM paper_corporate_entitlements_v1 WHERE account_id=1 AND settled=0')
      .all<{ symbol: string; action_id: string }>(),
  ])
  if (!positions.success || !rights.success || !positions.results || !rights.results) {
    throw new Error('paper_corporate_opening_universe_read_failed')
  }
  const history = await readCorporateCashDiscoveryDates(db, 1, sessionDate)
  const symbols = [...new Set([...positions.results.map(r => r.symbol),
    ...rights.results.map(r => r.symbol), ...Object.keys(history)])].sort()
  const outstanding = rights.results.map(r => r.action_id).sort()
  const historyArgs = Object.keys(history).length ? { historical_cash_dates: history } : {}
  const receipt = await controllerPostJson<{ snapshot: CorporateActionSnapshot;
    request?: { historical_cash_dates?: Record<string, string[]> };
    identity: { session_date: string; scope_id: string } }>(
    env, '/paper/corporate-source', { session_date: sessionDate, scope_id: 'paper-account-1',
      symbols, outstanding_action_ids: outstanding, ...historyArgs }, 180_000)
  if (receipt.identity?.session_date !== sessionDate || receipt.identity?.scope_id !== 'paper-account-1') {
    throw new Error('paper_corporate_source_receipt_identity_mismatch')
  }
  if (Object.keys(history).length) {
    const received = receipt.request?.historical_cash_dates
    if (!received || Object.keys(received).length !== Object.keys(history).length
      || Object.entries(history).some(([s, dates]) => JSON.stringify(received[s]) !== JSON.stringify(dates))) {
      throw new Error('paper_corporate_source_receipt_history_mismatch')
    }
  }
  validateCorporateSnapshot(receipt.snapshot, sessionDate, paperExecutionNow())
  if (symbols.some(s => !receipt.snapshot.covered_symbols.includes(s))
    || outstanding.some(id => !receipt.snapshot.actions.some(a => a.action_id === id))) {
    throw new Error('paper_corporate_source_receipt_coverage_missing')
  }
  const raw = JSON.stringify(receipt.snapshot)
  await env.KV.put(key, raw, { expirationTtl: 7 * 86400 })
  if (await env.KV.get(key) !== raw) throw new Error('paper_corporate_source_publish_not_visible')
}
