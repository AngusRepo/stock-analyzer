import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  dataDomainProjectionContractReady,
  dataDomainRoutingContractReady,
  tablesForDataDomainShadowBackfill,
  tableOwnershipMetadata,
} from './dataDomainRegistry'

const v41 = readFileSync('src/lib/v41DataRuntime.ts', 'utf8')
const dashboard = readFileSync('src/routes/dashboardReadRoutes.ts', 'utf8')
const orchestrator = readFileSync('src/lib/updateOrchestrator.ts', 'utf8')
const quality = readFileSync('src/lib/dataQualityMonitor.ts', 'utf8')
const artifact = readFileSync('src/lib/artifactLifecycle.ts', 'utf8')

assert.equal(dataDomainRoutingContractReady('ops'), true)
assert.equal(dataDomainProjectionContractReady('ops'), true)
assert.deepEqual(
  tablesForDataDomainShadowBackfill('ops').filter(
    (table) => tableOwnershipMetadata(table)?.route_ready !== true,
  ),
  [],
)

assert.match(v41, /readV41DataRuntimeStatus\(db: D1Database, opsDb: D1Database/)
for (const table of ['finlab_backfill_runs', 'source_diff_report', 'gap_fill_candidates']) {
  assert.match(v41, new RegExp('opsDb\\.prepare\\([\\s\\S]*?FROM ' + table + '\\b'))
}
assert.match(dashboard, /databaseForDataDomain\(c\.env, 'market'\)[\s\S]*databaseForDataDomain\(c\.env, 'ops'\)/)
assert.match(orchestrator, /sourceKeyCanonicalParityReadiness\([\s\S]*databaseForDataDomain\(env, 'ops'\)[\s\S]*databaseForDataDomain\(env, 'market'\)/)
assert.match(orchestrator, /fetchedFinLabSourceLanesForTarget\(databaseForDataDomain\(env, 'ops'\)/)
assert.match(orchestrator, /readFinLabSourceKeyReportForTarget\(databaseForDataDomain\(env, 'ops'\)/)
assert.match(quality, /const opsDb = databaseForDataDomain\(env, 'ops'\)/)
assert.match(quality, /firstCount\(\s*opsDb,[\s\S]*FROM webhook_log/)
assert.match(artifact, /const opsDb = artifactOpsDb\(env\)/)
assert.doesNotMatch(artifact, /legacy_d1_evidence_scrub_disabled_after_ops_cutover/)
assert.match(artifact, /assertBatchSuccess\(await opsDb\.batch/)

console.log('ops domain routing closure contract passed')
