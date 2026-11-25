import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const botDashboard = readFileSync('src/pages/BotDashboard.tsx', 'utf8')
const pipelinePage = readFileSync('src/pages/PipelinePage.tsx', 'utf8')

// 29770e60 replaced the aggregate L1.25 health badge with L4-executability badges, and
// 53e7474b removed the daily-recommendation fallback from BotDashboard entirely: the
// paper room renders pending buys only, so L1.25 evidence lives in the Pipeline trace.
assert(
  !botDashboard.includes('function FallbackRecommendations') &&
    !botDashboard.includes('recommendationsApi.daily') &&
    !botDashboard.includes('strategy_portfolio_intelligence_health'),
  'BotDashboard must not revive the daily-recommendation fallback or its aggregate L1.25 badge',
)

assert(
  pipelinePage.includes('evidence.layer125_finlab_portfolio_intelligence') &&
    pipelinePage.includes("layer: 'L1.25'") &&
    pipelinePage.includes("l125 ? textMetric(l125.portfolio_metric_status ?? 'available') : 'no evidence'"),
  'Pipeline layer trace must display L1.25 metric status and distinguish missing evidence',
)
