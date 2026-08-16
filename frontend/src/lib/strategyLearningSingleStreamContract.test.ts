import assert from 'node:assert/strict'
import fs from 'node:fs'

const page = fs.readFileSync('src/pages/StrategyLearningPage.tsx', 'utf8')
const api = fs.readFileSync('src/lib/api.ts', 'utf8')
const worker = fs.readFileSync('../worker/src/lib/strategyLearning.ts', 'utf8')

assert.match(api, /allocation_eligible: boolean/)
assert.match(api, /active_retention_min_hit_rate: number/)
assert.match(worker, /PROMOTION_MIN_HIT_RATE = 0\.52/)
assert.match(worker, /ACTIVE_RETENTION_MIN_HIT_RATE = 0\.48/)
assert.match(worker, /relative_pending_buy_gate_share_not_capital_allocation/)
assert.match(api, /all_non_retired_strategies_single_evaluation_stream/)
assert.match(page, /正式參與選股的策略/)
assert.match(page, /目前可讓推薦進待買/)
assert.match(page, /不是帳戶資金、下單金額或部位比例/)
assert.match(page, /待買資格過度集中（非健康穩態）/)
assert.match(page, /單一推薦資料流/)
assert.match(page, /52% \/ 48%/)
assert.match(page, /原子替換 V7 門檻/)
assert.match(page, /gate\.allocation_eligible === true/)
assert.match(page, /待買權重 0% 仍持續學習/)
assert.match(page, /PIT（當時可知資料）/)
assert.match(page, /LCB90/)
assert.doesNotMatch(page, /latest V6 run/)

console.log('strategy learning single-stream UI contract tests passed')
