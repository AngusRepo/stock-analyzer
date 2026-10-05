import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyMonthlyTrainingClosure } from './monthlyTrainingClosure'
import type { Bindings } from '../types'

test('monthly requires persisted receipt and never credits daily', async () => {
  const receipt = {schema_version:'l4-monthly-training-closure-v1',status:'complete',completion_scope:'monthly_training_candidate',
    as_of:'2026-10-04',cohort_id:'cohort',daily_freshness_credit:false,promoted:false,promotion_allowed:false,receipt_checksum:'a'.repeat(64)}
  const original=globalThis.fetch
  globalThis.fetch=async()=>new Response(JSON.stringify(receipt))
  const env={ML_CONTROLLER_URL:'https://controller.invalid'} as Bindings
  try {
    assert.deepEqual(await verifyMonthlyTrainingClosure(env,receipt,'active8-oof-monthly','monthly','2026-10-04','cohort'),receipt)
    await assert.rejects(verifyMonthlyTrainingClosure(env,receipt,'active8-oof-daily','daily','2026-10-04','cohort'))
    await assert.rejects(verifyMonthlyTrainingClosure(env,receipt,'active8-oof-monthly','monthly','2026-10-05','cohort'))
    await assert.rejects(verifyMonthlyTrainingClosure(env,{...receipt,promoted:true},'active8-oof-monthly','monthly','2026-10-04','cohort'))
    globalThis.fetch=async()=>new Response('missing',{status:404})
    await assert.rejects(verifyMonthlyTrainingClosure(env,receipt,'active8-oof-monthly','monthly','2026-10-04','cohort'))
  } finally {globalThis.fetch=original}
})
