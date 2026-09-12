/** OPB NAV-authorized D1 adoption. No offline efficacy veto or fabricated flags.
 * Reuses original model registry/pointer/history and the shared NAV verifier.
 * Publication is NOT yet the separate live allocator control activation.
 */
import { verifyNavPromotionEvidence, originalNavComparisonContext, navJournalFrontierGuard } from './pairedNavPromotionEvidence'
import { verifyNavCurrentContext, verifyNavFormalBaseline, navPointerCompareAndSwapGuard, type NavCurrentConfigReader } from './pairedNavPromotionContext'
import { setTradingConfig, validateTradingConfig } from './tradingConfig'
import { hydrateExpectedReturnConfigFromPointers } from './expectedReturnServingRegistry'
import { resolveExpectedReturnServingState } from './expectedReturnServingState'
import { loadExpectedReturnForwardGuard } from './expectedReturnForwardGuard'
import { L4_ALPHA_EV_CONTRACT, ALLOCATOR_EV_FUSION_CONTRACT } from './evidenceContracts'
import servingSource from '../../../ml-controller/services/opb_nav_serving_source.json'

type RecordValue = Record<string, any>
const OWNER = 'opb_arm_prior'
const SCHEMA = 'opb-nav-pointer-adoption-v1'
const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v
const same = (a: any, b: any) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
const hash = async (raw: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(raw))), b => b.toString(16).padStart(2, '0')).join('')
const fail = (reason: string): never => { throw new Error(`opb_nav_${reason}`) }

// Capture BOTH possible serving owners and the original guard, not just the
// selected pointer. Activating a previously absent Fusion also changes context.
const EV_FENCE = servingSource.ev_fence_sql

export type OpbNavIdentity = { artifactId: string; artifactChecksum: string }
export type OpbNavCommitReceipt = {
  artifact_id: string; artifact_checksum: string; model_version: string;
  payload_checksum: string; previous_version: string | null; evidence: RecordValue;
}

/** The same current-source reader serves unpublished and published lifecycle.
 * A changed comparator is usable only after its current source is validated.
 */
export async function readOpbComparisonSource(db: D1Database, readCurrent: NavCurrentConfigReader,
  purpose: 'candidate' | 'retirement' = 'candidate') {
  const current = await readCurrent()
  if (![current?.tradingConfig, current?.riskConfig].every(value => value && typeof value === 'object'
    && !Array.isArray(value) && Object.keys(value).length)) fail('comparison_current_config_missing')
  if (validateTradingConfig(current.tradingConfig as any).length) fail('comparison_current_config_invalid')
  const formal = await db.prepare(`SELECT artifact_id,cohort_id,payload_checksum,base_artifact_set_checksum
    FROM active8_ensemble_pointer_v1 WHERE singleton_id=1`).first<RecordValue>()
  if (!formal) fail('comparison_current_ml_missing')
  const fence = await db.prepare(EV_FENCE).first<{ token: string }>()
  if (!fence?.token) fail('serving_fence_missing')
  const hydrated = await hydrateExpectedReturnConfigFromPointers(db, current.tradingConfig)
  if (Object.values(hydrated.projections).some(p => p.blockers.includes('serving_registry_schema_missing')
    || !p.valid && (p.pointer_present || p.owner_state === 'learned_champion'))
    || !same(hydrated.config, current.tradingConfig)) fail('comparison_ev_source_invalid')
  const guard = await loadExpectedReturnForwardGuard(db)
  const state = resolveExpectedReturnServingState(hydrated.config,
    { pointerProjections: hydrated.projections, forwardGuard: guard })
  const owner = state.expected_return_owner
  if (!owner && purpose === 'retirement') {
    const projections = Object.values(hydrated.projections)
    const safe = (p: typeof projections[number]) => p.owner_state === 'safe_abstention'
      && p.valid && p.serving_mode === 'abstention_baseline' && !p.pointer_present
      && !p.artifact && !p.blockers.length
    // Withdrawal is not candidate admission: an explicit healthy abstention
    // can retire stale OPB authority, but cannot invent EV or promote anything.
    // Require at least one explicit state; total disappearance is not evidence.
    if (projections.some(safe) && projections.every(p => safe(p)
      || p.owner_state === 'no_champion' && !p.pointer_present && !p.artifact
        && p.blockers.length === 1 && p.blockers[0] === 'champion_pointer_missing')) {
      return { current, formal, evIdentity: [], fence: fence.token }
    }
  }
  if (!owner || !hydrated.projections[owner].valid) fail('comparison_ev_source_unavailable')
  const ev = hydrated.projections[owner].artifact!
  const contract = owner === 'l4_alpha_ev' ? L4_ALPHA_EV_CONTRACT : ALLOCATOR_EV_FUSION_CONTRACT
  const evIdentity = [{ expected_return_owner: owner, expected_return_model_version: ev.model_version,
    expected_return_trained_until: ev.trained_until, expected_return_contract_version: contract.artifactContractVersion,
    expected_return_semantic: contract.expectedReturnSemantic }]
  return { current, formal, evIdentity, fence: fence.token }
}

async function prior(db: D1Database, identity: OpbNavIdentity, gate: RecordValue) {
  if (!identity.artifactId || !/^[0-9a-f]{64}$/.test(identity.artifactChecksum)) fail('identity_invalid')
  const row = await db.prepare('SELECT * FROM model_artifact_registry WHERE artifact_id=? AND checksum=?')
    .bind(identity.artifactId, identity.artifactChecksum).first<RecordValue>()
  const raw = gate.candidate_payload_json
  if (!row || row.model_name !== OWNER || row.candidate_type !== 'opb_arm_prior_refresh'
    || typeof raw !== 'string' || await hash(raw) !== identity.artifactChecksum) fail('source_identity_invalid')
  const artifact = JSON.parse(raw)
  if (artifact.schema_version !== 'opb-arm-prior-artifact-v3' || artifact.artifact_id !== identity.artifactId
    || artifact.model_version !== row.version || identity.artifactId !== `${OWNER}:${row.version}`
    || artifact.trained_until !== row.source_run_date || gate.source_run_date !== row.source_run_date
    || row.training_run_id !== `opb_arm_prior_refresh:${row.source_run_date}:${artifact.expected_return_owner}`
    || !same(JSON.parse(row.offline_evidence_json ?? 'null'), artifact)) fail('source_metadata_invalid')
  return { row, artifact }
}
export { prior as verifyOpbPriorSource }

export async function readOpbNavCommitReceipt(db: D1Database, identity: OpbNavIdentity): Promise<OpbNavCommitReceipt | null> {
  const pointer = await db.prepare('SELECT * FROM model_champion_pointers WHERE model_name=?')
    .bind(OWNER).first<RecordValue>()
  if (!pointer || pointer.champion_artifact_id !== identity.artifactId) return null
  const evidence = JSON.parse(pointer.promotion_evidence_json ?? 'null')
  if (!evidence || evidence.schema_version !== SCHEMA || evidence.owner !== OWNER
    || evidence.artifact_id !== identity.artifactId || evidence.artifact_checksum !== identity.artifactChecksum
    || evidence.gate?.decision !== 'PASS' || evidence.gate.nav_validation?.decision !== 'PASS'
    || evidence.decision_checksum !== evidence.gate.evaluation_evidence_checksum
    || evidence.decision_checksum !== evidence.gate.nav_validation.decision_checksum) fail('commit_receipt_invalid')
  const { row, artifact } = await prior(db, identity, evidence.gate)
  const history = (await db.prepare('SELECT * FROM model_champion_history WHERE model_name=? AND retired_at IS NULL')
    .bind(OWNER).all<RecordValue>()).results ?? []
  if (row.state !== 'production' || pointer.champion_version !== artifact.model_version
    || pointer.promotion_reason !== SCHEMA || history.length !== 1
    || history[0].artifact_id !== identity.artifactId || history[0].version !== artifact.model_version
    || history[0].event_id !== `opb-nav:${identity.artifactChecksum}:${evidence.decision_checksum}`
    || history[0].evidence_grade !== 'exact' || history[0].source !== 'model_champion_history'
    || history[0].evidence_json !== pointer.promotion_evidence_json) fail('commit_readback_mismatch')
  return { artifact_id: identity.artifactId, artifact_checksum: identity.artifactChecksum,
    model_version: artifact.model_version, previous_version: pointer.rollback_version ?? null,
    payload_checksum: await hash(pointer.promotion_evidence_json), evidence }
}

/** Observe an UNPUBLISHED comparison using original proof and current owners.
 * A verified context change waits for the next frozen comparison, not a retry
 * of the old PASS. Missing/corrupt/racing sources still throw. No writes.
 * Existing publications deliberately bypass this path and must recover through
 * their original live projection/control checks; this is not a failure bypass.
 */
export async function inspectOpbNavComparison(db: D1Database, input: OpbNavIdentity & {
  gate: RecordValue; currentConfigReader: NavCurrentConfigReader; navBindings?: import('../types').Bindings;
}, now = new Date()): Promise<RecordValue | null> {
  if (await readOpbNavCommitReceipt(db, input)) return null
  const candidate = await prior(db, input, input.gate)
  if (['archived', 'rejected', 'production'].includes(candidate.row.state)) fail('candidate_not_adoptable')
  const proof = await verifyNavPromotionEvidence(db, { owner: OWNER, artifactId: input.artifactId,
    artifactChecksum: input.artifactChecksum, gate: input.gate }, now)
  const frozen = originalNavComparisonContext(proof)
  const keys = ['artifact_id', 'cohort_id', 'payload_checksum', 'base_artifact_set_checksum']
  const readSource = () => readOpbComparisonSource(db, input.currentConfigReader)
  const observed = await readSource()
  const changed = [
    ...(!same(observed.current.tradingConfig, frozen.configuration.trading_config) ? ['trading_config'] : []),
    ...(!same(observed.current.riskConfig, frozen.configuration.risk_config) ? ['risk_config'] : []),
    ...(keys.some(key => observed.formal[key] !== frozen.configuration.formal_baseline_identity[key]) ? ['formal_ml'] : []),
    ...(!same(observed.evIdentity, frozen.configuration.opb_serving_ev_identity) ? ['serving_ev'] : []),
  ]
  if (!changed.length) return null // Original publisher retains all commit-time checks.
  // Verify CURRENT ML first; a broken pointer is not a legitimate new baseline.
  await verifyNavFormalBaseline(db, observed.formal, input.navBindings)
  const repeated = await readSource()
  await verifyNavFormalBaseline(db, repeated.formal, input.navBindings)
  if (!same(observed, repeated) || !same(candidate, await prior(db, input, input.gate))
    || await readOpbNavCommitReceipt(db, input)) fail('comparison_source_changed_during_read')
  const body = { schema_version: 'opb-nav-comparison-observation-v1', owner: OWNER,
    artifact_id: input.artifactId, artifact_checksum: input.artifactChecksum, as_of_date: proof.asOfDate,
    decision_checksum: proof.decisionChecksum, frozen_configuration_checksum: input.gate.nav_validation.configuration_checksum,
    current_context_checksum: await hash(JSON.stringify(canonical(observed))), changed_fields: changed,
    state: 'baseline_changed', reason: 'awaiting_next_frozen_comparison',
    source: 'original_nav_proof_and_current_ml_ev_config', read_only: true,
    promotion_allowed: false, nav_maturity_credit: 0 }
  return { ...body, observation_checksum: await hash(JSON.stringify(canonical(body))) }
}

export async function commitOpbNavChampion(db: D1Database, input: OpbNavIdentity & {
  gate: RecordValue; currentConfigReader: NavCurrentConfigReader; navBindings?: import('../types').Bindings;
}, now = new Date()): Promise<OpbNavCommitReceipt> {
  // Recover ONLY an exact already committed receipt, not a new economic review.
  const existing = await readOpbNavCommitReceipt(db, input)
  if (existing) return existing
  const { row, artifact } = await prior(db, input, input.gate)
  if (['archived', 'rejected', 'production'].includes(row.state)) fail('candidate_not_adoptable')
  const proof = await verifyNavPromotionEvidence(db, { owner: OWNER, artifactId: input.artifactId,
    artifactChecksum: input.artifactChecksum, gate: input.gate }, now)
  const frozen = originalNavComparisonContext(proof)
  const current = await input.currentConfigReader()
  const context = await verifyNavCurrentContext(db, proof, async () => current, input.navBindings)
  const fence = await db.prepare(EV_FENCE).first<{ token: string }>()
  if (!fence?.token) fail('serving_fence_missing')
  const hydrated = await hydrateExpectedReturnConfigFromPointers(db, current.tradingConfig)
  const guard = await loadExpectedReturnForwardGuard(db)
  const state = resolveExpectedReturnServingState(hydrated.config, {
    pointerProjections: hydrated.projections, forwardGuard: guard })
  const owner = state.expected_return_owner
  if (!owner || owner !== artifact.expected_return_owner) fail('serving_owner_changed')
  const serving = hydrated.projections[owner]
  const contract = owner === 'l4_alpha_ev' ? L4_ALPHA_EV_CONTRACT : ALLOCATOR_EV_FUSION_CONTRACT
  const expected = [{ expected_return_owner: owner, expected_return_model_version: serving.artifact?.model_version,
    expected_return_trained_until: serving.artifact?.trained_until,
    expected_return_contract_version: contract.artifactContractVersion,
    expected_return_semantic: contract.expectedReturnSemantic }]
  if (!same(frozen.configuration.opb_serving_ev_identity, expected)
    || artifact.source_expected_return_contract_version !== contract.artifactContractVersion
    || artifact.source_expected_return_semantic !== contract.expectedReturnSemantic) fail('serving_ev_identity_changed')
  const previous = await db.prepare('SELECT * FROM model_champion_pointers WHERE model_name=?')
    .bind(OWNER).first<RecordValue>()
  const evidence = JSON.stringify({ schema_version: SCHEMA, owner: OWNER,
    artifact_id: input.artifactId, artifact_checksum: input.artifactChecksum,
    decision_checksum: proof.decisionChecksum, gate: input.gate,
    baseline_checksum: frozen.baseline_checksum, configuration: frozen.configuration,
    serving_ev_identity: expected, serving_fence: fence.token })
  const statements = [
    navJournalFrontierGuard(db, proof),
    navPointerCompareAndSwapGuard(db, proof, context, previous?.champion_artifact_id ?? null),
    db.prepare(`SELECT CASE WHEN (${EV_FENCE})=? THEN 1 ELSE json('opb_nav_ev_context_changed') END`)
      .bind(fence.token),
    db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM model_artifact_registry
      WHERE artifact_id=? AND checksum=? AND state=? AND version=? AND model_name=?
        AND candidate_type=? AND source_run_date=? AND training_run_id=?
        AND offline_evidence_json=? AND live_evidence_json=?)
      THEN 1 ELSE json('opb_nav_candidate_changed') END`).bind(input.artifactId, input.artifactChecksum,
        row.state, row.version, OWNER, row.candidate_type, row.source_run_date, row.training_run_id,
        row.offline_evidence_json, row.live_evidence_json),
    db.prepare(`UPDATE model_artifact_registry SET state='archived',promotion_decision='replaced_by_opb_nav_champion',
      updated_at=CURRENT_TIMESTAMP WHERE model_name=? AND state='production' AND artifact_id!=?`).bind(OWNER, input.artifactId),
    db.prepare(`UPDATE model_artifact_registry SET state='production',live_gate_status='promoted',
      promotion_decision=?,approval_state='not_required',updated_at=CURRENT_TIMESTAMP WHERE artifact_id=?`)
      .bind(SCHEMA, input.artifactId),
    db.prepare(`INSERT INTO model_champion_pointers(model_name,champion_version,champion_artifact_id,
      rollback_version,rollback_artifact_id,promotion_reason,promotion_evidence_json)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(model_name) DO UPDATE SET
      champion_version=excluded.champion_version,champion_artifact_id=excluded.champion_artifact_id,
      rollback_version=excluded.rollback_version,rollback_artifact_id=excluded.rollback_artifact_id,
      promotion_reason=excluded.promotion_reason,promotion_evidence_json=excluded.promotion_evidence_json,
      promoted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP`).bind(OWNER, row.version, input.artifactId,
        previous?.champion_version ?? null, previous?.champion_artifact_id ?? null, SCHEMA, evidence),
    db.prepare('UPDATE model_champion_history SET retired_at=CURRENT_TIMESTAMP WHERE model_name=? AND retired_at IS NULL').bind(OWNER),
    db.prepare(`INSERT INTO model_champion_history(event_id,model_name,version,artifact_id,effective_at,
      source,evidence_grade,evidence_json) VALUES(?,?,?,?,CURRENT_TIMESTAMP,'model_champion_history','exact',?)`)
      .bind(`opb-nav:${input.artifactChecksum}:${proof.decisionChecksum}`, OWNER, row.version, input.artifactId, evidence),
  ]
  const result = await db.batch(statements)
  if (result.length !== statements.length || result.some(r => r.success !== true)) fail('commit_batch_incomplete')
  const receipt = await readOpbNavCommitReceipt(db, input)
  if (!receipt || receipt.payload_checksum !== await hash(evidence)) fail('commit_readback_mismatch')
  return receipt
}

function withoutOpbControl(config: RecordValue) {
  const out = structuredClone(config)
  for (const root of [out.alphaFramework, out.alpha_framework]) {
    if (!root?.allocation) continue
    delete root.allocation.opbArmPrior
    delete root.allocation.opb_arm_prior
    delete root.allocation.controller
  }
  return out
}

function opbPrior(config: RecordValue) {
  const allocation = (config.alphaFramework ?? config.alpha_framework)?.allocation ?? {}
  return Object.hasOwn(allocation, 'opbArmPrior') ? allocation.opbArmPrior : allocation.opb_arm_prior ?? null
}

function opbController(config: RecordValue) {
  return (config.alphaFramework ?? config.alpha_framework)?.allocation?.controller
}

/** Reconcile the original immutable receipt, never synthesize offline/control PASS.
 * D1 is authoritative; KV is a recoverable projection, not an atomic second store.
 */
export async function projectOpbNavChampion(db: D1Database, kv: KVNamespace,
  receipt: OpbNavCommitReceipt, readCurrent: NavCurrentConfigReader, env?: import('../types').Bindings) {
  const identity = { artifactId: receipt.artifact_id, artifactChecksum: receipt.artifact_checksum }
  const artifact = JSON.parse(receipt.evidence.gate.candidate_payload_json)
  const frozen = receipt.evidence.configuration
  const assertCurrent = async () => {
    const actual = await readOpbNavCommitReceipt(db, identity)
    if (!actual || actual.payload_checksum !== receipt.payload_checksum) fail('projection_pointer_changed')
    await verifyNavFormalBaseline(db, frozen.formal_baseline_identity, env)
    const fence = await db.prepare(EV_FENCE).first<{ token: string }>()
    if (!fence || fence.token !== receipt.evidence.serving_fence) fail('projection_ev_changed')
    const current = await readCurrent()
    if (!same(current.riskConfig, frozen.risk_config)
      || !same(withoutOpbControl(current.tradingConfig), withoutOpbControl(frozen.trading_config))
      || ![opbController(frozen.trading_config), 'OnlinePortfolioBandit'].includes(opbController(current.tradingConfig))
      || ![opbPrior(frozen.trading_config), artifact].some(value => same(value, opbPrior(current.tradingConfig)))) {
      fail('projection_configuration_changed')
    }
    return current
  }
  const current = await assertCurrent()
  const config = structuredClone(current.tradingConfig)
  config.alphaFramework.allocation.opbArmPrior = artifact
  // The original NAV candidate runs the OPB controller, not merely a stored
  // prior. Adopt exactly that tested intervention; all other knobs stay fixed.
  config.alphaFramework.allocation.controller = 'OnlinePortfolioBandit'
  delete config.alphaFramework.allocation.opb_arm_prior
  const errors = validateTradingConfig(config as any)
  if (errors.length) fail(`projection_config_invalid:${errors.join(',')}`)
  const previousRaw = await kv.get('trading:config', 'json')
  const verifyCurrent = async () => {
    await assertCurrent()
    if (!same(await kv.get('trading:config', 'json'), config)) fail('control_config_changed')
  }
  if (same(previousRaw, config)) {
    await verifyCurrent()
    return { snapshot: null, config, verifyCurrent } // Exact recovery is read-only, not another config version.
  }
  const snapshot = await setTradingConfig(kv, config as any, {
    source: SCHEMA, push_id: `${receipt.artifact_checksum}:${receipt.evidence.decision_checksum}`,
  }, async () => {
    await assertCurrent()
    if (!same(await kv.get('trading:config', 'json'), previousRaw)) fail('projection_config_raced')
  })
  // A dropped write, lost ACK or changed serving baseline is not closure.
  if (!same(await kv.get('trading:config', 'json'), config)) fail('projection_readback_mismatch')
  await assertCurrent()
  return { snapshot, config, verifyCurrent }
}

/** Read the original formal allocation seal, not a new efficacy gate or queue.
 * Publication may finish before the next allocation; an existing failed run
 * must never be replaced by an older success or labelled normal waiting.
 */
export async function readOpbNavControlExecution(db: D1Database, receipt: OpbNavCommitReceipt,
  config: RecordValue, now = new Date()) {
  const history = await db.prepare('SELECT effective_at FROM model_champion_history WHERE model_name=? AND retired_at IS NULL')
    .bind(OWNER).first<RecordValue>()
  const rawTime = history?.effective_at
  const published = typeof rawTime === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(rawTime)
    ? rawTime.replace(' ', 'T') + 'Z' : rawTime
  const timestamp = (value: any) => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    ? Date.parse(value) : NaN
  const publishedAt = timestamp(published)
  if (!Number.isFinite(publishedAt) || publishedAt > now.getTime()) fail('control_publication_clock_invalid')
  const publishedDay = new Date(publishedAt + 8 * 3600000).toISOString().slice(0, 10)
  const base = { publication_receipt_checksum: receipt.payload_checksum,
    artifact_id: receipt.artifact_id, artifact_checksum: receipt.artifact_checksum,
    published_at: published, can_write_order: false }
  let cursorTime: string | null = null, cursorId = ''
  for (;;) {
    const rows = (await db.prepare(`SELECT * FROM paired_nav_frozen_manifests_v1
      WHERE snapshot_kind='allocation_context' AND prospective=1
        AND julianday(frozen_at)>=julianday(?) AND julianday(frozen_at)<=julianday(?)
        AND (? IS NULL OR julianday(frozen_at)<julianday(?)
          OR (julianday(frozen_at)=julianday(?) AND snapshot_id<?))
      ORDER BY julianday(frozen_at) DESC,snapshot_id DESC LIMIT 32`)
      .bind(published, now.toISOString(), cursorTime, cursorTime, cursorTime, cursorId)
      .all<RecordValue>()).results ?? []
    if (!rows.length) break
    for (const manifest of rows) {
      if (!Number.isInteger(manifest.part_count) || manifest.part_count < 1) fail('control_parts_invalid')
      const parts = (await db.prepare('SELECT part_no,payload_text FROM paired_nav_frozen_parts_v1 WHERE snapshot_id=? ORDER BY part_no')
        .bind(manifest.snapshot_id).all<RecordValue>()).results ?? []
      if (parts.length !== manifest.part_count || parts.some((part, i) => part.part_no !== i || typeof part.payload_text !== 'string'))
        fail('control_parts_missing')
      const raw = parts.map(part => part.payload_text).join('')
      if (await hash(raw) !== manifest.payload_checksum) fail('control_snapshot_checksum_mismatch')
      const payload = JSON.parse(raw), parent = payload.content
      const frozenAt = timestamp(manifest.frozen_at)
      if (!parent || payload.schema_version !== 'paired-nav-journal-v1'
        || payload.signal_date !== manifest.signal_date || payload.source_run_id !== manifest.source_run_id
        || payload.snapshot_kind !== 'allocation_context' || !Number.isFinite(frozenAt)
        || frozenAt > now.getTime()) fail('control_snapshot_identity_invalid')
      if (parent.upstream_allocation_context_snapshot_id) continue // Not a second formal run.
      const source = parent.inputs?.nav_control_context
      if (!source) {
        // A same-day allocation already in flight may predate publication.
        // A new config / later daily run without this source is a real gap.
        if (opbPrior(parent.trading_config ?? {})?.artifact_id === receipt.artifact_id
          || manifest.signal_date > publishedDay) fail('control_source_missing_after_publication')
        continue
      }
      const observedAt = timestamp(source.observed_at)
      if (!Number.isFinite(observedAt) || observedAt > frozenAt) fail('control_observation_clock_invalid')
      if (observedAt < publishedAt) continue // Original in-flight allocation, not a backfilled grant.
      const record = source.record
      if (!record || typeof record.promotion_evidence_json !== 'string'
        || await hash(record.promotion_evidence_json) !== receipt.payload_checksum
        || record.champion_artifact_id !== receipt.artifact_id || record.checksum !== receipt.artifact_checksum
        || !same(parent.trading_config, config) || !same(source.trading_config, config)
        || !same(parent.risk_config, receipt.evidence.configuration.risk_config)
        || !same(source.risk_config, parent.risk_config)
        || !same(parent.inputs?.ranking_config, config.ranking ?? {})
        || !same(parent.inputs?.ensemble_v2_cfg, config.ensemble_v2 ?? {})
        || !same(parent.formal_baseline_identity, receipt.evidence.configuration.formal_baseline_identity))
        fail('control_source_changed')
      const capture = parent.capture ?? {}, actual = parent.opb_control_execution ?? {}
      const packet = capture.opb_packet ?? {}, prior = packet.prior_artifact ?? {}, contract = capture.allocation_contract ?? {}
      const disabled = config.ranking?.enabled === false && parent.inputs?.ranking_config?.enabled === false
        && capture.status === 'allocation_disabled_by_frozen_config'
      const empty = Array.isArray(capture.allocation_candidates) && capture.allocation_candidates.length === 0
      const executed = packet.status === 'ok' && contract.controller_effective === 'OnlinePortfolioBandit'
        && contract.opb_production_control_allowed === true && prior.production_control_ready === true
        && prior.candidate_checksum === receipt.artifact_checksum && prior.publication_receipt_checksum === receipt.payload_checksum
      const expectedStatus = disabled || empty ? 'not_applicable' : executed ? 'completed' : 'failed'
      if (actual.artifact_id !== receipt.artifact_id || actual.artifact_checksum !== receipt.artifact_checksum
        || actual.publication_receipt_checksum !== receipt.payload_checksum || actual.can_write_order !== false
        || actual.status !== expectedStatus || actual.control_executed !== (expectedStatus === 'completed')
        || expectedStatus === 'not_applicable' && actual.reason !== 'no_enabled_eligible_allocation'
        || expectedStatus === 'failed' && actual.reason !== 'paired_nav_opb_control_execution_incomplete')
        fail('control_execution_receipt_invalid')
      return { ...base, ...actual, snapshot_id: manifest.snapshot_id, payload_checksum: manifest.payload_checksum,
        signal_date: manifest.signal_date, frozen_at: manifest.frozen_at }
    }
    const last = rows[rows.length - 1]
    cursorTime = last.frozen_at; cursorId = last.snapshot_id
  }
  return { ...base, status: 'awaiting_next_allocation', control_executed: false,
    reason: 'publication_precedes_next_allocation', snapshot_id: null, payload_checksum: null }
}
