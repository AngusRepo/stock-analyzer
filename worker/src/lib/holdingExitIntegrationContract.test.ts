import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const paperExitTasks = readFileSync('src/lib/paperExitTasks.ts', 'utf8')
const paperRoute = readFileSync('src/routes/paper.ts', 'utf8')
const paperExecutionEvents = readFileSync('src/lib/paperExecutionEvents.ts', 'utf8')

assert(
  paperExitTasks.includes('buildHoldingExitReviewCandidate'),
  'paper exit tasks should build a holding review candidate for open positions',
)
assert(
  paperExitTasks.includes('arbitratePaperExit'),
  'paper exit tasks should pass current policy and holding review through paperExitArbiter',
)
assert(
  paperExitTasks.includes("eventType: 'holding_exit_review'"),
  'paper exit tasks should record holding_exit_review execution events',
)
assert(
  paperExecutionEvents.includes("'holding_exit_review'"),
  'paper execution event contract should allow holding_exit_review events',
)
assert(
  paperRoute.includes('exit_review:'),
  '/api/paper/positions should expose latest exit_review per holding',
)
assert(
  paperRoute.includes('baseline_counterfactual'),
  'positions exit_review payload should include baseline_counterfactual for the UI',
)
assert(
  paperRoute.includes('features: detail.features'),
  'positions exit_review payload should keep feature-quality metadata inside review features',
)
assert(
  paperExitTasks.includes('features: review.features'),
  'holding_exit_review events should persist normalized feature-quality metadata',
)
assert(
  paperExitTasks.includes('buildMovingTakeProfitTarget'),
  'paper exit tasks should evaluate adaptive moving TP targets before active exit arbitration',
)
assert(
  paperExitTasks.includes("eventType: 'holding_exit_target_update'"),
  'paper exit tasks should audit adaptive TP target moves',
)
assert(
  paperExecutionEvents.includes("'holding_exit_target_update'"),
  'paper execution event contract should allow holding_exit_target_update events',
)
assert(
  paperRoute.includes('moving_tp_target'),
  '/api/paper/positions should expose moving TP target evidence per holding',
)
assert(
  paperExitTasks.includes('allowSellActions: eodHoldingExitParams.sellActions.enabled'),
  'EOD paper exit should enable guarded holding-review sell actions from adaptive params',
)
assert(
  paperExitTasks.includes('allowSellActions: intradayHoldingExitParams.sellActions.enabled'),
  'intraday paper exit should enable guarded holding-review sell actions from adaptive params',
)
assert(
  paperRoute.includes("paper.get('/exit-outcomes'"),
  '/api/paper/exit-outcomes should expose baseline-vs-active holding exit analytics',
)
assert(
  paperRoute.includes('loadHoldingExitOutcomeAnalytics'),
  'paper exit outcome API should use the outcome analytics builder',
)
