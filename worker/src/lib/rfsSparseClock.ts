import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import type { EvidenceClock } from './shadowEvidenceClocks'

export type RfsSummary = {
  plan_id: string; policy_identity: string; model_checksum: string; signal_date: string
  status: string; packet_checksum: string; blockers: string; candidate_count: number
}
export function summarizeRfs(latest: RfsSummary | null, currentPlan: string | null,
  totals: { samples: number; dates: number; blocked: number },
  outcomes: Array<{ horizon: number; dates: number; mean_delta: number }>): EvidenceClock {
  const blockers: string[] = latest ? JSON.parse(latest.blockers || '[]') : ['rfs_comparison_not_materialized']
  if (currentPlan && currentPlan !== latest?.plan_id) blockers.push('current_published_plan_comparison_missing')
  const h5 = outcomes.find(row => row.horizon === 5)
  const h20 = outcomes.find(row => row.horizon === 20)
  return {
    mechanism: 'rfs_allocator', label: 'RFS vs sparse allocator', governance: 'comparison_only', auto_promote: false,
    status: blockers.length ? 'blocked' : latest?.status ?? 'not_materialized',
    latest_evidence_date: latest?.signal_date ?? null, sample_count: totals.samples,
    distinct_dates: totals.dates, supported_regimes: [], coverage: totals.samples + totals.blocked > 0
      ? totals.samples / (totals.samples + totals.blocked) : null,
    incumbent_delta: h5?.mean_delta ?? null, confidence_bound: null, blockers,
    artifact_or_packet_checksum: latest?.packet_checksum ?? null,
    details: {
      sample_count_semantic: 'immutable_valid_allocation_pairs_current_policy_and_model',
      candidate_count: latest?.candidate_count ?? null, blocked_receipts: totals.blocked,
      mature_5_session_dates: h5?.dates ?? 0, mature_20_session_dates: h20?.dates ?? 0,
      mean_delta_20: h20?.mean_delta ?? null,
      outcome_semantic: 'fixed_basket_adjusted_close_not_paper_NAV',
      confidence_note: 'Overlapping outcomes; no independent-sample confidence claim.', production_effect: false,
    },
  }
}

export async function rfsSparseClock(env: Bindings): Promise<EvidenceClock> {
  const db = databaseForDataDomain(env, 'learning')
  const paper = databaseForDataDomain(env, 'paper')
  const [latest, head] = await Promise.all([
    db.prepare(`SELECT plan_id,policy_identity,signal_date,status,packet_checksum,
      json_extract(payload_json,'$.model_checksum') AS model_checksum,
      json_extract(payload_json,'$.validation_blockers') AS blockers,
      json_extract(payload_json,'$.source_expected_return_candidate_count') AS candidate_count
      FROM rfs_sparse_comparisons_v1 WHERE schema_version='rfs-b-sparse-comparison-v1'
      ORDER BY observed_at DESC,plan_id DESC LIMIT 1`).first<RfsSummary>(),
    paper.prepare('SELECT plan_id FROM l4_portfolio_head_v1 WHERE account_id=1').first<{plan_id: string}>(),
  ])
  if (!latest) return summarizeRfs(null, head?.plan_id ?? null, {samples: 0, dates: 0, blocked: 0}, [])
  const cohort = `c.schema_version='rfs-b-sparse-comparison-v1' AND c.policy_identity=?
    AND json_extract(c.payload_json,'$.model_checksum') IS ?`
  const [totals, outcomes] = await Promise.all([
    db.prepare(`SELECT coalesce(sum(status='collecting'),0) AS samples,
      count(DISTINCT CASE WHEN status='collecting' THEN signal_date END) AS dates,
      coalesce(sum(status='blocked'),0) AS blocked FROM rfs_sparse_comparisons_v1 c WHERE ${cohort}`)
      .bind(latest.policy_identity, latest.model_checksum).first<{samples: number; dates: number; blocked: number}>(),
    // A day with multiple receipts contributes one observation, not several independent samples.
    db.prepare(`SELECT horizon,count(*) AS dates,avg(day_delta) AS mean_delta FROM (
      SELECT o.horizon,o.entry_date,avg(o.delta) AS day_delta FROM rfs_sparse_outcomes_v1 o
      JOIN rfs_sparse_comparisons_v1 c ON c.plan_id=o.plan_id WHERE ${cohort}
      AND c.status='collecting' GROUP BY o.horizon,o.entry_date) GROUP BY horizon`)
      .bind(latest.policy_identity, latest.model_checksum).all<{horizon: number; dates: number; mean_delta: number}>(),
  ])
  return summarizeRfs(latest, head?.plan_id ?? null, totals ?? {samples: 0, dates: 0, blocked: 0}, outcomes.results ?? [])
}
