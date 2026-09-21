import assert from 'node:assert/strict'
import { Miniflare } from 'miniflare'
import { reservePipelineExecutionDispatch, commitPipelineExecutionDispatch, acceptPipelineExecutionCallback } from './pipelineStageLease'

async function main() {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['OPS'] })
  try {
    const db = await mf.getD1Database('OPS')
    await db.prepare(`CREATE TABLE pipeline_stage_runs (
      business_date TEXT, stage TEXT, canonical_run_id TEXT, status TEXT, cursor_key TEXT,
      processed_count INTEGER DEFAULT 0, expected_count INTEGER, persisted_count INTEGER DEFAULT 0,
      attempt_count INTEGER DEFAULT 0, lease_owner TEXT, lease_expires_at TEXT, queued_at TEXT,
      started_at TEXT, completed_at TEXT, updated_at TEXT, last_error TEXT, PRIMARY KEY(business_date,stage))`).run()
    const businessDate = '2026-09-21'
    await reservePipelineExecutionDispatch(db as unknown as D1Database, {businessDate, attemptId:'original'})
    await acceptPipelineExecutionCallback(db as unknown as D1Database, {businessDate, runId:'original', status:'error'})
    assert.equal(await reservePipelineExecutionDispatch(db as unknown as D1Database, {businessDate, attemptId:'stale', expectedFailedRunId:'wrong'}), null)
    const resume = await reservePipelineExecutionDispatch(db as unknown as D1Database, {businessDate, attemptId:'resume', expectedFailedRunId:'original'})
    assert.equal(resume?.canonical_run_id, 'resume')
    assert.equal(await reservePipelineExecutionDispatch(db as unknown as D1Database, {businessDate, attemptId:'duplicate', expectedFailedRunId:'original'}), null)
    assert.equal(await acceptPipelineExecutionCallback(db as unknown as D1Database, {businessDate, runId:'original', status:'success'}), null)
    assert.equal(await acceptPipelineExecutionCallback(db as unknown as D1Database, {businessDate, runId:'original', status:'error'}), null)
    assert(await commitPipelineExecutionDispatch(db as unknown as D1Database, {businessDate, attemptId:'resume', runId:'resume'}))
    assert(await acceptPipelineExecutionCallback(db as unknown as D1Database, {businessDate, runId:'resume', status:'success'}))
    assert.equal(await reservePipelineExecutionDispatch(db as unknown as D1Database, {businessDate, attemptId:'after-success', expectedFailedRunId:'resume'}), null)
  } finally { await mf.dispose() }
}
void main()
