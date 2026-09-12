import { twToday } from './dateUtils'
import type { Bindings } from '../types'
import { classifyCronSummary, logCronResult } from './schedulerRunLogger'
import { runMorningWarmup } from './localMaintenance'
import { handleWorkerDomainCron } from './cronWorkerDomainTasks'
import { handleGcpDomainCron } from './cronGcpDomainTasks'
import { batchGetIntradayOHLC } from './paperIntradayData'
import { runIntradayCheck } from './paperEntryTasks'
import { formatPendingBuyCronSummary } from './pendingBuyCronSummary'
import { buildPendingBuyStateSummary } from './pendingBuyStateSummary'
import { isTwIntradayTradingMinute } from './twMarketSession'
import { paperDomainDatabase } from './paperDomainDatabase'
import { settlePaperT2 } from './paperSettlementTasks'
import { runIntradayRescore } from './paperRescoreTasks'
export { settlePaperT2 } from './paperSettlementTasks'

function twNow() {
  return new Date(Date.now() + 8 * 3600_000)
}

function twDateString() {
  return twNow().toISOString().slice(0, 10)
}

type MlControllerProbeResult = {
  ok: boolean
  summary: string
}

function warmupTargetSummary(body: unknown): MlControllerProbeResult {
  const targets = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>).targets
    : null
  if (!targets || typeof targets !== 'object' || Array.isArray(targets)) {
    return { ok: false, summary: 'targets=unknown' }
  }

  const entries = Object.entries(targets)
  if (!entries.length) return { ok: false, summary: 'targets=empty' }

  const parts = entries.map(([name, value]) => {
    const record = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
    const status = typeof record.status === 'string' && record.status.trim()
      ? record.status.trim()
      : 'unknown'
    return `${name}=${status}`
  })

  return {
    ok: entries.every(([, value]) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false
      return (value as Record<string, unknown>).status === 'ok'
    }),
    summary: parts.join(' '),
  }
}

async function probeMlController(env: Bindings): Promise<string> {
  if (!env.ML_CONTROLLER_URL) return 'ML-Controller:skip(no ML_CONTROLLER_URL)'

  const headers = env.ML_CONTROLLER_SECRET ? { 'X-Controller-Token': env.ML_CONTROLLER_SECRET } : {}
  let warmupNote = ''
  try {
    const warmup = await fetch(`${env.ML_CONTROLLER_URL}/warmup`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(40_000),
    })
    if (warmup.ok) {
      const body = await warmup.json().catch(() => ({})) as any
      const targets = warmupTargetSummary(body)
      return targets.ok
        ? `ML-Controller:ok warmup=ok ${targets.summary}`
        : `ML-Controller:ok warmup=degraded ${targets.summary}`
    }
    warmupNote = `warmup_http=${warmup.status}`
  } catch (e: any) {
    warmupNote = `warmup_error=${e?.message ?? String(e)}`
  }

  try {
    const res = await fetch(`${env.ML_CONTROLLER_URL}/health`, {
      headers,
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) return `ML-Controller:fail(${res.status}; ${warmupNote})`
    const health = await res.json().catch(() => ({})) as any
    const pipelineJob = health.pipelineJobConfigured ? 'ok' : 'missing'
    const verifyJob = health.verifyJobConfigured ? 'ok' : 'missing'
    const callback = health.callbackConfigured ? 'ok' : 'missing'
    return `ML-Controller:ok health_fallback ${warmupNote} pipelineJob=${pipelineJob} verifyJob=${verifyJob} callback=${callback}`
  } catch (e: any) {
    return `ML-Controller:error(${warmupNote}; health_error=${e?.message ?? String(e)})`
  }
}

export async function runPreMarketWarmup(env: Bindings) {
  const results: string[] = []
  results.push('Worker:self ok')

  if (env.PAGES_ORIGIN) {
    try {
      const res = await fetch(env.PAGES_ORIGIN, {
        headers: { Accept: 'text/html,application/xhtml+xml' },
        signal: AbortSignal.timeout(10_000),
      })
      results.push(`Frontend:${res.ok ? 'ok' : `fail(${res.status})`}`)
    } catch (e: any) {
      results.push(`Frontend:error(${e.message})`)
    }
  } else {
    results.push('Frontend:skip(no PAGES_ORIGIN)')
  }

  results.push(await probeMlController(env))

  const proxyUrl = (env as any).SHIOAJI_PROXY_URL as string | undefined
  if (proxyUrl) {
    try {
      const res = await fetch(`${proxyUrl}/health`, {
        headers: { Authorization: `Bearer ${(env as any).PROXY_SERVICE_TOKEN ?? ''}` },
        signal: AbortSignal.timeout(10_000),
      })
      results.push(`Shioaji:${res.ok ? 'ok' : `fail(${res.status})`}`)
    } catch (e: any) {
      results.push(`Shioaji:error(${e.message})`)
    }
  }

  const summary = results.join(', ') || 'no warm targets'
  const hasDrift = results.some((item) => item.includes(':fail(') || item.includes(':error(') || item.includes('=missing'))
  return hasDrift ? `ERROR: control-plane drift ${summary}` : summary
}

async function runIntradayHeartbeat(env: Bindings, ctx: ExecutionContext, twTodayStr: string) {
  ctx.waitUntil((async () => {
    const started = Date.now()
    const { loadPendingBuySnapshot } = await import('./pendingBuyStore')
    await env.KV.put('cron:intraday-heartbeat', twNow().toISOString(), { expirationTtl: 3600 })
    const pendingBefore = await loadPendingBuySnapshot(env, twTodayStr, { allowFallbackRecent: false })
    const pendingBeforeState = buildPendingBuyStateSummary(pendingBefore.pendingBuys, pendingBefore.meta)
    if (!isTwIntradayTradingMinute()) {
      await env.KV.put(
        `cron:heartbeat:intraday-check:${twTodayStr}`,
        JSON.stringify({
          task: 'intraday-check',
          status: 'skipped',
          summary: formatPendingBuyCronSummary('heartbeat outside trading window', pendingBeforeState),
          duration_ms: Date.now() - started,
          timestamp: new Date().toISOString(),
        }),
        { expirationTtl: 7 * 86400 },
      )
      return
    }
    const beforeRow = await paperDomainDatabase(env).prepare(
      "SELECT COUNT(*) as cnt FROM paper_orders WHERE created_at >= ? AND side='buy'",
    ).bind(twTodayStr).first<{ cnt: number }>()
    const before = beforeRow?.cnt ?? 0

    const intradayLock = await env.KV.get('cron:intraday-lock')
    if (intradayLock) {
      await logCronResult(env.KV, 'intraday-check', {
        status: 'running',
        summary: formatPendingBuyCronSummary('heartbeat locked', pendingBeforeState, { total_buys: before }),
        duration_ms: Date.now() - started,
      })
      return
    }

    await env.KV.put('cron:intraday-lock', '1', { expirationTtl: 120 })
    let holdingPoll: Awaited<ReturnType<typeof runIntradayCheck>>
    try {
      holdingPoll = await runIntradayCheck(env)
    } finally {
      await env.KV.delete('cron:intraday-lock')
    }

    const afterRow = await paperDomainDatabase(env).prepare(
      "SELECT COUNT(*) as cnt FROM paper_orders WHERE created_at >= ? AND side='buy'",
    ).bind(twTodayStr).first<{ cnt: number }>()
    const after = afterRow?.cnt ?? 0
    const pendingAfter = await loadPendingBuySnapshot(env, twTodayStr, { allowFallbackRecent: false })
    const pendingAfterState = buildPendingBuyStateSummary(pendingAfter.pendingBuys, pendingAfter.meta)
    const buys = after - before
    const holdingResult = holdingPoll ?? null
    const holdingPartial = holdingResult != null && holdingResult.status === 'partial'
    await logCronResult(env.KV, 'intraday-check', {
      status: holdingPartial ? 'running' : buys > 0 ? 'success' : pendingAfter.pendingBuys.length > 0 ? 'running' : 'skipped',
      summary: formatPendingBuyCronSummary(holdingPartial ? 'heartbeat partial holding coverage' : 'heartbeat ok', pendingAfterState, {
        before_active: pendingBeforeState.active_count,
        buys: Math.max(0, buys),
        total_buys: after,
        holding_positions: holdingResult?.positions ?? 0,
        holding_quoted: holdingResult?.quoted ?? 0,
        holding_missing: holdingResult?.missing_symbols.join(',') ?? '',
      }),
      duration_ms: Date.now() - started,
    })
  })())
}

export { runIntradayRescore } from './paperRescoreTasks'

export async function handleScheduledCron(
  event: ScheduledEvent,
  env: Bindings,
  ctx: ExecutionContext,
) {
  const cron = event.cron
  const twTodayStr = twDateString()
  const twDayOfWeek = twNow().getUTCDay()
  const isWeekend = twDayOfWeek === 0 || twDayOfWeek === 6
  const isHoliday = await env.KV.get(`holiday:${twTodayStr}`)
  const weekendCrons = new Set(['0 20 * * 6', '0 22 * * 6', '30 22 * * 6', '0 */6 * * *'])

  if ((isWeekend || isHoliday) && !weekendCrons.has(cron)) {
    console.log(`[Cron] ${twTodayStr} holiday/weekend, skipping ${cron}`)
    return
  }

  const runWithLog = (task: string, fn: () => Promise<string>) =>
    ctx.waitUntil((async () => {
      const startedAt = Date.now()
      try {
        const summary = await fn()
        const status = classifyCronSummary(summary)
        await logCronResult(env.KV, task, {
          status,
          summary,
          duration_ms: Date.now() - startedAt,
        })
      } catch (e: any) {
        await logCronResult(env.KV, task, {
          status: 'error',
          summary: e?.message ?? 'Unknown error',
          duration_ms: Date.now() - startedAt,
          error: String(e),
        }, env as any)
      }
    })())

  const workerHandled = await handleWorkerDomainCron({
    cron,
    env,
    ctx,
    twTodayStr,
    runWithLog,
    runPreMarketWarmup,
    settlePaperT2,
    runIntradayHeartbeat,
    runIntradayRescore,
  })

  const gcpHandled = await handleGcpDomainCron({
    cron,
    env,
    runWithLog,
  })

  if (!workerHandled && !gcpHandled) {
    console.warn(`[Cron] Unhandled cron expression: ${cron}`)
  }
}
