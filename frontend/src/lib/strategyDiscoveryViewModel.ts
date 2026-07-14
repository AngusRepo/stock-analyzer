export type AnalysisButtonState = 'READY' | 'RUNNING' | 'COMPLETED' | 'FAILED_RECOVERABLE' | 'BLOCKED'
export type CodexButtonState = 'NOT_READY' | 'HANDOFF_READY' | 'AWAITING_RESULT' | 'RESULT_READY'

export interface AnalysisRun {
  run_id: string
  status: string
  completed_steps: number
  total_steps: number
  current_step: string | null
  feature_version?: string | null
  strategy_version?: string | null
  input_hash?: string | null
  blockers: string[]
  warnings: string[]
  fixture_mode: boolean
  created_at: string
  updated_at: string
}

export interface DashboardState {
  analysis_button: { enabled: boolean; state: AnalysisButtonState; message: string }
  codex_button: { enabled: boolean; state: CodexButtonState; message: string }
  current_snapshot: {
    feature_version: string
    strategy_version: string
    strategy_count: number
    feature_count: number
    snapshot_hash: string
  } | null
  latest_run: AnalysisRun | null
  codex_handoff: {
    run_id: string
    bundle_hash: string
    bundle_created_at: string
    repo_skill: 'strategy-discovery-jury'
    command: string
  } | null
  workers_ai: {
    usage_scope: 'ACCOUNT' | 'LAB_ONLY' | 'UNKNOWN'
    known_used_neurons: number
    external_reserved_neurons: number
    estimated_run_neurons: number
    safe_remaining_neurons: number
  }
  warnings: string[]
  blockers: string[]
}

export interface FinalConclusion {
  run_id: string
  bundle_hash: string
  executive_conclusion: {
    overall_health: string
    most_severe_issue: string
    confirmed_leakage: boolean | 'UNKNOWN'
    invalid_strategy_count: number
    locked_test_candidate_count: number
    summary: string
  }
  existing_strategies: Array<Record<string, unknown>>
  new_candidates: Array<Record<string, unknown>>
  red_team_accuracy: Array<Record<string, unknown>>
  tests: Array<Record<string, unknown>>
  remaining_uncertainty: {
    confirmed_issues: unknown[]
    refuted_issues: unknown[]
    unverifiable_issues: unknown[]
    missing_data: unknown[]
    recommended_next_steps: unknown[]
  }
}

export function formatStep(step: string | null): string {
  if (!step) return '等待 Workflow checkpoint'
  return step.replace(/^\d+_/, '').split('_').join(' ')
}

export function isRunPolling(state: DashboardState | null): boolean {
  return state?.analysis_button.state === 'RUNNING'
}

export function formatUtc(value: string): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'Asia/Taipei' }).format(date)
    : value
}
