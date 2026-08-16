import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  DATA_DOMAINS,
  MULTI_D1_PROJECTION_CONTRACT_GATES,
  MULTI_D1_ROUTING_CONTRACT_GATES,
  tablesForDataDomain,
  type DataDomain,
} from './dataDomainRegistry'

type DirectLegacyFinding = {
  file: string
  domain: DataDomain
  table: string
}

function sourceFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) return sourceFiles(fullPath)
    return entry.isFile() && entry.name.endsWith('.ts') ? [fullPath] : []
  })
}

const intentionalLegacyControlFiles = new Set([
  'dataDomainCutoverReadiness.ts',
  'dataDomainShadowBackfill.ts',
  'dataDomainShadowBackfillDrain.ts',
  'dailyExecutionPaperLineage.ts',
  'legacyEvidenceMigration.ts',
  'legacyHotDataRetirement.ts',
])

const ownership = new Map<string, DataDomain>()
for (const domain of DATA_DOMAINS) {
  for (const table of tablesForDataDomain(domain)) ownership.set(table, domain)
}

const findings: DirectLegacyFinding[] = []
const runtimeSources = sourceFiles('src')
  .filter((file) => !file.endsWith('.test.ts'))
for (const file of runtimeSources) {
  if (intentionalLegacyControlFiles.has(path.basename(file))) continue
  const source = fs.readFileSync(file, 'utf8')
  const directPrepare = /(?:\benv|\bc\.env)\.DB\.prepare\(\s*([`'"])([\s\S]*?)\1/g
  for (const statement of source.matchAll(directPrepare)) {
    const markerWindow = source.slice(Math.max(0, Number(statement.index ?? 0) - 240), Number(statement.index ?? 0))
    if (markerWindow.includes('multi-d1-intentional-legacy-source')) continue
    const sql = statement[2]
    const tableReference = /\b(?:FROM|JOIN|INTO|UPDATE|DELETE\s+FROM)\s+["`]?([A-Za-z_][A-Za-z0-9_]*)/gi
    for (const match of sql.matchAll(tableReference)) {
      const table = match[1].toLowerCase()
      const domain = ownership.get(table)
      if (domain) findings.push({
        file: file.replaceAll('\\', '/'),
        domain,
        table,
      })
    }
  }
}

const uniqueFindings = [...new Map(
  findings.map((finding) => [
    `${finding.file}:${finding.domain}:${finding.table}`,
    finding,
  ]),
).values()]
const directLegacyClosed = uniqueFindings.length === 0
assert.equal(
  MULTI_D1_ROUTING_CONTRACT_GATES.direct_legacy_db_paths_closed,
  directLegacyClosed,
  [
    `direct_legacy_db_paths_closed gate mismatch findings=${uniqueFindings.length}`,
    ...uniqueFindings.slice(0, 20).map((finding) => (
      `${finding.file}:${finding.domain}:${finding.table}`
    )),
  ].join('\n'),
)

const runtimeText = runtimeSources.map((file) => fs.readFileSync(file, 'utf8')).join('\n')
const outboxProducerPresent = /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+domain_projection_outbox/i.test(runtimeText)
const inboxConsumerPresent = /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+domain_projection_inbox/i.test(runtimeText)
assert.equal(
  MULTI_D1_PROJECTION_CONTRACT_GATES.typed_outbox_producers_wired,
  outboxProducerPresent,
  'typed_outbox_producers_wired must match executable producer evidence',
)
assert.equal(
  MULTI_D1_PROJECTION_CONTRACT_GATES.idempotent_inbox_consumers_wired,
  inboxConsumerPresent,
  'idempotent_inbox_consumers_wired must match executable consumer evidence',
)

console.log(JSON.stringify({
  direct_legacy_module_count: new Set(uniqueFindings.map((finding) => finding.file)).size,
  direct_legacy_reference_count: uniqueFindings.length,
  by_domain: Object.fromEntries(DATA_DOMAINS.map((domain) => [
    domain,
    uniqueFindings.filter((finding) => finding.domain === domain).length,
  ])),
  findings: uniqueFindings,
  outbox_producer_present: outboxProducerPresent,
  inbox_consumer_present: inboxConsumerPresent,
}, null, 2))
