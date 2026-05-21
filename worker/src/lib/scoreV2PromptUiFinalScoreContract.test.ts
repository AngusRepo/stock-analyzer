import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const llm = readFileSync('src/lib/llm.ts', 'utf8')
const pipelinePage = readFileSync('../frontend/src/pages/PipelinePage.tsx', 'utf8')

{
  assert(
    llm.includes('score=${scoreV2.finalScore}'),
    'LLM recommendation prompt should expose Score V2 finalScore as the candidate score',
  )
  assert(
    llm.includes('base=${scoreV2.total}'),
    'LLM recommendation prompt may expose Score V2 total only as base component context',
  )
  assert(
    llm.includes('必須使用 Score V2 finalScore 與五構面語意'),
    'LLM recommendation prompt should require Score V2 five-dimension reasoning',
  )
  assert(
    llm.includes('ML Edge=${scoreV2.components.mlEdge}/25'),
    'LLM recommendation prompt should expose Score V2 ML Edge label',
  )
  assert(
    llm.includes('News/Theme=${scoreV2.components.newsTheme}/5'),
    'LLM recommendation prompt should expose Score V2 News/Theme label',
  )
  assert(
    !llm.includes('需整合籌碼、技術、ML 三面向'),
    'LLM recommendation prompt must not keep legacy three-bucket instruction',
  )
  assert(
    !llm.includes('籌碼${scoreV2.components.chipFlow}/25+技術${scoreV2.components.technicalStructure}/25+ML${scoreV2.components.mlEdge}/25'),
    'LLM recommendation prompt must not serialize Score V2 as legacy chip/tech/ML buckets',
  )
}

{
  assert(
    pipelinePage.includes('scoreFinalValue(b) - scoreFinalValue(a)'),
    'Pipeline recommendation previews should sort by Score V2 finalScore',
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
