import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const botDashboard = readFileSync('src/pages/BotDashboard.tsx', 'utf8')

assert(
  botDashboard.includes('strategy_portfolio_intelligence_health') &&
    botDashboard.includes('strategyPortfolioHealth'),
  'BotDashboard must read daily recommendations strategy_portfolio_intelligence_health',
)

assert(
  botDashboard.includes('L1.25 {strategyPortfolioHealth.portfolio_metric_status') &&
    botDashboard.includes('metrics {strategyPortfolioHealth.metric_count_max'),
  'BotDashboard must display L1.25 metric status and strategy metric count',
)

assert(
  botDashboard.includes('used_live_strategy_asset_metrics') &&
    botDashboard.includes('degraded_reason'),
  'BotDashboard L1.25 badge must distinguish live metrics from degraded/empty state',
)
