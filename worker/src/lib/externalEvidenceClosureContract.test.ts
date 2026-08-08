import assert from 'node:assert/strict'
import fs from 'node:fs'

const materializer = fs.readFileSync('../tools/materialize_external_evidence_once.py', 'utf8')
const router = fs.readFileSync('../ml-controller/routers/external_evidence.py', 'utf8')
const workflow = fs.readFileSync('src/lib/controllerResearchWorkflows.ts', 'utf8')
const durable = fs.readFileSync('src/lib/durableSchedulerTask.ts', 'utf8')
const logger = fs.readFileSync('src/lib/schedulerRunLogger.ts', 'utf8')
const risk = fs.readFileSync('src/lib/newsThemeRiskOverlay.ts', 'utf8')
const themes = fs.readFileSync('src/lib/multiSourceThemeEvidence.ts', 'utf8')
const links = fs.readFileSync('src/lib/recommendationEvidenceLinks.ts', 'utf8')

assert(materializer.includes('D1_MAX_BOUND_PARAMS = 90'))
assert(materializer.includes('def build_materialization_receipt'))
assert(materializer.includes('"status": "ready" if ready else "incomplete"'))
assert(!materializer.includes('parsed_date < "2026-04-18"'))
assert(router.includes('result = module.main()'))
assert(router.includes('"materialization_receipt": parsed.get("materialization_receipt")'))

assert(workflow.includes('runExternalEvidenceMaterializeDetailed'))
assert(workflow.includes("receipt.status !== 'ready'"))
assert(durable.includes("'scheduler:terminal:' + task + ':' + runDate"))
assert(durable.includes("schema_version: 'scheduler_terminal_receipt_v1'"))
assert(logger.includes("'external-evidence': 'External Evidence'"))

assert(risk.includes('FROM source_quality_metrics quality'))
assert(risk.includes("date(quality.as_of_date) >= date(?, '-4 days')"))
assert(risk.includes("quality.freshness_status IN ('present', 'degraded_context_only')"))
assert(themes.includes("WHERE date >= date(?, '-4 days')"))
assert(themes.includes(').bind(date, date).all<'))
assert(links.match(/date\(published_at\) <= date\(\?\)/))
assert(links.includes(').bind(...chunk, date, date).all<NewsFallbackRow>()'))

console.log('external evidence closure contract tests passed')
