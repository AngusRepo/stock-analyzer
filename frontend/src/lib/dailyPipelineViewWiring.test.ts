import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const sourceRoot = path.resolve(process.cwd(), 'src')
const page = fs.readFileSync(path.join(sourceRoot, 'pages/PipelinePage.tsx'), 'utf8')
const api = fs.readFileSync(path.join(sourceRoot, 'lib/api.ts'), 'utf8')
const apiClient = fs.readFileSync(path.join(sourceRoot, 'lib/apiClient.ts'), 'utf8')

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

test('daily flow isolates recommendation, pending-buy, and risk-audit failures', () => {
  assert(page.includes('recIsError ?'))
  assert(page.includes('pbIsError ?'))
  assert(page.includes('riskAuditError={riskAuditIsError'))
  assert(page.includes('PipelineColumnLoading'))
  assert(page.includes('PipelineColumnError'))
  assert(!page.includes('const isLoading = recLoading || pbLoading'))
  assert(page.indexOf('{pbIsError ? (') > page.indexOf('{recIsError ? ('))
})

test('daily flow requests are abortable and bounded', () => {
  assert(page.includes("paperApi.pendingBuys({ signal, timeoutMs: 10_000 })"))
  assert(page.includes("paperApi.riskAudit(undefined, { signal, timeoutMs: 8_000 })"))
  assert(page.includes('queryTtl.dailyDecision'))
  assert(page.includes('queryTtl.dashboard'))
  assert(apiClient.includes('requestOptions.signal'))
  assert(apiClient.includes('new AbortController()'))
  assert(apiClient.includes('timeoutTriggered'))
})

test('strategy summary separates registry-active strategies from observed ones', () => {
  // active_strategy_count (registry) and strategies.length (active + observed) were both labelled 活躍.
  assert(!page.includes('>活躍策略<'))
  assert(page.includes("row?.status === 'observed'"))
  assert(page.includes('data-strategy-group={group.key}'))
  assert(page.includes('正式啟用') && page.includes('當日命中的觀察策略'))
  // Overlap averages are computed over every listed strategy; the label must say so.
  // N7: the label says it averages N strategies' pairs, not N pairs.
  assert(page.includes('個策略兩兩平均'))
  // Worker display_name wins; the mechanical id label is only the fallback.
  assert(page.includes('strategyDisplayLabel(row.strategy_id, row.display_name)'))
  // Legacy fallback shows "—" for the count, so it must not draw a length bar either.
  assert(page.includes('canonicalMatrixReady\n                        ? <div'))
})
