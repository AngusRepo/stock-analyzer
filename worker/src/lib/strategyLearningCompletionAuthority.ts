import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import { resolveEveningChainRunAuthority, type EveningChainRunAuthority } from './eveningChainRunAuthority'
import { strategyRegistryFingerprintPayload } from './selectionReferenceEvidence'
import { sha256Text } from './datasetSnapshots'
import type { StrategySpec } from './strategySpec'

/** Only an existing, timely frozen canonical run may finish learning late.
 * This does not authorize a late screener, historical re-scoring or promotion.
 * Serving separately enforces actual policy publication time.
 */
export async function resolveStrategyLearningCompletionAuthority(
  env: Bindings,
  input: { businessDate: string; canonicalRunId: string; producerRunId: string; specs: StrategySpec[] },
): Promise<EveningChainRunAuthority & { lateCompletion: boolean }> {
  const authority = await resolveEveningChainRunAuthority(env, input)
  if (authority.allowed) return { ...authority, lateCompletion: false }
  if (authority.reason !== 'next_executable_session_opened_use_snapshot_only_repair'
    || !authority.queuedAt || !authority.nextSessionOpenUtc) {
    return { ...authority, lateCompletion: false }
  }
  const source = await databaseForDataDomain(env, 'ops').prepare(`
    SELECT p.canonical_at
      FROM pipeline_runs p
      JOIN canonical_run_heads h ON h.run_id=p.run_id
     WHERE p.run_id=? AND p.business_date=? AND p.domain='screener'
       AND h.logical_run_key=?
       AND datetime(p.canonical_at)<datetime(?)
       AND EXISTS (
         SELECT 1 FROM pipeline_stage_runs s
          WHERE s.business_date=p.business_date AND s.stage='screener_v2'
            AND s.status='success' AND s.cursor_key=p.run_id
       )
  `).bind(input.producerRunId, input.businessDate,
    `screener:${input.businessDate}:TW:production:market_screener`, authority.nextSessionOpenUtc,
  ).first<{ canonical_at: string }>()
  const checksum = await sha256Text(JSON.stringify(strategyRegistryFingerprintPayload(input.specs)))
  const frozen = await databaseForDataDomain(env, 'learning').prepare(`
    SELECT mr.expected_cell_count,
      (SELECT COUNT(*) FROM strategy_label_matrix_v4 m
        WHERE m.signal_date=mr.signal_date AND m.producer_run_id=mr.producer_run_id
          AND m.strategy_registry_checksum=mr.strategy_registry_checksum
          AND m.labeler_version=mr.labeler_version
          AND m.reference_contract_version=mr.reference_contract_version
          AND datetime(m.created_at)<datetime(?)) matrix_rows,
      (SELECT COUNT(*) FROM selection_reference_snapshots_v1 r
        WHERE r.signal_date=mr.signal_date AND r.producer_run_id=mr.producer_run_id
          AND r.hard_gate_passed=1 AND r.strategy_registry_checksum=mr.strategy_registry_checksum
          AND r.strategy_labeler_version=mr.labeler_version
          AND r.feature_contract_version=mr.reference_contract_version
          AND r.evidence_artifact_id=mr.evidence_artifact_id
          AND datetime(r.created_at)<datetime(?)) reference_rows,
      mr.reference_candidate_count
    FROM strategy_label_matrix_runs_v4 mr
    WHERE mr.signal_date=? AND mr.producer_run_id=? AND mr.status='ready'
      AND mr.strategy_registry_checksum=? AND mr.strategy_count=?
      AND mr.expected_cell_count=mr.persisted_cell_count
      AND datetime(mr.created_at)<datetime(?)
  `).bind(authority.nextSessionOpenUtc, authority.nextSessionOpenUtc,
    input.businessDate, input.producerRunId, checksum, input.specs.length, authority.nextSessionOpenUtc,
  ).first<{ expected_cell_count: number; matrix_rows: number; reference_rows: number; reference_candidate_count: number }>()
  const valid = Boolean(source) && Number(frozen?.expected_cell_count) > 0
    && Number(frozen?.expected_cell_count) === Number(frozen?.matrix_rows)
    && Number(frozen?.reference_candidate_count) > 0
    && Number(frozen?.reference_candidate_count) === Number(frozen?.reference_rows)
  return valid
    ? { ...authority, allowed: true, runScope: 'live_canonical', lateCompletion: true,
        reason: 'timely_frozen_evidence_late_completion_forward_policy_only' }
    : { ...authority, allowed: false, lateCompletion: false,
        reason: 'late_learning_frozen_source_or_registry_invalid' }
}
