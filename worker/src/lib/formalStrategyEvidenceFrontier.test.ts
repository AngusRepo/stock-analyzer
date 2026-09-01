import assert from 'node:assert/strict'

import { auditFormalStrategyEvidenceFrontier } from './eveningChainEvidenceClosure'
import { SELECTION_REFERENCE_LEGACY_MATURE_CONTRACT_VERSION } from './selectionReferenceEvidence'
import {
  STRATEGY_FORMAL_LABELER_LEGACY_VERSION,
  STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION,
} from './strategySpec'

class FakeStatement {
  private args: unknown[] = []

  constructor(
    private readonly role: 'ops' | 'learning' | 'market',
    private readonly staleDate: string | null,
    private readonly invalidLineageDate: string | null,
    private readonly missingHeadDate: string | null,
  ) {}

  bind(...args: unknown[]): FakeStatement {
    this.args = args
    return this
  }

  all<T>(): Promise<{ results: T[] }> {
    if (this.role === 'ops') {
      return Promise.resolve({
        results: [
          { signal_date: '2026-08-18', producer_run_id: 'screener-2026-08-18' },
          { signal_date: '2026-08-19', producer_run_id: 'screener-2026-08-19' },
        ].filter((row) => row.signal_date !== this.missingHeadDate) as T[],
      })
    }
    if (this.role === 'market') {
      return Promise.resolve({
        results: [
          { session_date: '2026-08-18' },
          { session_date: '2026-08-19' },
        ] as T[],
      })
    }
    const headArgs = this.args.slice(0, this.args.length - 3)
    const rows = [] as any[]
    for (let index = 0; index < headArgs.length; index += 2) {
      const signalDate = String(headArgs[index])
      const producerRunId = String(headArgs[index + 1])
      rows.push({
        signal_date: signalDate,
        producer_run_id: producerRunId,
        ledger_status: signalDate === this.staleDate ? 'failed' : 'success',
        ledger_labeler_version: STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION,
        evaluation_contract_version: 'strategy-evaluation-v2',
        ledger_producer_run_id: signalDate === this.invalidLineageDate ? 'non-canonical-run' : producerRunId,
        source_reference_contract_version: SELECTION_REFERENCE_LEGACY_MATURE_CONTRACT_VERSION,
        production_policy_id: 'strategy-production-contribution-firewall-v3',
        production_policy_knowledge_cutoff_date: '2026-08-14',
        production_policy_checksum: 'a'.repeat(64),
        production_policy_source_contract: 'previous-firewall-v2',
        production_policy_rows: 1,
        matrix_status: 'ready',
        matrix_labeler_version: STRATEGY_FORMAL_LABELER_LEGACY_VERSION,
        reference_contract_version: SELECTION_REFERENCE_LEGACY_MATURE_CONTRACT_VERSION,
        reference_candidate_count: 100,
        expected_cell_count: 2600,
        persisted_cell_count: 2600,
        matrix_contract_rows: 2600,
        reference_contract_rows: 100,
        reference_projection_rows: 100,
        challenger_projection_rows: 2600,
        matched_rows: 200,
        threshold_evidence_rows: 200,
        projected_threshold_rows: 200,
      })
    }
    return Promise.resolve({ results: rows as T[] })
  }
}

class FakeD1 {
  constructor(
    private readonly role: 'ops' | 'learning' | 'market',
    private readonly staleDate: string | null = null,
    private readonly invalidLineageDate: string | null = null,
    private readonly missingHeadDate: string | null = null,
  ) {}

  prepare(_sql: string): FakeStatement {
    return new FakeStatement(this.role, this.staleDate, this.invalidLineageDate, this.missingHeadDate)
  }
}

async function main(): Promise<void> {
  const complete = await auditFormalStrategyEvidenceFrontier(
    new FakeD1('learning') as any,
    new FakeD1('ops') as any,
    new FakeD1('market') as any,
    '2026-08-19',
  )
  assert.deepEqual(complete.readyDates, ['2026-08-18', '2026-08-19'])
  assert.deepEqual(complete.backlog, [])

  const stale = await auditFormalStrategyEvidenceFrontier(
    new FakeD1('learning', '2026-08-19') as any,
    new FakeD1('ops') as any,
    new FakeD1('market') as any,
    '2026-08-19',
  )
  assert.deepEqual(stale.readyDates, ['2026-08-18'])
  assert.deepEqual(stale.backlog, [{
    date: '2026-08-19',
    blockers: ['formal_ledger_not_closed'],
  }])

  const invalidLineage = await auditFormalStrategyEvidenceFrontier(
    new FakeD1('learning', null, '2026-08-19') as any,
    new FakeD1('ops') as any,
    new FakeD1('market') as any,
    '2026-08-19',
  )
  assert.deepEqual(invalidLineage.readyDates, ['2026-08-18'])
  assert.deepEqual(invalidLineage.backlog, [{
    date: '2026-08-19',
    blockers: ['formal_ledger_lineage_invalid'],
  }])

  const missingHead = await auditFormalStrategyEvidenceFrontier(
    new FakeD1('learning') as any,
    new FakeD1('ops', null, null, '2026-08-19') as any,
    new FakeD1('market') as any,
    '2026-08-19',
  )
  assert.deepEqual(missingHead.readyDates, ['2026-08-18'])
  assert.deepEqual(missingHead.backlog, [{
    date: '2026-08-19',
    blockers: ['formal_canonical_head_missing'],
  }])
}

void main()
