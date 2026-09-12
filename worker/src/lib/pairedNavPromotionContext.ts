/** Current-serving comparison checks. No new statistical threshold or config owner. */
import { originalNavComparisonContext, type VerifiedNavPromotion } from './pairedNavPromotionEvidence'
import { readCommittedNavBaseline, type NavBaselineFence } from './active8NavBaseline'
import type { Bindings } from '../types'

type RecordValue = Record<string, any>
export type NavCurrentConfigReader = () => Promise<{ tradingConfig: RecordValue; riskConfig: RecordValue }>
const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v
const same = (a: any, b: any) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
const committedBaselines = new WeakMap<object, { db: D1Database; fence: NavBaselineFence }>()

export function comparableConfig(value: RecordValue, owner: string) {
  const out = structuredClone(value)
  if (owner === 'allocator_ev_fusion') {
    // Fusion's declared comparator is the exact frozen L4 CANDIDATE. L4 may be
    // activated immediately before Fusion in this batch; verify its exact D1
    // identity below, not equality with the former incumbent L4 projection.
    for (const object of [out, out.ensemble_v2]) {
      if (!object) continue
      for (const key of ['l4AlphaEv', 'l4_alpha_ev', 'alphaEvResolver']) delete object[key]
    }
  }
  return out
}

export async function verifyNavCurrentContext(db: D1Database, proof: VerifiedNavPromotion,
  readCurrent: NavCurrentConfigReader, env?: Bindings): Promise<{ formal: RecordValue; dependencyArtifactId: string | null }> {
  if (typeof readCurrent !== 'function') throw new Error('nav_promotion_current_config_reader_missing')
  const frozen = originalNavComparisonContext(proof)
  const current = await readCurrent()
  if (!current?.tradingConfig || !current.riskConfig
    || !same(comparableConfig(frozen.configuration.trading_config, proof.owner), comparableConfig(current.tradingConfig, proof.owner))
    || !same(frozen.configuration.risk_config, current.riskConfig)) {
    throw new Error('nav_promotion_current_configuration_changed')
  }
  const formal = frozen.configuration.formal_baseline_identity
  await verifyNavFormalBaseline(db, formal, env)
  let dependencyArtifactId: string | null = null
  if (proof.owner === 'allocator_ev_fusion') {
    const dependency = await db.prepare(`
      SELECT p.champion_artifact_id FROM model_champion_pointers p
      JOIN model_artifact_registry r ON r.artifact_id=p.champion_artifact_id
      JOIN expected_return_artifact_payloads x ON x.artifact_id=p.champion_artifact_id
      WHERE p.model_name='l4_alpha_ev' AND r.model_name=p.model_name AND r.state='production'
        AND r.checksum=? AND x.source_artifact_checksum=r.checksum AND x.serving_mode='alpha'
    `).bind(frozen.baseline_checksum).first<RecordValue>()
    if (!dependency) throw new Error('nav_promotion_exact_l4_dependency_changed')
    dependencyArtifactId = dependency.champion_artifact_id
  }
  return { formal, dependencyArtifactId }
}

/** Same live ML identity check for initial adoption and committed projection recovery. */
export async function verifyNavFormalBaseline(db: D1Database, formal: RecordValue, env?: Bindings): Promise<void> {
  committedBaselines.delete(formal)
  const currentFormal = await db.prepare(`
    SELECT p.*,a.validation_decision
      FROM active8_ensemble_pointer_v1 p JOIN active8_ensemble_artifacts_v1 a ON a.artifact_id=p.artifact_id
     WHERE p.singleton_id=1 AND a.cohort_id=p.cohort_id AND a.payload_checksum=p.payload_checksum
       AND a.base_artifact_set_checksum=p.base_artifact_set_checksum
       AND a.state='production' AND a.production_effect=1
  `).first<RecordValue>()
  if (!currentFormal || ['artifact_id','cohort_id','payload_checksum','base_artifact_set_checksum'].some(k => currentFormal[k] !== formal[k])) {
    throw new Error('nav_promotion_current_ml_baseline_changed')
  }
  const receipt = JSON.parse(currentFormal.promotion_evidence_json ?? '{}')
  if (receipt && Object.hasOwn(receipt, 'nav_validation')) {
    const fence = await readCommittedNavBaseline(db, env, formal)
    committedBaselines.set(formal, { db, fence })
  } else if (currentFormal.validation_decision !== 'PASS') {
    throw new Error('nav_promotion_current_ml_baseline_changed')
  }
}

export function navPointerCompareAndSwapGuard(db: D1Database, proof: VerifiedNavPromotion,
  context: { formal: RecordValue; dependencyArtifactId: string | null }, previousArtifactId: string | null): D1PreparedStatement {
  const f = context.formal
  const committed = committedBaselines.get(f)
  if (committed && committed.db !== db) throw new Error('nav_promotion_baseline_database_changed')
  // Executed inside the SAME D1 batch as all writes. JSON error aborts/rolls back
  // the batch on a changed ML/incumbent/L4 pointer, rather than silently doing 0 writes.
  return db.prepare(`SELECT CASE WHEN
    ${committed ? `(${committed.fence.sql})` : `EXISTS(SELECT 1 FROM active8_ensemble_pointer_v1 p JOIN active8_ensemble_artifacts_v1 a ON a.artifact_id=p.artifact_id
      WHERE p.singleton_id=1 AND p.artifact_id=? AND p.cohort_id=? AND p.payload_checksum=? AND p.base_artifact_set_checksum=?
        AND a.cohort_id=p.cohort_id AND a.payload_checksum=p.payload_checksum AND a.base_artifact_set_checksum=p.base_artifact_set_checksum
        AND a.validation_decision='PASS' AND a.state='production' AND a.production_effect=1)`}
    AND (SELECT champion_artifact_id FROM model_champion_pointers WHERE model_name=?) IS ?
    AND (? IS NULL OR EXISTS(SELECT 1 FROM model_champion_pointers p
      JOIN model_artifact_registry r ON r.artifact_id=p.champion_artifact_id
      JOIN expected_return_artifact_payloads x ON x.artifact_id=p.champion_artifact_id
      WHERE p.model_name='l4_alpha_ev' AND p.champion_artifact_id=?
        AND r.model_name=p.model_name AND r.state='production' AND r.checksum=?
        AND x.source_artifact_checksum=r.checksum AND x.serving_mode='alpha'))
    THEN 1 ELSE json('nav_promotion_serving_context_changed') END AS nav_context_stable`)
    .bind(...(committed ? committed.fence.params : [f.artifact_id, f.cohort_id, f.payload_checksum, f.base_artifact_set_checksum]),
      proof.owner, previousArtifactId, context.dependencyArtifactId, context.dependencyArtifactId,
      originalNavComparisonContext(proof).baseline_checksum)
}
