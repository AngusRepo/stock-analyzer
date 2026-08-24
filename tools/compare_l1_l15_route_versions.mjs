import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const LEARNING_DB = 'stockvision-learning-db'
const OPS_DB = 'stockvision-ops-db'
const OUT_DIR = join('output', 'l1_l15_route_repair_comparison')
const WRANGLER_CLI = join('worker', 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const REFERENCE_CONTRACT = 'selection-reference-snapshot-v3'
const FORMAL_LABELERS = [
  'strategy-labeler-v2-revenue-pit-fuse-v1',
  'strategy-decision-log-pit-reconstruction-v7-revenue-pit-fuse-v1',
]

function query(database, sql) {
  const raw = execFileSync(
    process.execPath,
    [WRANGLER_CLI, 'd1', 'execute', database, '--remote', '--json', '--command', sql],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: process.env },
  )
  const payload = JSON.parse(raw.slice(raw.indexOf('[')))
  if (!payload?.[0]?.success) throw new Error(`d1_query_failed:${database}`)
  return payload[0].results ?? []
}

function finite(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function mean(values) {
  const xs = values.filter(Number.isFinite)
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
}

function rank(values) {
  const indexed = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value)
  const out = Array(values.length).fill(0)
  for (let i = 0; i < indexed.length;) {
    let j = i + 1
    while (j < indexed.length && indexed[j].value === indexed[i].value) j += 1
    const averageRank = (i + j - 1) / 2
    for (let k = i; k < j; k += 1) out[indexed[k].index] = averageRank
    i = j
  }
  return out
}

function pearson(left, right) {
  if (left.length < 3 || left.length !== right.length) return null
  const lm = mean(left)
  const rm = mean(right)
  let covariance = 0
  let lv = 0
  let rv = 0
  for (let i = 0; i < left.length; i += 1) {
    const l = left[i] - lm
    const r = right[i] - rm
    covariance += l * r
    lv += l * l
    rv += r * r
  }
  return lv > 0 && rv > 0 ? covariance / Math.sqrt(lv * rv) : null
}

function spearman(rows, scoreKey) {
  const clean = rows.filter((row) => finite(row[scoreKey]) != null && finite(row.residual_return_net) != null)
  return pearson(
    rank(clean.map((row) => Number(row[scoreKey]))),
    rank(clean.map((row) => Number(row.residual_return_net))),
  )
}

function quantileSpread(rows, scoreKey) {
  const clean = rows
    .filter((row) => finite(row[scoreKey]) != null && finite(row.residual_return_net) != null)
    .sort((a, b) => Number(a[scoreKey]) - Number(b[scoreKey]))
  const width = Math.max(1, Math.floor(clean.length / 5))
  const low = clean.slice(0, width)
  const high = clean.slice(-width)
  const lowMean = mean(low.map((row) => Number(row.residual_return_net)))
  const highMean = mean(high.map((row) => Number(row.residual_return_net)))
  return {
    diagnostic_only_not_admission: true,
    low_quintile_mean: lowMean,
    high_quintile_mean: highMean,
    high_minus_low: lowMean == null || highMean == null ? null : highMean - lowMean,
  }
}

function effectiveBreadth(rows, scoreKey) {
  const weights = rows
    .map((row) => finite(row[scoreKey]))
    .filter((value) => value != null)
    .map((score) => Math.max(0.75, Math.min(1.25, 0.75 + score / 200)))
  const sum = weights.reduce((a, b) => a + b, 0)
  const sumSquares = weights.reduce((a, b) => a + b * b, 0)
  return {
    candidates_retained: weights.length,
    retention_rate: rows.length ? weights.length / rows.length : null,
    kish_effective_count: sumSquares > 0 ? (sum * sum) / sumSquares : null,
    kish_effective_share: sumSquares > 0 && rows.length ? ((sum * sum) / sumSquares) / rows.length : null,
    weight_min: weights.length ? Math.min(...weights) : null,
    weight_max: weights.length ? Math.max(...weights) : null,
  }
}

function summarize(rows, scoreKey) {
  const dates = [...new Set(rows.map((row) => row.signal_date))].sort()
  const perDate = dates.map((date) => {
    const cohort = rows.filter((row) => row.signal_date === date)
    return {
      date,
      samples: cohort.length,
      spearman: spearman(cohort, scoreKey),
      ...quantileSpread(cohort, scoreKey),
    }
  })
  const weighted = rows.map((row) => {
    const score = Number(row[scoreKey])
    const weight = Math.max(0.75, Math.min(1.25, 0.75 + score / 200))
    return { weight, residual: Number(row.residual_return_net) }
  })
  const weightSum = weighted.reduce((sum, row) => sum + row.weight, 0)
  return {
    samples: rows.length,
    dates: dates.length,
    global_spearman: spearman(rows, scoreKey),
    mean_daily_spearman: mean(perDate.map((row) => row.spearman)),
    median_daily_spearman: (() => {
      const xs = perDate.map((row) => row.spearman).filter(Number.isFinite).sort((a, b) => a - b)
      return xs.length ? xs[Math.floor(xs.length / 2)] : null
    })(),
    ...quantileSpread(rows, scoreKey),
    equal_weight_residual_mean: mean(rows.map((row) => Number(row.residual_return_net))),
    continuous_weight_residual_mean: weightSum > 0
      ? weighted.reduce((sum, row) => sum + row.weight * row.residual, 0) / weightSum
      : null,
    breadth: effectiveBreadth(rows, scoreKey),
    per_date: perDate,
  }
}

const heads = query(OPS_DB, `
  SELECT substr(logical_run_key, 10, 10) signal_date, run_id
    FROM canonical_run_heads
   WHERE logical_run_key GLOB 'screener:????-??-??:TW:production:market_screener'
   ORDER BY signal_date
`)
const canonical = Object.fromEntries(heads.map((row) => [row.signal_date, row.run_id]))
const valuesSql = heads
  .map((row) => `('${String(row.signal_date).replaceAll("'", "''")}','${String(row.run_id).replaceAll("'", "''")}')`)
  .join(',')
const routeDates = query(LEARNING_DB, `
  WITH canonical(signal_date, run_id) AS (VALUES ${valuesSql})
  SELECT DISTINCT r.signal_date
    FROM selection_reference_snapshots_v1 r
    JOIN canonical c ON c.signal_date=r.signal_date AND c.run_id=r.producer_run_id
    JOIN canonical_selection_labels_v4 l
      ON l.signal_date=r.signal_date AND l.symbol=r.symbol AND l.producer_run_id=r.producer_run_id
   WHERE r.strategy_matrix_status='ready'
     AND r.strategy_router_score IS NOT NULL
     AND r.strategy_challenger_route_score IS NOT NULL
   ORDER BY r.signal_date
`).map((row) => row.signal_date)

const allRows = []
for (const signalDate of routeDates) {
  const runId = canonical[signalDate]
  const rows = query(LEARNING_DB, `
    WITH canonical(signal_date, run_id) AS (VALUES ${valuesSql}),
    strategy_edge AS (
      SELECT m.strategy_id, m.strategy_version,
             COUNT(*) samples,
             AVG(l.residual_return_net) residual_edge
        FROM strategy_label_matrix_v4 m
        JOIN canonical c ON c.signal_date=m.signal_date AND c.run_id=m.producer_run_id
        JOIN selection_reference_snapshots_v1 r
          ON r.signal_date=m.signal_date AND r.symbol=m.symbol AND r.producer_run_id=m.producer_run_id
        JOIN strategy_label_matrix_runs_v4 mr ON mr.producer_run_id=m.producer_run_id
        JOIN canonical_selection_labels_v4 l
          ON l.signal_date=m.signal_date AND l.symbol=m.symbol AND l.producer_run_id=m.producer_run_id
       WHERE m.signal_date<'${signalDate}'
         AND m.strategy_hit=1 AND m.evaluable=1
         AND m.reference_contract_version='${REFERENCE_CONTRACT}'
         AND m.labeler_version IN ('${FORMAL_LABELERS.join("','")}')
         AND r.strategy_matrix_status='ready'
         AND r.strategy_labeler_version=m.labeler_version
         AND r.strategy_registry_checksum=m.strategy_registry_checksum
         AND mr.status='ready' AND mr.expected_cell_count>0
         AND mr.persisted_cell_count=mr.expected_cell_count
         AND mr.labeler_version=m.labeler_version
         AND mr.strategy_registry_checksum=m.strategy_registry_checksum
         AND mr.reference_contract_version=m.reference_contract_version
       GROUP BY m.strategy_id, m.strategy_version
    ),
    current_alignment AS (
      SELECT m.symbol,
             SUM(m.challenger_affinity * e.residual_edge * (1.0 * e.samples / (e.samples + 30.0)))
               / NULLIF(SUM(m.challenger_affinity), 0) aligned_edge,
             COUNT(e.strategy_id) evidence_strategy_count,
             COUNT(*) hit_strategy_count
        FROM strategy_label_matrix_v4 m
        LEFT JOIN strategy_edge e
          ON e.strategy_id=m.strategy_id AND e.strategy_version=m.strategy_version
       WHERE m.signal_date='${signalDate}' AND m.producer_run_id='${runId}'
         AND m.strategy_hit=1 AND m.evaluable=1 AND m.production_owner=1
       GROUP BY m.symbol
    )
    SELECT r.signal_date, r.symbol, r.producer_run_id,
           r.strategy_selected,
           r.strategy_router_score incumbent_score,
           r.strategy_challenger_route_score accumulated_challenger_score,
           l.residual_return_net,
           COALESCE(a.aligned_edge, 0) aligned_edge,
           COALESCE(a.evidence_strategy_count, 0) evidence_strategy_count,
           COALESCE(a.hit_strategy_count, 0) hit_strategy_count
      FROM selection_reference_snapshots_v1 r
      JOIN canonical_selection_labels_v4 l
        ON l.signal_date=r.signal_date AND l.symbol=r.symbol AND l.producer_run_id=r.producer_run_id
      LEFT JOIN current_alignment a ON a.symbol=r.symbol
     WHERE r.signal_date='${signalDate}' AND r.producer_run_id='${runId}'
       AND r.strategy_matrix_status='ready'
       AND r.strategy_router_score IS NOT NULL
       AND r.strategy_challenger_route_score IS NOT NULL
     ORDER BY r.symbol
  `)
  for (const row of rows) {
    const challenger = Number(row.accumulated_challenger_score)
    const adjustment = Math.max(-12, Math.min(12, Number(row.aligned_edge) * 2000))
    allRows.push({
      ...row,
      repaired_pit_continuous_v3_score: Math.max(0, Math.min(100, challenger + adjustment)),
    })
  }
}

const report = {
  generated_at: new Date().toISOString(),
  contract: 'l1-l15-same-canonical-ready-mature-cohort-comparison-v1',
  selection_semantics: 'full_universe_continuous_positive_weights_no_topk_admission',
  quantiles_are_diagnostic_only: true,
  canonical_dates_available: Object.keys(canonical).length,
  compared_dates: routeDates,
  versions: {
    formal_incumbent_v1: summarize(allRows, 'incumbent_score'),
    accumulated_challenger_v2: summarize(allRows, 'accumulated_challenger_score'),
    repaired_pit_continuous_v3: summarize(allRows, 'repaired_pit_continuous_v3_score'),
  },
  v3_replay: {
    lookahead_policy: 'strategy_edge_uses_only_canonical_ready_mature_rows_with_signal_date_strictly_before_scored_date',
    score_formula: 'clamp(accumulated_challenger_v2 + clamp(prior_strategy_residual_edge*2000,-12,12),0,100)',
    admission_effect: 'none',
    production_effect: false,
  },
}
mkdirSync(OUT_DIR, { recursive: true })
const outputPath = join(OUT_DIR, 'comparison.json')
writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n', 'utf8')
console.log(JSON.stringify({ outputPath, samples: allRows.length, dates: routeDates.length, versions: report.versions }, null, 2))
