import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(process.cwd(), 'src')
const card = fs.readFileSync(path.join(root, 'components/RecommendationCardClean.tsx'), 'utf8')
const pipeline = fs.readFileSync(path.join(root, 'pages/PipelinePage.tsx'), 'utf8')

test('recommendation card shows missing L0/L0.5 evidence as unknown, not blocked', () => {
  assert(card.includes("const UNKNOWN_EVIDENCE_LABEL = '未知（無資料）'"))
  assert(card.includes("value={liquidityPassed == null ? UNKNOWN_EVIDENCE_LABEL : liquidityPassed ? 'PASS' : 'BLOCKED'}"))
  assert(card.includes('const passed = universe.universe_passed == null ? null : boolFromValue(universe.universe_passed)'))
  assert(card.includes("value={passed == null ? UNKNOWN_EVIDENCE_LABEL : passed ? 'PASS'"))
})

test('pipeline layer trace shows missing L0/L0.5 evidence as unknown, not blocked', () => {
  assert(pipeline.includes("const UNKNOWN_EVIDENCE_LABEL = '未知（無資料）'"))
  assert(pipeline.includes('l0.universe_passed == null'))
  assert(pipeline.includes("l05.liquidity_capacity_passed != null ? boolMetric(l05.liquidity_capacity_passed, 'pass', 'blocked') : UNKNOWN_EVIDENCE_LABEL"))
})
