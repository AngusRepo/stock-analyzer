import assert from 'node:assert/strict'
import fs from 'node:fs'

const api = fs.readFileSync('src/lib/api.ts', 'utf8')
const page = fs.readFileSync('src/pages/BotDashboard.tsx', 'utf8')

assert(api.includes("status: 'computed' | 'insufficient_evidence'"))
assert(api.includes('latest_attempt: PboAttemptReceipt | null'))
assert(api.includes('numeric_result: PboNumericResult | null'))
assert(api.includes("get<PboDashboardResponse>('/backtest/pbo')"))
assert(page.includes('const pboAttempt = pboData?.latest_attempt'))
assert(page.includes('const pboNumeric = pboAttempt?.numeric_result'))
assert(page.includes("pboAttempt?.status === 'insufficient_evidence'"))
assert(page.includes('樣本 {pboAttempt.observed_trades}/{pboAttempt.required_trades}'))
assert(page.includes('不沿用舊 numeric result 作為本週狀態'))
assert(!page.includes('pboData?.pbo != null'))
