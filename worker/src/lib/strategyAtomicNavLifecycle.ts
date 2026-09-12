/** Read-only lifecycle reconciliation for the ORIGINAL Atomic publisher. */
import type { Bindings } from '../types'
import { registryRowToStrategySpec, type StrategySpecRegistryRow } from './strategyLearning'
import { readCurrentCanonicalAtomicPolicy } from './atomicStrategySource'
import { atomicNavDigest, readAtomicNavPublication, atomicNavSupersessionPath } from './strategyAtomicNavReceipt'
import { observeAtomicCanonicalUse } from './navScreenerObservation'
import { readNavRouteDependency } from './navRouteDependency'
import { inspectNavPolicyCandidate, originalNavComparisonContext } from './pairedNavPromotionEvidence'
import { verifyNavFormalBaseline, type NavCurrentConfigReader } from './pairedNavPromotionContext'
import { paperExecutionNow } from './paperExecutionScope'

type Row = Record<string, any>
const fail = (reason: string): never => { throw new Error('strategy_atomic_nav_' + reason) }
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const ordered = (specs: any[]) => specs.sort((a, b) => a.id.localeCompare(b.id))

async function currentExecutionContext(db: D1Database, env: Bindings, readCurrent?: NavCurrentConfigReader) {
  if (!readCurrent) fail('reconciliation_config_reader_missing')
  const current = await readCurrent!()
  if (!current?.tradingConfig || !current.riskConfig || typeof current.tradingConfig !== 'object'
    || typeof current.riskConfig !== 'object' || Array.isArray(current.tradingConfig)
    || Array.isArray(current.riskConfig)) fail('reconciliation_current_context_missing')
  const formal = await db.prepare(`SELECT artifact_id,cohort_id,payload_checksum,base_artifact_set_checksum
    FROM active8_ensemble_pointer_v1 WHERE singleton_id=1`).first<Row>()
  if (!formal) fail('reconciliation_current_ml_missing')
  // A missing/corrupt current source is an ERROR, not a normal baseline change.
  await verifyNavFormalBaseline(db, formal!, env)
  return { current, formal: formal!, checksum: await atomicNavDigest({ current, formal }) }
}

export async function reconcileAtomicNavCandidates(db: D1Database, env: Bindings,
  input: { business_date: string; candidates: Row[] }, now = new Date(), readCurrent?: NavCurrentConfigReader) {
  const observationClockOrigin = paperExecutionNow()
  const request = structuredClone(input), seen = new Set<string>()
  const today = new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
  if (!request || !/^\d{4}-\d{2}-\d{2}$/.test(request.business_date)
    || !Number.isFinite(Date.parse(request.business_date))
    || new Date(request.business_date).toISOString().slice(0, 10) !== request.business_date || request.business_date > today
    || !Array.isArray(request.candidates) || !request.candidates.length) fail('reconciliation_request_invalid')
  for (const item of request.candidates) {
    if (!item || !hash(item.artifact_checksum) || item.artifact_id !== `atomic_strategy:${item.artifact_checksum}`
      || seen.has(item.artifact_checksum)
      || Object.keys(item).sort().join(',') !== 'artifact_checksum,artifact_id,baseline_checksum') fail('reconciliation_identity_invalid')
    seen.add(item.artifact_checksum)
  }
  const registry = async () => ordered(((await db.prepare(`SELECT * FROM strategy_spec_registry
    WHERE status<>'retired' ORDER BY strategy_id,version`).all<StrategySpecRegistryRow>()).results ?? []).map(registryRowToStrategySpec))
  const current = await registry()
  if (!current.length || new Set(current.map(spec => spec.id)).size !== current.length) fail('reconciliation_registry_invalid')
  const currentChecksum = await atomicNavDigest(current)
  const source = await readCurrentCanonicalAtomicPolicy(env, request.business_date, now)
  const routeDependency = await readNavRouteDependency(db, source.source.inputs.options.promotedRouteCalibration)
  const sourceRegistryChecksum = await atomicNavDigest(ordered([...source.policyContext.identity.specs]))
  const sourceSupersession = await atomicNavSupersessionPath(db, sourceRegistryChecksum, currentChecksum)
  const entries = []
  let executionContext: Awaited<ReturnType<typeof currentExecutionContext>> | null = null
  for (const item of request.candidates) {
    const row = await db.prepare('SELECT * FROM strategy_atomic_nav_adoptions_v1 WHERE artifact_checksum=?')
      .bind(item.artifact_checksum).first<Row>()
    const identity = { artifact_id: item.artifact_id, artifact_checksum: item.artifact_checksum }
    if (row) {
      const publication = await readAtomicNavPublication(db, row)
      if (publication.receipt.artifact_id !== item.artifact_id) fail('reconciliation_receipt_identity_changed')
      const path = await atomicNavSupersessionPath(db, publication.receipt.after_registry_checksum, currentChecksum)
      entries.push({ ...identity, state: path.length ? 'published_superseded' : 'published',
        reason: 'original_publication_verified', publication_receipt_checksum: row.receipt_checksum,
        policy_checksum: publication.policy.checksum, supersession_receipt_checksums: path,
        execution_observation: await observeAtomicCanonicalUse(db, source, publication) })
    } else {
      if (item.baseline_checksum !== null && !hash(item.baseline_checksum)) fail('reconciliation_baseline_missing')
      const assessed = await inspectNavPolicyCandidate(db, env, { owner: 'atomic_strategy',
        artifactId: item.artifact_id, artifactChecksum: item.artifact_checksum, businessDate: request.business_date },
        new Date(now.getTime() + Math.max(0, paperExecutionNow() - observationClockOrigin)))
      if (item.baseline_checksum !== (assessed.gate.nav_validation.baseline_checksum ?? null))
        fail('reconciliation_original_baseline_changed')
      if (!assessed.proof) {
        entries.push({ ...identity, state: 'observing', reason: assessed.gate.nav_validation.reason,
          decision_checksum: assessed.gate.evaluation_evidence_checksum })
        continue
      }
      const frozen = originalNavComparisonContext(assessed.proof)
      if (!executionContext) executionContext = await currentExecutionContext(db, env, readCurrent)
      const { current, formal } = executionContext
      const executionReason = ['artifact_id', 'cohort_id', 'payload_checksum', 'base_artifact_set_checksum']
        .some(key => formal[key] !== frozen.configuration.formal_baseline_identity[key]) ? 'ml_baseline_changed'
        : await atomicNavDigest(current.tradingConfig) !== await atomicNavDigest(frozen.configuration.trading_config)
          || await atomicNavDigest(current.riskConfig) !== await atomicNavDigest(frozen.configuration.risk_config)
          ? 'configuration_changed' : null
      // This is eligibility against today's comparator, NOT another evaluation
      // or maturity reset. The promoter still verifies the original NAV proof.
      const state = executionReason ? 'baseline_changed'
        : sourceSupersession.length || !routeDependency.matches ? 'awaiting_current_source'
        : item.baseline_checksum === source.policyContext.policy_checksum ? 'candidate' : 'baseline_changed'
      entries.push({ ...identity, state, reason: executionReason ?? (state === 'candidate' ? 'same_current_comparator'
        : state === 'baseline_changed' ? 'frozen_comparator_no_longer_current'
          : !routeDependency.matches ? 'route_publication_after_current_canonical' : 'publication_after_current_canonical'),
        decision_checksum: assessed.proof.decisionChecksum, context_checksum: executionContext.checksum,
        comparison_baseline_checksum: item.baseline_checksum })
    }
  }
  const finalSource = await readCurrentCanonicalAtomicPolicy(env, request.business_date, now)
  if (executionContext && (await currentExecutionContext(db, env, readCurrent)).checksum !== executionContext.checksum)
    fail('reconciliation_execution_context_changed')
  if (await atomicNavDigest(await registry()) !== currentChecksum
    || (await readNavRouteDependency(db, finalSource.source.inputs.options.promotedRouteCalibration)).checksum !== routeDependency.checksum
    || finalSource.source.source_checksum !== source.source.source_checksum) fail('reconciliation_source_changed')
  return { schema_version: 'strategy-atomic-nav-reconciliation-v1', complete: true, read_only: true,
    owner: 'atomic_strategy', as_of_date: request.business_date, observed_at: now.toISOString(),
    source: 'original_atomic_registry_policy_and_receipts', request_checksum: await atomicNavDigest(request),
    current_registry_checksum: currentChecksum, canonical_source_checksum: source.source.source_checksum,
    canonical_policy_checksum: source.policyContext.policy_checksum, source_supersession_receipt_checksums: sourceSupersession,
    route_dependency_checksum: routeDependency.checksum, route_dependency_matches_canonical: routeDependency.matches,
    entries, entries_checksum: await atomicNavDigest(entries), promotion_allowed: false, nav_maturity_credit: 0 }
}
