import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { navNumber, navPercent, navSign } from './navTradingRoom'
const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
// 047cdef2 (unify single B views) removed the /bot NAV tab, and 62b94c74 (close input stage
// without Atomic) removed the paired-NAV summary from Pipeline maturity; neither surface may return.
test('Paper room is the single B view; NAV comparison tab and paired-NAV summary stay removed', () => {
  const bot = source('../pages/BotDashboard.tsx')
  assert.ok(!bot.includes('value="nav"')); assert.ok(!bot.includes('/bot?tab=nav'))
  assert.ok(!bot.includes("import('@/components/NavTradingRoom')"))
  const maturity = source('../components/PipelineMaturityContribution.tsx')
  assert.ok(!maturity.includes('<NavCollectionSummary')); assert.ok(!maturity.includes('<PairedNavShadow'))
})
test('UI separates absent data, actual zero, comparison identity and cost evidence', () => {
  const view = source('../components/NavTradingRoom.tsx')
  assert.ok(view.includes('connectNulls={false}')); assert.ok(view.includes('隔離模擬 · 唯讀'))
  assert.ok(view.includes('不能推定零成交')); assert.ok(view.includes('股票資金使用率'))
  assert.ok(view.includes('比'))
  const api = source('./navTradingRoomApi.ts')
  assert.ok(api.includes('apiGet')); assert.ok(!api.includes('apiPost'))
  assert.ok(source('./navTradingRoom.ts').includes('增量比較（基準為凍結 L4）'))
  assert.equal(navNumber(0), '0'); assert.equal(navPercent(0), '0.00%')
  assert.equal(navPercent(null), '尚無可驗證數值'); assert.equal(navNumber(NaN), '尚無可驗證數值')
  assert.equal(navSign(0.01), 'text-up'); assert.equal(navSign(-0.01), 'text-down')
})

test('shared account type remains within the deployed Cloud Run Worker source root', () => {
  const worker = source('../../../worker/src/lib/navTradingRoom.ts')
  assert.ok(worker.includes("from './navTradingRoomContract'"))
  assert.ok(source('./navTradingRoom.ts').includes('../../../worker/src/lib/navTradingRoomContract'))
})
