import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const botDashboard = readFileSync('src/pages/BotDashboard.tsx', 'utf8')

assert(
  botDashboard.includes('pendingExecutionPolicy') &&
    botDashboard.includes('pbData?.execution_policy') &&
    botDashboard.includes('policy={pendingExecutionPolicy}'),
  'BotDashboard must read /paper/pending-buys execution_policy and pass it into pending-buy badges',
)

// 2026-11-26 batch3：英文說明改成中文「L4 終選」標籤，原始 policy 代碼與 watch fallback 狀態移到 title。
assert(
  botDashboard.includes('l4_sparse_final_buy_only') &&
    botDashboard.includes('L4 終選') &&
    botDashboard.includes('watch_fallback_allowed === false') &&
    botDashboard.includes('watch fallback off'),
  'BotDashboard must visibly identify pending buys as L4 final BUY only, with the watch-fallback state in the tooltip',
)

assert(
  botDashboard.includes('只有 L4 終選的買進列進入待買清單，每日推薦在 L4 選中前只是證據'),
  'BotDashboard copy must explain that daily recommendations are evidence until L4 selects them',
)

assert(
  botDashboard.includes('visiblePendingBuys(pbData)') &&
    !botDashboard.includes('FallbackRecommendations') &&
    !botDashboard.includes('allPendingBuys.filter'),
  'Pending-buy cards must show the execution pool without mixing full allocation targets or filtering advisory verdicts',
)

assert(
  botDashboard.includes('title={`${executionPolicy}') &&
    botDashboard.includes('policy?.execution_pool_policy') &&
    botDashboard.includes('sourceRecoDate'),
  'BotDashboard pending-buy cards must expose execution-pool provenance beside item state',
)
