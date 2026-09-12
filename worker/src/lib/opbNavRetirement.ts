/** Original OPB owner lifecycle: retire incompatible control, never grant it.
 * Reuses registry/pointer/history and the existing guarded KV projection.
 */
import { readOpbNavCommitReceipt, readOpbComparisonSource, verifyOpbPriorSource, type OpbNavIdentity } from './opbNavPublication'
import { verifyNavFormalBaseline, type NavCurrentConfigReader } from './pairedNavPromotionContext'
import { setTradingConfig, validateTradingConfig } from './tradingConfig'
import type { Bindings } from '../types'
import servingSource from '../../../ml-controller/services/opb_nav_serving_source.json'

type Row = Record<string, any>
const OWNER = 'opb_arm_prior', SCHEMA = 'opb-nav-context-retirement-v1'
const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v
const same = (a: any, b: any) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
async function hash(raw: string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)))]
    .map(b => b.toString(16).padStart(2, '0')).join('')
}
const digest = (v: any) => hash(JSON.stringify(canonical(v)))
const fail = (reason: string): never => { throw new Error('opb_nav_retirement_' + reason) }
// Live withdrawal fence only. Do not change historical EV tokens or replay
// identities: those predate serving-mode and pointerless owner-state checks.
const LIVE_EV_STATE_SQL = `SELECT json_array(
  (SELECT json_group_array(json_array(owner,owner_state,champion_artifact_id)) FROM
    (SELECT owner,owner_state,champion_artifact_id FROM expected_return_owner_state_v2
     WHERE owner IN ('l4_alpha_ev','allocator_ev_fusion') ORDER BY owner)),
  (SELECT json_group_array(json_array(model_name,champion_artifact_id,serving_mode)) FROM
    (SELECT p.model_name,p.champion_artifact_id,x.serving_mode FROM model_champion_pointers p
     LEFT JOIN expected_return_artifact_payloads x ON x.artifact_id=p.champion_artifact_id
     WHERE p.model_name IN ('l4_alpha_ev','allocator_ev_fusion') ORDER BY p.model_name))
) AS token`
async function retirementSource(db: D1Database, readCurrent: NavCurrentConfigReader) {
  const before = await db.prepare(LIVE_EV_STATE_SQL).first<{ token: string }>()
  const source = await readOpbComparisonSource(db, readCurrent, 'retirement')
  const after = await db.prepare(LIVE_EV_STATE_SQL).first<{ token: string }>()
  if (!before?.token || before.token !== after?.token) fail('ev_state_raced')
  return { ...source, liveEvState: before.token }
}
const allocation = (config: Row) => (config.alphaFramework ?? config.alpha_framework)?.allocation ?? {}
const prior = (config: Row) => allocation(config).opbArmPrior ?? allocation(config).opb_arm_prior ?? null
const keys = ['controller', 'opbArmPrior', 'opb_arm_prior']
function controls(config: Row) {
  const value = allocation(config)
  return Object.fromEntries(keys.filter(k => Object.hasOwn(value, k)).map(k => [k, value[k]]))
}

function historyTime(value: string) {
  const text = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? value.replace(' ', 'T') + 'Z' : value
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(text) || !Number.isFinite(Date.parse(text))) fail('history_clock_invalid')
  return Date.parse(text)
}

/** Read the actual pre-OPB allocator through immutable prior publications.
 * No default controller/parameters and no runtime grant are created here.
 */
export async function originalOpbFallbackControls(db: D1Database, configuration: Row, cutoff: number) {
  const seen = new Set<string>(), history: Row[] = []
  let config = configuration, limit = cutoff
  while (true) {
    const value = controls(config), previous = prior(config)
    if (value.controller !== 'OnlinePortfolioBandit' && previous?.schema_version !== 'opb-arm-prior-artifact-v3')
      return { controls: value, history }
    if (value.controller !== 'OnlinePortfolioBandit' || previous?.schema_version !== 'opb-arm-prior-artifact-v3')
      fail('baseline_history_unavailable')
    const id = previous.artifact_id
    if (seen.has(id)) fail('baseline_history_cycle')
    seen.add(id)
    const rows = (await db.prepare(`SELECT * FROM model_champion_history WHERE model_name=?
      AND artifact_id=? AND event_id LIKE 'opb-nav:%'`).bind(OWNER, id).all<Row>()).results ?? []
    const active = rows.filter(row => historyTime(row.effective_at) <= limit
      && (row.retired_at === null || historyTime(row.retired_at) >= limit))
    if (active.length !== 1) fail('baseline_history_missing_or_ambiguous')
    const row = active[0], evidence = JSON.parse(row.evidence_json)
    const identity = { artifactId: id, artifactChecksum: evidence.artifact_checksum }
    const source = await verifyOpbPriorSource(db, identity, evidence.gate)
    if (evidence.schema_version !== 'opb-nav-pointer-adoption-v1' || evidence.owner !== OWNER
      || evidence.artifact_id !== id || evidence.gate.decision !== 'PASS'
      || evidence.gate.nav_validation?.decision !== 'PASS'
      || evidence.decision_checksum !== evidence.gate.nav_validation.decision_checksum
      || evidence.decision_checksum !== evidence.gate.evaluation_evidence_checksum
      || row.event_id !== `opb-nav:${identity.artifactChecksum}:${evidence.decision_checksum}`
      || row.source !== 'model_champion_history' || row.evidence_grade !== 'exact'
      || row.version !== previous.model_version || !same(source.artifact, previous)) fail('baseline_history_invalid')
    history.push({ event_id: row.event_id, evidence_checksum: await hash(row.evidence_json),
      effective_at: row.effective_at, retired_at: row.retired_at, evidence_json: row.evidence_json })
    config = evidence.configuration.trading_config
    limit = historyTime(row.effective_at)
  }
}

async function readRetirement(db: D1Database, identity: OpbNavIdentity) {
  const rows = (await db.prepare(`SELECT * FROM model_champion_history WHERE model_name=?
    AND artifact_id=? AND event_id LIKE 'opb-nav-retirement:%' ORDER BY effective_at DESC LIMIT 1`)
    .bind(OWNER, identity.artifactId).all<Row>()).results ?? []
  if (!rows.length) return null
  const row = rows[0], value = JSON.parse(row.evidence_json)
  const { retirement_checksum: checksum, ...body } = value
  const original = (await db.prepare(`SELECT * FROM model_champion_history
    WHERE model_name=? AND artifact_id=? AND event_id=?`).bind(OWNER, identity.artifactId,
      value.original_history_event_id).all<Row>()).results ?? []
  const registry = await db.prepare('SELECT * FROM model_artifact_registry WHERE artifact_id=?')
    .bind(identity.artifactId).first<Row>()
  if (value.schema_version !== SCHEMA || value.owner !== OWNER || value.artifact_id !== identity.artifactId
    || value.artifact_checksum !== identity.artifactChecksum || checksum !== await digest(body)
    || row.event_id !== `opb-nav-retirement:${identity.artifactChecksum}:${value.publication_receipt_checksum}`
    || row.source !== 'model_champion_history' || row.evidence_grade !== 'exact'
    || row.effective_at !== value.retired_at || row.retired_at !== value.retired_at
    || original.length !== 1 || original[0].retired_at !== value.retired_at
    || await hash(original[0].evidence_json) !== value.publication_receipt_checksum
    || original[0].version !== row.version || original[0].source !== 'model_champion_history'
    || original[0].evidence_grade !== 'exact' || !registry || registry.model_name !== OWNER
    || registry.version !== row.version || registry.checksum !== identity.artifactChecksum
    || await hash(JSON.parse(original[0].evidence_json).gate.candidate_payload_json) !== identity.artifactChecksum) {
    fail('record_invalid')
  }
  await verifyOpbPriorSource(db, identity, JSON.parse(original[0].evidence_json).gate)
  if (!Array.isArray(value.fallback_history)) fail('baseline_history_invalid')
  for (const reference of value.fallback_history) {
    const ancestor = await db.prepare('SELECT * FROM model_champion_history WHERE event_id=?')
      .bind(reference.event_id).first<Row>()
    if (!ancestor || ancestor.model_name !== OWNER || ancestor.source !== 'model_champion_history'
      || ancestor.evidence_grade !== 'exact' || ancestor.effective_at !== reference.effective_at
      || ancestor.retired_at !== reference.retired_at
      || await hash(ancestor.evidence_json) !== reference.evidence_checksum) fail('baseline_history_changed')
  }
  return value
}

function response(value: Row) {
  return { schema_version: SCHEMA, owner: OWNER, artifact_id: value.artifact_id,
    artifact_checksum: value.artifact_checksum, status: 'retired', completion_scope: 'retirement',
    success: true, retired: true, pointer_committed: false, promotion_allowed: false,
    control_activation_verified: false, config_projection_verified: true,
    nav_maturity_credit: 0, retirement: value }
}

/** Called only from the existing OPB publication/recovery endpoint. */
export async function reconcileOpbNavPublication(db: D1Database, kv: KVNamespace,
  identity: OpbNavIdentity, gate: Row, readCurrent: NavCurrentConfigReader, env?: Bindings, now = new Date()) {
  const receipt = await readOpbNavCommitReceipt(db, identity)
  if (!receipt) {
    const retired = await readRetirement(db, identity)
    if (!retired) return null
    // A new original NAV decision may qualify this SAME immutable candidate in
    // another frozen comparison. Historical retirement must not veto that review.
    if (gate.decision === 'PASS' && gate.nav_validation?.decision_checksum
      && gate.nav_validation.decision_checksum !== retired.decision_checksum) return null
    const current = await retirementSource(db, readCurrent)
    await verifyNavFormalBaseline(db, current.formal, env)
    if (prior(current.current.tradingConfig)?.artifact_id === identity.artifactId) fail('old_control_still_configured')
    const pointer = await db.prepare('SELECT champion_artifact_id FROM model_champion_pointers WHERE model_name=?')
      .bind(OWNER).first<Row>()
    if (pointer?.champion_artifact_id === identity.artifactId) fail('pointer_still_active')
    return response(retired)
  }
  const observed = await retirementSource(db, readCurrent)
  await verifyNavFormalBaseline(db, observed.formal, env)
  const frozen = receipt.evidence.configuration
  const changes = [
    ...(!same(observed.formal, Object.fromEntries(Object.keys(observed.formal)
      .map(k => [k, frozen.formal_baseline_identity[k]]))) ? ['formal_ml'] : []),
    ...(observed.fence !== receipt.evidence.serving_fence ? ['serving_ev'] : []),
    ...(!same(observed.current.riskConfig, frozen.risk_config) ? ['risk_config'] : []),
  ]
  const beforeConfig = structuredClone(observed.current.tradingConfig)
  const strip = (value: Row) => {
    const copy = structuredClone(value)
    for (const root of [copy.alphaFramework, copy.alpha_framework])
      if (root?.allocation) for (const key of keys) delete root.allocation[key]
    return copy
  }
  if (!same(strip(beforeConfig), strip(frozen.trading_config))) changes.push('trading_config')
  if (!changes.length) return null // Original projection/control validation still owns unchanged recovery.
  const artifact = JSON.parse(receipt.evidence.gate.candidate_payload_json)
  const initialControls = controls(frozen.trading_config)
  const publication = await db.prepare('SELECT * FROM model_champion_history WHERE event_id=?')
    .bind(`opb-nav:${identity.artifactChecksum}:${receipt.evidence.decision_checksum}`).first<Row>()
  if (!publication || historyTime(publication.effective_at) > now.getTime()) fail('publication_clock_invalid')
  const fallback = await originalOpbFallbackControls(db, frozen.trading_config, historyTime(publication.effective_at))
  const baseline = fallback.controls
  const projected: Row = { ...initialControls, controller: 'OnlinePortfolioBandit', opbArmPrior: artifact }
  delete projected.opb_arm_prior
  if (!same(controls(beforeConfig), projected) && !same(controls(beforeConfig), baseline)
    && !same(controls(beforeConfig), initialControls))
    fail('control_changed_by_other_owner')
  const target = structuredClone(beforeConfig)
  if (!target.alphaFramework?.allocation || !baseline.controller) fail('baseline_control_missing')
  for (const key of keys) delete target.alphaFramework.allocation[key]
  Object.assign(target.alphaFramework.allocation, baseline)
  if (validateTradingConfig(target as any).length) fail('fallback_config_invalid')
  const verify = async (expected: Row) => {
    const current = await retirementSource(db, readCurrent)
    await verifyNavFormalBaseline(db, current.formal, env)
    const active = await readOpbNavCommitReceipt(db, identity)
    if (!active || active.payload_checksum !== receipt.payload_checksum
      || !same(await originalOpbFallbackControls(db, frozen.trading_config, historyTime(publication.effective_at)), fallback)
      || current.fence !== observed.fence || current.liveEvState !== observed.liveEvState
      || !same(current.formal, observed.formal)
      || !same(current.current.riskConfig, observed.current.riskConfig)
      || !same(current.current.tradingConfig, expected)) fail('source_changed')
  }
  await verify(beforeConfig)
  const raw = await kv.get('trading:config', 'json')
  if (!same(raw, target)) await setTradingConfig(kv, target as any,
    { source: SCHEMA, push_id: receipt.payload_checksum }, async () => {
      await verify(beforeConfig)
      if (!same(await kv.get('trading:config', 'json'), raw)) fail('config_raced')
    })
  if (!same(await kv.get('trading:config', 'json'), target)) fail('projection_readback_mismatch')
  await verify(target)
  const retiredAt = now.toISOString()
  const body = { schema_version: SCHEMA, owner: OWNER, artifact_id: identity.artifactId,
    artifact_checksum: identity.artifactChecksum, decision_checksum: receipt.evidence.decision_checksum,
    publication_receipt_checksum: receipt.payload_checksum, retired_at: retiredAt,
    original_history_event_id: `opb-nav:${identity.artifactChecksum}:${receipt.evidence.decision_checksum}`,
    changed_fields: changes, source: 'original_opb_publication_and_verified_current_context',
    restored_controls: baseline, fallback_history: fallback.history.map(({ evidence_json, ...reference }) => reference),
    restored_config_checksum: await digest(target),
    current_context_checksum: await digest(observed), promotion_allowed: false, nav_maturity_credit: 0 }
  const record = { ...body, retirement_checksum: await digest(body) }
  const statements = [
    ...fallback.history.map(row => db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM model_champion_history
      WHERE event_id=? AND evidence_json=? AND effective_at=? AND retired_at IS ?)
      THEN 1 ELSE json('opb_nav_retirement_ancestor_raced') END`)
      .bind(row.event_id, row.evidence_json, row.effective_at, row.retired_at)),
    db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM model_champion_pointers p
      JOIN model_artifact_registry r ON r.artifact_id=p.champion_artifact_id
      WHERE p.model_name=? AND p.champion_artifact_id=? AND p.promotion_evidence_json=?
      AND r.state='production' AND r.checksum=?) AND (${servingSource.ev_fence_sql})=?
      AND (${LIVE_EV_STATE_SQL})=?
      AND EXISTS(SELECT 1 FROM active8_ensemble_pointer_v1 m JOIN active8_ensemble_artifacts_v1 a
        ON a.artifact_id=m.artifact_id WHERE m.singleton_id=1 AND m.artifact_id=?
        AND m.cohort_id=? AND m.payload_checksum=? AND m.base_artifact_set_checksum=?
        AND a.cohort_id=m.cohort_id AND a.payload_checksum=m.payload_checksum
        AND a.base_artifact_set_checksum=m.base_artifact_set_checksum
        AND a.state='production' AND a.production_effect=1)
      THEN 1 ELSE json('opb_nav_retirement_context_raced') END`).bind(OWNER, identity.artifactId,
        JSON.stringify(receipt.evidence), identity.artifactChecksum, observed.fence, observed.liveEvState,
        observed.formal.artifact_id, observed.formal.cohort_id, observed.formal.payload_checksum,
        observed.formal.base_artifact_set_checksum),
    db.prepare(`UPDATE model_champion_history SET retired_at=? WHERE model_name=? AND retired_at IS NULL`)
      .bind(retiredAt, OWNER),
    db.prepare(`INSERT INTO model_champion_history(event_id,model_name,version,artifact_id,effective_at,
      retired_at,source,evidence_grade,evidence_json) VALUES(?,?,?,?,?,?,'model_champion_history','exact',?)`)
      .bind(`opb-nav-retirement:${identity.artifactChecksum}:${receipt.payload_checksum}`, OWNER,
        receipt.model_version, identity.artifactId, retiredAt, retiredAt, JSON.stringify(record)),
    db.prepare(`UPDATE model_artifact_registry SET state='shadowing',live_gate_status='not_started',
      promotion_decision=?,updated_at=CURRENT_TIMESTAMP WHERE artifact_id=?`)
      .bind(SCHEMA, identity.artifactId),
    db.prepare('DELETE FROM model_champion_pointers WHERE model_name=? AND champion_artifact_id=?')
      .bind(OWNER, identity.artifactId),
  ]
  const result = await db.batch(statements)
  if (result.length !== statements.length || result.some(r => r.success !== true)) fail('batch_incomplete')
  const recorded = await readRetirement(db, identity)
  if (!same(recorded, record) || !same(await kv.get('trading:config', 'json'), target)) fail('readback_mismatch')
  return response(recorded!)
}
