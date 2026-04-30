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
  const result = evaluateResearchInternGate({ action: 'request_walk_forward_dry_run', dryRun: false })
  assert(result.decision === 'REQUIRE_APPROVAL', 'non-dry-run research execution should require approval')
}

{
  const result = evaluateResearchInternGate({ action: 'generate_patch' })
  assert(result.decision === 'REQUIRE_APPROVAL', 'patch generation should require reviewer approval')
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
