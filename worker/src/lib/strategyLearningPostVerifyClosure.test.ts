import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { closeStrategyLearningPostVerifyStage } from './strategyLearningRunState'

async function main() {
  const sql = new DatabaseSync(':memory:')
  const db = { prepare(query: string) { return { bind(...params: any[]) { return {
    async first() { return sql.prepare(query).get(...params) ?? null },
  } } } } } as unknown as D1Database
  sql.exec(`
    CREATE TABLE pipeline_stage_runs(business_date TEXT, stage TEXT, canonical_run_id TEXT,
      status TEXT, lease_owner TEXT, completed_at TEXT, updated_at TEXT, last_error TEXT);
    CREATE TABLE strategy_learning_runs(business_date TEXT, canonical_run_id TEXT, status TEXT,
      production_authority_intent INTEGER, policy_closure_status TEXT, completed_at TEXT,
      policy_closure_completed_at TEXT, expected_candidates INTEGER, processed_candidates INTEGER,
      expected_decision_rows INTEGER, persisted_decision_rows INTEGER);
    CREATE TABLE scheduler_execution_tickets_v1(business_date TEXT, scheduler_job_id TEXT, ticket_kind TEXT);
  `)
  function reset() {
    sql.exec(`DELETE FROM pipeline_stage_runs; DELETE FROM strategy_learning_runs;
      DELETE FROM scheduler_execution_tickets_v1;
      INSERT INTO pipeline_stage_runs VALUES('2026-09-21','post_verify_chain','canonical','waiting',NULL,NULL,NULL,NULL);
      INSERT INTO pipeline_stage_runs VALUES('2026-09-21','pipeline_execution','canonical','success',NULL,'done',NULL,NULL);
      INSERT INTO strategy_learning_runs VALUES('2026-09-21','canonical','success',0,'evidence_only','done','done',808,808,21008,21008);
      INSERT INTO scheduler_execution_tickets_v1 VALUES('2026-09-21','evening-chain','physical_root');`)
  }
  const identity = { businessDate: '2026-09-21', canonicalRunId: 'canonical' }
  reset()
  const learningBefore = sql.prepare('SELECT * FROM strategy_learning_runs').get()
  assert.equal(await closeStrategyLearningPostVerifyStage(db, identity), true)
  assert.equal(await closeStrategyLearningPostVerifyStage(db, identity), true, 'idempotent retry')
  assert.deepEqual(sql.prepare('SELECT * FROM strategy_learning_runs').get(), learningBefore, 'no policy promotion or rewriting evidence')
  for (const mutation of [
    "UPDATE strategy_learning_runs SET status='running'",
    "UPDATE strategy_learning_runs SET canonical_run_id='stale'",
    "UPDATE strategy_learning_runs SET policy_closure_status='pending'",
    "UPDATE strategy_learning_runs SET production_authority_intent=1",
    "UPDATE strategy_learning_runs SET completed_at=NULL",
    "UPDATE strategy_learning_runs SET policy_closure_completed_at=NULL",
    "UPDATE strategy_learning_runs SET processed_candidates=807",
    "UPDATE strategy_learning_runs SET persisted_decision_rows=21007",
    "UPDATE strategy_learning_runs SET expected_candidates=0,processed_candidates=0",
    "UPDATE strategy_learning_runs SET expected_decision_rows=0,persisted_decision_rows=0",
    "UPDATE pipeline_stage_runs SET canonical_run_id='newer' WHERE stage='pipeline_execution'",
    "UPDATE pipeline_stage_runs SET status='error' WHERE stage='pipeline_execution'",
    "DELETE FROM pipeline_stage_runs WHERE stage='pipeline_execution'",
    "UPDATE pipeline_stage_runs SET canonical_run_id='newer' WHERE stage='post_verify_chain'",
    "UPDATE pipeline_stage_runs SET status='running' WHERE stage='post_verify_chain'",
    "UPDATE pipeline_stage_runs SET lease_owner='active' WHERE stage='post_verify_chain'",
    "DELETE FROM scheduler_execution_tickets_v1",
    "UPDATE scheduler_execution_tickets_v1 SET business_date='2026-09-20'",
    "UPDATE scheduler_execution_tickets_v1 SET scheduler_job_id='research'",
    "UPDATE scheduler_execution_tickets_v1 SET ticket_kind='logical_child'",
  ]) {
    reset(); sql.exec(mutation)
    const before = sql.prepare('SELECT * FROM pipeline_stage_runs').all()
    assert.equal(await closeStrategyLearningPostVerifyStage(db, identity), false, mutation)
    assert.deepEqual(sql.prepare('SELECT * FROM pipeline_stage_runs').all(), before, mutation)
  }
  reset()
  sql.exec("UPDATE strategy_learning_runs SET production_authority_intent=1,policy_closure_status='materialized'")
  assert.equal(await closeStrategyLearningPostVerifyStage(db, identity), true, 'original live policy closure retained')
  sql.close()
  console.log('strategy learning post-verify closure: PASS (20 negative cases, historical/live success, idempotency)')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
