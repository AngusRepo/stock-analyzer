import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const pipelinePage = readFileSync('../frontend/src/pages/PipelinePage.tsx', 'utf8')

{
  assert(
    !pipelinePage.includes('scoreFinalValue(b) - scoreFinalValue(a)') && pipelinePage.includes("view: 'pipeline'"),
    'Pipeline must consume the canonical server aggregate without Score V2 reranking',
  )
  assert(
    !pipelinePage.includes('(b.score ?? 0) - (a.score ?? 0)'),
    'Pipeline recommendation previews must not sort by raw scalar score',
  )
  assert(
    !pipelinePage.includes('Math.round(r.score)'),
    'Pipeline recommendation previews must render Score V2 finalScore instead of raw scalar score',
  )
}
