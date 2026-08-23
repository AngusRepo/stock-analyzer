import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const sourceRoot = path.resolve(process.cwd(), 'src')
const page = fs.readFileSync(path.join(sourceRoot, 'pages/PipelinePage.tsx'), 'utf8')
const api = fs.readFileSync(path.join(sourceRoot, 'lib/api.ts'), 'utf8')

test('daily flow consumes only the compact pipeline aggregate', () => {
  assert(page.includes("queryKey: ['recommendations', 'daily', today, 'pipeline-view-v1']"))
  assert(page.includes("view: 'pipeline', signal, timeoutMs: 15_000"))
  assert(page.includes('recData?.counts'))
  assert(page.includes('recData?.sector_summary'))
  assert(!page.includes('const allRecs = recommendationRowsFromPayload(recData)'))
  assert(!page.includes('queryFn: () => recommendationsApi.daily()'))
  assert(page.includes('useQuery<DailyPipelineView>'))
  assert(api.includes("view?: 'full' | 'card' | 'pipeline'"))
  assert(api.includes('export type DailyPipelineView'))
  for (const field of ['counts', 'funnel_summary', 'strategy_summary', 'sector_summary', 'generated_at']) {
    assert(api.includes(field), `DailyPipelineView type missing ${field}`)
  }
})

test('daily flow isolates recommendation, pending-buy, and quadrant failures', () => {
  assert(page.includes('recIsError ?'))
  assert(page.includes('pbIsError ?'))
  assert(page.includes('qfError={qfIsError'))
  assert(page.includes('PipelineColumnLoading'))
  assert(page.includes('PipelineColumnError'))
  assert(!page.includes('const isLoading = recLoading || pbLoading'))
  assert(page.indexOf('{pbIsError ? (') > page.indexOf('{recIsError ? ('))
})

test('daily flow requests are abortable and bounded', () => {
  assert(page.includes("paperApi.pendingBuys({ signal, timeoutMs: 10_000 })"))
  assert(page.includes("paperApi.quadrantFilter(undefined, { signal, timeoutMs: 8_000 })"))
  assert(page.includes('queryTtl.dailyDecision'))
  assert(page.includes('queryTtl.dashboard'))
  assert(api.includes('requestOptions.signal'))
  assert(api.includes('new AbortController()'))
  assert(api.includes('timeoutTriggered'))
})
