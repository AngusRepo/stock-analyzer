import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const LEARNING_DB = 'stockvision-learning-db'
const OPS_DB = 'stockvision-ops-db'
const WRANGLER_CLI = join('worker', 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const OUT_DIR = join('output', 'l1_l15_route_repair_comparison')

function query(database, sql) {
  const raw = execFileSync(process.execPath, [
    WRANGLER_CLI, 'd1', 'execute', database, '--remote', '--json', '--command', sql,
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: process.env })
  const payload = JSON.parse(raw.slice(raw.indexOf('[')))
  if (!payload?.[0]?.success) throw new Error('d1_query_failed:' + database)
  if (Number(payload[0]?.meta?.changes ?? 0) !== 0 || Number(payload[0]?.meta?.rows_written ?? 0) !== 0) {
    throw new Error('read_only_contract_violated:' + database)
  }
  return payload[0].results ?? []
}

function sql(value) {
  return String(value ?? '').replaceAll("'", "''")
}

function finite(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function mean(values) {
  const clean = values.filter(Number.isFinite)
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null
}

function rank(values) {
  const indexed = values.map((value, index) => ({ value, index })).sort((left, right) => left.value - right.value)
  const output = Array(values.length).fill(0)
  for (let index = 0; index < indexed.length;) {
    let next = index + 1
    while (next < indexed.length && indexed[next].value === indexed[index].value) next += 1
    const average = (index + next - 1) / 2
    for (let cursor = index; cursor < next; cursor += 1) output[indexed[cursor].index] = average
    index = next
  }
  return output
}

function pearson(left, right) {
  if (left.length < 3 || left.length !== right.length) return null
  const lm = mean(left)
  const rm = mean(right)
  let covariance = 0
  let lv = 0
  let rv = 0
  for (let index = 0; index < left.length; index += 1) {
    const l = left[index] - lm
    const r = right[index] - rm
    covariance += l * r
    lv += l * l
    rv += r * r
  }
  return lv > 0 && rv > 0 ? covariance / Math.sqrt(lv * rv) : null
}

function spearman(rows, key) {
  const clean = rows.filter((row) => finite(row[key]) != null && finite(row.residual_return_net) != null)
  return pearson(
    rank(clean.map((row) => Number(row[key]))),
    rank(clean.map((row) => Number(row.residual_return_net))),
  )
}

function spread(rows, key) {
  const clean = rows
    .filter((row) => finite(row[key]) != null && finite(row.residual_return_net) != null)
    .sort((left, right) => Number(left[key]) - Number(right[key]))
  const width = Math.max(1, Math.floor(clean.length / 5))
  const low = mean(clean.slice(0, width).map((row) => Number(row.residual_return_net)))
  const high = mean(clean.slice(-width).map((row) => Number(row.residual_return_net)))
  return low == null || high == null ? null : high - low
}

function summarize(rows, key) {
  const dates = [...new Set(rows.map((row) => row.signal_date))].sort()
  const perDate = dates.map((date) => {
    const cohort = rows.filter((row) => row.signal_date === date)
    return { date, samples: cohort.length, spearman: spearman(cohort, key), high_minus_low: spread(cohort, key) }
  })
  return {
    samples: rows.filter((row) => finite(row[key]) != null).length,
    global_spearman: spearman(rows, key),
    mean_daily_spearman: mean(perDate.map((row) => row.spearman)),
    high_minus_low: spread(rows, key),
    positive_dates: perDate.filter((row) => row.spearman != null && row.spearman > 0).length,
    per_date: perDate,
  }
}

const heads = query(OPS_DB, [
  "SELECT substr(logical_run_key,10,10) signal_date,run_id",
  "FROM canonical_run_heads",
  "WHERE logical_run_key GLOB 'screener:????-??-??:TW:production:market_screener'",
].join(' '))
const values = heads.map((row) => "('" + sql(row.signal_date) + "','" + sql(row.run_id) + "')").join(',')
const rows = query(LEARNING_DB, [
  'WITH canonical(signal_date,run_id) AS (VALUES ' + values + ')',
  'SELECT r.signal_date,r.symbol,l.residual_return_net,',
  'r.score_v2 finalScore,',
  "json_extract(r.score_components,'$.total') total,",
  "json_extract(r.score_components,'$.alphaAdjustment') alphaAdjustment,",
  "json_extract(r.score_components,'$.components.mlEdge') mlEdge,",
  "json_extract(r.score_components,'$.components.chipFlow') chipFlow,",
  "json_extract(r.score_components,'$.components.technicalStructure') technicalStructure,",
  "json_extract(r.score_components,'$.components.fundamentalQuality') fundamentalQuality,",
  "json_extract(r.score_components,'$.technicalBreakdown.trendStructure') trendStructure,",
  "json_extract(r.score_components,'$.technicalBreakdown.volatilityStructure') volatilityStructure,",
  "json_extract(r.score_components,'$.technicalBreakdown.reversalExtreme') reversalExtreme,",
  "json_extract(r.score_components,'$.technicalBreakdown.volumeConfirmation') volumeConfirmation,",
  "json_extract(r.score_components,'$.technicalBreakdown.executionRisk') executionRisk",
  'FROM selection_reference_snapshots_v1 r',
  'JOIN canonical c ON c.signal_date=r.signal_date AND c.run_id=r.producer_run_id',
  'JOIN canonical_selection_labels_v4 l',
  'ON l.signal_date=r.signal_date AND l.symbol=r.symbol AND l.producer_run_id=r.producer_run_id',
  "WHERE r.strategy_matrix_status='ready'",
  'AND r.strategy_router_score IS NOT NULL',
  'AND r.strategy_challenger_route_score IS NOT NULL',
  'ORDER BY r.signal_date,r.symbol',
].join(' '))
const keys = [
  'finalScore',
  'total',
  'alphaAdjustment',
  'mlEdge',
  'chipFlow',
  'technicalStructure',
  'fundamentalQuality',
  'trendStructure',
  'volatilityStructure',
  'reversalExtreme',
  'volumeConfirmation',
  'executionRisk',
]
const report = {
  generated_at: new Date().toISOString(),
  contract: 'l1-score-v2-canonical-ready-mature-component-ic-v1',
  production_effect: false,
  rows: rows.length,
  factors: Object.fromEntries(keys.map((key) => [key, summarize(rows, key)])),
}
mkdirSync(OUT_DIR, { recursive: true })
const outputPath = join(OUT_DIR, 'l1_score_component_diagnostics.json')
writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n', 'utf8')
console.log(JSON.stringify({ outputPath, rows: rows.length, factors: report.factors }, null, 2))
