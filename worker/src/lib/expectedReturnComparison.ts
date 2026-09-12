/** Read-only observation after ORIGINAL publication validation has refused.
 * This function cannot commit, project config, or grant promotion authority.
 */
import { verifyExpectedReturnCandidate, readExpectedReturnCommitReceipt,
  hydrateExpectedReturnConfigFromPointers } from './expectedReturnServingRegistry'
import type { commitExpectedReturnChampion } from './expectedReturnServingRegistry'
import { originalNavComparisonContext } from './pairedNavPromotionEvidence'
import { comparableConfig, verifyNavFormalBaseline } from './pairedNavPromotionContext'

type RecordValue = Record<string, any>
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const same = (a: any, b: any) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
async function hash(value: any) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical(value))))
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function inspectExpectedReturnComparison(db: D1Database,
  input: Parameters<typeof commitExpectedReturnChampion>[1]): Promise<RecordValue | null> {
  const identity = { artifactId: input.artifactId.trim(), artifactChecksum: input.artifactChecksum.trim().toLowerCase(),
    modelVersion: String(input.artifact.model_version ?? '').trim() }
  if (await readExpectedReturnCommitReceipt(db, { ...input, ...identity })) return null
  const candidate = await verifyExpectedReturnCandidate(db, input, identity)
  const frozen = originalNavComparisonContext(candidate.navProof)
  const readSource = async () => {
    if (!input.currentConfigReader) throw new Error('nav_promotion_current_config_reader_missing')
    const current = await input.currentConfigReader()
    if (![current?.tradingConfig, current?.riskConfig].every(value => value && typeof value === 'object'
      && !Array.isArray(value) && Object.keys(value).length)) throw new Error('nav_ev_comparison_config_missing')
    const { validateTradingConfig } = await import('./tradingConfig')
    if (validateTradingConfig(current.tradingConfig as any).length) throw new Error('nav_ev_comparison_config_invalid')
    const hydrated = await hydrateExpectedReturnConfigFromPointers(db, current.tradingConfig)
    if (!same(hydrated.config, current.tradingConfig) || Object.values(hydrated.projections).some(p =>
      p.blockers.includes('serving_registry_schema_missing') ||
      !p.valid && (p.pointer_present || p.owner_state === 'learned_champion'))) {
      throw new Error('nav_ev_comparison_serving_source_invalid')
    }
    const formal = await db.prepare(`SELECT artifact_id,cohort_id,payload_checksum,base_artifact_set_checksum
      FROM active8_ensemble_pointer_v1 WHERE singleton_id=1`).first<RecordValue>()
    if (!formal) throw new Error('nav_ev_comparison_ml_missing')
    const dependency = input.owner === 'allocator_ev_fusion' ? await db.prepare(`
      SELECT r.artifact_id,r.checksum FROM model_champion_pointers p
      JOIN model_artifact_registry r ON r.artifact_id=p.champion_artifact_id
      WHERE p.model_name='l4_alpha_ev' AND r.model_name=p.model_name AND r.state='production'
    `).first<RecordValue>() : null
    return { current, formal, projections: hydrated.projections, dependency }
  }
  const observed = await readSource()
  const changed = [
    ...(!same(comparableConfig(observed.current.tradingConfig, input.owner),
      comparableConfig(frozen.configuration.trading_config, input.owner)) ? ['trading_config'] : []),
    ...(!same(observed.current.riskConfig, frozen.configuration.risk_config) ? ['risk_config'] : []),
    ...(['artifact_id','cohort_id','payload_checksum','base_artifact_set_checksum'].some(key =>
      observed.formal[key] !== frozen.configuration.formal_baseline_identity[key]) ? ['formal_ml'] : []),
    ...(input.owner === 'allocator_ev_fusion' && observed.dependency?.checksum !== frozen.baseline_checksum
      ? ['l4_dependency'] : []),
  ]
  if (!changed.length) return null
  await verifyNavFormalBaseline(db, observed.formal, input.navBindings)
  const repeated = await readSource()
  await verifyNavFormalBaseline(db, repeated.formal, input.navBindings)
  const checked = await verifyExpectedReturnCandidate(db, input, identity)
  if (!same(observed, repeated) || !same(candidate.registry, checked.registry)
    || candidate.navProof.decisionChecksum !== checked.navProof.decisionChecksum
    || await readExpectedReturnCommitReceipt(db, { ...input, ...identity })) {
    throw new Error('nav_ev_comparison_source_changed_during_read')
  }
  const dependencyOnly = changed.length === 1 && changed[0] === 'l4_dependency'
  const body = { schema_version: 'ev-nav-comparison-observation-v1', owner: input.owner,
    artifact_id: identity.artifactId, artifact_checksum: identity.artifactChecksum,
    as_of_date: candidate.navProof.asOfDate, decision_checksum: candidate.navProof.decisionChecksum,
    frozen_configuration_checksum: input.prospectiveValidation.nav_validation.configuration_checksum,
    current_context_checksum: await hash(observed), changed_fields: changed,
    state: dependencyOnly ? 'awaiting_dependency' : 'baseline_changed',
    reason: dependencyOnly ? 'exact_l4_dependency_not_serving' : 'awaiting_next_frozen_comparison',
    source: 'original_nav_proof_and_current_ml_ev_config', read_only: true,
    promotion_allowed: false, nav_maturity_credit: 0 }
  return { ...body, observation_checksum: await hash(body) }
}
