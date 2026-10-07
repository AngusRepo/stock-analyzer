import { twToday } from './dateUtils'
import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import { assertMarketDataReady, type MarketDataReadinessResult } from './marketDataReadiness'
import { recomputeDailyMarketRisk } from './marketRiskMaterialization'
import {
  commitPipelineExecutionDispatch,
  failPipelineExecutionDispatch,
  reservePipelineExecutionDispatch,
} from './pipelineStageLease'

function resolvePipelineRunDate(runDate?: string | null): string {
  const value = (runDate || '').trim()
  if (!value) return twToday()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid pipeline run date: ${value}; expected YYYY-MM-DD`)
  }
  return value
}

export interface PipelineTriggerOptions {
  prevalidatedEventChain?: boolean
}

export async function runMLAndRiskV2(
  env: Bindings,
  runDate?: string | null,
  options: PipelineTriggerOptions = {},
): Promise<string> {
  const twDate = resolvePipelineRunDate(runDate)
  const opsDb = databaseForDataDomain(env, 'ops')
  const marketDb = databaseForDataDomain(env, 'market')
  if (options.prevalidatedEventChain) {
    await assertMarketDataReady(env, twDate)
  } else {
    await assertEveningPipelineReady(env, twDate)
  }

  const lockKey = `lock:ml-predict:${twDate}`
  const existing = await env.KV.get(lockKey)
  if (existing) {
    console.log('[ML V2] Already running, skip')
    return 'LOCKED'
  }

  await env.KV.put(lockKey, '1', { expirationTtl: 1800 })
  let dispatchAttemptId: string | null = null
  let dispatchReserved = false
  let controllerAccepted = false
  let dispatchAmbiguous = false

  try {
    if (!env.ML_CONTROLLER_URL) {
      throw new Error('ML_CONTROLLER_URL not set; cannot trigger pipeline V2')
    }

    try {
      await recomputeDailyMarketRisk(env,twDate)
    } catch (e: any) {
      throw new Error(`market risk unavailable; pipeline blocked: ${e?.message ?? e}`)
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (env.ML_CONTROLLER_SECRET) headers['X-Controller-Token'] = env.ML_CONTROLLER_SECRET

    // A completed Modal bundle is reusable only after the exact continuation
    // is verified failed. A new downstream attempt retains explicit source lineage.
    const failedRun = await opsDb.prepare(`
      SELECT canonical_run_id FROM pipeline_stage_runs
       WHERE business_date=? AND stage='pipeline_execution' AND status='error'
    `).bind(twDate).first<{ canonical_run_id: string }>()
    let resumeRunId: string | null = null
    if (failedRun?.canonical_run_id) {
      const preflight = await fetch(`${env.ML_CONTROLLER_URL}/pipeline/v2/resume?date=${twDate}&run_id=${encodeURIComponent(failedRun.canonical_run_id)}`, {
        headers, signal: AbortSignal.timeout(30_000),
      })
      if (!preflight.ok) throw new Error(`pipeline_resume_preflight_failed:${preflight.status}`)
      const recovery = await preflight.json() as { resumable?: boolean; run_id?: string; run_date?: string }
      if (recovery.resumable === true && recovery.run_id === failedRun.canonical_run_id && recovery.run_date === twDate) {
        resumeRunId = failedRun.canonical_run_id
        headers['X-Pipeline-Resume-From'] = resumeRunId
      }
    }
    dispatchAttemptId = `pipeline-dispatch:${twDate}:${crypto.randomUUID()}`
    headers['X-Pipeline-Run-Id'] = dispatchAttemptId
    const reservation = await reservePipelineExecutionDispatch(opsDb, {
      businessDate: twDate,
      attemptId: dispatchAttemptId,
      expectedFailedRunId: resumeRunId ?? undefined,
    })
    if (!reservation) {
      const current = await databaseForDataDomain(env, 'ops').prepare(`
        SELECT canonical_run_id, status
          FROM pipeline_stage_runs
         WHERE business_date=? AND stage='pipeline_execution'
      `).bind(twDate).first<{ canonical_run_id?: string | null; status?: string | null }>()
      if (current?.status === 'success') {
        console.log(`[ML V2] Same-date pipeline already completed for ${twDate} run_id=${current.canonical_run_id ?? 'unknown'}`)
        return `ALREADY_COMPLETED pipeline execution for ${twDate} run_id=${current.canonical_run_id ?? 'unknown'}`
      }
      console.log(`[ML V2] Durable pipeline execution already active for ${twDate}`)
      return `LOCKED durable pipeline execution for ${twDate} run_id=${current?.canonical_run_id ?? 'unknown'} status=${current?.status ?? 'unknown'}`
    }
    dispatchReserved = true

    console.log(`[ML V2] Triggering ml-controller /pipeline/v2/run date=${twDate} (async, expect 202)...`)
    const t0 = Date.now()
    let res: Response
    try {
      res = await fetch(`${env.ML_CONTROLLER_URL}/pipeline/v2/run?date=${twDate}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(30_000),
      })
    } catch (error) {
      dispatchAmbiguous = true
      const reason = error instanceof Error ? error.message : String(error)
      console.warn(`[ML V2] Ambiguous controller handoff; D1 reservation retained run_id=${dispatchAttemptId}: ${reason}`)
      return `LOCKED ambiguous pipeline dispatch for ${twDate} run_id=${dispatchAttemptId}; callback or lease expiry required`
    }
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)

    if (res.status !== 202 && !res.ok) {
      const text = await res.text().catch(() => '')
      if (res.status >= 500) {
        dispatchAmbiguous = true
        console.warn(
          `[ML V2] Ambiguous controller HTTP ${res.status}; D1 reservation retained run_id=${dispatchAttemptId}`,
        )
        return `LOCKED ambiguous pipeline dispatch for ${twDate} run_id=${dispatchAttemptId} HTTP ${res.status}; callback or lease expiry required`
      }
      if (res.status === 409 && text.toLowerCase().includes('active execution')) {
        await failPipelineExecutionDispatch(opsDb, {
          businessDate: twDate,
          attemptId: dispatchAttemptId!,
          error: `controller_active_execution:${text.slice(0, 300)}`,
        })
        dispatchReserved = false
        console.log(`[ML V2] Controller reports active execution for ${twDate}; preserving active-run contract`)
        return `LOCKED active execution for ${twDate}: ${text.slice(0, 220)}`
      }
      throw new Error(`Pipeline V2 trigger HTTP ${res.status}: ${text.slice(0, 300)}`)
    }

    controllerAccepted = true
    let executionName: string | undefined
    let responseRunId = dispatchAttemptId
    try {
      const body = await res.json() as any
      responseRunId = String(body?.run_id ?? dispatchAttemptId)
      executionName = typeof body?.execution_name === 'string' ? body.execution_name : undefined
    } catch {
      responseRunId = dispatchAttemptId
    }
    if (responseRunId !== dispatchAttemptId) {
      dispatchAmbiguous = true
      throw new Error(
        `pipeline_execution_response_identity_mismatch:requested=${dispatchAttemptId}:received=${responseRunId}`,
      )
    }

    let committed = null
    let commitError: unknown = null
    for (let attempt = 0; attempt < 3 && !committed; attempt += 1) {
      try {
        committed = await commitPipelineExecutionDispatch(opsDb, {
          businessDate: twDate,
          attemptId: dispatchAttemptId!,
          runId: dispatchAttemptId!,
          executionName,
        })
      } catch (error) {
        commitError = error
      }
      if (!committed && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 100 * (2 ** attempt)))
      }
    }
    if (!committed) {
      const current = await databaseForDataDomain(env, 'ops').prepare(`
        SELECT canonical_run_id, status
          FROM pipeline_stage_runs
         WHERE business_date=? AND stage='pipeline_execution'
      `).bind(twDate).first<{ canonical_run_id?: string | null; status?: string | null }>()
      if (current?.canonical_run_id !== dispatchAttemptId) {
        dispatchAmbiguous = true
        throw new Error(
          `pipeline_execution_dispatch_commit_lost:${twDate}:${dispatchAttemptId}:${commitError instanceof Error ? commitError.message : String(commitError ?? 'cas_rejected')}`,
        )
      }
      dispatchReserved = false
      await env.KV.put(lockKey, dispatchAttemptId, { expirationTtl: 1800 }).catch(() => {})
      console.warn(
        `[ML V2] Controller accepted but D1 remained status=${current.status ?? 'unknown'}; exact callback can close run_id=${dispatchAttemptId}`,
      )
      return `triggered run_id=${dispatchAttemptId}, authority commit pending exact callback`
    }
    dispatchReserved = false
    await env.KV.put(lockKey, dispatchAttemptId, { expirationTtl: 1800 })
    console.log(`[ML V2] Triggered in ${elapsed}s, run_id=${dispatchAttemptId} (awaiting callback for final status)`)
    return `triggered run_id=${dispatchAttemptId}, callback expected`
  } catch (e: any) {
    if (dispatchReserved && dispatchAttemptId && !controllerAccepted && !dispatchAmbiguous) {
      await failPipelineExecutionDispatch(opsDb, {
        businessDate: twDate,
        attemptId: dispatchAttemptId,
        error: e?.message ?? String(e),
      }).catch(() => false)
    }
    if (!controllerAccepted && !dispatchAmbiguous) {
      await env.KV.delete(lockKey).catch(() => {})
    }
    throw e
  }
}

export async function assertEveningPipelineReady(
  env: Bindings,
  twDate: string,
): Promise<MarketDataReadinessResult> {
  const ready = await assertMarketDataReady(env, twDate)
  const queueLog = await env.KV.get(`scheduler:run:indicator-queue:${twDate}`, 'json') as {
    status?: string
    summary?: string
  } | null

  // Waiting belongs to the evening-chain queue finalizer. This guard only blocks
  // direct pipeline triggers from bypassing the event-driven dependency chain.
  if (!queueLog || queueLog.status !== 'success') {
    throw new Error(
      `indicator queue not complete for ${twDate}: status=${queueLog?.status ?? 'missing'}; ` +
      `summary=${queueLog?.summary ?? ''}`,
    )
  }

  const regimeLog = await env.KV.get(`scheduler:run:regime-compute:${twDate}`, 'json') as {
    status?: string
    summary?: string
  } | null
  if (!regimeLog || regimeLog.status !== 'success') {
    throw new Error(
      `regime-compute not complete for ${twDate}: status=${regimeLog?.status ?? 'missing'}; ` +
      `summary=${regimeLog?.summary ?? ''}`,
    )
  }

  return ready
}
