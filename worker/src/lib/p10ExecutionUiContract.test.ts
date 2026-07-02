import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const uiHelper = readFileSync('../frontend/src/lib/pendingBuyExecutionUi.ts', 'utf8')
const botDashboard = readFileSync('../frontend/src/pages/BotDashboard.tsx', 'utf8')
const obsPage = readFileSync('../frontend/src/pages/ObservabilityPage.tsx', 'utf8')
const paperRoutes = readFileSync('src/routes/paper.ts', 'utf8')

for (const status of [
  'pending',
  'checked_waiting',
  'submitted',
  'requoted',
  'partially_filled',
  'stale_quote',
  'quote_unavailable',
  'filled',
  'skipped',
  'cancelled',
  'expired',
  'rejected',
]) {
  assert(uiHelper.includes(`${status}:`), `frontend execution UI helper must label ${status}`)
}

assert(
  uiHelper.includes('formatPartialFillRemaining'),
  'frontend must expose a partial-fill remaining formatter',
)
assert(
  uiHelper.includes('formatExecutionStatusBadge'),
  'frontend must expose a human-readable execution status formatter',
)
assert(
  uiHelper.includes('formatPendingBuyExecutionBadge'),
  'frontend must expose an item-aware pending-buy execution formatter',
)
assert(
  uiHelper.includes('盤中已檢查，等待條件'),
  'frontend must distinguish checked-but-waiting pending buys from never-checked pending buys',
)
assert(
  uiHelper.includes('S12 空方防守成立') && uiHelper.includes('S12 結構等待過久'),
  'frontend must expose readable S12 defensive and stale trace labels',
)
assert(
  uiHelper.includes('formatS12HoldingDefenseBadge') &&
    uiHelper.includes('S12 防守啟動') &&
    uiHelper.includes('S12 結構監控') &&
    uiHelper.includes('S12 防守資料不足') &&
    uiHelper.includes('S12 部分停利') &&
    uiHelper.includes('S12 報價不可用'),
  'frontend must expose readable S12 active-holding defense labels',
)
assert(
  uiHelper.includes('減碼或停利') && uiHelper.includes('停利或提高防守') && uiHelper.includes('提高防守停損'),
  'frontend S12 holding-defense badge must distinguish take-profit advisory from tighten-stop advisory',
)
assert(
  uiHelper.includes('formatCanonicalTradeLifecycleBadge') && uiHelper.includes('S12 結構進場'),
  'frontend must expose canonical trade lifecycle labels',
)
assert(
  uiHelper.includes('接手角色') && uiHelper.includes('不買/防守'),
  'frontend S12 trace must explain takeover role in readable Chinese',
)
assert(
  botDashboard.includes('formatPendingBuyExecutionBadge'),
  'Bot dashboard must use item-aware execution status labels',
)
assert(
  botDashboard.includes('盤中 Real-time 檢查：{executionBadge.label}') &&
    botDashboard.includes('交易門檻：{executionBadge.description}') &&
    botDashboard.includes('S12 結構：{s12Badge.label}'),
  'Bot dashboard pending-buy cards must merge intraday threshold and S12 structure into one readable real-time gate card',
)
assert(
  botDashboard.includes('formatS12HoldingDefenseBadge') && botDashboard.includes('p.s12_holding_defense'),
  'Bot dashboard holdings table must surface S12 holding-defense status',
)
assert(
  botDashboard.includes('formatCanonicalTradeLifecycleBadge') && botDashboard.includes('p.canonical_trade_lifecycle'),
  'Bot dashboard holdings table must surface canonical lifecycle owner status',
)
assert(
  uiHelper.includes('formatPositionRiskPlan') &&
    uiHelper.includes('S12 買賣主機制') &&
    uiHelper.includes('exitPlanPrice') &&
    botDashboard.includes('S12 持倉分析：{s12HoldingDefense.label}') &&
    botDashboard.includes('riskPlan.primaryS12') &&
    botDashboard.includes('S12 TP1') &&
    botDashboard.includes('S12 主出場') &&
    botDashboard.includes('riskContractBadge') &&
    botDashboard.includes('止損 / 停利 contract：{riskContractBadge.label}'),
  'Bot dashboard holdings table must expand S12 holding analysis and align stop/take-profit UI with the risk-plan formatter',
)
assert(
  botDashboard.includes('formatPartialFillRemaining'),
  'Bot dashboard must surface partial-fill remaining shares',
)
assert(
  !botDashboard.includes('execution: {b.execution_status'),
  'Bot dashboard must not render raw execution status labels',
)
assert(
  paperRoutes.includes('s12_holding_defense') && paperRoutes.includes("source = 's12_holding_defense'"),
  'paper positions API must expose latest S12 holding-defense event per position',
)
assert(
  paperRoutes.includes('canonical_trade_lifecycle') &&
    paperRoutes.includes('trade_lifecycle_json') &&
    paperRoutes.includes('paper_orders'),
  'paper positions API must expose canonical lifecycle from position row first and latest buy order note fallback',
)
assert(
  obsPage.includes('checked_waiting') && obsPage.includes('quote_unavailable') && obsPage.includes('partially_filled'),
  'OBS page must recognize P10 execution realism states',
)
