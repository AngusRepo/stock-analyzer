import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const monitor = readFileSync('src/lib/dataQualityMonitor.ts', 'utf8')
const adminGateTest = readFileSync('src/lib/adminGateRoutes.test.ts', 'utf8')
const schemaCheckStart = monitor.indexOf('function buildSchemaCheck')
const schemaCheckEnd = monitor.indexOf('export function buildDatasetSnapshotManifestCheck', schemaCheckStart)
assert(schemaCheckStart >= 0 && schemaCheckEnd > schemaCheckStart, 'data quality schema check block should be locatable')
const schemaCheckBlock = monitor.slice(schemaCheckStart, schemaCheckEnd)

assert(
  monitor.includes("SUM(CASE WHEN score_components LIKE '%score_v2%' THEN 1 ELSE 0 END) AS score_v2_count"),
  'data quality recommendation enrichment should count canonical Score V2 payloads',
)
assert(
  monitor.includes("score_components IS NULL OR score_components NOT LIKE '%score_v2%'"),
  'screener seed quality should fail missing canonical Score V2 payloads',
)
assert(
  monitor.includes('Recommendation Score V2 enrichment'),
  'data quality label should expose Score V2 enrichment semantics',
)
assert(
  monitor.includes('missing_score_v2_components'),
  'data quality metrics should name missing Score V2 components explicitly',
)
assert(
  monitor.includes('score_v2_final'),
  'screener score distribution should derive scores from canonical Score V2 payloads',
)
for (const legacyScoreAggregate of ['AVG(score)', 'MIN(score)', 'MAX(score)', 'score >= 90', 'score >= 100']) {
  assert(!monitor.includes(legacyScoreAggregate), `data quality monitor must not aggregate legacy scalar ${legacyScoreAggregate}`)
}
assert(
  !monitor.includes('ml_score_positive'),
  'data quality monitor must not use legacy ml_score_positive as recommendation enrichment source',
)
assert(
  !monitor.includes('chip_score IS NULL OR tech_score IS NULL'),
  'data quality monitor must not treat legacy chip/tech columns as component ownership',
)
for (const legacyColumn of ['chip_score', 'tech_score', 'momentum_score', 'ml_score']) {
  assert(!schemaCheckBlock.includes(legacyColumn), `daily_recommendations schema check must not require legacy ${legacyColumn}`)
}
for (const canonicalColumn of ['score', 'score_components', 'alpha_context', 'alpha_allocation', 'ml_vote_summary']) {
  assert(schemaCheckBlock.includes(canonicalColumn), `daily_recommendations schema check should require canonical ${canonicalColumn}`)
}
assert(
  adminGateTest.includes('score_v2_count'),
  'admin gate test fixture should follow Score V2 enrichment query semantics',
)
const adminSchemaFixtureStart = adminGateTest.indexOf("if (sql.includes('PRAGMA table_info(daily_recommendations)'))")
const adminSchemaFixtureEnd = adminGateTest.indexOf("if (sql.includes('FROM daily_recommendations')", adminSchemaFixtureStart)
assert(adminSchemaFixtureStart >= 0 && adminSchemaFixtureEnd > adminSchemaFixtureStart, 'admin data-quality schema fixture should be locatable')
const adminSchemaFixtureBlock = adminGateTest.slice(adminSchemaFixtureStart, adminSchemaFixtureEnd)
for (const legacyColumn of ['chip_score', 'tech_score', 'momentum_score', 'ml_score']) {
  assert(!adminSchemaFixtureBlock.includes(legacyColumn), `admin data-quality fixture must not require legacy ${legacyColumn}`)
}
