import assert from 'node:assert/strict'
import fs from 'node:fs'

const wrangler = fs.readFileSync('wrangler.toml', 'utf8')
const expected: Record<string, string> = {
  DB: 'migrations',
  MARKET_DB: 'domain-migrations/market',
  LEARNING_DB: 'domain-migrations/learning',
  OPS_DB: 'domain-migrations/ops',
  CORE_DB: 'domain-migrations/core',
  EXECUTION_DB: 'domain-migrations/execution',
  PAPER_DB: 'domain-migrations/paper',
  RESEARCH_DB: 'domain-migrations/research',
}

for (const [binding, migrationsDir] of Object.entries(expected)) {
  const block = wrangler.match(new RegExp(`\\[\\[d1_databases\\]\\][\\s\\S]*?binding = "${binding}"[\\s\\S]*?(?=\\n\\[\\[|$)`))?.[0]
  assert(block, `missing D1 binding ${binding}`)
  assert.match(block, new RegExp(`migrations_dir = "${migrationsDir.replaceAll('/', '\\/')}"`))
}

const execution = fs.readFileSync('domain-migrations/execution/0001_execution_baseline.sql', 'utf8')
const paper = fs.readFileSync('domain-migrations/paper/0001_paper_baseline.sql', 'utf8')
const learningBaseline = fs.readFileSync('domain-migrations/learning/0001_learning_baseline.sql', 'utf8')
const executionCutoverProbe = fs.readFileSync('domain-migrations/execution/0002_data_domain_cutover_probe_canary.sql', 'utf8')
const paperCutoverProbe = fs.readFileSync('domain-migrations/paper/0002_data_domain_cutover_probe_canary.sql', 'utf8')
const learningIncremental = fs.readFileSync('domain-migrations/learning/0002_learning_policy_evidence.sql', 'utf8')
const learningForwardExtension = fs.readFileSync('domain-migrations/learning/0003_learning_active8_forward_extension.sql', 'utf8')
const opsIncremental = fs.readFileSync('domain-migrations/ops/0002_ops_retention_s12_pit.sql', 'utf8')
for (const table of [
  'strategy_production_policy_history_v1',
  'expected_return_shadow_evaluation_packets',
  'adaptive_meta_policy_decisions',
  'active8_oof_freshness_sla',
  'strategy_adaptive_policy_history_v2',
]) assert.match(learningIncremental, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`))
assert.match(learningForwardExtension, /CREATE TABLE IF NOT EXISTS active8_oof_forward_extension_coverage/)
for (const table of [
  'data_retention_cursors',
  'data_retention_run_items',
  's12_structure_batch_runs',
  's12_structure_batch_shards',
  'sector_flow_pit_rebuild_runs_v1',
]) assert.match(opsIncremental, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`))

assert.match(
  learningBaseline,
  /CREATE TABLE IF NOT EXISTS strategy_decision_log[\s\S]*created_at[\s\S]*context_id[\s\S]*evidence_artifact_id[\s\S]*evaluable[\s\S]*evaluation_contract_version/,
)

assert.equal((execution.match(/CREATE TABLE IF NOT EXISTS broker_/g) ?? []).length, 3)
assert.equal((paper.match(/CREATE TABLE IF NOT EXISTS paper_/g) ?? []).length, 11)
assert.match(paper, /CREATE TABLE IF NOT EXISTS paper_execution_events/)
assert.match(paper, /CREATE TABLE IF NOT EXISTS paper_daily_snapshots/)

assert.match(executionCutoverProbe, /CREATE TABLE IF NOT EXISTS data_domain_cutover_probe_canary/)
assert.match(executionCutoverProbe, /CHECK\(domain = 'execution'\)/)
assert.match(paperCutoverProbe, /CREATE TABLE IF NOT EXISTS data_domain_cutover_probe_canary/)
assert.match(paperCutoverProbe, /CHECK\(domain = 'paper'\)/)
console.log('domain migration layout contract passed')
