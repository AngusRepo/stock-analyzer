export const UNKNOWN = 'UNKNOWN' as const
export type UnknownValue = typeof UNKNOWN
export type KnownNumber = number | UnknownValue

export type AnalysisRunStatus =
  | 'CREATED'
  | 'PREFLIGHT'
  | 'RUNNING'
  | 'CLOUD_ANALYSIS_COMPLETE'
  | 'CODEX_HANDOFF_READY'
  | 'AWAITING_RESULT'
  | 'RESULT_READY'
  | 'FAILED_RECOVERABLE'
  | 'BLOCKED'

export type AnalysisButtonState = 'READY' | 'RUNNING' | 'COMPLETED' | 'FAILED_RECOVERABLE' | 'BLOCKED'
export type CodexButtonState = 'NOT_READY' | 'HANDOFF_READY' | 'AWAITING_RESULT' | 'RESULT_READY'
export type SearchMode =
  | 'MODE_A_FREE_DISCOVERY'
  | 'MODE_B_PARENT_MUTATION'
  | 'MODE_C_PORTFOLIO_GAP'
  | 'MODE_D_REGIME_SPECIALIST'

export type MutationType =
  | 'ADD_GATE'
  | 'REPLACE_FEATURE'
  | 'SIMPLIFY_RULE'
  | 'MODIFY_EXIT'
  | 'REDUCE_TURNOVER'
  | 'NEUTRALIZE_EXPOSURE'

export interface FeatureCard {
  feature_id: string
  name: string
  family: string
  definition: string | UnknownValue
  data_source: string[]
  availability_lag: string | UnknownValue
  earliest_execution: string | UnknownValue
  lookback_days: number | UnknownValue
  point_in_time?: {
    status: 'VERIFIED' | 'UNKNOWN'
    policy_version: string
    evidence_refs: string[]
  }
  missing_rate: KnownNumber
  outlier_rate: KnownNumber
  turnover_proxy: KnownNumber
  correlation_cluster: string | UnknownValue
  ic_summary: Record<string, KnownNumber>
  regime_summary: Record<string, unknown>
  factor_exposure: Record<string, unknown>
  used_by_strategies: string[]
  known_risks: string[]
  governance: {
    selector_role: string
    promotion_state: string
    materializer_status: string
    eligible_for_strategy: boolean
  }
}

export interface StrategyCard {
  strategy_id: string
  version: string
  name: string
  hypothesis: string
  feature_ids: string[]
  entry_rules: unknown[]
  exit_rules: unknown[]
  holding_period: string | UnknownValue
  execution_timing: string | UnknownValue
  transaction_cost: Record<string, unknown> | UnknownValue
  preferred_regimes: string[]
  failure_regimes: string[]
  annual_performance: Record<string, unknown>
  regime_performance: Record<string, unknown>
  factor_exposure: Record<string, unknown>
  signal_correlation: Record<string, unknown>
  selection_overlap: Record<string, unknown>
  known_failures: string[]
  source_references: string[]
  governance: {
    status: string
    owner_type: string
    promotion_status: string
    alpha_bucket: string
    family_id: string
    variant_id: string
  }
}

export interface SharedSystemProfile {
  schema_version: string
  market: 'TW_EQUITY'
  timezone: 'Asia/Taipei'
  feature_availability_policy: string
  strategy_execution_policy: string
  transaction_cost_policy: string | UnknownValue
  data_sources: string[]
  source_hashes: Record<string, string>
}

export interface SnapshotManifest {
  schema_version: string
  run_id: string
  created_at: string
  feature_version: string
  strategy_version: string
  feature_snapshot_hash: string
  strategy_snapshot_hash: string
  system_profile_hash: string
  input_hash: string
  feature_count: number
  strategy_count: number
  fixture_mode: boolean
}

export interface PortfolioGapMap {
  overrepresented: string[]
  underrepresented: string[]
  missing_regimes: string[]
  missing_horizons: string[]
  unused_feature_clusters: string[]
  highly_correlated_strategy_groups: string[][]
}

export interface FeatureCluster {
  cluster_id: string
  family: string
  feature_ids: string[]
  feature_count: number
  used_feature_count: number
  strategy_ids: string[]
  method: 'SOURCE_CORRELATION_CLUSTER' | 'FAMILY_FALLBACK'
}

export interface DeterministicFeatureIntelligence {
  feature_clusters: FeatureCluster[]
  family_distribution: Record<string, number>
  feature_usage_frequency: Record<string, number>
  strategy_feature_coverage: Record<string, { known_feature_count: number; unknown_feature_ids: string[] }>
  exact_feature_duplicate_groups: string[][]
  limitations: string[]
}

export interface RegimeSampleEvidence {
  regime: 'bull' | 'bear' | 'volatile' | 'sideways'
  max_samples: number
  evidence_rows: number
  source: 'd1:strategy_reward_ledger'
  count_policy: 'MAX_PER_EVIDENCE_ROW_NO_SUM'
}

export interface StrategyHypothesis {
  hypothesis_id: string
  run_id: string
  search_mode: SearchMode
  parent_strategy_id: string | null
  mutation_type: MutationType | null
  hypothesis: string
  economic_mechanism: string
  portfolio_gap: string
  preferred_regimes: string[]
  minimum_regime_samples: number | UnknownValue
  feature_ids: string[]
  falsification_condition: string
  source_model: string
  source_type: 'REAL' | 'FIXTURE'
}

export interface StaticValidationResult {
  candidate_id: string
  candidate_hash: string
  valid: boolean
  errors: string[]
  warnings: string[]
}

export interface StrategyDsl {
  feature_ids: string[]
  parameters: Record<string, string | number | boolean>
  regime_gate: Record<string, unknown> | null
  entry_rules: unknown[]
  exit_rules: unknown[]
  signal_time: string
  execution_time: string
  falsification_condition: string
  lags: number[]
}

export interface StrategyCandidate {
  candidate_id: string
  run_id: string
  search_mode: SearchMode
  parent_strategy_id: string | null
  mutation_type: MutationType | null
  hypothesis: string
  economic_mechanism: string
  portfolio_gap: string
  preferred_regimes: string[]
  minimum_regime_samples: number | UnknownValue
  dsl: StrategyDsl
  candidate_hash: string
  source_model: string
  source_type: 'REAL' | 'FIXTURE'
}

export type EvidenceLevel = 'E0' | 'E1' | 'E2' | 'E3' | 'E4'
export type CrossExamStatus =
  | 'VALID_CLAIM'
  | 'POSSIBLE_BUT_UNVERIFIED'
  | 'OVERSTATED'
  | 'DUPLICATE'
  | 'NOT_APPLICABLE'
  | 'UNSUBSTANTIATED'

export interface AuditIssue {
  issue_id: string
  run_id: string
  target_type: 'STRATEGY' | 'CANDIDATE' | 'SYSTEM'
  target_ids: string[]
  category: string
  claim: string
  attack_mechanism: string
  observed_evidence: unknown[]
  missing_evidence: string[]
  severity_if_true: 'FATAL' | 'MAJOR' | 'MINOR' | 'INFO'
  evidence_level: EvidenceLevel
  critic_model: string
  critic_confidence: number
  falsification_test: Record<string, unknown>
  blocks_if_confirmed: boolean
  cross_exam_status: CrossExamStatus
  duplicate_of: string | null
}

export type IssueVerdict = 'CONFIRMED' | 'PARTIALLY_CONFIRMED' | 'REFUTED' | 'UNVERIFIED' | 'NOT_APPLICABLE'
export type StrategyVerdict = 'INVALID' | 'BLOCKED' | 'RETEST_REQUIRED' | 'SURVIVED' | 'INSUFFICIENT_EVIDENCE'
export type CandidateVerdict = 'REJECTED' | 'BLOCKED' | 'RETEST_REQUIRED' | 'READY_FOR_LOCKED_TEST' | 'INSUFFICIENT_EVIDENCE'

export interface CodeEvidence {
  file: string
  line_start: number
  line_end: number
  finding: string
}

export interface IssueVerdictRecord {
  issue_id: string
  verdict: IssueVerdict
  severity: 'FATAL' | 'MAJOR' | 'MINOR' | 'INFO'
  evidence_level: EvidenceLevel
  evidence: CodeEvidence[]
  commands_executed: string[]
  test_results: unknown[]
  remaining_uncertainty: string[]
  required_fix: string
  blocks_target: boolean
}

export interface AnalysisRunRecord {
  run_id: string
  status: AnalysisRunStatus
  idempotency_key: string
  workflow_instance_id: string | null
  workflow_attempt: number
  feature_version: string | null
  strategy_version: string | null
  feature_snapshot_hash: string | null
  strategy_snapshot_hash: string | null
  system_profile_hash: string | null
  input_hash: string | null
  prompt_set_version: string
  schema_set_version: string
  completed_steps: number
  total_steps: number
  current_step: string | null
  blockers: string[]
  warnings: string[]
  fixture_mode: boolean
  created_at: string
  updated_at: string
  heartbeat_at: string | null
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
  latest_run: AnalysisRunRecord | null
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

export interface ModelCallResult<T> {
  parsed: T
  raw: unknown
  model_id: string
  model_version: string
  prompt_tokens: number
  output_tokens: number
  estimated_neurons: number
  repair_count: number
  source_type: 'REAL' | 'FIXTURE'
}
