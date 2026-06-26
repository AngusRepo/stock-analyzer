import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const uiHelper = readFileSync('../frontend/src/lib/pendingBuyExecutionUi.ts', 'utf8')
const botDashboard = readFileSync('../frontend/src/pages/BotDashboard.tsx', 'utf8')
const obsPage = readFileSync('../frontend/src/pages/ObservabilityPage.tsx', 'utf8')

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
  uiHelper.includes('已檢查，等待條件'),
  'frontend must distinguish checked-but-waiting pending buys from never-checked pending buys',
)
assert(
  botDashboard.includes('formatPendingBuyExecutionBadge'),
  'Bot dashboard must use item-aware execution status labels',
)
assert(
  botDashboard.includes('盤中原因：{executionBadge.label}'),
  'Bot dashboard pending-buy cards must display the intraday reason inside each card',
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
  obsPage.includes('checked_waiting') && obsPage.includes('quote_unavailable') && obsPage.includes('partially_filled'),
  'OBS page must recognize P10 execution realism states',
)
