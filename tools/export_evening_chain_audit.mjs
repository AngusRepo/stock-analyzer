import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')
const workerDir = resolve(repoRoot, 'worker')

function cliValue(name, fallback = '') {
  const prefix = `--${name}=`
  const arg = process.argv.find((value) => value.startsWith(prefix))
  return arg ? arg.slice(prefix.length) : fallback
}

const dateArg = process.argv.find((arg) => arg.startsWith('--date='))
const outArg = process.argv.find((arg) => arg.startsWith('--out='))
const date = dateArg ? dateArg.slice('--date='.length) : '2026-06-25'
const outDir = outArg ? resolve(repoRoot, outArg.slice('--out='.length)) : resolve(repoRoot, `output/evening_chain_${date.replaceAll('-', '')}_audit`)
const rerunStatus = cliValue('rerun-status', 'not_recorded')
const rerunNote = cliValue('rerun-note', '')
const rerunChainRunId = cliValue('rerun-chain-run-id', '')
const pipelineRunId = cliValue('pipeline-run-id', '')
const verifyRunId = cliValue('verify-run-id', '')

function d1(sql) {
  const statements = sql
    .split(';')
    .map((statement) => statement.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  const results = []
  for (const statement of statements) {
    const output = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        "& 'C:\\Program Files\\nodejs\\npx.cmd' wrangler@4 d1 execute stockvision-db --remote --json --command $env:SV_SQL",
      ],
      {
        cwd: workerDir,
        encoding: 'utf8',
        maxBuffer: 128 * 1024 * 1024,
        env: { ...process.env, SV_SQL: statement },
      },
    )
    const jsonStart = output.indexOf('[')
    if (jsonStart < 0) throw new Error(`Wrangler did not return JSON: ${output.slice(0, 500)}`)
    const parsed = JSON.parse(output.slice(jsonStart))
    results.push(parsed[0]?.results ?? [])
  }
  return results
}

function csvEscape(value) {
  if (value == null) return ''
  const text = String(value)
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`
  return text
}

function writeCsv(name, rows) {
  const file = resolve(outDir, name)
  const headers = rows.length ? Object.keys(rows[0]) : []
  const body = [
    headers.map(csvEscape).join(','),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(',')),
  ].join('\n')
  writeFileSync(file, `${body}\n`, 'utf8')
}

function writeJson(name, value) {
  writeFileSync(resolve(outDir, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function parseJson(value, fallback) {
  if (!value) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean).map(String))].sort((a, b) => a.localeCompare(b))
}

function phi(aSet, bSet, universe) {
  let both = 0
  let aOnly = 0
  let bOnly = 0
  let neither = 0
  for (const symbol of universe) {
    const a = aSet.has(symbol)
    const b = bSet.has(symbol)
    if (a && b) both += 1
    else if (a) aOnly += 1
    else if (b) bOnly += 1
    else neither += 1
  }
  const denom = Math.sqrt((both + aOnly) * (bOnly + neither) * (both + bOnly) * (aOnly + neither))
  if (!Number.isFinite(denom) || denom === 0) return null
  return (both * neither - aOnly * bOnly) / denom
}

function round(value, digits = 4) {
  if (value == null || !Number.isFinite(value)) return null
  return Number(value.toFixed(digits))
}

mkdirSync(outDir, { recursive: true })

const [
  latestRunRows,
  runHistoryRows,
] = d1(`
SELECT run_id, status, universe_count, candidate_count, final_count, emerging_count, metadata, created_at
  FROM screener_funnel_runs
 WHERE date='${date}' AND status='success'
 ORDER BY created_at DESC
 LIMIT 1;
SELECT run_id, status, universe_count, candidate_count, final_count, emerging_count, metadata, created_at
  FROM screener_funnel_runs
 WHERE date='${date}'
 ORDER BY created_at DESC
 LIMIT 10;
`)

if (!latestRunRows.length) {
  throw new Error(`No successful screener run found for ${date}`)
}

const run = latestRunRows[0]
const runId = run.run_id
const runMetadata = parseJson(run.metadata, {})
const strategyPoolMetadata = runMetadata.strategyCandidatePool ?? {}
const poolStatusByStrategy = new Map((Array.isArray(strategyPoolMetadata.pool_status) ? strategyPoolMetadata.pool_status : [])
  .map((row) => [row.strategy_id, row]))

const [
  stageCounts,
  finalItemsRaw,
  dailyRowsRaw,
  activeStrategiesRaw,
  strategyMatchRows,
  predictionSummaryRows,
] = d1(`
SELECT stage, decision, COUNT(*) AS rows, COUNT(DISTINCT symbol) AS symbols, MIN(rank) AS min_rank, MAX(rank) AS max_rank
  FROM screener_funnel_items
 WHERE date='${date}' AND run_id='${runId}'
 GROUP BY stage, decision
 ORDER BY stage, decision;
SELECT symbol, name, rank AS funnel_rank, score_after AS funnel_score, reason_code, evidence
  FROM screener_funnel_items
 WHERE date='${date}' AND run_id='${runId}' AND stage='final_selection'
 ORDER BY rank ASC, symbol ASC;
SELECT symbol, name, rank AS daily_rank, score AS daily_score, signal, confidence, has_buy_signal,
       recommendation_lane, eligible_for_ml, eligible_for_pending_buy, alpha_allocation, score_components
  FROM daily_recommendations
 WHERE date='${date}'
 ORDER BY recommendation_lane DESC, rank ASC, symbol ASC;
SELECT strategy_id, version, name, status, alpha_bucket, family_id, variant_id, thresholds_json, candidate_policy_json
  FROM strategy_spec_registry
 WHERE status='active'
 ORDER BY strategy_id;
SELECT strategy_id, strategy_status, matched, reason_code, COUNT(*) AS rows, COUNT(DISTINCT symbol) AS symbols,
       AVG(match_score) AS avg_match_score, MIN(created_at) AS first_created, MAX(created_at) AS last_created
  FROM strategy_decision_log
 WHERE date='${date}'
 GROUP BY strategy_id, strategy_status, matched, reason_code
 ORDER BY strategy_id, matched DESC, reason_code;
SELECT COUNT(*) AS prediction_rows, COUNT(DISTINCT stock_id) AS prediction_stocks,
       COUNT(DISTINCT model_name) AS prediction_models, MAX(generated_at) AS prediction_latest_generated
  FROM predictions
 WHERE prediction_date='${date}';
`)

const finalBySymbol = new Map()
const finalItems = finalItemsRaw.map((row) => {
  const evidence = parseJson(row.evidence, {})
  const strategyIds = uniqueSorted(evidence.strategy_pool_ids ?? [])
  const researchStrategyIds = uniqueSorted(evidence.research_strategy_ids ?? [])
  const out = {
    symbol: row.symbol,
    name: row.name,
    funnel_rank: row.funnel_rank,
    funnel_score: row.funnel_score,
    reason_code: row.reason_code,
    strategy_count: strategyIds.length,
    strategy_ids: strategyIds.join(';'),
    research_strategy_ids: researchStrategyIds.join(';'),
  }
  finalBySymbol.set(row.symbol, { ...out, evidence, strategyIds })
  return out
})

const dailyRows = dailyRowsRaw.map((row) => {
  const allocation = parseJson(row.alpha_allocation, {})
  const final = finalBySymbol.get(row.symbol)
  return {
    symbol: row.symbol,
    name: row.name,
    daily_rank: row.daily_rank,
    daily_score: row.daily_score,
    signal: row.signal,
    confidence: row.confidence,
    has_buy_signal: row.has_buy_signal,
    recommendation_lane: row.recommendation_lane,
    eligible_for_ml: row.eligible_for_ml,
    eligible_for_pending_buy: row.eligible_for_pending_buy,
    alpha_selected: allocation.selected === true ? 1 : 0,
    alpha_bucket: allocation.bucket ?? '',
    allocation_quota: allocation.quota ?? '',
    strategy_count: final?.strategyIds.length ?? 0,
    strategy_ids: final?.strategyIds.join(';') ?? '',
  }
})

const tradableDailyRows = dailyRows.filter((row) => row.recommendation_lane === 'tradable')
const buyRows = tradableDailyRows.filter((row) => Number(row.has_buy_signal) === 1 || row.signal === 'BUY' || Number(row.alpha_selected) === 1)
const emergingRows = dailyRows.filter((row) => row.recommendation_lane === 'emerging_watchlist')

const activeStrategyIds = activeStrategiesRaw.map((row) => row.strategy_id)
const finalUniverse = finalItems.map((row) => row.symbol)
const finalUniverseSet = new Set(finalUniverse)
const strategyFinalSets = new Map(activeStrategyIds.map((id) => [id, new Set()]))
for (const item of finalItems) {
  for (const strategyId of item.strategy_ids ? item.strategy_ids.split(';').filter(Boolean) : []) {
    if (strategyFinalSets.has(strategyId)) strategyFinalSets.get(strategyId).add(item.symbol)
  }
}

const buyBySymbol = new Map(buyRows.map((row) => [row.symbol, row]))
const strategyBuySets = new Map(activeStrategyIds.map((id) => [id, new Set()]))
for (const row of buyRows) {
  const final = finalBySymbol.get(row.symbol)
  if (!final) continue
  for (const strategyId of final.strategyIds) {
    if (strategyBuySets.has(strategyId)) strategyBuySets.get(strategyId).add(row.symbol)
  }
}

const strictMatches = new Map()
for (const row of strategyMatchRows) {
  if (row.strategy_status === 'active' && Number(row.matched) === 1) {
    strictMatches.set(row.strategy_id, row)
  }
}

const activeStrategyCounts = activeStrategiesRaw.map((strategy) => {
  const policy = parseJson(strategy.candidate_policy_json, {})
  const poolStatus = poolStatusByStrategy.get(strategy.strategy_id) ?? {}
  const adaptivePolicy = poolStatus.adaptive_policy ?? {}
  const finalSymbols = uniqueSorted([...strategyFinalSets.get(strategy.strategy_id)])
  const buySymbols = uniqueSorted([...strategyBuySets.get(strategy.strategy_id)])
  const strict = strictMatches.get(strategy.strategy_id)
  return {
    strategy_id: strategy.strategy_id,
    name: strategy.name,
    alpha_bucket: strategy.alpha_bucket,
    family_id: strategy.family_id,
    variant_id: strategy.variant_id,
    status_today: 'active',
    daily_match_status: strict ? 'strict_match' : 'strict_empty_threshold',
    strict_match_count: strict?.symbols ?? 0,
    near_match_count: 0,
    static_pool_quota: poolStatus.static_quota ?? policy.poolQuota ?? '',
    adaptive_pool_quota: poolStatus.quota ?? strategyPoolMetadata.l15_adaptive_pool_quota_by_strategy?.[strategy.strategy_id] ?? '',
    static_cost_budget: poolStatus.static_cost_budget ?? policy.costBudget ?? '',
    adaptive_cost_budget: poolStatus.cost_budget ?? strategyPoolMetadata.l15_adaptive_cost_budget_by_strategy?.[strategy.strategy_id] ?? '',
    static_max_ml_share: poolStatus.static_max_ml_share ?? policy.maxMlShare ?? '',
    adaptive_max_ml_share: poolStatus.max_ml_share ?? strategyPoolMetadata.l15_adaptive_max_ml_share_by_strategy?.[strategy.strategy_id] ?? '',
    adaptive_policy_reason: adaptivePolicy.reason ?? '',
    adaptive_policy_quality_score: adaptivePolicy.quality_score ?? '',
    adaptive_policy_demand_score: adaptivePolicy.demand_score ?? '',
    adaptive_policy_crowding_score: adaptivePolicy.crowding_score ?? '',
    adaptive_policy_uniqueness_score: adaptivePolicy.uniqueness_score ?? '',
    quota: poolStatus.quota ?? strategyPoolMetadata.l15_adaptive_pool_quota_by_strategy?.[strategy.strategy_id] ?? policy.poolQuota ?? '',
    l1_attribution_count: finalSymbols.length,
    final160_attribution_count: finalSymbols.length,
    l4_buy5_attribution_count: buySymbols.length,
    final_symbols: finalSymbols.join(';'),
    buy_symbols: buySymbols.join(';'),
  }
})

const pairwiseFinal = []
for (let i = 0; i < activeStrategyIds.length; i += 1) {
  for (let j = i + 1; j < activeStrategyIds.length; j += 1) {
    const a = activeStrategyIds[i]
    const b = activeStrategyIds[j]
    const aSet = strategyFinalSets.get(a)
    const bSet = strategyFinalSets.get(b)
    const intersection = [...aSet].filter((symbol) => bSet.has(symbol)).length
    const union = new Set([...aSet, ...bSet]).size
    pairwiseFinal.push({
      basis: 'final_selection_160_attribution',
      strategy_a: a,
      strategy_b: b,
      a_count: aSet.size,
      b_count: bSet.size,
      intersection,
      union,
      jaccard: union ? round(intersection / union) : null,
      corr_phi: round(phi(aSet, bSet, finalUniverseSet)),
    })
  }
}
pairwiseFinal.sort((a, b) => {
  const aj = a.jaccard ?? -1
  const bj = b.jaccard ?? -1
  if (bj !== aj) return bj - aj
  return `${a.strategy_a}:${a.strategy_b}`.localeCompare(`${b.strategy_a}:${b.strategy_b}`)
})

const runtimeMatchSets = new Map(activeStrategyIds.map((id) => [id, new Set()]))
const [runtimeMatchedSymbols] = d1(`
SELECT strategy_id, symbol
  FROM strategy_decision_log
 WHERE date='${date}' AND strategy_status='active' AND matched=1
 ORDER BY strategy_id, symbol;
`)
for (const row of runtimeMatchedSymbols) {
  if (runtimeMatchSets.has(row.strategy_id)) runtimeMatchSets.get(row.strategy_id).add(row.symbol)
}
const runtimeUniverse = new Set(uniqueSorted(runtimeMatchedSymbols.map((row) => row.symbol)))
const pairwiseRuntime = []
for (let i = 0; i < activeStrategyIds.length; i += 1) {
  for (let j = i + 1; j < activeStrategyIds.length; j += 1) {
    const a = activeStrategyIds[i]
    const b = activeStrategyIds[j]
    const aSet = runtimeMatchSets.get(a)
    const bSet = runtimeMatchSets.get(b)
    const intersection = [...aSet].filter((symbol) => bSet.has(symbol)).length
    const union = new Set([...aSet, ...bSet]).size
    pairwiseRuntime.push({
      basis: 'strategy_decision_log_active_strict_match',
      strategy_a: a,
      strategy_b: b,
      a_count: aSet.size,
      b_count: bSet.size,
      intersection,
      union,
      jaccard: union ? round(intersection / union) : null,
      corr_phi: round(phi(aSet, bSet, runtimeUniverse)),
    })
  }
}
pairwiseRuntime.sort((a, b) => {
  const aj = a.jaccard ?? -1
  const bj = b.jaccard ?? -1
  if (bj !== aj) return bj - aj
  return `${a.strategy_a}:${a.strategy_b}`.localeCompare(`${b.strategy_a}:${b.strategy_b}`)
})

const stageByKey = new Map(stageCounts.map((row) => [`${row.stage}:${row.decision}`, row]))
const stageRows = [
  { layer: 'L0', stage: 'universe', decision: 'raw', rows: Number(stageByKey.get('universe:pass')?.rows ?? 0) + Number(stageByKey.get('universe:drop')?.rows ?? 0), symbols: Number(stageByKey.get('universe:pass')?.symbols ?? 0) + Number(stageByKey.get('universe:drop')?.symbols ?? 0), note: 'pass + drop' },
  { layer: 'L0', stage: 'universe', decision: 'pass', rows: stageByKey.get('universe:pass')?.rows ?? 0, symbols: stageByKey.get('universe:pass')?.symbols ?? 0, note: 'tradable universe after universe gate' },
  { layer: 'L0', stage: 'universe', decision: 'drop', rows: stageByKey.get('universe:drop')?.rows ?? 0, symbols: stageByKey.get('universe:drop')?.symbols ?? 0, note: 'universe gate dropped' },
  { layer: 'L0', stage: 'scoring', decision: 'pass', rows: stageByKey.get('scoring:pass')?.rows ?? 0, symbols: stageByKey.get('scoring:pass')?.symbols ?? 0, note: 'scored candidates' },
  { layer: 'L1', stage: 'l1_candidate_seed_after_overlay', decision: 'selected', rows: stageByKey.get('l1_candidate_seed_after_overlay:selected')?.rows ?? 0, symbols: stageByKey.get('l1_candidate_seed_after_overlay:selected')?.symbols ?? 0, note: `candidate seed after overlays; adaptive_before_dynamic=${strategyPoolMetadata.l15_adaptive_target_size_before_dynamic_quota ?? ''}; dynamic_effective_quota=${strategyPoolMetadata.l15_dynamic_effective_quota_total ?? ''}` },
  { layer: 'L1', stage: 'layer1_strategy_breadth_gate', decision: 'pass', rows: stageByKey.get('layer1_strategy_breadth_gate:pass')?.rows ?? 0, symbols: stageByKey.get('layer1_strategy_breadth_gate:pass')?.symbols ?? 0, note: 'strategy breadth gate' },
  { layer: 'L1.5', stage: 'l15_ml_slate_queue', decision: 'observe', rows: stageByKey.get('l15_ml_slate_queue:observe')?.rows ?? 0, symbols: stageByKey.get('l15_ml_slate_queue:observe')?.symbols ?? 0, note: 'ML slate queue rows can include paired evidence per symbol' },
  { layer: 'L2', stage: 'layer2_timesfm_enrichment', decision: 'observe', rows: stageByKey.get('layer2_timesfm_enrichment:observe')?.rows ?? 0, symbols: stageByKey.get('layer2_timesfm_enrichment:observe')?.symbols ?? 0, note: 'TimesFM sidecar enrichment' },
  { layer: 'L3', stage: 'layer3_formal_ml_gate', decision: 'pass', rows: stageByKey.get('layer3_formal_ml_gate:pass')?.rows ?? 0, symbols: stageByKey.get('layer3_formal_ml_gate:pass')?.symbols ?? 0, note: 'formal ML gate pass' },
  { layer: 'L3', stage: 'layer3_formal_ml_gate', decision: 'drop', rows: stageByKey.get('layer3_formal_ml_gate:drop')?.rows ?? 0, symbols: stageByKey.get('layer3_formal_ml_gate:drop')?.symbols ?? 0, note: 'formal ML gate drop' },
  { layer: 'L4', stage: 'daily_recommendations', decision: 'tradable', rows: tradableDailyRows.length, symbols: new Set(tradableDailyRows.map((row) => row.symbol)).size, note: 'tradable recommendation rows' },
  { layer: 'L4', stage: 'daily_recommendations', decision: 'buy', rows: buyRows.length, symbols: new Set(buyRows.map((row) => row.symbol)).size, note: 'sparse allocation BUY rows' },
  { layer: 'L4', stage: 'daily_recommendations', decision: 'emerging_watchlist', rows: emergingRows.length, symbols: new Set(emergingRows.map((row) => row.symbol)).size, note: 'context watchlist, not pending-buy eligible' },
]

const summary = {
  date,
  run_id: runId,
  run_status: run.status,
  run_created_at: run.created_at,
  universe_count: run.universe_count,
  candidate_count: run.candidate_count,
  final_count: run.final_count,
  emerging_count: run.emerging_count,
  adaptive_target_size_before_dynamic_quota: strategyPoolMetadata.l15_adaptive_target_size_before_dynamic_quota ?? null,
  adaptive_target_size: strategyPoolMetadata.l15_adaptive_target_size ?? null,
  dynamic_effective_quota_total: strategyPoolMetadata.l15_dynamic_effective_quota_total ?? null,
  dynamic_effective_quota_policy: strategyPoolMetadata.l15_dynamic_effective_quota_policy ?? null,
  dynamic_effective_quota_by_strategy: strategyPoolMetadata.l15_dynamic_effective_quota_by_strategy ?? null,
  adaptive_strategy_policy_version: strategyPoolMetadata.l15_adaptive_strategy_policy_version ?? null,
  adaptive_pool_quota_by_strategy: strategyPoolMetadata.l15_adaptive_pool_quota_by_strategy ?? null,
  adaptive_cost_budget_by_strategy: strategyPoolMetadata.l15_adaptive_cost_budget_by_strategy ?? null,
  adaptive_max_ml_share_by_strategy: strategyPoolMetadata.l15_adaptive_max_ml_share_by_strategy ?? null,
  static_pool_quota_by_strategy: strategyPoolMetadata.l15_static_pool_quota_by_strategy ?? null,
  static_cost_budget_by_strategy: strategyPoolMetadata.l15_static_cost_budget_by_strategy ?? null,
  static_max_ml_share_by_strategy: strategyPoolMetadata.l15_static_max_ml_share_by_strategy ?? null,
  daily_recommendations: dailyRows.length,
  daily_tradable_recommendations: tradableDailyRows.length,
  daily_emerging_watchlist: emergingRows.length,
  daily_buy_signals: buyRows.length,
  daily_vs_funnel_intersection: tradableDailyRows.filter((row) => finalBySymbol.has(row.symbol)).length,
  active_strategy_count: activeStrategiesRaw.length,
  active_strategy_with_final_attribution: activeStrategyCounts.filter((row) => row.final160_attribution_count > 0).length,
  prediction_summary: predictionSummaryRows[0] ?? {},
  report_dir: outDir,
  rerun_status: rerunStatus,
  rerun_note: rerunNote,
  rerun_chain_run_id: rerunChainRunId,
  pipeline_run_id: pipelineRunId,
  verify_run_id: verifyRunId,
}

writeJson('summary.json', summary)
writeCsv('run_history.csv', runHistoryRows)
writeCsv('stage_counts.csv', stageCounts)
writeCsv('l0_l4_flow.csv', stageRows)
writeCsv('final_selection_160.csv', finalItems)
writeCsv('daily_recommendations_184.csv', dailyRows)
writeCsv('daily_recommendations_tradable_160.csv', tradableDailyRows)
writeCsv('l4_buy_5.csv', buyRows)
writeCsv('active_strategy_counts.csv', activeStrategyCounts)
writeCsv('strategy_pairwise_final160.csv', pairwiseFinal)
writeCsv('strategy_pairwise_runtime_matches.csv', pairwiseRuntime)
writeCsv('strategy_decision_summary.csv', strategyMatchRows)
writeJson('raw_summary_evidence.json', {
  latest_run: run,
  stage_counts: stageCounts,
  l0_l4_flow: stageRows,
  active_strategy_counts: activeStrategyCounts,
  pairwise_final_top10: pairwiseFinal.slice(0, 10),
  pairwise_runtime_top10: pairwiseRuntime.slice(0, 10),
})

console.log(JSON.stringify(summary, null, 2))
