const fs = require('fs')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const workflows = fs.readFileSync('src/lib/controllerResearchWorkflows.ts', 'utf8')
const router = fs.readFileSync('../ml-controller/routers/backtest.py', 'utf8')
const weeklyService = fs.readFileSync('../ml-controller/services/weekly_evidence_service.py', 'utf8')
const monteCarlo = fs.readFileSync('../ml-controller/services/monte_carlo_service.py', 'utf8')
const pbo = fs.readFileSync('../ml-controller/services/pbo_service.py', 'utf8')
const resultStore = fs.readFileSync('../ml-controller/services/backtest_result_store.py', 'utf8')

assert(
  workflows.includes('historical canonical rerun forbidden') &&
    workflows.includes('/backtest/historical-weekly-replay') &&
    workflows.includes('expected_run_date=${encodeURIComponent(runDate)}') &&
    workflows.includes('persist=true&evidence_scope=canonical_current'),
  'weekly canonical evidence must reject historical mutation and bind paper/backtest/PBO to one as-of clock',
)

assert(
  router.includes('@router.post("/historical-weekly-replay")') &&
    weeklyService.includes('"evidence_scope": "comparison_only"') &&
    weeklyService.includes('"production_effect": False') &&
    weeklyService.includes('"persisted": False') &&
    weeklyService.includes('"promotion_gate_eligible": False'),
  'historical weekly replay must remain read-only comparison evidence',
)

assert(
  weeklyService.includes('BacktestDataset.load_from_snapshot_manifest') &&
    weeklyService.includes('mode="B"') &&
    weeklyService.includes('weekly_evidence_snapshot_lookahead_detected') &&
    weeklyService.includes('weekly_evidence_snapshot_availability_lookahead') &&
    weeklyService.includes('historical_replay_config_checksum_mismatch') &&
    weeklyService.includes('historical_replay_config_lookahead_detected') &&
    weeklyService.includes('build_backtest_portfolio_return_evidence'),
  'weekly evidence must use frozen snapshot Mode B portfolio NAV with a look-ahead guard',
)

assert(
  monteCarlo.includes('AND (? IS NULL OR date <= ?)') &&
    pbo.includes('AND (? IS NULL OR substr(created_at, 1, 10) <= ?)'),
  'paper Monte Carlo/PBO inputs must be bounded by expected_run_date',
)

assert(
  resultStore.includes('INSERT OR IGNORE INTO backtest_results') &&
    resultStore.includes('immutable_backtest_evidence_conflict') &&
    monteCarlo.includes('INSERT OR IGNORE INTO monte_carlo_results') &&
    monteCarlo.includes('immutable_monte_carlo_evidence_conflict') &&
    pbo.includes('INSERT OR IGNORE INTO pbo_results') &&
    pbo.includes('immutable_pbo_evidence_conflict'),
  'canonical weekly evidence retries must be idempotent and fail closed on content conflicts',
)

assert(
  monteCarlo.includes("AND strategy = 'replay_mode_b'") &&
    pbo.includes("AND strategy = 'replay_mode_b'") &&
    monteCarlo.includes('canonical_weekly_evidence_error') &&
    pbo.includes('canonical_weekly_evidence_error'),
  'MC/PBO must consume only canonical Mode B snapshot evidence with a valid evidence clock',
)
