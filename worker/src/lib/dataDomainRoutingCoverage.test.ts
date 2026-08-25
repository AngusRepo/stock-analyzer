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
  'dataDomainCutoverCompletion.ts',
  'dataDomainFormalCutover.ts',
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
const pythonLegacyBudgets = new Map<string, number>()
const pythonDomainProxyContracts = new Map<string, {
  classMarker: string
  factoryMarker: string
  bindingMarker: string
  expectedQueryCalls: number
}>([
  ['ml-controller/services/model_artifact_registry.py', {
    classMarker: 'class _LearningArtifactRegistryD1Client:',
    factoryMarker: 'return client_for_domain(D1DataDomain.LEARNING)',
    bindingMarker: 'd1_client = _LearningArtifactRegistryD1Client()',
    expectedQueryCalls: 4,
  }],
  ['ml-controller/strategy_mining_job_main.py', {
    classMarker: 'class _ResearchD1ClientProxy:',
    factoryMarker: 'return client_for_domain(D1DataDomain.RESEARCH).query(*args, **kwargs)',
    bindingMarker: 'd1_client = _ResearchD1ClientProxy()',
    expectedQueryCalls: 1,
  }],
])

function pythonSourceFiles(root: string): string[] {
  if (!fs.existsSync(root)) return []
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      if (['.venv', '__pycache__', 'tests'].includes(entry.name)) return []
      return pythonSourceFiles(fullPath)
    }
    return entry.isFile() && entry.name.endsWith('.py') ? [fullPath] : []
  })
}

const repoRoot = path.resolve(process.cwd(), '..')
const pythonRoots = [
  path.join(repoRoot, 'ml-controller'),
  path.join(repoRoot, 'ml-service'),
]
const pythonFiles = pythonRoots.flatMap((root) => (
  fs.existsSync(root) && fs.statSync(root).isFile() ? [root] : pythonSourceFiles(root)
))
const pythonLegacyCounts = new Map<string, number>()
for (const file of pythonFiles) {
  const source = fs.readFileSync(file, 'utf8')
  const relativeFile = path.relative(repoRoot, file).replaceAll('\\', '/')
  const rawDirectCalls = [...source.matchAll(/\bd1_client\.query\s*\(/g)].length
  const proxyContract = pythonDomainProxyContracts.get(relativeFile)
  if (proxyContract) {
    assert(source.includes(proxyContract.classMarker), `${relativeFile}: domain proxy class missing`)
    assert(source.includes(proxyContract.factoryMarker), `${relativeFile}: canonical domain factory missing`)
    assert(source.includes(proxyContract.bindingMarker), `${relativeFile}: domain proxy binding missing`)
    assert(!source.includes('from services import d1_client'), `${relativeFile}: legacy module import forbidden`)
    assert(!source.includes('from services.d1_client import'), `${relativeFile}: legacy client import forbidden`)
    assert.equal(rawDirectCalls, proxyContract.expectedQueryCalls, `${relativeFile}: domain proxy query surface drift`)
  }
  const directCalls = proxyContract ? 0 : rawDirectCalls
  const aliasCalls = [...source.matchAll(/\bd1_query\s*\(/g)].filter((match) => (
    source.slice(Math.max(0, Number(match.index ?? 0) - 4), Number(match.index ?? 0)) !== 'def '
  )).length
  const count = directCalls + aliasCalls
  if (count > 0) {
    pythonLegacyCounts.set(relativeFile, count)
  }
}
const unbudgetedPythonLegacy = [...pythonLegacyCounts].filter(([file]) => !pythonLegacyBudgets.has(file))
assert.deepEqual(unbudgetedPythonLegacy, [], 'new unbudgeted Python legacy D1 consumer detected')
for (const [file, count] of pythonLegacyCounts) {
  assert(
    count <= Number(pythonLegacyBudgets.get(file) ?? -1),
    `Python legacy D1 debt increased: ${file} count=${count} budget=${pythonLegacyBudgets.get(file)}`,
  )
}
const pythonLegacyReferenceCount = [...pythonLegacyCounts.values()].reduce((sum, count) => sum + count, 0)
const directLegacyClosed = uniqueFindings.length === 0 && pythonLegacyReferenceCount === 0
assert.equal(
  MULTI_D1_ROUTING_CONTRACT_GATES.direct_legacy_db_paths_closed,
  directLegacyClosed,
  [
    `direct_legacy_db_paths_closed gate mismatch worker=${uniqueFindings.length} python=${pythonLegacyReferenceCount}`,
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
  python_direct_legacy_module_count: pythonLegacyCounts.size,
  python_direct_legacy_reference_count: pythonLegacyReferenceCount,
  by_domain: Object.fromEntries(DATA_DOMAINS.map((domain) => [
    domain,
    uniqueFindings.filter((finding) => finding.domain === domain).length,
  ])),
  findings: uniqueFindings,
  outbox_producer_present: outboxProducerPresent,
  inbox_consumer_present: inboxConsumerPresent,
}, null, 2))
