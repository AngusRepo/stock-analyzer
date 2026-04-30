import { evaluateResearchInternGate } from './researchInternGate'
import type { ResearchExperimentRecord } from './researchExperimentRegistry'
import { assertOwnerCanOwn } from './strategyOwnerFreeze'

export type ResearchEvaluationStepKind = 'backtest' | 'walk_forward' | 'verify'

export interface ResearchEvaluationStep {
  id: string
  kind: ResearchEvaluationStepKind
  controller_endpoint: string | null
  method: 'POST'
  body: Record<string, unknown>
  mutation_allowed: false
  gate_decision: 'ALLOW' | 'REQUIRE_APPROVAL' | 'BLOCK'
  execution_ready: boolean
  block_reason?: string
}

export interface ResearchEvaluationPlan {
  experiment_id: string
  mode: 'dry_run_only'
  hypothesis: string
  steps: ResearchEvaluationStep[]
  warnings: string[]
  blocked_capabilities: string[]
}

const BLOCKED_CAPABILITIES = [
  'production retrain',
  'model promote',
  'production deploy',
  'paper/live trade execution',
  'trading config mutation',
]

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function cleanObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function dateRange(record: ResearchExperimentRecord): { startDate: string; endDate: string } {
  const dataSlice = cleanObject(record.data_slice)
  const startDate = cleanText(dataSlice.start_date) || '2025-01-01'
  const endDate = cleanText(dataSlice.end_date) || new Date().toISOString().slice(0, 10)
  return { startDate, endDate }
}

function baseBody(record: ResearchExperimentRecord): Record<string, unknown> {
  return {
    experiment_id: record.id,
    hypothesis: record.hypothesis,
    strategy_spec_ids: record.strategy_spec_ids,
    data_slice: cleanObject(record.data_slice),
    metrics: record.metrics,
  }
}

export function buildResearchEvaluationPlan(record: ResearchExperimentRecord): ResearchEvaluationPlan {
  assertOwnerCanOwn('research', 'experiment_registry')
  assertOwnerCanOwn('research', 'review_packet')

  const warnings: string[] = []
  if (!cleanText(record.hypothesis) || record.hypothesis.length < 12) warnings.push('hypothesis_too_short')
  if (!record.strategy_spec_ids?.length) warnings.push('strategy_spec_ids_missing')
  if (!record.metrics?.length) warnings.push('metrics_missing')

  const backtestGate = evaluateResearchInternGate({ action: 'request_backtest_dry_run', dryRun: true, experimentId: record.id })
  const walkForwardGate = evaluateResearchInternGate({ action: 'request_walk_forward_dry_run', dryRun: true, experimentId: record.id })
  const verifyGate = evaluateResearchInternGate({ action: 'request_verify_dry_run', dryRun: true, experimentId: record.id })

  const common = baseBody(record)
  const { startDate, endDate } = dateRange(record)
  return {
    experiment_id: record.id,
    mode: 'dry_run_only',
    hypothesis: record.hypothesis,
    warnings,
    blocked_capabilities: BLOCKED_CAPABILITIES,
    steps: [
      {
        id: `${record.id}:backtest-dry-run`,
        kind: 'backtest',
        controller_endpoint: '/backtest/replay',
        method: 'POST',
        body: {
          ...common,
          start_date: startDate,
          end_date: endDate,
          params: {},
          mode: 'B',
          persist_results: false,
          persist_confirm: false,
          verbose: false,
          source: 'research_experiment',
          research_mode: 'strategy_spec_replay',
        },
        mutation_allowed: false,
        gate_decision: backtestGate.decision,
        execution_ready: true,
      },
      {
        id: `${record.id}:walk-forward-dry-run`,
        kind: 'walk_forward',
        controller_endpoint: '/walk_forward/dry-run',
        method: 'POST',
        body: {
          ...common,
          start_date: startDate,
          end_date: endDate,
          train_window_days: 60,
          test_window_days: 30,
          subset_size: 200,
          batch_count: 5,
          concurrent_windows: 2,
        },
        mutation_allowed: false,
        gate_decision: walkForwardGate.decision,
        execution_ready: true,
      },
      {
        id: `${record.id}:verify-dry-run`,
        kind: 'verify',
        controller_endpoint: '/verify/dry-run',
        method: 'POST',
        body: {
          ...common,
          run_date: endDate,
          lookback_days: 5,
          limit: 200,
          async_mode: false,
          source: 'research_experiment',
          research_mode: 'strategy_spec_verify',
        },
        mutation_allowed: false,
        gate_decision: verifyGate.decision,
        execution_ready: true,
      },
    ],
  }
}
