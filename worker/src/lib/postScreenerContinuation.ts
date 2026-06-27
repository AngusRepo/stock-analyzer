import type { Bindings } from '../types'
import { logSchedulerResult } from './schedulerRunLogger'

export async function enqueuePostScreenerPipelineContinuation(
  env: Bindings,
  options: {
    triggerTime: string
    runId: string
    shardCount?: number
    source: string
    summary?: string
  },
): Promise<void> {
  const shardCount = Math.max(1, Math.floor(Number(options.shardCount ?? 1) || 1))
  await logSchedulerResult(env.KV, 'evening-chain', {
    status: 'running',
    summary: options.summary ??
      `event-driven chain queued post-screener continuation for ${options.triggerTime}; run_id=${options.runId}; source=${options.source}`,
    duration_ms: 0,
    run_date: options.triggerTime,
    run_id: options.runId,
  })
  await env.UPDATE_QUEUE.send({
    type: 'post_screener_pipeline',
    cursor: 0,
    triggerTime: options.triggerTime,
    runId: options.runId,
    shardCount,
    attempt: 1,
  })
  await env.KV.put(
    `cron:indicator-queue:${options.triggerTime}:${options.runId}:post-screener-enqueued`,
    new Date().toISOString(),
    { expirationTtl: 7 * 86400 },
  ).catch((e) => console.warn('[Queue] Post-screener enqueue marker write failed:', e))
}
