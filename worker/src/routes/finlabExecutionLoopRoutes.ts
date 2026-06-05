import { Hono } from 'hono'
import { requireServiceToken } from '../lib/auth'
import { runIntradayCheck } from '../lib/paperEntryTasks'
import { logSchedulerResult } from '../lib/schedulerRunLogger'
import type { Bindings, Variables } from '../types'

export const finlabExecutionLoopRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

finlabExecutionLoopRoutes.post('/api/internal/execution/intraday-check', async (c) => {
  const authError = await requireServiceToken(c)
  if (authError) return authError

  const startedAt = Date.now()
  try {
    await runIntradayCheck(c.env)
  } catch (error) {
    const durationMs = Date.now() - startedAt
    await logSchedulerResult(c.env.KV, 'intraday-check', {
      status: 'error',
      summary: error instanceof Error ? error.message : String(error),
      duration_ms: durationMs,
      strict: true,
    }, c.env as any)
    return c.json({
      success: false,
      mode: 'real_loop_simulated_order',
      paper_order_mode: 'worker_intraday_check',
      live_submit_enabled: false,
      can_submit_real_order: false,
      duration_ms: durationMs,
      error: error instanceof Error ? error.message : String(error),
    }, 500)
  }
  const durationMs = Date.now() - startedAt
  await logSchedulerResult(c.env.KV, 'intraday-check', {
    status: 'success',
    summary: 'finlab real loop paper intraday-check completed',
    duration_ms: durationMs,
    strict: true,
  }, c.env as any)
  return c.json({
    success: true,
    mode: 'real_loop_simulated_order',
    paper_order_mode: 'worker_intraday_check',
    live_submit_enabled: false,
    can_submit_real_order: false,
    duration_ms: durationMs,
  })
})
