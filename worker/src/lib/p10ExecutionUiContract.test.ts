import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const uiHelper = readFileSync('../frontend/src/lib/pendingBuyExecutionUi.ts', 'utf8')
const botDashboard = readFileSync('../frontend/src/pages/BotDashboard.tsx', 'utf8')
const obsPage = readFileSync('../frontend/src/pages/ObservabilityPage.tsx', 'utf8')

for (const status of [
  'pending',
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
  botDashboard.includes('formatExecutionStatusBadge'),
  'Bot dashboard must not show raw execution_status strings',
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
  obsPage.includes('quote_unavailable') && obsPage.includes('partially_filled'),
  'OBS page must recognize P10 execution realism states',
)
