import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const monitor = readFileSync('src/lib/dataQualityMonitor.ts', 'utf8')
const adminGateTest = readFileSync('src/lib/adminGateRoutes.test.ts', 'utf8')

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
  !monitor.includes('ml_score_positive'),
  'data quality monitor must not use legacy ml_score_positive as recommendation enrichment source',
)
assert(
  !monitor.includes('chip_score IS NULL OR tech_score IS NULL'),
  'data quality monitor must not treat legacy chip/tech columns as component ownership',
)
assert(
  adminGateTest.includes('score_v2_count'),
  'admin gate test fixture should follow Score V2 enrichment query semantics',
)
