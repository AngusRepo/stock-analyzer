const fs = require('fs')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const adminGcp = fs.readFileSync('src/lib/adminTriggerGcpTasks.ts', 'utf8')
const index = fs.readFileSync('src/index.ts', 'utf8')

assert(
  adminGcp.includes('deps.runWeeklyBacktest(requestedRunDate())') &&
    adminGcp.includes('deps.runWeeklyMonteCarlo(requestedRunDate())') &&
    adminGcp.includes('deps.runWeeklyPBO(requestedRunDate())') &&
    index.includes('runWeeklyBacktestWorkflow(c.env, runDate)') &&
    index.includes('runWeeklyMonteCarloWorkflow(c.env, runDate)') &&
    index.includes('runWeeklyPboWorkflow(c.env, runDate)'),
  'manual weekly validation must preserve requested historical run_date through backtest, Monte Carlo, and PBO',
)
