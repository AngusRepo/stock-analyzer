/** NAV -> the existing route run/head owner. No model-registry surrogate. */
import type { Bindings } from '../types'
import { verifyNavPolicyPromotionEvidence, inspectNavPolicyCandidate, originalNavComparisonContext,
  navJournalFrontierGuard, type VerifiedNavPromotion } from './pairedNavPromotionEvidence'
import { verifyNavCurrentContext, verifyNavFormalBaseline, navPointerCompareAndSwapGuard, type NavCurrentConfigReader } from './pairedNavPromotionContext'
import { loadPromotedStrategyRouteCalibration, STRATEGY_ROUTE_CHALLENGER_VERSION } from './strategyRouteCalibration'
import { L15_MARGINAL_SLATE_BUILDER_VERSION, MULTI_STRATEGY_PLE_ROUTER_VERSION } from './multiStrategyPleRouter'
import { ROUTE_NAV_ARTIFACT_VERSION, readRouteNavReceipt, routeReceiptHash } from './strategyRouteNavReceipt'
import { observeRouteCanonicalUse } from './navScreenerObservation'
import { atomicNavDigest } from './strategyAtomicNavReceipt'
import { paperExecutionDate, paperExecutionNow } from './paperExecutionScope'
import { readCanonicalAtomicPolicy } from './atomicStrategySource'
import { registryRowToStrategySpec, type StrategySpecRegistryRow } from './strategyLearning'

type Row = Record<string, any>
const head = (db: D1Database) => db.prepare(`SELECT h.*,r.status,r.gate_json
  FROM strategy_route_calibration_head_v1 h JOIN strategy_route_calibration_runs_v1 r ON r.run_id=h.run_id
  WHERE h.singleton_id=1 AND h.artifact_version=r.artifact_version
    AND h.candidate_route_version=r.candidate_route_version AND h.route_floor IS r.route_floor`).first<Row>()

/** Shared eligibility for publisher and daily lifecycle. A valid but different
 * context is distinct from a missing/corrupt source; the latter still throws. */
async function routeCandidateContext(db: D1Database, env: Bindings, proof: VerifiedNavPromotion,
  definition: Row, readCurrent: NavCurrentConfigReader) {
  const frozen = originalNavComparisonContext(proof)
  const originalSource = await readCanonicalAtomicPolicy(env, frozen.route_source)
  const registry = (await db.prepare("SELECT * FROM strategy_spec_registry WHERE status<>'retired' ORDER BY strategy_id,version")
    .all<StrategySpecRegistryRow>()).results ?? []
  const specs = registry.map(registryRowToStrategySpec).sort((a, b) => a.id.localeCompare(b.id))
  if (!specs.length || new Set(specs.map(spec => spec.id)).size !== specs.length)
    throw new Error('strategy_route_nav_registry_invalid')
  const expected = [...originalSource.policyContext.identity.specs].sort((a, b) => a.id.localeCompare(b.id))
  const current = await readCurrent()
  if (!current?.tradingConfig || !current.riskConfig || typeof current.tradingConfig !== 'object'
    || typeof current.riskConfig !== 'object' || Array.isArray(current.tradingConfig)
    || Array.isArray(current.riskConfig)) throw new Error('strategy_route_nav_current_context_missing')
  const formal = await db.prepare(`SELECT artifact_id,cohort_id,payload_checksum,base_artifact_set_checksum
    FROM active8_ensemble_pointer_v1 WHERE singleton_id=1`).first<Row>()
  // Validate CURRENT pointer/artifact consistency before classifying a change.
  if (!formal) throw new Error('strategy_route_nav_current_ml_baseline_missing')
  await verifyNavFormalBaseline(db, formal, env)
  const previous = await head(db)
  const raw = await db.prepare('SELECT run_id FROM strategy_route_calibration_head_v1 WHERE singleton_id=1').first<Row>()
  if (raw && (!previous || previous.status !== 'promoted')) throw new Error('strategy_route_nav_existing_head_invalid')
  const routes = frozen.configuration.route_policies
  const reason = definition.challenger_version !== STRATEGY_ROUTE_CHALLENGER_VERSION
    || definition.slate_builder_version !== L15_MARGINAL_SLATE_BUILDER_VERSION
    || routes?.challenger_version !== definition.challenger_version
    || routes?.slate_builder_version !== definition.slate_builder_version ? 'runtime_version_changed'
    : await atomicNavDigest(specs) !== await atomicNavDigest(expected) ? 'registry_changed'
      : ['artifact_id', 'cohort_id', 'payload_checksum', 'base_artifact_set_checksum']
        .some(key => formal[key] !== frozen.configuration.formal_baseline_identity[key]) ? 'ml_baseline_changed'
        : await atomicNavDigest(current.tradingConfig) !== await atomicNavDigest(frozen.configuration.trading_config)
          || await atomicNavDigest(current.riskConfig) !== await atomicNavDigest(frozen.configuration.risk_config) ? 'configuration_changed'
          : routes.incumbent_version !== (previous?.candidate_route_version ?? MULTI_STRATEGY_PLE_ROUTER_VERSION) ? 'route_baseline_changed' : null
  return { registry, reason, checksum: await atomicNavDigest({ registry, current, formal, previous }) }
}

async function publication(db: D1Database, env: Bindings, payload: Row, recovered: boolean) {
  const row = await head(db)
  if (!row) throw new Error('strategy_route_nav_head_missing')
  const receipt = await readRouteNavReceipt(row)
  const serving = await loadPromotedStrategyRouteCalibration(db)
  if (receipt.artifact_id !== payload.artifact_id || receipt.artifact_checksum !== payload.artifact_checksum
    || serving?.runId !== row.run_id || serving.routeVersion !== receipt.policy_definition.challenger_version
    || receipt.policy_definition.slate_builder_version !== L15_MARGINAL_SLATE_BUILDER_VERSION)
    throw new Error('strategy_route_nav_readback_changed')
  const publicationReceiptChecksum = await routeReceiptHash(row.gate_json)
  const execution = await observeRouteCanonicalUse(env, { owner: 'l15_route', artifact_id: receipt.artifact_id,
    artifact_checksum: receipt.artifact_checksum, publication_receipt_checksum: publicationReceiptChecksum,
    published_at: row.promoted_at, business_date: payload.evaluation_business_date,
    run_id: row.run_id, route_version: receipt.policy_definition.challenger_version })
  if ((await head(db))?.run_id !== row.run_id) throw new Error('strategy_route_nav_head_changed_during_observation')
  return { complete: true, status: 'completed', completion_scope: 'publication', owner: 'l15_route',
    artifact_id: receipt.artifact_id, artifact_checksum: receipt.artifact_checksum,
    pointer_committed: true, serving_readers_verified: true, recovered_existing_commit: recovered,
    publication_receipt_checksum: publicationReceiptChecksum,
    serving: { ...serving, published_at: row.promoted_at },
    execution_observation: execution,
    serving_activation_verified: execution.executed, source: 'route_head_and_original_reader' }
}

/** Existing publication is observed daily even if today's numerical verdict is
 * HOLD. No new promotion, review budget, training or database write. */
export async function reconcileNavStrategyRoute(db: D1Database, env: Bindings,
  request: { business_date: string; candidates?: Array<{ artifact_id: string; artifact_checksum: string }> },
  now = paperExecutionDate(), readCurrent?: NavCurrentConfigReader) {
  const observationClockOrigin = paperExecutionNow()
  const input = structuredClone(request), day = input?.business_date
  if (!input || !['business_date', 'business_date,candidates'].includes(Object.keys(input).sort().join(',')) || !/^\d{4}-\d{2}-\d{2}$/.test(day)
    || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day
    || day > new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10))
    throw new Error('strategy_route_nav_reconciliation_request_invalid')
  if ('candidates' in input && (!Array.isArray(input.candidates) || !input.candidates.length || !readCurrent
    || new Set(input.candidates.map(row => row?.artifact_id)).size !== input.candidates.length
    || input.candidates.some(row => !row || Object.keys(row).sort().join(',') !== 'artifact_checksum,artifact_id'
      || typeof row.artifact_id !== 'string' || !row.artifact_id.startsWith('l15_route:')
      || !/^[a-f0-9]{64}$/.test(row.artifact_checksum)))) throw new Error('strategy_route_nav_reconciliation_inventory_invalid')
  const current = await head(db)
  const raw = await db.prepare('SELECT run_id FROM strategy_route_calibration_head_v1 WHERE singleton_id=1').first<Row>()
  if (raw && (!current || current.status !== 'promoted')) throw new Error('strategy_route_nav_existing_head_invalid')
  let committed: Awaited<ReturnType<typeof publication>> | null = null
  if (current?.artifact_version === ROUTE_NAV_ARTIFACT_VERSION) {
    const receipt = await readRouteNavReceipt(current)
    committed = await publication(db, env, { artifact_id: receipt.artifact_id,
      artifact_checksum: receipt.artifact_checksum, evaluation_business_date: day }, true)
  }
  const entries: Row[] = []
  const contexts: Array<{ proof: VerifiedNavPromotion; definition: Row; checksum: string }> = []
  for (const item of input.candidates ?? []) {
    if (committed?.artifact_id === item.artifact_id && committed.artifact_checksum === item.artifact_checksum) {
      entries.push({ ...item, state: 'published', reason: 'original_publication_verified' })
      continue
    }
    const assessed = await inspectNavPolicyCandidate(db, env, { owner: 'l15_route', artifactId: item.artifact_id,
      artifactChecksum: item.artifact_checksum, businessDate: day },
      // Head reads and earlier candidates are not part of this HTTP request's
      // latency. Preserve the supplied cutoff clock while advancing to its start.
      new Date(now.getTime() + Math.max(0, paperExecutionNow() - observationClockOrigin)))
    if (!assessed.proof) {
      entries.push({ ...item, state: 'observing', reason: assessed.gate.nav_validation.reason,
        decision_checksum: assessed.gate.evaluation_evidence_checksum })
      continue
    }
    const context = await routeCandidateContext(db, env, assessed.proof, assessed.policyDefinition, readCurrent!)
    contexts.push({ proof: assessed.proof, definition: assessed.policyDefinition, checksum: context.checksum })
    entries.push({ ...item, state: context.reason ? 'baseline_changed' : 'candidate',
      reason: context.reason ?? 'same_current_comparator', decision_checksum: assessed.proof.decisionChecksum,
      context_checksum: context.checksum })
  }
  for (const observed of contexts) {
    if ((await routeCandidateContext(db, env, observed.proof, observed.definition, readCurrent!)).checksum !== observed.checksum)
      throw new Error('strategy_route_nav_context_changed_during_reconciliation')
  }
  const final = await db.prepare('SELECT run_id FROM strategy_route_calibration_head_v1 WHERE singleton_id=1').first<Row>()
  if (await atomicNavDigest(raw) !== await atomicNavDigest(final)) throw new Error('strategy_route_nav_head_changed_during_observation')
  const body = { schema_version: 'strategy-route-nav-reconciliation-v1', complete: true, read_only: true,
    owner: 'l15_route', business_date: day, source: 'original_route_head_and_canonical_selection',
    request_checksum: await atomicNavDigest(input), publication: committed,
    ...('candidates' in input ? { entries, entries_checksum: await atomicNavDigest(entries) } : {}),
    promotion_allowed: false, nav_maturity_credit: 0 }
  return { ...body, reconciliation_checksum: await atomicNavDigest(body) }
}

export async function adoptNavStrategyRoute(db: D1Database, env: Bindings, payload: Row,
  readCurrent: NavCurrentConfigReader, now = new Date()) {
  const observationClockOrigin = paperExecutionNow()
  if (!payload || typeof payload.artifact_id !== 'string' || !/^[a-f0-9]{64}$/.test(payload.artifact_checksum))
    throw new Error('strategy_route_nav_identity_invalid')
  const previous = await head(db)
  const rawHead = await db.prepare('SELECT run_id FROM strategy_route_calibration_head_v1 WHERE singleton_id=1').first<Row>()
  if (rawHead && !previous) throw new Error('strategy_route_nav_existing_head_invalid')
  if (previous?.artifact_version === ROUTE_NAV_ARTIFACT_VERSION) {
    const committed = await readRouteNavReceipt(previous)
    if (committed.artifact_id === payload.artifact_id && committed.artifact_checksum === payload.artifact_checksum)
      return publication(db, env, payload, true)
  }
  const { proof, gate, policyDefinition } = await verifyNavPolicyPromotionEvidence(db, env,
    { owner: 'l15_route', payload },
    new Date(now.getTime() + Math.max(0, paperExecutionNow() - observationClockOrigin)))
  const frozen = originalNavComparisonContext(proof)
  const eligibility = await routeCandidateContext(db, env, proof, policyDefinition, readCurrent)
  if (eligibility.reason) throw new Error('strategy_route_nav_' + eligibility.reason)
  const registry = eligibility.registry
  const routes = frozen.configuration.route_policies
  if (policyDefinition.challenger_version !== STRATEGY_ROUTE_CHALLENGER_VERSION
    || policyDefinition.slate_builder_version !== L15_MARGINAL_SLATE_BUILDER_VERSION
    || routes?.challenger_version !== policyDefinition.challenger_version
    || routes.slate_builder_version !== policyDefinition.slate_builder_version
    || routes.incumbent_version !== (previous?.candidate_route_version ?? MULTI_STRATEGY_PLE_ROUTER_VERSION))
    throw new Error('strategy_route_nav_executable_or_baseline_changed')
  // This shared check retains the existing formal ML and live risk/config guards.
  // NAV-owned L3 is accepted only through its original committed authority.
  const context = await verifyNavCurrentContext(db, proof, readCurrent, env)
  const runId = `route-nav:${payload.artifact_checksum}:${proof.decisionChecksum}`
  const receipt = JSON.stringify({ schema_version: ROUTE_NAV_ARTIFACT_VERSION, run_id: runId,
    artifact_id: payload.artifact_id, artifact_checksum: payload.artifact_checksum,
    policy_definition: policyDefinition, gate })
  const statements = [
    navPointerCompareAndSwapGuard(db, proof, context, null),
    navJournalFrontierGuard(db, proof),
    db.prepare(`SELECT CASE WHEN (SELECT COUNT(*) FROM strategy_spec_registry WHERE status<>'retired')=?
      THEN 1 ELSE json('strategy_route_nav_registry_changed') END`).bind(registry.length),
    ...registry.map(row => {
      const keys = Object.keys(row) as Array<keyof StrategySpecRegistryRow>
      return db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM strategy_spec_registry
        WHERE ${keys.map(key => `${key} IS ?`).join(' AND ')})
        THEN 1 ELSE json('strategy_route_nav_registry_changed') END`).bind(...keys.map(key => row[key]))
    }),
    db.prepare(`SELECT CASE WHEN
      (? IS NULL AND NOT EXISTS(SELECT 1 FROM strategy_route_calibration_head_v1 WHERE singleton_id=1))
      OR EXISTS(SELECT 1 FROM strategy_route_calibration_head_v1 h
        JOIN strategy_route_calibration_runs_v1 r ON r.run_id=h.run_id
        WHERE h.singleton_id=1 AND h.run_id=? AND h.artifact_version=? AND h.candidate_route_version=?
          AND h.route_floor IS ? AND h.promoted_at=? AND r.gate_json=? AND r.status='promoted')
      THEN 1 ELSE json('strategy_route_nav_head_changed') END`).bind(previous?.run_id ?? null,
        previous?.run_id ?? null, previous?.artifact_version ?? null, previous?.candidate_route_version ?? null,
        previous?.route_floor ?? null, previous?.promoted_at ?? null, previous?.gate_json ?? null),
    db.prepare(`INSERT INTO strategy_route_calibration_runs_v1
      (run_id,artifact_version,as_of_date,status,candidate_route_version,route_floor,sample_count,date_count,gate_json)
      VALUES(?,?,?,'promoted',?,NULL,?,?,?)`).bind(runId, ROUTE_NAV_ARTIFACT_VERSION, proof.asOfDate,
        policyDefinition.challenger_version, gate.evaluable_date_count, gate.evaluable_date_count, receipt),
    db.prepare(`INSERT INTO strategy_route_calibration_head_v1
      (singleton_id,run_id,artifact_version,candidate_route_version,route_floor,promoted_at)
      VALUES(1,?,?,?,NULL,?) ON CONFLICT(singleton_id) DO UPDATE SET
        run_id=excluded.run_id,artifact_version=excluded.artifact_version,
        candidate_route_version=excluded.candidate_route_version,route_floor=NULL,promoted_at=excluded.promoted_at`)
      .bind(runId, ROUTE_NAV_ARTIFACT_VERSION, policyDefinition.challenger_version, now.toISOString()),
  ]
  // Re-read after authority work; config changes must not silently inherit a PASS.
  await verifyNavCurrentContext(db, proof, readCurrent, env)
  const writes = await db.batch(statements)
  if (writes.length !== statements.length || writes.some(write => !write.success))
    throw new Error('strategy_route_nav_publication_incomplete')
  return publication(db, env, payload, false)
}
