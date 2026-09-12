/** Original NAV authority -> original registry AND daily policy, one D1 batch. */
import type { Bindings } from '../types'
import type { StrategySpecRegistryRow } from './strategyLearning'
import { registryRowToStrategySpec } from './strategyLearning'
import { verifyNavPolicyPromotionEvidence, originalNavComparisonContext, navJournalFrontierGuard } from './pairedNavPromotionEvidence'
import { verifyNavCurrentContext, navPointerCompareAndSwapGuard, type NavCurrentConfigReader } from './pairedNavPromotionContext'
import { readCurrentCanonicalAtomicPolicy } from './atomicStrategySource'
import { readNavRouteDependency } from './navRouteDependency'
import { paperExecutionNow } from './paperExecutionScope'
import { STRATEGY_PRODUCTION_FIREWALL_POLICY_ID } from './strategyProductionContributionFirewall'
import { captureStrategyWeightSource, replayStrategyWeightSource, STRATEGY_PRODUCTION_WEIGHT_KERNEL } from './strategyProductionWeightReplay'
import { prepareStrategyProductionPolicyWrite, verifyStrategyProductionPolicyRecord,
  sha256StrategyProductionPolicyPayload, type StrategyProductionPolicyHistoryRow } from './strategyProductionPolicyStore'
import { ATOMIC_NAV_RECEIPT_SCHEMA, atomicNavCanonical, atomicNavDigest, readAtomicNavPublication, atomicNavSupersessionPath } from './strategyAtomicNavReceipt'

type Row = Record<string, any>
const registrySql = `SELECT * FROM strategy_spec_registry WHERE status<>'retired' ORDER BY strategy_id,version`
const latestPolicySql = `SELECT * FROM strategy_production_policy_history_v1
  WHERE policy_id=? AND status='active' AND knowledge_cutoff_date<=?
  ORDER BY knowledge_cutoff_date DESC,created_at DESC,checksum DESC LIMIT 1`
const specsFor = (rows: StrategySpecRegistryRow[]) => rows.map(registryRowToStrategySpec)
  .sort((a, b) => a.id.localeCompare(b.id))
const sortedSpecs = (specs: any[]) => [...specs].sort((a, b) => a.id.localeCompare(b.id))
const same = (a: any, b: any) => atomicNavCanonical(a) === atomicNavCanonical(b)
const fail = (reason: string): never => { throw new Error('strategy_atomic_nav_' + reason) }
const registryRows = async (db: D1Database) => (await db.prepare(registrySql).all<StrategySpecRegistryRow>()).results ?? []
const receiptRow = (db: D1Database, checksum: string) => db.prepare(
  'SELECT * FROM strategy_atomic_nav_adoptions_v1 WHERE artifact_checksum=?').bind(checksum).first<Row>()

function rowGuard(db: D1Database, table: string, row: Row) {
  const keys = Object.keys(row)
  return db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM ${table}
    WHERE ${keys.map(key => `${key} IS ?`).join(' AND ')})
    THEN 1 ELSE json('strategy_atomic_nav_source_changed') END`).bind(...keys.map(key => row[key]))
}

async function publication(db: D1Database, payload: Row, recovered: boolean) {
  const row = await receiptRow(db, payload.artifact_checksum)
  if (!row) fail('receipt_missing')
  const { receipt, policy } = await readAtomicNavPublication(db, row!)
  if (receipt.artifact_id !== payload.artifact_id) fail('receipt_identity_changed')
  const current = specsFor(await registryRows(db))
  const currentChecksum = await atomicNavDigest(current)
  const supersession = await atomicNavSupersessionPath(db, receipt.after_registry_checksum, currentChecksum)
  if (await atomicNavDigest(specsFor(await registryRows(db))) !== currentChecksum) fail('registry_changed_during_recovery')
  return { complete: true, status: 'completed', completion_scope: 'publication', owner: 'atomic_strategy',
    artifact_id: row!.artifact_id, artifact_checksum: row!.artifact_checksum,
    pointer_committed: true, serving_readers_verified: true, recovered_existing_commit: recovered,
    publication_receipt_checksum: row!.receipt_checksum, source: 'original_registry_and_policy_reader',
    publication_state: supersession.length ? 'superseded' : 'current',
    current_registry_checksum: currentChecksum, supersession_receipt_checksums: supersession,
    policy: { checksum: policy.checksum, knowledge_cutoff_date: policy.state.knowledge_cutoff_date,
      created_at: policy.created_at, weights: policy.state.strategy_weights },
    // The original serving reader uses created_at < next decision date. This
    // publication receipt does NOT assert that a screener has already run it.
    serving_activation_verified: false }
}

export async function adoptNavAtomicStrategy(db: D1Database, env: Bindings, request: Row,
  readCurrent: NavCurrentConfigReader, now = new Date()) {
  const observationClockOrigin = paperExecutionNow()
  const payload = structuredClone(request)
  if (!payload || typeof payload.artifact_id !== 'string' || !/^[a-f0-9]{64}$/.test(payload.artifact_checksum)) fail('identity_invalid')
  if (await receiptRow(db, payload.artifact_checksum)) return publication(db, payload, true)
  const { proof, gate, policyDefinition } = await verifyNavPolicyPromotionEvidence(db, env,
    { owner: 'atomic_strategy', payload },
    new Date(now.getTime() + Math.max(0, paperExecutionNow() - observationClockOrigin)))
  if (policyDefinition.weight_policy_version !== STRATEGY_PRODUCTION_WEIGHT_KERNEL
    || await atomicNavDigest(policyDefinition) !== payload.artifact_checksum
    || payload.artifact_id !== `atomic_strategy:${payload.artifact_checksum}`) fail('executable_policy_mismatch')
  const frozen = originalNavComparisonContext(proof)
  const currentSource = await readCurrentCanonicalAtomicPolicy(env, proof.asOfDate, now)
  if (!same(currentSource.policyContext.identity, frozen.configuration.atomic_policy_identity)
    || currentSource.policyContext.policy_checksum !== frozen.baseline_checksum) fail('current_recipe_changed')
  const routeDependency = await readNavRouteDependency(db, currentSource.source.inputs.options.promotedRouteCalibration)
  if (!routeDependency.matches) fail('route_changed')
  const rows = await registryRows(db)
  const specs = specsFor(rows)
  if (!specs.length || new Set(specs.map(spec => spec.id)).size !== specs.length
    || !same(specs, sortedSpecs(currentSource.policyContext.identity.specs))) fail('current_registry_changed')
  const prior = await db.prepare(latestPolicySql).bind(STRATEGY_PRODUCTION_FIREWALL_POLICY_ID, proof.asOfDate)
    .first<StrategyProductionPolicyHistoryRow>()
  if (!prior || !Number.isFinite(Date.parse(prior.created_at)) || Date.parse(prior.created_at) > now.getTime()) fail('current_policy_missing_or_future')
  const previous = await verifyStrategyProductionPolicyRecord(prior!, specs.map(spec => spec.id))
  if (previous.state.policy_id !== STRATEGY_PRODUCTION_FIREWALL_POLICY_ID) fail('legacy_policy_not_adoptable')
  const source = 'evidence_owner' in previous.state.evidence ? previous.state.evidence.evidence_owner?.weight_source : undefined
  if (!source || !same(sortedSpecs([...source.inputs.strategies]), specs)) fail('current_weight_source_changed')
  const replacement = policyDefinition.replacement
  if (!same(policyDefinition.candidate, specs.find(spec => spec.id === replacement.candidateId))
    || !same(policyDefinition.incumbent, specs.find(spec => spec.id === replacement.incumbentId))) fail('definition_registry_changed')
  const replay = await replayStrategyWeightSource(source!, replacement)
  const state = replay.state
  state.evidence.evidence_owner!.weight_source = await captureStrategyWeightSource(replay.inputs, state)
  state.canonical_payload = JSON.stringify({ ...JSON.parse(state.canonical_payload), evidence_owner: state.evidence.evidence_owner })
  const prepared = await prepareStrategyProductionPolicyWrite(db, state)
  const context = await verifyNavCurrentContext(db, proof, readCurrent, env)
  const after = sortedSpecs([...replay.inputs.strategies])
  const receipt = { schema_version: ATOMIC_NAV_RECEIPT_SCHEMA, artifact_id: payload.artifact_id,
    artifact_checksum: payload.artifact_checksum, policy_definition: policyDefinition, gate,
    before_registry_checksum: await atomicNavDigest(specs), after_registry_checksum: await atomicNavDigest(after),
    previous_policy_checksum: previous.checksum, policy_checksum: prepared.checksum,
    knowledge_cutoff_date: state.knowledge_cutoff_date,
    canonical_source_checksum: currentSource.source.source_checksum }
  const receiptJson = JSON.stringify(receipt)
  const statements = [navPointerCompareAndSwapGuard(db, proof, context, null), navJournalFrontierGuard(db, proof),
    ...routeDependency.statements,
    db.prepare(`SELECT CASE WHEN (SELECT COUNT(*) FROM strategy_spec_registry WHERE status<>'retired')=?
      THEN 1 ELSE json('strategy_atomic_nav_registry_count_changed') END`).bind(rows.length),
    ...rows.map(row => rowGuard(db, 'strategy_spec_registry', row)),
    rowGuard(db, 'strategy_production_policy_history_v1', prior!),
    db.prepare(`SELECT CASE WHEN (${latestPolicySql.replace('SELECT *', 'SELECT checksum')})=?
      THEN 1 ELSE json('strategy_atomic_nav_latest_policy_changed') END`)
      .bind(STRATEGY_PRODUCTION_FIREWALL_POLICY_ID, proof.asOfDate, previous.checksum),
    db.prepare(`UPDATE strategy_spec_registry SET status='active',promotion_status='production',updated_at=CURRENT_TIMESTAMP
      WHERE strategy_id=? AND version=? AND status='candidate' AND promotion_status='candidate' AND owner_type='strategy'`)
      .bind(replacement.candidateId, replacement.candidateVersion),
    db.prepare(`UPDATE strategy_spec_registry SET status='candidate',promotion_status='candidate',updated_at=CURRENT_TIMESTAMP
      WHERE strategy_id=? AND version=? AND status='active' AND promotion_status='production' AND owner_type='strategy'`)
      .bind(replacement.incumbentId, replacement.incumbentVersion),
    db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM strategy_spec_registry WHERE strategy_id=? AND version=? AND status='active' AND promotion_status='production')
      AND EXISTS(SELECT 1 FROM strategy_spec_registry WHERE strategy_id=? AND version=? AND status='candidate' AND promotion_status='candidate')
      AND (SELECT COUNT(*) FROM strategy_spec_registry WHERE status='active')=?
      THEN 1 ELSE json('strategy_atomic_nav_roles_not_committed') END`)
      .bind(replacement.candidateId, replacement.candidateVersion, replacement.incumbentId, replacement.incumbentVersion,
        specs.filter(spec => spec.status === 'active').length),
    ...prepared.statements,
    db.prepare(`SELECT CASE WHEN (${latestPolicySql.replace('SELECT *', 'SELECT checksum')})=?
      THEN 1 ELSE json('strategy_atomic_nav_new_policy_not_current') END`)
      .bind(STRATEGY_PRODUCTION_FIREWALL_POLICY_ID, proof.asOfDate, prepared.checksum),
    db.prepare(`INSERT INTO strategy_atomic_nav_adoptions_v1
      (artifact_checksum,artifact_id,decision_checksum,policy_checksum,knowledge_cutoff_date,receipt_json,receipt_checksum)
      VALUES(?,?,?,?,?,?,?)`).bind(payload.artifact_checksum, payload.artifact_id, proof.decisionChecksum,
        prepared.checksum, state.knowledge_cutoff_date, receiptJson, await sha256StrategyProductionPolicyPayload(receiptJson)),
  ]
  const lastSource = await readCurrentCanonicalAtomicPolicy(env, proof.asOfDate, now)
  if (lastSource.source.source_checksum !== currentSource.source.source_checksum) fail('source_changed_before_commit')
  await verifyNavCurrentContext(db, proof, readCurrent, env)
  const result = await db.batch(statements)
  if (result.length !== statements.length || result.some(row => !row.success)) fail('publication_incomplete')
  await prepared.verifyCommitted()
  return publication(db, payload, false)
}
