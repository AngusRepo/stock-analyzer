/** Immutable publication receipt. It never evaluates another NAV hypothesis. */
import { NAV_GATE_SCHEMA } from './pairedNavPromotionEvidence'
import { STRATEGY_PRODUCTION_WEIGHT_KERNEL, replayStrategyWeightSource, captureStrategyWeightSource } from './strategyProductionWeightReplay'
import { sha256StrategyProductionPolicyPayload, verifyStrategyProductionPolicyRecord, type StrategyProductionPolicyHistoryRow } from './strategyProductionPolicyStore'
import { STRATEGY_PRODUCTION_FIREWALL_POLICY_ID } from './strategyProductionContributionFirewall'

export const ATOMIC_NAV_RECEIPT_SCHEMA = 'strategy-atomic-nav-adoption-v1'
export function atomicNavCanonical(value: any): string {
  const order = (item: any): any => Array.isArray(item) ? item.map(order)
    : item && typeof item === 'object'
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, order(item[key])])) : item
  return JSON.stringify(order(value))
}
export const atomicNavDigest = (value: any) => sha256StrategyProductionPolicyPayload(atomicNavCanonical(value))

/** An immutable adoption transfers replacement authority, not diagnostic work.
 * Missing migration/invalid receipt is an error, never permission for legacy.
 */
export async function atomicNavOwnsRegistry(db: D1Database): Promise<boolean> {
  const row = await db.prepare('SELECT * FROM strategy_atomic_nav_adoptions_v1 LIMIT 1')
    .first<Record<string, any>>()
  if (!row) return false
  await readAtomicNavReceipt(row)
  return true
}

export function legacyAtomicPromotionGuard(db: D1Database): D1PreparedStatement {
  return db.prepare(`SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM strategy_atomic_nav_adoptions_v1)
    THEN 1 ELSE json('strategy_atomic_nav_owns_registry') END`)
}

export async function readAtomicNavReceipt(row: Record<string, any>) {
  const fail = (): never => { throw new Error('strategy_atomic_nav_receipt_invalid') }
  if (typeof row.receipt_json !== 'string'
    || await sha256StrategyProductionPolicyPayload(row.receipt_json) !== row.receipt_checksum) return fail()
  let body: any
  try { body = JSON.parse(row.receipt_json) } catch { return fail() }
  const gate = body?.gate, nav = gate?.nav_validation, definition = body?.policy_definition
  if (body?.schema_version !== ATOMIC_NAV_RECEIPT_SCHEMA
    || body.artifact_id !== row.artifact_id || body.artifact_checksum !== row.artifact_checksum
    || body.policy_checksum !== row.policy_checksum || body.knowledge_cutoff_date !== row.knowledge_cutoff_date
    || body.artifact_id !== `atomic_strategy:${body.artifact_checksum}`
    || definition?.weight_policy_version !== STRATEGY_PRODUCTION_WEIGHT_KERNEL
    || await atomicNavDigest(definition) !== body.artifact_checksum
    || gate?.schema_version !== NAV_GATE_SCHEMA || gate.decision !== 'PASS'
    || gate.training_dispatched !== false || gate.evaluation_unit !== 'original_costed_paired_daily_nav'
    || !Array.isArray(gate.failed_gates) || gate.failed_gates.length
    || gate.candidate_artifact_id !== body.artifact_id || gate.candidate_artifact_checksum !== body.artifact_checksum
    || nav?.owner !== 'atomic_strategy' || nav.decision !== 'PASS'
    || nav.candidate_artifact_id !== body.artifact_id || nav.candidate_checksum !== body.artifact_checksum
    || nav.decision_checksum !== row.decision_checksum || gate.evaluation_evidence_checksum !== row.decision_checksum
    || typeof nav.decision_payload_json !== 'string'
    || await sha256StrategyProductionPolicyPayload(nav.decision_payload_json) !== row.decision_checksum) return fail()
  const { decision_checksum, decision_payload_json, ...fields } = nav
  let original: any
  try { original = JSON.parse(decision_payload_json) } catch { return fail() }
  if (atomicNavCanonical(original) !== atomicNavCanonical(fields)) return fail()
  return body
}

/** Historical publication proof, independent of today's registry roles. */
export async function readAtomicNavPublication(db: D1Database, row: Record<string, any>) {
  const receipt = await readAtomicNavReceipt(row)
  const load = async (checksum: string) => {
    const rows = (await db.prepare(`SELECT * FROM strategy_production_policy_history_v1
      WHERE policy_id=? AND checksum=? LIMIT 2`).bind(STRATEGY_PRODUCTION_FIREWALL_POLICY_ID, checksum)
      .all<StrategyProductionPolicyHistoryRow>()).results ?? []
    if (rows.length !== 1) throw new Error('strategy_atomic_nav_published_policy_missing_or_ambiguous')
    const policy = await verifyStrategyProductionPolicyRecord(rows[0], Object.keys(JSON.parse(rows[0].strategy_weights_json)))
    const source = 'evidence_owner' in policy.state.evidence ? policy.state.evidence.evidence_owner?.weight_source : undefined
    if (!source) throw new Error('strategy_atomic_nav_published_weight_source_missing')
    const replay = await replayStrategyWeightSource(source)
    const stored = JSON.parse(policy.state.canonical_payload)
    if (stored.evidence_owner) delete stored.evidence_owner.weight_source
    if (atomicNavCanonical(stored) !== atomicNavCanonical(JSON.parse(replay.state.canonical_payload)))
      throw new Error('strategy_atomic_nav_published_policy_source_mismatch')
    return { policy, source }
  }
  const previous = await load(receipt.previous_policy_checksum)
  const published = await load(receipt.policy_checksum)
  const time = (value: unknown) => {
    const raw = typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
      ? value.replace(' ', 'T') + 'Z' : value
    return typeof raw === 'string' && /(Z|[+-]\d{2}:\d{2})$/.test(raw) ? Date.parse(raw) : NaN
  }
  const clocks = [time(previous.policy.created_at), time(published.policy.created_at), time(row.created_at)]
  if (clocks.some(value => !Number.isFinite(value)) || clocks[0] > clocks[1] || clocks[1] > clocks[2])
    throw new Error('strategy_atomic_nav_publication_time_invalid')
  const ordered = (specs: readonly any[]) => [...specs].sort((a, b) => a.id.localeCompare(b.id))
  const replay = await replayStrategyWeightSource(previous.source, receipt.policy_definition.replacement)
  const expectedSource = await captureStrategyWeightSource(replay.inputs, replay.state)
  if (await atomicNavDigest(ordered(previous.source.inputs.strategies)) !== receipt.before_registry_checksum
    || await atomicNavDigest(ordered(published.source.inputs.strategies)) !== receipt.after_registry_checksum
    || expectedSource.source_checksum !== published.source.source_checksum
    || published.policy.state.knowledge_cutoff_date !== receipt.knowledge_cutoff_date
    || atomicNavCanonical(published.policy.state.strategy_weights) !== atomicNavCanonical(replay.state.strategy_weights))
    throw new Error('strategy_atomic_nav_publication_lineage_invalid')
  const definition = receipt.policy_definition, before = previous.source.inputs.strategies
  if (atomicNavCanonical(before.find(spec => spec.id === definition.replacement.candidateId)) !== atomicNavCanonical(definition.candidate)
    || atomicNavCanonical(before.find(spec => spec.id === definition.replacement.incumbentId)) !== atomicNavCanonical(definition.incumbent))
    throw new Error('strategy_atomic_nav_publication_definition_changed')
  return { row, receipt, ...published }
}

/** Only verified committed transitions explain a changed registry. A manual or
 * corrupted role edit is not relabelled as a successful supersession. */
export async function atomicNavSupersessionPath(db: D1Database, from: string, current: string) {
  if (from === current) return [] as string[]
  const queue = [{ checksum: from, receipts: [] as string[] }], seen = new Set([from])
  for (let index = 0; index < queue.length; index++) {
    const entry = queue[index]
    let cursor = ''
    for (;;) {
      const rows = (await db.prepare(`SELECT * FROM strategy_atomic_nav_adoptions_v1
        WHERE json_extract(receipt_json,'$.before_registry_checksum')=? AND artifact_checksum>?
        ORDER BY artifact_checksum LIMIT 50`).bind(entry.checksum, cursor).all<Record<string, any>>()).results ?? []
      for (const row of rows) {
        const publication = await readAtomicNavPublication(db, row)
        const after = publication.receipt.after_registry_checksum
        const path = [...entry.receipts, row.receipt_checksum]
        if (after === current) return path
        if (!seen.has(after)) { seen.add(after); queue.push({ checksum: after, receipts: path }) }
      }
      if (rows.length < 50) break
      cursor = rows[rows.length - 1].artifact_checksum
    }
  }
  throw new Error('strategy_atomic_nav_registry_change_unexplained')
}
