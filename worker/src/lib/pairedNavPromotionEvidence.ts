/** Verify the original Controller review; this module does not refit statistics.
 * Policy has ONE shared source. Hash original Python bytes (not JS reserialization
 * of floats / large random seeds). Caller PASS alone cannot authorize promotion.
 */
import policy from '../../../ml-controller/services/paired_nav_review_policy.json'
import transportPolicy from '../../../ml-controller/services/paired_nav_transport_policy.json'

import { parseNavJournalFrontier, verifyNavJournalFrontier, navJournalFrontierStatement } from './pairedNavJournalFrontier'
import { controllerJson } from './controllerClient'
import type { Bindings } from '../types'

type RecordValue = Record<string, any>
export const NAV_GATE_SCHEMA = 'expected-return-candidate-nav-gate-v1'
const verified = new WeakMap<object, string>()
const comparisonContexts = new WeakMap<object, RecordValue>()
export interface VerifiedNavPromotion {
  owner: string
  artifactId: string
  artifactChecksum: string
  decisionChecksum: string
  asOfDate: string
  reviewRecordId: string
}
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const same = (a: any, b: any) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
const hash = async (raw: string): Promise<string> => Array.from(new Uint8Array(
  await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))), b => b.toString(16).padStart(2, '0')).join('')
const digest = (value: any) => hash(JSON.stringify(canonical(value)))
const fail = (reason: string): never => { throw new Error(`nav_promotion_${reason}`) }
const exactDate = (value: any): boolean => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString().slice(0, 10) === value
const key = (protocol: string, family = '', review = '', kind = 'protocol') =>
  digest(['paired-nav-review-record-v1', protocol, family, review, kind])

async function readRecord(db: D1Database, recordId: string, today: string, now: Date) {
  const h = await db.prepare('SELECT * FROM paired_nav_review_records_v1 WHERE record_id=?')
    .bind(recordId).first<RecordValue>()
  if (!h) fail('record_missing')
  if (!Number.isInteger(h.part_count) || h.part_count < 1 || !exactDate(h.as_of_date)
    || h.as_of_date > today || !Number.isFinite(Date.parse(h.created_at))
    || Date.parse(h.created_at) > now.getTime()) fail('record_header_invalid')
  if (h.record_id !== recordId || await key(h.protocol_id, h.family_id, h.review_id, h.record_kind) !== recordId)
    fail('record_identity_mismatch')
  const parts = (await db.prepare('SELECT part_no,payload_text FROM paired_nav_review_parts_v1 WHERE record_id=? ORDER BY part_no')
    .bind(recordId).all<RecordValue>()).results ?? []
  if (parts.length !== h.part_count || parts.some((p, i) => p.part_no !== i || typeof p.payload_text !== 'string'))
    fail('record_parts_incomplete')
  const raw = parts.map(p => p.payload_text).join('')
  if (await hash(raw) !== h.payload_checksum) fail('record_checksum_mismatch')
  const b = JSON.parse(raw)
  if (!b || ['record_kind', 'protocol_id', 'family_id', 'review_id', 'as_of_date'].some(k => b[k] !== h[k]))
    fail('record_body_identity_mismatch')
  return { h, b }
}

export function hasVerifiedNavPromotion(proof: VerifiedNavPromotion | undefined, owner: string,
  artifactId: string, checksum: string, gate: RecordValue): boolean {
  return !!proof && verified.get(proof) === JSON.stringify(canonical(gate)) && proof.owner === owner && proof.artifactId === artifactId
    && proof.artifactChecksum === checksum && proof.decisionChecksum === gate.evaluation_evidence_checksum
    && proof.asOfDate === gate.nav_validation?.as_of_date
}

export function originalNavComparisonContext(proof: VerifiedNavPromotion): RecordValue {
  const context = comparisonContexts.get(proof)
  if (!context || !verified.has(proof)) fail('comparison_proof_missing')
  return structuredClone(context)
}

export function navJournalFrontierGuard(db: D1Database, proof: VerifiedNavPromotion): D1PreparedStatement {
  return navJournalFrontierStatement(db, originalNavComparisonContext(proof).journal_frontier)
}

export async function verifyNavPromotionEvidence(db: D1Database, input: {
  owner: string; artifactId: string; artifactChecksum: string; gate: RecordValue
}, now = new Date()): Promise<VerifiedNavPromotion> {
  return verifyOriginalNavPromotionEvidence(db, input, now, true)
}

/** Policies are not model artifacts. Re-read the original authenticated owner,
 * then retain ALL common immutable review, family and journal checks below.
 * A caller-provided response/proof or an optional skip-registry flag is never an
 * authority input on this public path.
 */
export async function verifyNavPolicyPromotionEvidence(db: D1Database, env: Bindings, input: {
  owner: 'atomic_strategy' | 'l15_route'; payload: RecordValue
}, now = new Date()): Promise<{ proof: VerifiedNavPromotion; gate: RecordValue; policyDefinition: RecordValue }> {
  const { owner, payload } = input
  if (!payload) fail('policy_request_invalid')
  const result = await inspectNavPolicyCandidate(db, env, { owner, artifactId: payload.artifact_id,
    artifactChecksum: payload.artifact_checksum, businessDate: payload.evaluation_business_date }, now)
  if (!same(result.payload, payload)) fail('policy_original_decision_changed')
  if (!result.proof) fail('gate_identity_invalid')
  return { proof: result.proof, gate: result.gate, policyDefinition: result.policyDefinition }
}

/** Read the same original decision for daily eligibility, including HOLD.
 * Only a fully verified original PASS produces a promotion proof. */
export async function inspectNavPolicyCandidate(db: D1Database, env: Bindings, input: {
  owner: 'atomic_strategy' | 'l15_route'; artifactId: string; artifactChecksum: string; businessDate: string
}, now = new Date()): Promise<{ payload: RecordValue; proof: VerifiedNavPromotion | null;
  gate: RecordValue; policyDefinition: RecordValue }> {
  const started = performance.now()
  const owner = input.owner
  const payload = { artifact_id: input.artifactId, artifact_checksum: input.artifactChecksum,
    evaluation_business_date: input.businessDate }
  if (!['atomic_strategy', 'l15_route'].includes(owner)
    || !payload || typeof payload.artifact_id !== 'string' || !/^[a-f0-9]{64}$/.test(payload.artifact_checksum)
    || !exactDate(payload.evaluation_business_date)) fail('policy_request_invalid')
  // Do not accidentally turn an unset local controller secret into authority.
  if (!env.ML_CONTROLLER_SECRET?.trim()) fail('policy_controller_auth_missing')
  const response = await controllerJson<RecordValue>(env, '/nav/policy-decision', {
    method: 'POST', timeoutMs: transportPolicy.controller_read_timeout_seconds * 1000, jsonBody: {
      owner, candidate_artifact_id: payload.artifact_id, candidate_checksum: payload.artifact_checksum,
      business_date: payload.evaluation_business_date,
    },
  })
  if (response.schema_version !== 'paired-nav-policy-decision-response-v1'
    || response.owner !== owner || response.read_only !== true
    || response.source !== 'original_frozen_policy_and_verified_nav'
    || typeof response.observed_at !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(response.observed_at)
    || !Number.isFinite(Date.parse(response.observed_at))
    || Date.parse(response.observed_at) < now.getTime()
    || Date.parse(response.observed_at) > now.getTime() + Math.ceil(performance.now() - started)
    || response.payload?.artifact_id !== payload.artifact_id || response.payload?.artifact_checksum !== payload.artifact_checksum
    || response.payload?.evaluation_business_date !== payload.evaluation_business_date) fail('policy_original_decision_changed')
  const nav = response.payload.prospective_validation?.nav_validation ?? {}
  if (nav.as_of_date !== payload.evaluation_business_date) fail('policy_evaluation_date_changed')
  if (!response.payload.policy_definition || typeof response.payload.policy_definition !== 'object'
    || Array.isArray(response.payload.policy_definition)) fail('policy_definition_missing')
  const gate = {
    schema_version: NAV_GATE_SCHEMA, decision: response.payload.prospective_validation?.decision,
    failed_gates: nav.decision === 'PASS' ? [] : [nav.reason],
    candidate_artifact_id: payload.artifact_id, candidate_artifact_checksum: payload.artifact_checksum,
    minimum_evaluable_dates: nav.minimum_evaluable_dates, maximum_evaluable_dates: nav.maximum_evaluable_dates,
    evaluable_date_count: nav.evaluable_date_count, evaluation_evidence_checksum: nav.decision_checksum,
    evaluation_unit: 'original_costed_paired_daily_nav', training_dispatched: false, nav_validation: nav,
  }
  if (!['PASS', 'HOLD', 'PENDING'].includes(nav.decision) || gate.decision !== nav.decision
    || nav.schema_version !== 'paired-nav-candidate-decision-v1' || nav.owner !== owner
    || nav.candidate_artifact_id !== payload.artifact_id || nav.candidate_checksum !== payload.artifact_checksum)
    fail('gate_identity_invalid')
  const { decision_checksum, decision_payload_json, ...fields } = nav
  if (typeof decision_payload_json !== 'string' || !same(JSON.parse(decision_payload_json), fields)
    || await hash(decision_payload_json) !== decision_checksum) fail('decision_checksum_mismatch')
  const proof = nav.decision === 'PASS' ? await verifyOriginalNavPromotionEvidence(db, {
    owner, artifactId: payload.artifact_id, artifactChecksum: payload.artifact_checksum, gate,
  }, new Date(response.observed_at), false) : null
  return { payload: structuredClone(response.payload), proof, gate, policyDefinition: structuredClone(response.payload.policy_definition) }
}

async function verifyOriginalNavPromotionEvidence(db: D1Database, input: {
  owner: string; artifactId: string; artifactChecksum: string; gate: RecordValue
}, now: Date, registryProjection: boolean): Promise<VerifiedNavPromotion> {
  const { owner, artifactId, artifactChecksum, gate } = input
  const nav = gate.nav_validation ?? {}
  const today = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10)
  if (gate.schema_version !== NAV_GATE_SCHEMA || gate.decision !== 'PASS'
    || !Array.isArray(gate.failed_gates) || gate.failed_gates.length
    || gate.training_dispatched !== false || gate.evaluation_unit !== 'original_costed_paired_daily_nav'
    || nav.schema_version !== 'paired-nav-candidate-decision-v1' || nav.decision !== 'PASS'
    || nav.owner !== owner || nav.candidate_artifact_id !== artifactId || nav.candidate_checksum !== artifactChecksum
    || gate.candidate_artifact_id !== artifactId || gate.candidate_artifact_checksum !== artifactChecksum
    || gate.evaluation_evidence_checksum !== nav.decision_checksum) fail('gate_identity_invalid')
  if (!exactDate(nav.as_of_date) || nav.as_of_date > today || !exactDate(nav.checkpoint_as_of_date)
    || nav.checkpoint_as_of_date > nav.as_of_date) fail('decision_date_invalid')
  const body = JSON.parse(nav.decision_payload_json ?? 'null')
  const { decision_checksum, decision_payload_json, ...fields } = nav
  if (!body || !same(body, fields) || await hash(decision_payload_json) !== decision_checksum)
    fail('decision_checksum_mismatch')
  // Current mutable projection must exactly match the original reader output.
  if (registryProjection) {
    const registry = await db.prepare('SELECT live_evidence_json FROM model_artifact_registry WHERE artifact_id=? AND checksum=?')
      .bind(artifactId, artifactChecksum).first<RecordValue>()
    if (!registry || !same(JSON.parse(registry.live_evidence_json ?? 'null'), gate)) fail('registry_gate_mismatch')
  }
  const policyChecksum = await digest(policy)
  const protocolId = `${policy.revision}:${policyChecksum}`
  if (nav.policy_checksum !== policyChecksum || nav.protocol_id !== protocolId
    || nav.minimum_evaluable_dates !== policy.minimum_sessions || nav.maximum_evaluable_dates !== policy.final_sessions
    || gate.minimum_evaluable_dates !== policy.minimum_sessions
    || !Number.isInteger(nav.evaluable_date_count) || nav.evaluable_date_count < policy.minimum_sessions
    || gate.evaluable_date_count !== nav.evaluable_date_count) fail('policy_mismatch')
  const checkpoint = nav.evaluable_date_count >= policy.final_sessions ? policy.final_sessions : policy.minimum_sessions
  if (nav.review_id !== `sessions_${checkpoint}`) fail('checkpoint_mismatch')
  const protocol = await readRecord(db, await key(protocolId), today, now)
  const reservation = await readRecord(db, await key(protocolId, nav.family_id, nav.review_id, 'reservation'), today, now)
  const review = await readRecord(db, await key(protocolId, nav.family_id, nav.review_id, 'review'), today, now)
  const effectPolicy = { policy_id: protocolId, min_sessions: policy.minimum_sessions,
    tail_alpha: policy.family_alpha / 2, block_length: policy.block_length, resamples: policy.resamples }
  const budgetPolicy = { protocol_id: protocolId, family_alpha: policy.family_alpha,
    review_alphas: [[`sessions_${policy.minimum_sessions}`, policy.family_alpha / 2],
      [`sessions_${policy.final_sessions}`, policy.family_alpha / 2]] }
  if (!same(protocol.b.effect_policy, effectPolicy) || !same(protocol.b.budget_policy, budgetPolicy)) fail('protocol_mismatch')
  if (review.h.record_id !== nav.review_record_id || review.h.payload_checksum !== nav.review_record_checksum
    || reservation.h.payload_checksum !== nav.reservation_checksum
    || review.b.reservation_checksum !== reservation.h.payload_checksum
    || review.b.protocol_checksum !== protocol.h.payload_checksum || reservation.b.protocol_checksum !== protocol.h.payload_checksum
    || review.b.as_of_date !== nav.checkpoint_as_of_date || reservation.b.as_of_date !== review.b.as_of_date
    || review.b.chain_checksum !== reservation.b.chain_checksum || review.b.population_checksum !== reservation.b.population_checksum)
    fail('review_lineage_mismatch')
  const family = review.b.family
  if (!family || family.owner !== owner || family.family_id !== nav.family_id
    || family.denominator_status !== 'materialized_hypotheses_complete'
    || !family.tail_resolution_sufficient || family.review_alpha !== policy.family_alpha / 2)
    fail('family_incomplete')
  for (const k of Object.keys(reservation.b.family ?? {})) {
    if (!same(family[k], reservation.b.family[k])) fail('reserved_family_mismatch')
  }
  const hypothesis = await digest(['paired-nav-hypothesis-v1', { owner, candidate_checksum: artifactChecksum,
    baseline_checksum: nav.baseline_checksum, configuration_checksum: nav.configuration_checksum }])
  const findings = family.hypotheses.filter((h: any) => h.hypothesis_checksum === hypothesis)
  if (hypothesis !== nav.hypothesis_checksum || findings.length !== 1) fail('hypothesis_mismatch')
  const finding = findings[0]
  const effects = review.b.effects.filter((e: any) => e.pair_id === finding.effect_pair_id)
  if (effects.length !== 1) fail('effect_missing')
  const effect = effects[0]
  if (finding.numerical_support !== true || finding.availability_reason !== null
    || finding.effect_pair_id !== nav.effect_pair_id || finding.holm_adjusted_p !== nav.holm_adjusted_p
    || finding.mean_daily_nav_delta !== nav.mean_daily_nav_delta || !same(effect.comparison, nav.comparison)
    || effect.comparison?.candidate_checksum !== artifactChecksum || effect.comparison?.baseline_checksum !== nav.baseline_checksum
    || effect.exact_nav_sessions < policy.minimum_sessions || effect.unknown_nav_sessions !== 0
    || effect.accounted_sessions !== effect.exact_nav_sessions || effect.inference_status !== 'evaluated_fixed_sample'
    || effect.latest_session > nav.checkpoint_as_of_date || !same(effect.policy, effectPolicy)) fail('effect_mismatch')
  const manifest = await db.prepare('SELECT * FROM paired_nav_frozen_manifests_v1 WHERE snapshot_id=?')
    .bind(nav.allocation_snapshot_id).first<RecordValue>()
  if (!manifest || manifest.prospective !== 1 || manifest.snapshot_kind !== 'allocation_pair'
    || manifest.signal_date !== nav.latest_signal_date || manifest.signal_date > nav.as_of_date
    || typeof manifest.frozen_at !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(manifest.frozen_at)
    || !Number.isFinite(Date.parse(manifest.frozen_at)) || Date.parse(manifest.frozen_at) > now.getTime()
    || manifest.payload_checksum !== nav.allocation_payload_checksum
    || !Number.isInteger(manifest.part_count) || manifest.part_count < 1) fail('allocation_manifest_mismatch')
  const parts = (await db.prepare('SELECT part_no,payload_text FROM paired_nav_frozen_parts_v1 WHERE snapshot_id=? ORDER BY part_no')
    .bind(nav.allocation_snapshot_id).all<RecordValue>()).results ?? []
  if (parts.length !== manifest.part_count || parts.some((p, i) => p.part_no !== i)) fail('allocation_parts_missing')
  const raw = parts.map(p => p.payload_text).join('')
  if (await hash(raw) !== manifest.payload_checksum) fail('allocation_checksum_mismatch')
  const allocation = JSON.parse(raw)
  const plan = allocation.content
  if (allocation.signal_date !== manifest.signal_date || allocation.snapshot_kind !== manifest.snapshot_kind
    || allocation.source_run_id !== manifest.source_run_id || plan.owner !== owner
    || plan.candidate_checksum !== artifactChecksum || plan.candidate_artifact_id !== artifactId
    || plan.baseline_checksum !== nav.baseline_checksum || plan.configuration_checksum !== nav.configuration_checksum
    || !finding.pair_ids.includes(plan.pair_id) || !plan.configuration?.formal_baseline_identity)
    fail('allocation_identity_mismatch')
  const frontier = parseNavJournalFrontier(nav.review_family_journal_frontier, family.pair_ids, nav.as_of_date)
  await verifyNavJournalFrontier(db, frontier)
  const proof = Object.freeze({ owner, artifactId, artifactChecksum, decisionChecksum: decision_checksum,
    asOfDate: nav.as_of_date, reviewRecordId: review.h.record_id })
  verified.set(proof, JSON.stringify(canonical(gate)))
  comparisonContexts.set(proof, { configuration: plan.configuration, baseline_checksum: plan.baseline_checksum,
    original_comparison: nav.comparison, journal_frontier: frontier,
    // Verified original bytes above bind this reference. Exposing metadata does
    // not rewrite a frozen allocation, hypothesis, review or maturity date.
    route_source: owner === 'l15_route' ? { signalDate: manifest.signal_date,
      producerRunId: plan.route_effect?.screener_run_id, decisionDeadline: manifest.frozen_at } : null })
  return proof
}
