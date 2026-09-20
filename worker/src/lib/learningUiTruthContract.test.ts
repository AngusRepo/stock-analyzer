import assert from 'node:assert/strict'
import fs from 'node:fs'

const recommendations = fs.readFileSync('src/routes/other.ts', 'utf8')
const maturity = fs.readFileSync('src/lib/pipelineDecisionMaturity.ts', 'utf8')
const adminRead = fs.readFileSync('src/routes/adminReadRoutes.ts', 'utf8')
const learning = fs.readFileSync('src/lib/strategyLearning.ts', 'utf8')

assert.match(recommendations, /d1SafeInChunks\(symbolsForHydration\)/)
assert.match(recommendations, /optional broker aggregate hydration unavailable/)
assert.doesNotMatch(recommendations, /symbolsForHydration\.length \/ 400/)

const sectorSql = maturity.slice(maturity.indexOf('WITH session_calendar AS ('), maturity.indexOf(']).bind(requestedDate)', maturity.indexOf('WITH session_calendar AS (')))
assert.match(sectorSql, /FROM canonical_market_daily/)
assert.match(sectorSql, /stock_id='0050'/)
assert.doesNotMatch(sectorSql, /FROM market_risk/)

assert.match(adminRead, /STRATEGY_EVIDENCE_METRIC_DEFINITION_VERSION/)
assert.match(adminRead, /DENSE_RANK\(\) OVER \(ORDER BY outcome_as_of_date DESC,datetime\(snapshot_created_at\) DESC,snapshot_run_id DESC\)[\s\S]*WHERE definition_version=\? AND source_mode='authority_bridge'/)
assert.match(adminRead, /\.bind\(STRATEGY_EVIDENCE_METRIC_DEFINITION_VERSION\)\.all<StrategyEvidenceMetricApiRow>/)
assert.match(adminRead, /ORDER BY as_of_date DESC, created_at DESC, run_id DESC/)
assert.doesNotMatch(adminRead, /ORDER BY date_count DESC, as_of_date DESC/)

assert.match(learning, /mm\.producer_run_id=\? AND mm\.evaluable=1 AND mm\.strategy_hit=1/)

console.log('learning UI truth contract tests passed')
