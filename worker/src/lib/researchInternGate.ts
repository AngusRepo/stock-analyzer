import { assertOwnerCanOwn } from './strategyOwnerFreeze'

export type ResearchInternAction =
  | 'read_source'
  | 'generate_hypothesis'
  | 'create_experiment'
  | 'request_backtest_dry_run'
  | 'request_walk_forward_dry_run'
  | 'request_verify_dry_run'
  | 'request_model_benchmark_dry_run'
  | 'generate_review_packet'
  | 'approve_shadow'
  | 'request_more_evidence'
  | 'promote_paper_active'
  | 'archive_experiment'
  | 'generate_patch'
  | 'retrain_prod'
  | 'promote_model'
  | 'deploy_prod'
  | 'place_trade'

export type ResearchGateDecision = 'ALLOW' | 'REQUIRE_APPROVAL' | 'BLOCK'

export interface ResearchInternGateRequest {
  action: ResearchInternAction | string
  experimentId?: string
  dryRun?: boolean
  approval?: {
    reviewer?: string
    approved?: boolean
    scope?: string
  }
}

export interface ResearchInternGateResult {
  decision: ResearchGateDecision
  action: string
  reason: string
  allowed_next_steps: string[]
  blocked_capabilities: string[]
}

const SAFE_ACTIONS = new Set<ResearchInternAction>([
  'read_source',
  'generate_hypothesis',
  'create_experiment',
  'request_backtest_dry_run',
  'request_walk_forward_dry_run',
  'request_verify_dry_run',
  'request_model_benchmark_dry_run',
  'generate_review_packet',
  'request_more_evidence',
  'archive_experiment',
])

const APPROVAL_ACTIONS = new Set<ResearchInternAction>(['approve_shadow', 'promote_paper_active'])

const PATCH_ACTIONS = new Set<ResearchInternAction>(['generate_patch'])

const FORBIDDEN_ACTIONS = new Set<ResearchInternAction>([
  'retrain_prod',
  'promote_model',
  'deploy_prod',
  'place_trade',
])

const BLOCKED_CAPABILITIES = [
  'production retrain',
  'model promote',
  'production deploy',
  'paper/live trade execution',
  'trading config mutation',
]

function normalizeAction(action: string): ResearchInternAction | null {
  const normalized = action.trim().toLowerCase().replace(/[-\s]+/g, '_')
  const all = [...SAFE_ACTIONS, ...APPROVAL_ACTIONS, ...PATCH_ACTIONS, ...FORBIDDEN_ACTIONS]
  return all.includes(normalized as ResearchInternAction) ? normalized as ResearchInternAction : null
}

export function evaluateResearchInternGate(request: ResearchInternGateRequest): ResearchInternGateResult {
  assertOwnerCanOwn('research', 'research_hypothesis')
  assertOwnerCanOwn('research', 'experiment_registry')
  assertOwnerCanOwn('research', 'review_packet')

  const action = normalizeAction(String(request.action ?? ''))
  if (!action) {
    return {
      decision: 'BLOCK',
      action: String(request.action ?? ''),
      reason: 'unknown_research_action',
      allowed_next_steps: ['read_source', 'generate_hypothesis', 'create_experiment'],
      blocked_capabilities: BLOCKED_CAPABILITIES,
    }
  }

  if (FORBIDDEN_ACTIONS.has(action)) {
    return {
      decision: 'BLOCK',
      action,
      reason: 'research_intern_never_mutates_production_or_trading_state',
      allowed_next_steps: ['generate_review_packet', 'request_backtest_dry_run', 'request_walk_forward_dry_run'],
      blocked_capabilities: BLOCKED_CAPABILITIES,
    }
  }

  if (APPROVAL_ACTIONS.has(action)) {
    const approved = request.approval?.approved === true && Boolean(request.approval?.reviewer)
    return {
      decision: approved ? 'ALLOW' : 'REQUIRE_APPROVAL',
      action,
      reason: approved ? 'human_approved_strategy_learning_state_change' : 'strategy_learning_state_change_requires_human_reviewer',
      allowed_next_steps: approved
        ? ['update_experiment_registry_status', 'refresh_strategy_learning_summary']
        : ['request_human_review', 'generate_review_packet'],
      blocked_capabilities: BLOCKED_CAPABILITIES,
    }
  }

  if (PATCH_ACTIONS.has(action)) {
    const approved = request.approval?.approved === true && Boolean(request.approval?.reviewer)
    return {
      decision: approved ? 'ALLOW' : 'REQUIRE_APPROVAL',
      action,
      reason: approved ? 'human_reviewed_patch_generation_only' : 'patch_generation_requires_human_reviewer',
      allowed_next_steps: approved
        ? ['generate_patch', 'run_local_tests', 'prepare_review_packet']
        : ['generate_review_packet', 'request_human_review'],
      blocked_capabilities: BLOCKED_CAPABILITIES,
    }
  }

  if (
    (
      action === 'request_backtest_dry_run'
      || action === 'request_walk_forward_dry_run'
      || action === 'request_verify_dry_run'
      || action === 'request_model_benchmark_dry_run'
    )
    && request.dryRun === false
  ) {
    return {
      decision: 'REQUIRE_APPROVAL',
      action,
      reason: 'non_dry_run_research_execution_requires_explicit_orchestrator_approval',
      allowed_next_steps: ['rerun_with_dry_run_true', 'request_human_review'],
      blocked_capabilities: BLOCKED_CAPABILITIES,
    }
  }

  return {
    decision: 'ALLOW',
    action,
    reason: 'research_metadata_or_dry_run_only',
    allowed_next_steps: ['persist_experiment', 'generate_review_packet', 'run_dry_run_evaluation'],
    blocked_capabilities: BLOCKED_CAPABILITIES,
  }
}
