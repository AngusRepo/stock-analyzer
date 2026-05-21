import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const workerDebate = readFileSync('src/lib/debateTrader.ts', 'utf8')
const controllerDebate = readFileSync('../ml-controller/services/debate_service.py', 'utf8')

for (const [name, source] of [
  ['worker debateTrader', workerDebate],
  ['controller debate_service', controllerDebate],
] as const) {
  assert(source.includes('Score V2 / ML Evidence:'), `${name} should label shared context as Score V2 evidence`)
  assert(source.includes('Score V2 finalScore、五構面、ML ensemble'), `${name} should instruct Zealot to reason from Score V2 finalScore`)
  assert(source.includes('ML Edge、Chip Flow、Technical Structure、Fundamental Quality、News/Theme'), `${name} should use Score V2 taxonomy`)
  assert(source.includes('不准退回舊 chip_score / tech_score / ml_score 三分法語意'), `${name} should explicitly forbid legacy score semantics`)
  assert(!source.includes('把 ML 信號、技術面、籌碼面的正面訊號放大解讀'), `${name} must not keep legacy Zealot prompt wording`)
  assert(!source.includes('根據 ML 數據和公司資訊'), `${name} must not keep legacy initial bull-case prompt wording`)
}
