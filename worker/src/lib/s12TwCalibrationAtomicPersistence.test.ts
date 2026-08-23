import assert from 'node:assert/strict'
import test from 'node:test'
import {
  commitS12TwCalibrationAtomically,
  type S12TwCalibrationArtifact,
} from './s12TwEquityCalibration'

class AtomicStatement {
  constructor(
    readonly sql: string,
    readonly values: readonly unknown[] = [],
    private readonly owner: AtomicDb,
  ) {}

  bind(...values: unknown[]): AtomicStatement {
    return new AtomicStatement(this.sql, values, this.owner)
  }

  async run(): Promise<{ meta: { changes: number } }> {
    this.owner.directWrites += 1
    return { meta: { changes: 1 } }
  }
}

class AtomicDb {
  directWrites = 0
  batches: AtomicStatement[][] = []
  committedSql: string[] = []
  failBatch = false

  prepare(sql: string): AtomicStatement {
    return new AtomicStatement(sql, [], this)
  }

  async batch(statements: AtomicStatement[]): Promise<unknown[]> {
    this.batches.push(statements)
    if (this.failBatch) throw new Error('injected_s12_atomic_batch_failure')
    this.committedSql.push(...statements.map((statement) => statement.sql))
    return statements.map(() => ({ success: true, meta: { changes: 1 } }))
  }
}

function artifact(id: string, status: 'approved' | 'rejected' = 'approved'): S12TwCalibrationArtifact {
  return {
    artifactId: id,
    runId: 's12-tw-calibration-weekly-2026-08-23',
    status,
    cadence: 'weekly',
    scope: {
      marketSegment: 'LISTED',
      entryCohort: 'reaction_ready',
      alphaBucket: 'high',
      entryTimeBucket: 'opening',
    },
    policy: { minFastVwapSignals: 2 },
    exit: {
      tp1MfeQuantile: 0.03,
      tp2MfeQuantile: 0.05,
      stopMaeQuantile: 0.02,
      minNetProfitR: 0.25,
    },
    validationStart: '2026-05-25',
    validationEnd: '2026-08-23',
    sampleCount: 80,
    dateCount: 20,
    metrics: { failed_gates: status === 'approved' ? [] : ['selected_validation_mean_r'] },
    createdAt: '2026-08-23T19:00:00.000Z',
    approvedAt: status === 'approved' ? '2026-08-23T19:00:00.000Z' : null,
  }
}

function input(artifacts: S12TwCalibrationArtifact[], replaceExistingRunArtifacts = false) {
  return {
    runId: 's12-tw-calibration-weekly-2026-08-23',
    runDate: '2026-08-23',
    cadence: 'weekly' as const,
    artifacts,
    evidenceCount: 4128,
    scopesSeen: artifacts.length,
    failedGateDistribution: {},
    replaceExistingRunArtifacts,
  }
}

test('commits supersede, artifacts, and terminal run receipt in one ordered D1 batch', async () => {
  const db = new AtomicDb()
  const written = await commitS12TwCalibrationAtomically(
    db as unknown as D1Database,
    input([artifact('approved-a'), artifact('rejected-b', 'rejected')], true),
  )
  assert.equal(written, 2)
  assert.equal(db.directWrites, 0)
  assert.equal(db.batches.length, 1)
  assert.equal(db.batches[0].length, 5)
  assert.match(db.batches[0][0].sql, /DELETE FROM s12_tw_calibration_artifacts/)
  assert.match(db.batches[0][1].sql, /UPDATE s12_tw_calibration_artifacts/)
  assert.match(db.batches[0][2].sql, /INSERT OR REPLACE INTO s12_tw_calibration_artifacts/)
  assert.match(db.batches[0][3].sql, /INSERT OR REPLACE INTO s12_tw_calibration_artifacts/)
  assert.match(db.batches[0][4].sql, /INSERT OR REPLACE INTO s12_tw_calibration_runs/)
})

test('propagates batch failure without any direct or committed partial promotion writes', async () => {
  const db = new AtomicDb()
  db.failBatch = true
  await assert.rejects(
    commitS12TwCalibrationAtomically(
      db as unknown as D1Database,
      input([artifact('approved-a'), artifact('approved-b')]),
    ),
    /injected_s12_atomic_batch_failure/,
  )
  assert.equal(db.directWrites, 0)
  assert.equal(db.batches.length, 1)
  assert.deepEqual(db.committedSql, [])
  assert.match(db.batches[0].at(-1)?.sql ?? '', /INSERT OR REPLACE INTO s12_tw_calibration_runs/)
})

test('fails closed before D1 when the atomic statement cap is exceeded', async () => {
  const db = new AtomicDb()
  const artifacts = Array.from({ length: 125 }, (_, index) => artifact(`approved-${index}`))
  await assert.rejects(
    commitS12TwCalibrationAtomically(db as unknown as D1Database, input(artifacts, true)),
    /atomic batch exceeds 250 statements: 252/,
  )
  assert.equal(db.batches.length, 0)
  assert.equal(db.directWrites, 0)
})
