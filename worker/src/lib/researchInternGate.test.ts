import { evaluateResearchInternGate } from './researchInternGate'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  const result = evaluateResearchInternGate({ action: 'generate_hypothesis' })
  assert(result.decision === 'ALLOW', 'research intern should generate hypotheses')
  assert(result.blocked_capabilities.includes('production deploy'), 'research gate should expose blocked deploy capability')
}

{
  const result = evaluateResearchInternGate({ action: 'request_backtest_dry_run', dryRun: true })
  assert(result.decision === 'ALLOW', 'dry-run backtest request should be allowed')
}

{
  const result = evaluateResearchInternGate({ action: 'request_model_benchmark_dry_run', dryRun: true })
  assert(result.decision === 'ALLOW', 'dry-run model benchmark request should be allowed')
}

{
  const result = evaluateResearchInternGate({ action: 'request_walk_forward_dry_run', dryRun: false })
  assert(result.decision === 'REQUIRE_APPROVAL', 'non-dry-run research execution should require approval')
}

{
  const result = evaluateResearchInternGate({ action: 'request_model_benchmark_dry_run', dryRun: false })
  assert(result.decision === 'REQUIRE_APPROVAL', 'non-dry-run model benchmark should require approval')
}

{
  const result = evaluateResearchInternGate({ action: 'generate_patch' })
  assert(result.decision === 'REQUIRE_APPROVAL', 'patch generation should require reviewer approval')
}

{
  const result = evaluateResearchInternGate({ action: 'approve_shadow' })
  assert(result.decision === 'REQUIRE_APPROVAL', 'approve-shadow should require reviewer approval')
  assert(result.allowed_next_steps.includes('request_human_review'), 'approve-shadow should expose human review next step')
}

{
  const result = evaluateResearchInternGate({
    action: 'promote_paper_active',
    approval: { approved: true, reviewer: 'wei', scope: 'paper-active only' },
  })
  assert(result.decision === 'ALLOW', 'reviewed paper-active promotion request should be allowed as metadata')
  assert(result.blocked_capabilities.includes('production deploy'), 'paper-active metadata still blocks deploy')
}

{
  const result = evaluateResearchInternGate({
    action: 'generate_patch',
    approval: { approved: true, reviewer: 'wei', scope: 'local patch only' },
  })
  assert(result.decision === 'ALLOW', 'reviewed patch generation should be allowed')
}

for (const action of ['retrain_prod', 'promote_model', 'deploy_prod', 'place_trade']) {
  const result = evaluateResearchInternGate({ action })
  assert(result.decision === 'BLOCK', `${action} must be blocked`)
  assert(result.reason.includes('never_mutates_production'), `${action} should explain production mutation block`)
}
