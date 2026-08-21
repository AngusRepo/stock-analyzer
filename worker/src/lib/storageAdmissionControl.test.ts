import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyStorageAdmission,
  inspectStorageAdmission,
  isStorageAdmissionManagedTask,
  storageAdmissionOwner,
} from './storageAdmissionControl'

function capacityDb(sizeAfter: number | null, error?: Error): D1Database {
  return {
    prepare: () => ({
      all: async () => {
        if (error) throw error
        return { results: [{ storage_admission_probe: 1 }], meta: { size_after: sizeAfter } }
      },
    }),
  } as unknown as D1Database
}

test('unmanaged tasks report actual critical and unknown capacity instead of false healthy', async () => {
  const critical = await inspectStorageAdmission({ DB: capacityDb(9_000_000_000) }, 'evening-chain')
  assert.equal(critical.allowed, true)
  assert.equal(critical.managed, false)
  assert.equal(critical.utilizationPct, 90)
  assert.equal(critical.status, 'critical')
  assert.equal(critical.reason, 'critical_exempt_trading_or_capacity_reducing_path')

  const unknown = await inspectStorageAdmission({ DB: capacityDb(null, new Error('probe unavailable')) }, 'evening-chain')
  assert.equal(unknown.allowed, true)
  assert.equal(unknown.status, 'unknown')
  assert.equal(unknown.reason, 'legacy_d1_capacity_unknown_exempt')
})

test('managed tasks fail closed when capacity cannot be measured', async () => {
  const decision = await inspectStorageAdmission(
    { DB: capacityDb(null, new Error('probe unavailable')) },
    'weekly-backtest',
  )
  assert.equal(decision.allowed, false)
  assert.equal(decision.managed, true)
  assert.equal(decision.status, 'unknown')
  assert.equal(decision.reason, 'legacy_d1_capacity_unknown')
})

test('Learning-owned jobs probe Learning D1 after cutover and legacy before cutover', async () => {
  const legacy = capacityDb(9_000_000_000)
  const learning = capacityDb(2_000_000_000)
  const active = await inspectStorageAdmission({
    DB: legacy,
    LEARNING_DB: learning,
    MULTI_D1_ACTIVE_DOMAINS: 'learning',
    MULTI_D1_STRICT: 'true',
  }, 'weekly-backtest')
  assert.equal(storageAdmissionOwner('weekly-backtest'), 'learning')
  assert.equal(storageAdmissionOwner('legacy-strategy-evidence-migration'), 'learning')
  assert.equal(active.allowed, true)
  assert.equal(active.utilizationPct, 20)

  const migration = await inspectStorageAdmission({
    DB: legacy,
    LEARNING_DB: learning,
    MULTI_D1_ACTIVE_DOMAINS: 'learning',
    MULTI_D1_STRICT: 'true',
  }, 'legacy-strategy-evidence-migration')
  assert.equal(migration.allowed, true)
  assert.equal(migration.utilizationPct, 20)

  const legacyOwner = await inspectStorageAdmission({ DB: legacy, LEARNING_DB: learning }, 'weekly-backtest')
  assert.equal(legacyOwner.allowed, false)
  assert.equal(legacyOwner.utilizationPct, 90)
  assert.equal(storageAdmissionOwner('legacy-evidence-migration'), 'legacy')
})

test('major admin writers have explicit drain or critical admission coverage', () => {
  for (const task of [
    'weekly-backtest',
    'monte-carlo',
    'pbo',
    'allocator-ev-feature-snapshot-backfill',
    'selection-reference-repair',
    'selection-reference-identity-repair',
    's12-smcvwap-calibration',
    'legacy-evidence-migration',
    'legacy-strategy-evidence-migration',
  ]) {
    assert.equal(isStorageAdmissionManagedTask(task), true, `${task} must be managed`)
    assert.equal(classifyStorageAdmission(task, 75).allowed, false, `${task} must stop in drain`)
  }

  for (const task of [
    'strategy-learning',
    'strategy-learning-finalize',
    'external-evidence',
    'active8-oof-lifecycle',
    'active8-oof-daily',
  ]) {
    assert.equal(isStorageAdmissionManagedTask(task), true, `${task} must be managed`)
    assert.equal(classifyStorageAdmission(task, 75).allowed, true, `${task} remains guarded at drain`)
    assert.equal(classifyStorageAdmission(task, 85).allowed, false, `${task} must stop at critical`)
  }
})

test('trading and capacity-reducing cutover tasks remain allowed but visibly critical', () => {
  for (const task of ['evening-chain', 'intraday-check', 'legacy-hot-data-retirement', 'data-domain-shadow-backfill-next']) {
    const decision = classifyStorageAdmission(task, 90)
    assert.equal(decision.allowed, true, `${task} must remain available`)
    assert.equal(decision.managed, false)
    assert.equal(decision.status, 'critical')
    assert.equal(decision.reason, 'critical_exempt_trading_or_capacity_reducing_path')
  }
})
