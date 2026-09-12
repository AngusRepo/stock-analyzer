/** Observe ORIGINAL canonical selection; no new ledger, gate or execution. */
import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import { readCurrentCanonicalAtomicPolicy } from './atomicStrategySource'
import { atomicNavDigest, readAtomicNavPublication } from './strategyAtomicNavReceipt'
import { STRATEGY_PRODUCTION_FIREWALL_POLICY_ID } from './strategyProductionContributionFirewall'
import { verifyStrategyProductionPolicyRecord, type StrategyProductionPolicyHistoryRow } from './strategyProductionPolicyStore'
import { resolveStrategyServingSpecs } from './strategyProductionWeightReplay'
import { paperExecutionDate } from './paperExecutionScope'

type Canonical = Awaited<ReturnType<typeof readCurrentCanonicalAtomicPolicy>>
type Publication = { owner: 'atomic_strategy' | 'l15_route'; artifact_id: string; artifact_checksum: string;
  publication_receipt_checksum: string; published_at: string }
const fail = (reason: string): never => { throw new Error('nav_screener_observation_' + reason) }
const clock = (value: string) => {
  const utc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? value.replace(' ', 'T') + 'Z' : value
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(utc) || !Number.isFinite(Date.parse(utc))) fail('time_invalid')
  return utc
}

async function observation(publication: Publication, day: string, canonical: Canonical | null,
  matches: boolean, policyChecksum: string | null = null) {
  const publishedAt = clock(publication.published_at)
  const observedAt = canonical?.source.observed_at ?? null
  if (matches && observedAt && Date.parse(observedAt) < Date.parse(publishedAt)) fail('used_before_publication')
  const body = { schema_version: 'nav-canonical-screener-observation-v1', ...publication, published_at: publishedAt,
    business_date: day, source: 'original_canonical_screener', scope: 'canonical_l1_l15_selection',
    status: matches ? 'observed' : 'not_observed', executed: matches,
    reason: matches ? 'published_policy_used_by_canonical_selection'
      : canonical ? 'canonical_uses_different_policy' : 'current_canonical_not_available',
    canonical_artifact_id: canonical?.canonical_artifact_id ?? null,
    canonical_artifact_checksum: canonical?.canonical_artifact_checksum ?? null,
    producer_run_id: canonical?.source.producer_run_id ?? null,
    source_checksum: canonical?.source.source_checksum ?? null,
    source_observed_at: observedAt, baseline_checksum: canonical?.source.baseline_checksum ?? null,
    policy_checksum: policyChecksum, read_only: true, promotion_allowed: false, nav_maturity_credit: 0,
    orders_executed_verified: false }
  return { ...body, observation_checksum: await atomicNavDigest(body) }
}

export async function observeAtomicCanonicalUse(db: D1Database, canonical: Canonical,
  published: Awaited<ReturnType<typeof readAtomicNavPublication>>) {
  const { receipt, row } = published
  const specs = canonical.source.inputs.specs
  const sameRoles = await atomicNavDigest([...specs].sort((a, b) => a.id.localeCompare(b.id))) === receipt.after_registry_checksum
  let policyChecksum: string | null = null
  if (sameRoles) {
    const captured = canonical.source.inputs.productionWeightSource
    if (!captured) fail('atomic_original_weight_source_missing')
    // Exact original capsule, not today's latest policy or a freshly rebuilt one.
    const rows = (await db.prepare(`SELECT * FROM strategy_production_policy_history_v1
      WHERE policy_id=? AND json_extract(canonical_payload,'$.evidence_owner.weight_source.source_checksum')=? LIMIT 2`)
      .bind(STRATEGY_PRODUCTION_FIREWALL_POLICY_ID, captured!.source_checksum)
      .all<StrategyProductionPolicyHistoryRow>()).results ?? []
    if (rows.length !== 1) fail('atomic_original_policy_missing_or_ambiguous')
    const policy = await verifyStrategyProductionPolicyRecord(rows[0], specs.map(spec => spec.id))
    await resolveStrategyServingSpecs(specs, policy, canonical.source.signal_date)
    policyChecksum = policy.checksum
  }
  return observation({ owner: 'atomic_strategy', artifact_id: receipt.artifact_id,
    artifact_checksum: receipt.artifact_checksum, publication_receipt_checksum: row.receipt_checksum,
    published_at: row.created_at }, canonical.source.signal_date, canonical, sameRoles, policyChecksum)
}

export async function observeRouteCanonicalUse(env: Bindings, input: Publication & {
  owner: 'l15_route'; business_date: string; run_id: string; route_version: string }, now = paperExecutionDate()) {
  const day = input.business_date
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day))
    || new Date(day).toISOString().slice(0, 10) !== day) fail('date_invalid')
  const db = databaseForDataDomain(env, 'ops')
  const runs = (await db.prepare(`SELECT run_id FROM pipeline_runs
    WHERE business_date=? AND domain='screener' AND status='canonical' AND canonical_at IS NOT NULL`)
    .bind(day).all<{ run_id: string }>()).results ?? []
  if (runs.length > 1) fail('canonical_ambiguous')
  const canonical = runs.length ? await readCurrentCanonicalAtomicPolicy(env, day, now) : null
  const route = canonical?.source.inputs.options.promotedRouteCalibration
  const matches = Boolean(route && route.runId === input.run_id && route.routeVersion === input.route_version
    && route.routeFloor === null)
  const publication = { owner: input.owner, artifact_id: input.artifact_id, artifact_checksum: input.artifact_checksum,
    publication_receipt_checksum: input.publication_receipt_checksum, published_at: input.published_at }
  const result = await observation(publication, day, canonical, matches)
  const final = (await db.prepare(`SELECT run_id FROM pipeline_runs
    WHERE business_date=? AND domain='screener' AND status='canonical' AND canonical_at IS NOT NULL`)
    .bind(day).all<{ run_id: string }>()).results ?? []
  if (await atomicNavDigest(runs) !== await atomicNavDigest(final)) fail('canonical_changed')
  return result
}
