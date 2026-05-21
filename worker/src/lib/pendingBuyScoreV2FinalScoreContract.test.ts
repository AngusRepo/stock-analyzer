import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const pendingBuyOrchestrator = readFileSync('src/lib/pendingBuyOrchestrator.ts', 'utf8')
const postExit = readFileSync('src/lib/postExit.ts', 'utf8')
const paperEntryTasks = readFileSync('src/lib/paperEntryTasks.ts', 'utf8')

{
  assert(
    pendingBuyOrchestrator.includes('score: scoreV2.finalScore'),
    'morning setup pending buys should persist Score V2 finalScore as scalar score',
  )
  assert(
    !pendingBuyOrchestrator.includes('score: scoreV2.total'),
    'morning setup pending buys must not drop alpha adjustment by using Score V2 total',
  )
}

{
  assert(
    postExit.includes('score: scoreV2.finalScore'),
    'post-exit rerank pending buys should persist Score V2 finalScore as scalar score',
  )
  assert(
    postExit.includes('score=${scoreV2.finalScore}'),
    'post-exit rerank logs should report Score V2 finalScore',
  )
  assert(
    !postExit.includes('score: scoreV2.total') && !postExit.includes('score=${scoreV2.total}'),
    'post-exit rerank must not use Score V2 total where scalar score is expected',
  )
}

{
  assert(
    paperEntryTasks.includes('scoreV2.finalScore'),
    'paper entry decision log should write Score V2 finalScore into total_score',
  )
  assert(
    paperEntryTasks.includes('score_components, chip_score') &&
      paperEntryTasks.includes('decisionScoreComponents') &&
      paperEntryTasks.includes('finalScore: scoreV2.finalScore'),
    'paper entry decision log should persist canonical Score V2 payload into decision_logs.score_components',
  )
  assert(
    !paperEntryTasks.includes('          scoreV2.total,'),
    'paper entry decision log must not write unadjusted Score V2 total into total_score',
  )
}
