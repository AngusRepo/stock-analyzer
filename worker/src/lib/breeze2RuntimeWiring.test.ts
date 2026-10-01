const fs = require('fs')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const marketScreener = fs.readFileSync('src/lib/marketScreener.ts', 'utf8')
const pendingBuyOrchestrator = fs.readFileSync('src/lib/pendingBuyOrchestrator.ts', 'utf8')

for (const name of ['enrichScreenerCandidatesWithBreeze2', 'executeModal: true']) {
  assert(!marketScreener.includes(name), `screener must not invoke retired provider: ${name}`)
}
for (const name of ['enrichMorningDebateCandidatesWithBreeze2', 'breeze2_context']) {
  assert(!pendingBuyOrchestrator.includes(name), `debate must not invoke retired provider: ${name}`)
}
assert(pendingBuyOrchestrator.includes('runBuyDebateBatchViaController(candidates'), 'individual-stock debate remains active')
