import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const llm = readFileSync('src/lib/llm.ts', 'utf8')
const pipelinePage = readFileSync('../frontend/src/pages/PipelinePage.tsx', 'utf8')

{
  const candidateStart = llm.indexOf('export interface RecommendationCandidate')
  const candidateEnd = llm.indexOf('export async function generateRecommendationReasons', candidateStart)
  assert(candidateStart >= 0 && candidateEnd > candidateStart, 'LLM recommendation candidate interface should be locatable')
  const candidateBlock = llm.slice(candidateStart, candidateEnd)
  assert(
    candidateBlock.includes('score_v2: string | null'),
    'LLM recommendation candidate should require normalized Score V2 payload input',
  )
  assert(
    !candidateBlock.includes('score_components: string | null'),
    'LLM recommendation candidate must not expose raw score_components',
  )
  for (const legacyField of [
    'score: number',
    'chip_score: number',
    'tech_score: number',
    'momentum_score?: number | null',
    'ml_score: number',
  ]) {
    assert(!candidateBlock.includes(legacyField), `LLM recommendation candidate must not expose legacy ${legacyField}`)
  }
  assert(
    llm.includes("readScoreV2Snapshot({ score_components: c.score_v2 } as ScoreV2StorageRow)"),
    'LLM recommendation prompt should adapt normalized score_v2 through the shared Score V2 taxonomy reader',
  )
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
