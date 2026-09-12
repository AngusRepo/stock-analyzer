/** Original Controller NAV decisions -> read-only strategy detail. No grants. */
import type { Bindings } from '../types'
import { controllerJson } from './controllerClient'
import { databaseForDataDomain } from './dataDomainRegistry'
import { atomicNavCanonical, atomicNavDigest, atomicNavOwnsRegistry, readAtomicNavPublication } from './strategyAtomicNavReceipt'
import { sha256Text } from './datasetSnapshots'
import transport from '../../../ml-controller/services/paired_nav_transport_policy.json'
import policy from '../../../ml-controller/services/paired_nav_review_policy.json'

const fail = (): never => { throw new Error('strategy_nav_original_evidence_invalid') }
export async function readStrategyNavEvidence(env: Bindings, input: {
  strategy_id: string; strategy_version: string; business_date: string
}) {
  if (!env.ML_CONTROLLER_SECRET?.trim()) throw new Error('strategy_nav_controller_auth_missing')
  const db = databaseForDataDomain(env, 'learning')
  const [response, navOwner] = await Promise.all([
    controllerJson<any>(env, '/nav/strategy-evidence', { method: 'POST', jsonBody: input,
      timeoutMs: transport.controller_read_timeout_seconds * 1000 }),
    atomicNavOwnsRegistry(db),
  ])
  if (response?.schema_version !== 'strategy-nav-evidence-v1'
    || response.strategy_id !== input.strategy_id || response.strategy_version !== input.strategy_version
    || response.as_of_date !== input.business_date || response.read_only !== true || response.promotion_allowed !== false
    || response.source !== 'original_frozen_policy_and_verified_nav'
    || !['available', 'not_registered', 'unavailable'].includes(response.status)
    || !Array.isArray(response.entries) || response.entry_count !== response.entries.length
    || typeof response.observed_at !== 'string' || !Number.isFinite(Date.parse(response.observed_at))) fail()
  const seen = new Set<string>()
  const policyChecksum = await atomicNavDigest(policy)
  for (const entry of response.entries) {
    const definition = entry.policy_definition
    if (!definition || !Array.isArray(entry.strategy_roles) || !entry.strategy_roles.length
      || seen.has(entry.artifact_checksum) || !/^[a-f0-9]{64}$/.test(entry.artifact_checksum)
      || entry.artifact_id !== `atomic_strategy:${entry.artifact_checksum}`
      || typeof entry.source_run_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.source_run_date)
      || entry.source_run_date > input.business_date
      || await atomicNavDigest(definition) !== entry.artifact_checksum) fail()
    seen.add(entry.artifact_checksum)
    const roles = ['candidate', 'incumbent'].filter(role => definition[role]?.id === input.strategy_id
      && definition[role]?.version === input.strategy_version)
    if (atomicNavCanonical(roles) !== atomicNavCanonical(entry.strategy_roles)) fail()
    if (entry.status === 'unavailable') {
      if (entry.nav !== null || typeof entry.error !== 'string' || !entry.error) fail()
      continue
    }
    const nav = entry.nav
    if (entry.status !== 'available' || entry.error !== null || !nav
      || nav.schema_version !== 'paired-nav-candidate-decision-v1' || nav.owner !== 'atomic_strategy'
      || nav.candidate_artifact_id !== entry.artifact_id || nav.candidate_checksum !== entry.artifact_checksum
      || nav.as_of_date !== input.business_date || nav.policy_checksum !== policyChecksum
      || nav.minimum_evaluable_dates !== policy.minimum_sessions || nav.maximum_evaluable_dates !== policy.final_sessions
      || nav.promotion_allowed !== false || !['PASS', 'HOLD', 'PENDING', 'FAIL'].includes(nav.decision)
      || typeof nav.decision_payload_json !== 'string') fail()
    const { decision_payload_json, decision_checksum, ...fields } = nav
    if (!/^[a-f0-9]{64}$/.test(decision_checksum) || await sha256Text(decision_payload_json) !== `sha256:${decision_checksum}`
      || atomicNavCanonical(JSON.parse(decision_payload_json)) !== atomicNavCanonical(fields)) fail()
    for (const key of ['evaluable_date_count', 'mean_daily_nav_delta', 'holm_adjusted_p', 'review_alpha']) {
      if (nav[key] != null && (typeof nav[key] !== 'number' || !Number.isFinite(nav[key]))) fail()
    }
    if (nav.evaluable_date_count != null && (!Number.isSafeInteger(nav.evaluable_date_count) || nav.evaluable_date_count < 0)) fail()
    if (nav.holm_adjusted_p != null && (nav.holm_adjusted_p < 0 || nav.holm_adjusted_p > 1)) fail()
    if (nav.review_alpha != null && (nav.review_alpha <= 0 || nav.review_alpha > 1)) fail()
  }
  const status = response.entries.some((e: any) => e.status !== 'available') ? 'unavailable'
    : response.entries.length ? 'available' : 'not_registered'
  if (response.status !== status) fail()
  const entries = await Promise.all(response.entries.map(async (entry: any) => {
    const row = navOwner ? await db.prepare('SELECT * FROM strategy_atomic_nav_adoptions_v1 WHERE artifact_checksum=?')
      .bind(entry.artifact_checksum).first<Record<string, any>>() : null
    const published = row ? await readAtomicNavPublication(db, row) : null
    return { ...entry, publication: published ? { receipt_checksum: row!.receipt_checksum,
      knowledge_cutoff_date: published.receipt.knowledge_cutoff_date,
      decision_checksum: row!.decision_checksum, historical_publication_verified: true } : null }
  }))
  if (await atomicNavOwnsRegistry(db) !== navOwner) throw new Error('strategy_nav_owner_changed_during_read')
  return { ...response, entries,
    current_replacement_owner: navOwner ? 'original_paired_daily_nav' : 'legacy_atomic_v7' }
}
