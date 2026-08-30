import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const workerRoot = path.resolve(process.cwd())
const repoRoot = path.resolve(workerRoot, '..')
const routeSource = fs.readFileSync(path.join(workerRoot, 'src/routes/other.ts'), 'utf8')
const frontendSource = fs.readFileSync(path.join(repoRoot, 'frontend/src/pages/PipelinePage.tsx'), 'utf8')
const apiSource = fs.readFileSync(path.join(repoRoot, 'frontend/src/lib/api.ts'), 'utf8')

function section(source: string, start: string, end: string): string {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from + start.length)
  assert(from >= 0 && to > from, 'contract section anchors must exist')
  return source.slice(from, to)
}

test('daily pipeline view exits before full recommendation hydration', () => {
  const route = section(routeSource, "recommendations.get('/daily'", "recommendations.get('/history'")
  const earlyReturn = route.indexOf("if (view === 'pipeline')")
  const fullHydration = route.indexOf('const coreResult = await')
  assert(earlyReturn >= 0, 'daily recommendations must expose pipeline view')
  assert(fullHydration > earlyReturn, 'pipeline view must return before full recommendation hydration')
  assert(route.includes("requestedView === 'card' || requestedView === 'pipeline'"))
  assert(route.includes('...pipelinePayload'))
})

test('pipeline payload uses aggregate-only SQL and excludes heavy recommendation fields', () => {
  const helper = section(routeSource, 'async function buildDailyPipelineViewPayload(', 'function formatAbsTwdAmountFromBillion')
  assert(helper.includes('WITH eligible AS'))
  assert(helper.includes('COUNT(*) AS count'))
  assert(helper.includes('GROUP BY sector'))
  assert(helper.includes('buildDailyPipelineSummaries'))
  assert(helper.includes("schema_version: 'daily_pipeline_view_v1'"))
  for (const field of ['counts', 'funnel_summary', 'strategy_summary', 'sector_summary', 'generated_at']) {
    assert(helper.includes(field), `pipeline payload missing ${field}`)
  }
  assert(!/SELECT\s+r\.\*/i.test(helper), 'pipeline SQL must never SELECT r.*')
  for (const heavy of [
    'prediction_forecast_data',
    'screener_funnel_timeline',
    'evidence_links',
    'alpha_context',
    'alpha_allocation',
    'ml_vote_summary',
    'canonical_broker_rank_daily',
    'canonical_broker_flow_daily',
  ]) {
    assert(!helper.includes(heavy), `pipeline aggregate must exclude heavy hydration: ${heavy}`)
  }
  assert(routeSource.includes('const DAILY_PIPELINE_VIEW_MAX_BYTES = 512_000'))
  assert(routeSource.includes('const DAILY_PIPELINE_STRATEGY_LIMIT = 64'))
  assert(routeSource.includes('const DAILY_PIPELINE_PAIRWISE_LIMIT = 120'))
  assert(helper.includes('new TextEncoder().encode(JSON.stringify(payload)).byteLength'))
  assert(helper.includes('daily_pipeline_view_payload_too_large'))
  assert(helper.includes('compactDailyPipelineStrategySummary'))
  const compactStrategy = section(
    routeSource,
    'function compactDailyPipelineStrategySummary(',
    'async function buildDailyPipelineViewPayload(',
  )
  assert(!compactStrategy.includes('symbols: row.symbols'))
  assert(!compactStrategy.includes('overlap_metrics'))
  assert(compactStrategy.includes('.slice(0, DAILY_PIPELINE_STRATEGY_LIMIT)'))
  assert(compactStrategy.includes('.slice(0, DAILY_PIPELINE_PAIRWISE_LIMIT)'))
  assert(compactStrategy.includes('strategies_total_count: rawStrategies.length'))
  assert(compactStrategy.includes('pairwise_total_count: rawPairwise.length'))
  assert(compactStrategy.includes('pairwise_truncated: rawPairwise.length > pairwise.length'))
})

test('pipeline strategy summary projects strategy ids in SQL without full evidence blobs', () => {
  const summaryBuilder = section(routeSource, 'async function buildDailyPipelineSummaries(', 'type DailyPipelineSectorAggregateRow')
  assert(summaryBuilder.includes('JOIN json_each('))
  assert(summaryBuilder.includes("json_extract(i.evidence, '$.strategy_pool_ids')"))
  assert(summaryBuilder.includes('CAST(strategy.value AS TEXT) AS strategy_id'))
  assert(!/SELECT\s+symbol\s*,\s*evidence/i.test(summaryBuilder))
  assert(!summaryBuilder.includes('parseJsonObject(row.evidence)'))
})
test('L3 is summarized as evidence-only and never as candidate elimination', () => {
  const summaryBuilder = section(routeSource, 'async function buildDailyPipelineSummaries(', 'type DailyPipelineSectorAggregateRow')
  assert(summaryBuilder.includes("mode: 'evidence_only'"))
  assert(summaryBuilder.includes("label: 'Formal ML evidence'"))
  assert(summaryBuilder.includes('eliminated: 0'))
  assert(frontendSource.includes("const evidenceOnly = row.mode === 'evidence_only'"))
  assert(frontendSource.includes("evidenceOnly ? '完成評估' : '通過'"))
  assert(frontendSource.includes("evidenceOnly ? '證據合格' : '淘汰'"))
})
test('frontend requests pipeline aggregate with cancellation and independent loading boundaries', () => {
  assert(frontendSource.includes("view: 'pipeline', signal, timeoutMs: 15_000"))
  assert(frontendSource.includes('queryTtl.dailyDecision'))
  assert(frontendSource.includes('PipelineColumnLoading'))
  assert(frontendSource.includes('PipelineColumnError'))
  assert(frontendSource.includes('pbIsError'))
  assert(frontendSource.includes('recIsError'))
  assert(frontendSource.includes('riskAuditIsError'))
  assert(!frontendSource.includes('const isLoading = recLoading || pbLoading'))
  assert(!frontendSource.includes('queryFn: () => recommendationsApi.daily()'))
  assert(apiSource.includes("view?: 'full' | 'card' | 'pipeline'"))
  assert(apiSource.includes('signal?: AbortSignal'))
  assert(apiSource.includes('timeoutMs?: number'))
})
