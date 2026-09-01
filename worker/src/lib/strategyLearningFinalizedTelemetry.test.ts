import assert from 'node:assert/strict'
import {
  reconcileAndReleaseStrategyLearningFinalizedTelemetry,
  reconcileStrategyLearningFinalizedRetryFastPath,
} from './strategyLearningFinalizedTelemetry'
import type {
  StrategyLearningLeaseIdentity,
  StrategyLearningRunRow,
} from './strategyLearningRunState'

class PartialFailureKv {
  readonly values = new Map<string, string>()
  private failed = false

  constructor(private readonly failOnce = true) {}

  async get(key: string, type?: string): Promise<unknown> {
    const value = this.values.get(key)
    if (value == null) return null
    return type === 'json' ? JSON.parse(value) : value
  }

  async put(key: string, value: string): Promise<void> {
    if (this.failOnce && !this.failed && key === 'scheduler:run:post-verify-chain:2026-08-14') {
      this.failed = true
      throw new Error('injected_partial_kv_failure')
    }
    this.values.set(key, value)
  }
}

class FakeFinalizedLeaseStatement {
  private values: unknown[] = []

  constructor(
    private readonly db: FakeFinalizedLeaseD1,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): FakeFinalizedLeaseStatement {
    this.values = values
    return this
  }

  async first<T>(): Promise<T | null> {
    return this.db.first(this.sql, this.values) as T | null
  }

  async run(): Promise<{ meta: { changes: number } }> {
    return { meta: { changes: this.db.run(this.sql, this.values) } }
  }
}

class FakeFinalizedLeaseD1 {
  status: 'success' = 'success'
  leaseOwner: string | null = 'lease-a'
  leaseExpiresAt: string | null = '2026-08-15 00:15:00'
  leaseLive = true
  postVerifyCanonicalRunId = 'canonical-run'
  heartbeatCount = 0
  reclaimCount = 0
  releaseCount = 0
  postVerifyCloseCheckCount = 0

  prepare(sql: string): FakeFinalizedLeaseStatement {
    return new FakeFinalizedLeaseStatement(this, sql)
  }

  first(sql: string, values: unknown[]): { authorized?: number; closed?: number } | null {
    if (sql.includes('UPDATE strategy_learning_runs') && sql.includes('RETURNING 1 AS')) {
      const alias = sql.match(/RETURNING 1 AS (\w+)/)?.[1]
      const changed = this.run(sql, values)
      return changed === 1 && alias ? { [alias]: 1 } : null
    }
    if (sql.includes('SELECT 1 AS closed') && sql.includes('FROM pipeline_stage_runs')) {
      this.postVerifyCloseCheckCount += 1
      const [businessDate, canonicalRunId] = values.map(String)
      return businessDate === '2026-08-14' && canonicalRunId === this.postVerifyCanonicalRunId
        ? { closed: 1 }
        : null
    }
    if (!sql.includes('SELECT 1 AS authorized') || !sql.includes('FROM pipeline_stage_runs')) {
      throw new Error(`unsupported first SQL: ${sql}`)
    }
    const [businessDate, canonicalRunId] = values.map(String)
    return businessDate === '2026-08-14' && canonicalRunId === this.postVerifyCanonicalRunId
      ? { authorized: 1 }
      : null
  }

  run(sql: string, values: unknown[]): number {
    if (sql.includes("SET lease_expires_at=datetime('now', ?)") && sql.includes("status IN ('running', 'success')")) {
      assert.match(sql, /status IN \('running', 'success'\)/)
      const [, businessDate, canonicalRunId, leaseOwner] = values.map(String)
      if (
        businessDate !== '2026-08-14'
        || canonicalRunId !== 'canonical-run'
        || this.status !== 'success'
        || this.leaseOwner !== leaseOwner
        || !this.leaseExpiresAt
        || !this.leaseLive
      ) return 0
      this.heartbeatCount += 1
      this.leaseExpiresAt = '2026-08-15 00:15:00'
      return 1
    }
    if (sql.includes("SET lease_expires_at=datetime('now', ?)") && sql.includes('lease_expires_at < CURRENT_TIMESTAMP')) {
      assert.match(sql, /status='success' AND completed_at IS NOT NULL/)
      assert.match(sql, /lease_owner IS NOT NULL AND lease_owner=\?/)
      assert.match(sql, /FROM pipeline_stage_runs p/)
      const [, businessDate, canonicalRunId, leaseOwner] = values.map(String)
      if (
        businessDate !== '2026-08-14'
        || canonicalRunId !== 'canonical-run'
        || this.status !== 'success'
        || this.leaseOwner !== leaseOwner
        || !this.leaseExpiresAt
        || this.leaseLive
        || this.postVerifyCanonicalRunId !== canonicalRunId
      ) return 0
      this.reclaimCount += 1
      this.leaseLive = true
      this.leaseExpiresAt = '2026-08-15 00:15:00'
      return 1
    }
    if (sql.includes('SET lease_owner=NULL, lease_expires_at=NULL')) {
      assert.match(sql, /status='success' AND completed_at IS NOT NULL/)
      assert.match(sql, /FROM pipeline_stage_runs p/)
      const [businessDate, canonicalRunId, leaseOwner] = values.map(String)
      if (
        businessDate !== '2026-08-14'
        || canonicalRunId !== 'canonical-run'
        || this.leaseOwner !== leaseOwner
        || this.postVerifyCanonicalRunId !== canonicalRunId
        || !this.leaseExpiresAt
        || !this.leaseLive
      ) return 0
      this.releaseCount += 1
      this.leaseOwner = null
      this.leaseExpiresAt = null
      return 1
    }
    throw new Error(`unsupported run SQL: ${sql}`)
  }

  canPostVerifyTakeOver(): boolean {
    return !(this.status === 'success' && this.leaseOwner && this.leaseExpiresAt && this.leaseLive)
  }
}

function readStatus(kv: PartialFailureKv, task: string): string | null {
  const value = kv.values.get(`scheduler:run:${task}:2026-08-14`)
  if (!value) return null
  return String((JSON.parse(value) as { status?: string }).status ?? '')
}

function finalizedRow(db: FakeFinalizedLeaseD1): StrategyLearningRunRow {
  return {
    business_date: '2026-08-14',
    canonical_run_id: 'canonical-run',
    producer_run_id: 'producer-run',
    status: 'success',
    cursor_symbol: '2330',
    expected_candidates: 2,
    processed_candidates: 2,
    strategy_count: 2,
    expected_decision_rows: 4,
    persisted_decision_rows: 4,
    lease_owner: db.leaseOwner,
    lease_expires_at: db.leaseExpiresAt,
    completed_at: '2026-08-15 00:00:00',
    production_authority_intent: 1,
    policy_closure_status: 'materialized',
    policy_closure_reason: 'live_canonical:test',
    policy_closure_completed_at: '2026-08-15 00:00:00',
  }
}

async function main(): Promise<void> {
  const kv = new PartialFailureKv()
  const db = new FakeFinalizedLeaseD1()
  const identity: StrategyLearningLeaseIdentity = {
    businessDate: '2026-08-14',
    canonicalRunId: 'canonical-run',
    leaseOwner: 'lease-a',
  }
  let evidenceRuns = 1
  let policyRuns = 1
  const seedCalls = 0
  const listCalls = 0
  const initializeCalls = 0
  const retryPolicyCalls = 0
  const input = {
    runDate: '2026-08-14',
    canonicalRunId: 'canonical-run',
    summary: 'durable finalize complete',
    attemptId: 'attempt-a',
    runScope: 'live_canonical' as const,
  }

  await assert.rejects(
    reconcileAndReleaseStrategyLearningFinalizedTelemetry(
      db as unknown as D1Database,
      kv as unknown as KVNamespace,
      identity,
      input,
    ),
    /injected_partial_kv_failure/,
  )
  assert.equal(readStatus(kv, 'strategy-learning'), 'success')
  assert.equal(readStatus(kv, 'post-verify-chain'), null)
  assert.equal(readStatus(kv, 'evening-chain'), null)
  assert.equal(db.leaseOwner, 'lease-a')
  assert.equal(db.releaseCount, 0)
  assert.equal(db.canPostVerifyTakeOver(), false)

  // Queue/manual finalized readback only repairs the strict telemetry writes and
  // then releases the same finalized lease. Evidence and policy do not rerun.
  assert.equal(await reconcileStrategyLearningFinalizedRetryFastPath(
    db as unknown as D1Database,
    kv as unknown as KVNamespace,
    finalizedRow(db),
    { attemptId: 'attempt-retry' },
  ), 'reconciled')
  assert.equal(readStatus(kv, 'strategy-learning'), 'success')
  assert.equal(readStatus(kv, 'post-verify-chain'), 'success')
  assert.equal(readStatus(kv, 'evening-chain'), 'success')
  assert.equal(evidenceRuns, 1)
  assert.equal(policyRuns, 1)
  assert.equal(db.releaseCount, 1)
  assert.equal(db.leaseOwner, null)
  assert.equal(db.canPostVerifyTakeOver(), true)
  assert.deepEqual(
    { seedCalls, listCalls, initializeCalls, retryPolicyCalls },
    { seedCalls: 0, listCalls: 0, initializeCalls: 0, retryPolicyCalls: 0 },
  )

  const expiredDb = new FakeFinalizedLeaseD1()
  expiredDb.leaseLive = false
  expiredDb.leaseExpiresAt = '2026-08-14 23:59:59'
  const expiredKv = new PartialFailureKv(false)
  assert.equal(await reconcileStrategyLearningFinalizedRetryFastPath(
    expiredDb as unknown as D1Database,
    expiredKv as unknown as KVNamespace,
    finalizedRow(expiredDb),
    { attemptId: 'attempt-expired-retry' },
  ), 'reconciled')
  assert.equal(readStatus(expiredKv, 'strategy-learning'), 'success')
  assert.equal(readStatus(expiredKv, 'post-verify-chain'), 'success')
  assert.equal(readStatus(expiredKv, 'evening-chain'), 'success')
  assert.equal(expiredDb.heartbeatCount, 0)
  assert.equal(expiredDb.reclaimCount, 1)
  assert.equal(expiredDb.releaseCount, 1)
  assert.equal(expiredDb.leaseOwner, null)

  const historicalDb = new FakeFinalizedLeaseD1()
  const historicalKv = new PartialFailureKv(false)
  const historicalRow = finalizedRow(historicalDb)
  historicalRow.production_authority_intent = 0
  historicalRow.policy_closure_status = 'evidence_only'
  historicalRow.policy_closure_reason = 'historical_replay:evidence_only'
  assert.equal(await reconcileStrategyLearningFinalizedRetryFastPath(
    historicalDb as unknown as D1Database,
    historicalKv as unknown as KVNamespace,
    historicalRow,
    { attemptId: 'attempt-historical-retry' },
  ), 'reconciled')
  assert.equal(readStatus(historicalKv, 'strategy-learning'), 'success')
  assert.equal(readStatus(historicalKv, 'post-verify-chain'), null)
  assert.equal(readStatus(historicalKv, 'evening-chain'), null)
  assert.equal(historicalDb.postVerifyCloseCheckCount, 0)
  assert.equal(historicalDb.releaseCount, 1)
  assert.equal(historicalDb.leaseOwner, null)

  const staleDb = new FakeFinalizedLeaseD1()
  staleDb.leaseLive = false
  staleDb.leaseExpiresAt = '2026-08-14 23:59:59'
  staleDb.postVerifyCanonicalRunId = 'pipeline-b'
  const staleKv = new PartialFailureKv(false)
  assert.equal(await reconcileStrategyLearningFinalizedRetryFastPath(
    staleDb as unknown as D1Database,
    staleKv as unknown as KVNamespace,
    finalizedRow(staleDb),
    { attemptId: 'attempt-stale' },
  ), 'authority_changed')
  assert.equal(staleKv.values.size, 0)
  assert.equal(staleDb.heartbeatCount, 0)
  assert.equal(staleDb.reclaimCount, 0)
  assert.equal(staleDb.releaseCount, 0)

  const legacyDb = new FakeFinalizedLeaseD1()
  legacyDb.leaseOwner = null
  legacyDb.leaseExpiresAt = null
  legacyDb.leaseLive = false
  const legacyKv = new PartialFailureKv(false)
  assert.equal(await reconcileStrategyLearningFinalizedRetryFastPath(
    legacyDb as unknown as D1Database,
    legacyKv as unknown as KVNamespace,
    finalizedRow(legacyDb),
    { attemptId: 'attempt-legacy' },
  ), 'no_live_telemetry_lease')
  assert.equal(legacyKv.values.size, 0)
  assert.equal(legacyDb.reclaimCount, 0)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
