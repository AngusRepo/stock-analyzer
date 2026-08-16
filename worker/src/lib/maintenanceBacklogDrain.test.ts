import { strict as assert } from 'node:assert'
import * as fs from 'node:fs'
import {
  enqueueMaintenanceBacklogDrain,
  isAuditJsonDurableWindowOpen,
  processMaintenanceBacklogDrain,
  resolveMaintenanceDrainNextStep,
  sendMaintenanceContinuation,
} from './maintenanceBacklogDrain'

void (async () => {
  const values = new Map<string, string>()
  const messages: unknown[] = []
  const env = {
    KV: {
      get: async (key: string) => values.get(key) ?? null,
      put: async (key: string, value: string) => { values.set(key, value) },
      delete: async (key: string) => { values.delete(key) },
    },
    UPDATE_QUEUE: {
      send: async (message: unknown) => { messages.push(message) },
    },
  } as any

  const first = await enqueueMaintenanceBacklogDrain(env, {
    task: 'legacy-strategy-evidence-migration',
    runDate: '2026-07-22',
    runId: 'drain-1',
  })
  const duplicate = await enqueueMaintenanceBacklogDrain(env, {
    task: 'legacy-strategy-evidence-migration',
    runDate: '2026-07-22',
    runId: 'drain-2',
  })

  assert.equal(first.queued, true)
  assert.equal(duplicate.queued, false)
  assert.equal(duplicate.runId, 'drain-1')
  assert.equal(messages.length, 1)
  assert.deepEqual(messages[0], {
    type: 'maintenance_backlog_drain',
    maintenanceTask: 'legacy-strategy-evidence-migration',
    cursor: 0,
    triggerTime: '2026-07-22',
    runId: 'drain-1',
    attempt: 0,
    maxAttempts: 240,
    maintenanceCycle: 0,
    maxMaintenanceCycles: 1,
  })

  const auditFirst = await enqueueMaintenanceBacklogDrain(env, {
    task: 'audit-json-retention',
    runDate: '2026-08-15',
    runId: 'audit-drain-1',
    maxAttempts: 240,
    auditJsonOptions: {
      targets: ['strategy_decision_log'],
      retentionDays: 30,
      limitPerTable: 500,
      minBlobBytes: 1024,
    },
  })
  const auditDuplicate = await enqueueMaintenanceBacklogDrain(env, {
    task: 'audit-json-retention',
    runDate: '2026-08-15',
    runId: 'audit-drain-2',
    auditJsonOptions: {
      targets: ['strategy_decision_log'],
      retentionDays: 30,
      limitPerTable: 500,
      minBlobBytes: 1024,
    },
  })
  assert.equal(auditFirst.queued, true)
  assert.equal(auditDuplicate.queued, false)
  assert.equal(auditDuplicate.runId, 'audit-drain-1')
  assert.deepEqual(messages[1], {
    type: 'maintenance_backlog_drain',
    maintenanceTask: 'audit-json-retention',
    cursor: 0,
    triggerTime: '2026-08-15',
    runId: 'audit-drain-1',
    attempt: 0,
    maxAttempts: 240,
    maintenanceCycle: 0,
    maxMaintenanceCycles: 1,
    maintenanceTargets: ['strategy_decision_log'],
    maintenanceRetentionDays: 30,
    maintenanceLimitPerTable: 500,
    maintenanceMinBlobBytes: 1024,
  })

  assert.equal(isAuditJsonDurableWindowOpen(new Date('2026-08-15T16:59:59.999Z')), false)
  assert.equal(isAuditJsonDurableWindowOpen(new Date('2026-08-15T17:00:00.000Z')), true)
  assert.equal(isAuditJsonDurableWindowOpen(new Date('2026-08-15T22:39:59.999Z')), true)
  assert.equal(isAuditJsonDurableWindowOpen(new Date('2026-08-15T22:40:00.000Z')), false)
  assert.equal(isAuditJsonDurableWindowOpen(new Date('2026-08-15T22:49:00.000Z')), false)
  assert.equal(isAuditJsonDurableWindowOpen(new Date('2026-08-15T22:50:00.000Z')), false)

  const deferredValues = new Map<string, string>()
  const deferredDeletes: string[] = []
  const deferredMessages: unknown[] = []
  const deferredEnv = {
    DB: {
      prepare: () => { throw new Error('window_closed_must_not_touch_d1') },
    },
    KV: {
      get: async (key: string, type?: string) => {
        const value = deferredValues.get(key)
        if (value === undefined) return null
        return type === 'json' ? JSON.parse(value) : value
      },
      put: async (key: string, value: string) => { deferredValues.set(key, value) },
      delete: async (key: string) => {
        deferredDeletes.push(key)
        deferredValues.delete(key)
      },
    },
    UPDATE_QUEUE: {
      send: async (message: unknown) => { deferredMessages.push(message) },
    },
  } as any
  const deferredActiveKey = 'maintenance:backlog-drain:audit-json-retention:active'
  deferredValues.set(deferredActiveKey, 'audit-window-test')
  await processMaintenanceBacklogDrain(deferredEnv, {
    type: 'maintenance_backlog_drain',
    maintenanceTask: 'audit-json-retention',
    cursor: 0,
    triggerTime: '2026-08-15',
    runId: 'audit-window-test',
    attempt: 0,
    maxAttempts: 240,
    maintenanceCycle: 0,
    maxMaintenanceCycles: 1,
    maintenanceTargets: ['strategy_decision_log'],
    maintenanceRetentionDays: 30,
    maintenanceLimitPerTable: 500,
    maintenanceMinBlobBytes: 1024,
  }, new Date('2026-08-15T22:40:00.000Z'))
  assert.equal(deferredMessages.length, 0)
  assert.ok(deferredDeletes.includes(deferredActiveKey))
  const skipped = JSON.parse(
    deferredValues.get('scheduler:run:audit-json-retention:2026-08-15') ?? '{}',
  ) as { status?: string; summary?: string }
  assert.equal(skipped.status, 'skipped')
  assert.match(String(skipped.summary), /window_closed/)
  assert.match(String(skipped.summary), /backlog_remaining=true/)

  const protectedValues = new Map<string, string>()
  const protectedDeletes: string[] = []
  const protectedMessages: unknown[] = []
  const protectedEnv = {
    DB: {
      prepare: () => { throw new Error('ops_shadow_backfill_active_must_not_touch_d1') },
    },
    KV: {
      get: async (key: string, type?: string) => {
        const value = protectedValues.get(key)
        if (value === undefined) return null
        return type === 'json' ? JSON.parse(value) : value
      },
      put: async (key: string, value: string) => { protectedValues.set(key, value) },
      delete: async (key: string) => {
        protectedDeletes.push(key)
        protectedValues.delete(key)
      },
    },
    UPDATE_QUEUE: {
      send: async (message: unknown) => { protectedMessages.push(message) },
    },
  } as any
  const protectedActiveKey = 'maintenance:backlog-drain:audit-json-retention:active'
  protectedValues.set(protectedActiveKey, 'audit-ops-protection-test')
  protectedValues.set(
    'data-domain-shadow-backfill:ops:active',
    JSON.stringify({ run_id: 'ops-backfill-1', started_at: '2026-08-15T17:00:00.000Z' }),
  )
  await processMaintenanceBacklogDrain(protectedEnv, {
    type: 'maintenance_backlog_drain',
    maintenanceTask: 'audit-json-retention',
    cursor: 0,
    triggerTime: '2026-08-15',
    runId: 'audit-ops-protection-test',
    attempt: 0,
    maxAttempts: 240,
    maintenanceCycle: 0,
    maxMaintenanceCycles: 1,
    maintenanceTargets: ['strategy_decision_log'],
    maintenanceRetentionDays: 30,
    maintenanceLimitPerTable: 500,
    maintenanceMinBlobBytes: 1024,
  }, new Date('2026-08-15T17:30:00.000Z'))
  assert.equal(protectedMessages.length, 0)
  assert.ok(protectedDeletes.includes(protectedActiveKey))
  const protectedSkipped = JSON.parse(
    protectedValues.get('scheduler:run:audit-json-retention:2026-08-15') ?? '{}',
  ) as { status?: string; summary?: string }
  assert.equal(protectedSkipped.status, 'skipped')
  assert.match(String(protectedSkipped.summary), /ops_shadow_backfill_active/)
  assert.match(String(protectedSkipped.summary), /ops-backfill-1/)

  const failedSendValues = new Map<string, string>()
  let failedSendAttempts = 0
  const failedSendEnv = {
    KV: {
      get: async (key: string, type?: string) => {
        const value = failedSendValues.get(key)
        if (value === undefined) return null
        return type === 'json' ? JSON.parse(value) : value
      },
      put: async (key: string, value: string) => { failedSendValues.set(key, value) },
      delete: async (key: string) => { failedSendValues.delete(key) },
    },
    UPDATE_QUEUE: {
      send: async () => {
        failedSendAttempts += 1
        throw new Error('queue_unavailable')
      },
    },
  } as any
  const failedSend = await sendMaintenanceContinuation(failedSendEnv, {
    task: 'audit-json-retention',
    runDate: '2026-08-15',
    runId: 'audit-send-failure',
    message: messages[1] as any,
    delaySeconds: 5,
    phase: 'next_attempt',
  })
  assert.equal(failedSend, false)
  assert.equal(failedSendAttempts, 1)
  assert.equal(
    failedSendValues.has('maintenance:backlog-drain:audit-json-retention:active'),
    false,
  )
  const failedSendLog = JSON.parse(
    failedSendValues.get('scheduler:run:audit-json-retention:2026-08-15') ?? '{}',
  ) as { status?: string; summary?: string; error?: string }
  assert.equal(failedSendLog.status, 'error')
  assert.match(String(failedSendLog.summary), /continuation_send_failed/)
  assert.match(String(failedSendLog.summary), /backlog_remaining=true/)
  assert.equal(failedSendLog.error, 'queue_unavailable')

  const initialFailureEnv = {
    KV: {
      get: async () => null,
      put: async () => {},
      delete: async () => { throw new Error('active_release_failed') },
    },
    UPDATE_QUEUE: {
      send: async () => { throw new Error('initial_send_failed') },
    },
  } as any
  await assert.rejects(
    () => enqueueMaintenanceBacklogDrain(initialFailureEnv, {
      task: 'audit-json-retention',
      runDate: '2026-08-15',
      runId: 'audit-initial-send-failure',
      auditJsonOptions: {
        targets: ['strategy_decision_log'],
        retentionDays: 30,
        limitPerTable: 500,
        minBlobBytes: 1024,
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError)
      assert.equal(error.message, 'maintenance_initial_send_failed_active_release_failed')
      assert.deepEqual(
        error.errors.map((cause) => cause instanceof Error ? cause.message : String(cause)),
        ['initial_send_failed', 'active_release_failed'],
      )
      return true
    },
  )

  assert.equal(resolveMaintenanceDrainNextStep({ backlogRemaining: false, attempt: 0, maxAttempts: 240, cycle: 0, maxCycles: 4 }), 'complete')
  assert.equal(resolveMaintenanceDrainNextStep({ backlogRemaining: true, attempt: 238, maxAttempts: 240, cycle: 0, maxCycles: 4 }), 'next_attempt')
  assert.equal(resolveMaintenanceDrainNextStep({ backlogRemaining: true, attempt: 239, maxAttempts: 240, cycle: 0, maxCycles: 4 }), 'next_cycle')
  assert.equal(resolveMaintenanceDrainNextStep({ backlogRemaining: true, attempt: 239, maxAttempts: 240, cycle: 3, maxCycles: 4 }), 'exhausted')

  const orchestrator = fs.readFileSync('src/lib/updateOrchestrator.ts', 'utf8')
  assert.match(orchestrator, /msg\.type === 'maintenance_backlog_drain'/)
  assert.match(orchestrator, /processMaintenanceBacklogDrain/)
  const maintenanceDrain = fs.readFileSync('src/lib/maintenanceBacklogDrain.ts', 'utf8')
  assert.equal(
    (maintenanceDrain.match(/await sendMaintenanceContinuation\(env,/g) ?? []).length,
    3,
  )
  const scheduler = fs.readFileSync('../infra/gcp-scheduler-jobs.json', 'utf8')
  assert.match(scheduler, /legacy-strategy-evidence-migration[^\n]+durable=1/)
  assert.match(scheduler, /audit-json-retention[^\n]+durable=1/)
  assert.doesNotMatch(scheduler, /"id": "d1-evidence-scrub"/)
  assert.match(scheduler, /"d1-evidence-scrub"/)
})().catch((error) => {
  throw error
})
