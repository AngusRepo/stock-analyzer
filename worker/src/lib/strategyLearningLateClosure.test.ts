import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { initializeStrategyLearningRun, isStrategyLearningTerminalFailure, resumeRepairedStrategyLearningRun } from './strategyLearningRunState'
import { resolveStrategyLearningCompletionAuthority } from './strategyLearningCompletionAuthority'
import { STRATEGY_PRODUCTION_POLICY_POINT_IN_TIME_SQL, STRATEGY_PRODUCTION_POLICY_SERVING_SQL } from './strategyProductionPolicyStore'
import { DEFAULT_STRATEGY_SPECS } from './strategySpec'
import { strategyRegistryFingerprintPayload } from './selectionReferenceEvidence'
import { sha256Text } from './datasetSnapshots'

async function main() {
  const sql = new DatabaseSync(':memory:')
  const db = { prepare(query: string) {
    const statement = sql.prepare(query)
    const bound = (params: any[]) => ({
      bind: (...values: any[]) => bound(values),
      all: async () => ({ results: statement.all(...params) }),
      first: async () => statement.get(...params) ?? null,
      run: async () => ({ meta: { changes: Number(statement.run(...params).changes) } }),
    })
    return bound([])
  }, async batch(statements: any[]) {
    sql.exec('BEGIN')
    try {
      const results = []
      for (const statement of statements) results.push(await statement.run())
      sql.exec('COMMIT')
      return results
    } catch (error) { sql.exec('ROLLBACK'); throw error }
  } } as unknown as D1Database
  const opsSchema = readFileSync(new URL('../../domain-schemas/ops.sql', import.meta.url), 'utf8')
  sql.exec(opsSchema.match(/CREATE TABLE IF NOT EXISTS strategy_learning_runs \([\s\S]*?\);/)![0])
  sql.exec(`
    CREATE TABLE selection_reference_snapshots_v1(signal_date TEXT, symbol TEXT, producer_run_id TEXT,
      hard_gate_passed INTEGER,strategy_labeled INTEGER,strategy_matrix_status TEXT,
      strategy_registry_checksum TEXT,strategy_labeler_version TEXT,feature_contract_version TEXT,
      evidence_artifact_id TEXT,created_at TEXT);
    CREATE TABLE pipeline_stage_runs(business_date TEXT,stage TEXT,canonical_run_id TEXT,
      queued_at TEXT,status TEXT,cursor_key TEXT,lease_owner TEXT,last_error TEXT,completed_at TEXT,updated_at TEXT);
    CREATE TABLE pipeline_runs(run_id TEXT,business_date TEXT,domain TEXT,canonical_at TEXT);
    CREATE TABLE canonical_run_heads(logical_run_key TEXT,run_id TEXT);
    CREATE TABLE canonical_market_daily(stock_id TEXT,source TEXT,date TEXT);
    CREATE TABLE strategy_label_matrix_runs_v4(signal_date TEXT,producer_run_id TEXT,status TEXT,
      strategy_registry_checksum TEXT,strategy_count INTEGER,expected_cell_count INTEGER,
      persisted_cell_count INTEGER,reference_candidate_count INTEGER,created_at TEXT,
      labeler_version TEXT,reference_contract_version TEXT,evidence_artifact_id TEXT);
    CREATE TABLE strategy_label_matrix_v4(signal_date TEXT,producer_run_id TEXT,strategy_registry_checksum TEXT,
      labeler_version TEXT,reference_contract_version TEXT,created_at TEXT);
    CREATE TABLE strategy_production_policy_history_v1(policy_id TEXT,knowledge_cutoff_date TEXT,
      version INTEGER,status TEXT,strategy_weights_json TEXT,quarantined_strategy_ids_json TEXT,
      candidate_ready_strategy_ids_json TEXT,base_weight_source TEXT,base_weight_run_id TEXT,
      evidence_json TEXT,canonical_payload TEXT,checksum TEXT,created_at TEXT);
  `)
  const spec = DEFAULT_STRATEGY_SPECS[0]
  const checksum = await sha256Text(JSON.stringify(strategyRegistryFingerprintPayload([spec])))
  sql.prepare('INSERT INTO selection_reference_snapshots_v1 VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run('2026-09-07','2330','producer',1,1,'ready',checksum,'v3','v4','artifact','2026-09-07 13:49:02')
  const initial = {businessDate:'2026-09-07',runId:'pipeline',strategyCount:1,canonicalProducerRunId:'producer',productionAuthorityIntent:true}
  await initializeStrategyLearningRun(db, initial)
  sql.exec("UPDATE strategy_learning_runs SET status='error',cursor_symbol='2330',processed_candidates=1,persisted_decision_rows=1,last_error='terminal',policy_closure_reason='terminal'")
  const before = sql.prepare('SELECT * FROM strategy_learning_runs').get()
  await initializeStrategyLearningRun(db, {...initial,runId:'queue-redelivery'})
  assert.deepEqual(sql.prepare('SELECT * FROM strategy_learning_runs').get(), before, 'redelivery must preserve terminal progress and reason')

  sql.exec(`
    INSERT INTO pipeline_stage_runs(business_date,stage,canonical_run_id,queued_at,status,cursor_key) VALUES ('2026-09-07','post_verify_chain','pipeline','2026-09-08 00:57:26','waiting',NULL);
    INSERT INTO pipeline_stage_runs(business_date,stage,canonical_run_id,queued_at,status,cursor_key) VALUES ('2026-09-07','screener_v2','indicator','2026-09-07 13:20:00','success','producer');
    INSERT INTO pipeline_runs VALUES ('producer','2026-09-07','screener','2026-09-07 13:49:15');
    INSERT INTO canonical_run_heads VALUES ('screener:2026-09-07:TW:production:market_screener','producer');
    INSERT INTO canonical_market_daily VALUES ('0050','finlab.price','2026-09-08');
  `)
  sql.prepare('INSERT INTO strategy_label_matrix_runs_v4 VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('2026-09-07','producer','ready',checksum,1,1,1,1,'2026-09-07 13:49:02','v3','v4','artifact')
  sql.prepare('INSERT INTO strategy_label_matrix_v4 VALUES (?,?,?,?,?,?)')
    .run('2026-09-07','producer',checksum,'v3','v4','2026-09-07 13:49:02')
  const now = Date.now
  Date.now = () => Date.parse('2026-09-08T02:00:00Z')
  try {
    const env = { DB:db, KV:{} } as any
    const input = {businessDate:'2026-09-07',canonicalRunId:'pipeline',producerRunId:'producer',specs:[spec]}
    const late = await resolveStrategyLearningCompletionAuthority(env,input)
    assert.equal(late.allowed,true)
    assert.equal(late.lateCompletion,true)
    assert.match(late.reason,/forward_policy_only/)
    assert.equal((await resolveStrategyLearningCompletionAuthority(env,{...input,canonicalRunId:'stale'})).allowed,false)
    sql.exec("UPDATE strategy_label_matrix_v4 SET created_at='2026-09-08 01:01:00'")
    assert.equal((await resolveStrategyLearningCompletionAuthority(env,input)).allowed,false,'post-open reconstruction must not impersonate frozen evidence')
    sql.exec("UPDATE strategy_label_matrix_v4 SET created_at='2026-09-07 13:49:02'")
    sql.exec("UPDATE strategy_label_matrix_runs_v4 SET strategy_registry_checksum='different'")
    assert.equal((await resolveStrategyLearningCompletionAuthority(env,input)).allowed,false,'registry drift must fail closed')
  } finally { Date.now = now }

  const resumeInput = {businessDate:'2026-09-07',canonicalRunId:'pipeline',producerRunId:'producer'}
  assert.equal(await resumeRepairedStrategyLearningRun(db,resumeInput),false,'pipeline success is required')
  sql.exec(`INSERT INTO pipeline_stage_runs(business_date,stage,canonical_run_id,status)
    VALUES ('2026-09-07','pipeline_execution','pipeline','success');
    UPDATE pipeline_stage_runs SET status='error' WHERE stage='post_verify_chain';`)
  assert.equal(await resumeRepairedStrategyLearningRun(db,{...resumeInput,producerRunId:'wrong'}),false)
  assert.equal(await resumeRepairedStrategyLearningRun(db,{...resumeInput,canonicalRunId:'stale'}),false)
  sql.exec("UPDATE pipeline_stage_runs SET lease_owner='other' WHERE stage='post_verify_chain'")
  assert.equal(await resumeRepairedStrategyLearningRun(db,resumeInput),false,'active stage lease fences repair')
  sql.exec("UPDATE pipeline_stage_runs SET lease_owner=NULL WHERE stage='post_verify_chain'")
  assert.equal(await resumeRepairedStrategyLearningRun(db,resumeInput),true)
  const resumed = sql.prepare('SELECT * FROM strategy_learning_runs').get()!
  assert.equal(resumed.status,'queued')
  assert.equal(resumed.cursor_symbol,before!.cursor_symbol)
  assert.equal(resumed.processed_candidates,before!.processed_candidates)
  assert.equal(resumed.persisted_decision_rows,before!.persisted_decision_rows)
  assert.equal(sql.prepare("SELECT status FROM pipeline_stage_runs WHERE stage='post_verify_chain'").get()?.status,'waiting')
  assert.equal(await resumeRepairedStrategyLearningRun(db,resumeInput),false,'operator retry is idempotent')

  sql.exec(`INSERT INTO strategy_production_policy_history_v1(policy_id,knowledge_cutoff_date,status,checksum,created_at)
    VALUES ('policy','2026-09-04','active','old','2026-09-04 15:41:12'),
           ('policy','2026-09-07','active','late','2026-09-08 02:00:00')`)
  assert.equal(sql.prepare(STRATEGY_PRODUCTION_POLICY_SERVING_SQL).get('policy','2026-09-08','2026-09-08')?.checksum,'old')
  assert.equal(sql.prepare(STRATEGY_PRODUCTION_POLICY_SERVING_SQL).get('policy','2026-09-09','2026-09-09')?.checksum,'late')
  assert.equal(sql.prepare(STRATEGY_PRODUCTION_POLICY_POINT_IN_TIME_SQL).get('policy','2026-09-08')?.checksum,'late','historical evidence adapter stays separate')
  assert.equal(isStrategyLearningTerminalFailure('evening_chain_formal_evidence_backlog:2026-08-20:formal_canonical_head_missing'),true)
  assert.equal(isStrategyLearningTerminalFailure('D1 transient network error'),false)
  sql.close()
  console.log('strategyLearningLateClosure: PASS (real SQLite retry, frozen-time, registry, publication fences)')
}
main().catch(error=>{console.error(error);process.exitCode=1})
