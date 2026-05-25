import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const notify = readFileSync('src/lib/notify.ts', 'utf8')
const dailyReportContract = readFileSync('src/lib/dailyReportScoreV2Contract.test.ts', 'utf8')
const actionableStart = notify.indexOf('export interface ActionableSignal')
const actionableEnd = notify.indexOf('export interface HoldingSnapshot', actionableStart)
assert(actionableStart >= 0 && actionableEnd > actionableStart, 'ActionableSignal interface should be locatable')
const actionableBlock = notify.slice(actionableStart, actionableEnd)

assert(notify.includes('actionableSignalScoreSummary'), 'notify should expose a Score V2 actionable summary helper')
assert(notify.includes('`Score V2 ${Math.round(snapshot.finalScore)}'), 'notify summary should label canonical Score V2 payloads')
assert(!notify.includes("'Score V2 projection'"), 'notify summary must not label storage-projection fallback')
assert(notify.includes('if (!snapshot) return'), 'notify summary should omit scores without canonical Score V2 payloads')
assert(actionableBlock.includes('score_v2?: unknown'), 'ActionableSignal should accept canonical score_v2 payloads')
for (const legacyField of ['score_components', 'chip_score', 'tech_score', 'ml_score', 'momentum_score']) {
  assert(!actionableBlock.includes(legacyField), `ActionableSignal must not expose legacy ${legacyField}`)
}
assert(!actionableBlock.includes('\n  score:'), 'ActionableSignal must not expose ambiguous legacy scalar score')
assert(notify.includes('snapshot.components.mlEdge'), 'notify summary should include ML Edge')
assert(notify.includes('snapshot.components.chipFlow'), 'notify summary should include chipFlow')
assert(notify.includes('snapshot.components.technicalStructure'), 'notify summary should include technicalStructure')
assert(notify.includes('const score = actionableSignalScoreSummary(s)'), 'daily embed should use Score V2 summary text')
assert(!notify.includes('const scoreValue = actionableSignalDisplayScore(s)'), 'daily embed must not render a naked score value')
assert(!notify.includes('` 分 ${Math.round(scoreValue)}`'), 'daily embed must not use ambiguous legacy score label')
assert(dailyReportContract.includes('actionableSignalScoreSummary'), 'daily report contract should cover notify summary')
assert(dailyReportContract.includes('Score V2 62'), 'daily report contract should assert Score V2 score label')
assert(dailyReportContract.includes('score_v2'), 'daily report contract should use canonical score_v2 actionable payloads')
