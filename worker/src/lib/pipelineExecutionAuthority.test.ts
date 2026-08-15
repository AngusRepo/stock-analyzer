import assert from 'node:assert/strict'
import test from 'node:test'

import {
  acceptPipelineExecutionCallback,
  commitPipelineExecutionDispatch,
  reservePipelineExecutionDispatch,
  type PipelineStageRow,
} from './pipelineStageLease'

class Statement {
  private values: unknown[] = []
  constructor(private readonly db: FakeDispatchD1, private readonly sql: string) {}
  bind(...values: unknown[]) { this.values = values; return this }
  async first<T>(): Promise<T | null> { return this.db.first(this.sql, this.values) as T | null }
}

class FakeDispatchD1 {
  row: PipelineStageRow | null = null
  leaseLive = true
  prepare(sql: string) { return new Statement(this, sql) }

  first(sql: string, values: unknown[]): PipelineStageRow | null {
    if (sql.includes("INSERT INTO pipeline_stage_runs") && sql.includes("'pipeline_execution'")) {
      const [businessDate, attemptId] = values.map(String)
      if (this.row && this.row.status !== 'error' && this.leaseLive) return null
      this.row = {
        business_date: businessDate,
        stage: 'pipeline_execution',
        canonical_run_id: attemptId,
        status: 'running',
        cursor_key: null,
        processed_count: 0,
        expected_count: null,
        persisted_count: 0,
        attempt_count: (this.row?.attempt_count ?? -1) + 1,
        lease_owner: attemptId,
        lease_expires_at: '2099-01-01 00:00:00',
      }
      this.leaseLive = true
      return { ...this.row }
    }
    if (sql.includes("SET canonical_run_id=?, status='waiting'")) {
      const [runId, , businessDate, attemptId, owner] = values.map(String)
      if (!this.row || this.row.business_date !== businessDate || this.row.status !== 'running') return null
      if (this.row.canonical_run_id !== attemptId || this.row.lease_owner !== owner || !this.leaseLive) return null
      this.row = { ...this.row, canonical_run_id: runId, status: 'waiting', lease_owner: attemptId }
      return { ...this.row }
    }
    if (sql.includes("SET status=?, last_error=?") && sql.includes("stage='pipeline_execution'")) {
      const [status, , businessDate, runId, duplicateStatus] = values.map(String)
      if (!this.row || this.row.business_date !== businessDate || this.row.canonical_run_id !== runId) return null
      if (!['running', 'waiting'].includes(this.row.status) && this.row.status !== duplicateStatus) return null
      this.row = {
        ...this.row,
        status: status as PipelineStageRow['status'],
        lease_owner: null,
        lease_expires_at: null,
      }
      return { ...this.row }
    }
    throw new Error(`unsupported dispatch SQL: ${sql}`)
  }
}

test('two concurrent pipeline triggers reserve one controller dispatch', async () => {
  const db = new FakeDispatchD1()
  const [a, b] = await Promise.all([
    reservePipelineExecutionDispatch(db as unknown as D1Database, {
      businessDate: '2026-08-14', attemptId: 'attempt-A',
    }),
    reservePipelineExecutionDispatch(db as unknown as D1Database, {
      businessDate: '2026-08-14', attemptId: 'attempt-B',
    }),
  ])
  const controllerCalls = [a, b].filter(Boolean).length
  assert.equal(controllerCalls, 1)
  assert.equal(a?.canonical_run_id, 'attempt-A')
  assert.equal(b, null)
})

test('new dispatch may recover terminal error A and late A callback cannot close B', async () => {
  const db = new FakeDispatchD1()
  await reservePipelineExecutionDispatch(db as unknown as D1Database, {
    businessDate: '2026-08-14', attemptId: 'attempt-A',
  })
  assert.ok(await commitPipelineExecutionDispatch(db as unknown as D1Database, {
    businessDate: '2026-08-14', attemptId: 'attempt-A', runId: 'run-A',
  }))
  assert.ok(await acceptPipelineExecutionCallback(db as unknown as D1Database, {
    businessDate: '2026-08-14', runId: 'run-A', status: 'error', error: 'failed-A',
  }))
  assert.ok(await reservePipelineExecutionDispatch(db as unknown as D1Database, {
    businessDate: '2026-08-14', attemptId: 'attempt-B',
  }))
  assert.ok(await commitPipelineExecutionDispatch(db as unknown as D1Database, {
    businessDate: '2026-08-14', attemptId: 'attempt-B', runId: 'run-B',
  }))
  assert.equal(await acceptPipelineExecutionCallback(db as unknown as D1Database, {
    businessDate: '2026-08-14', runId: 'run-A', status: 'error', error: 'late-A',
  }), null)
  assert.equal(db.row?.canonical_run_id, 'run-B')
  assert.equal(db.row?.status, 'waiting')
  assert.ok(await acceptPipelineExecutionCallback(db as unknown as D1Database, {
    businessDate: '2026-08-14', runId: 'run-B', status: 'success',
  }))
  assert.equal(db.row?.status, 'success')
})

test('accepted response loss stays reserved, exact callback closes it, and same-date success is immutable', async () => {
  const db = new FakeDispatchD1()
  assert.ok(await reservePipelineExecutionDispatch(db as unknown as D1Database, {
    businessDate: '2026-08-14', attemptId: 'run-A',
  }))
  assert.equal(await reservePipelineExecutionDispatch(db as unknown as D1Database, {
    businessDate: '2026-08-14', attemptId: 'run-B',
  }), null)
  assert.ok(await acceptPipelineExecutionCallback(db as unknown as D1Database, {
    businessDate: '2026-08-14', runId: 'run-A', status: 'success',
  }))
  assert.equal(await reservePipelineExecutionDispatch(db as unknown as D1Database, {
    businessDate: '2026-08-14', attemptId: 'run-B',
  }), null)
  assert.equal(db.row?.canonical_run_id, 'run-A')
  assert.equal(db.row?.status, 'success')
})

test('same-run terminal callback is idempotent but an opposing terminal callback is rejected', async () => {
  const db = new FakeDispatchD1()
  await reservePipelineExecutionDispatch(db as unknown as D1Database, {
    businessDate: '2026-08-14', attemptId: 'attempt-A',
  })
  await commitPipelineExecutionDispatch(db as unknown as D1Database, {
    businessDate: '2026-08-14', attemptId: 'attempt-A', runId: 'run-A',
  })
  assert.ok(await acceptPipelineExecutionCallback(db as unknown as D1Database, {
    businessDate: '2026-08-14', runId: 'run-A', status: 'error', error: 'failed',
  }))
  assert.ok(await acceptPipelineExecutionCallback(db as unknown as D1Database, {
    businessDate: '2026-08-14', runId: 'run-A', status: 'error', error: 'failed',
  }))
  assert.equal(await acceptPipelineExecutionCallback(db as unknown as D1Database, {
    businessDate: '2026-08-14', runId: 'run-A', status: 'success',
  }), null)
  assert.equal(db.row?.status, 'error')
})
