import type { Bindings } from '../types'
import {
  enqueuePipelineStage,
  markPipelineStageFenced,
} from './pipelineStageLease'
import { logSchedulerResult } from './schedulerRunLogger'

export const POST_SCREENER_CONTINUATION_STAGE = 'post_screener_continuation'

export async function enqueuePostScreenerPipelineContinuation(
  env: Bindings,
  options: {
    triggerTime: string
    runId: string
    shardCount?: number
    source: string
    summary?: string
  },
): Promise<{ queued: boolean; canonicalRunId: string; status: string }> {
  const shardCount = Math.max(1, Math.floor(Number(options.shardCount ?? 1) || 1))
  const state = await enqueuePipelineStage(env.DB, {
    businessDate: options.triggerTime,
    stage: POST_SCREENER_CONTINUATION_STAGE,
    runId: options.runId,
    resumeWaiting: true,
    adoptRunIdOnResume: true,
  })
  if (!state.shouldEnqueue) {
    return {
      queued: false,
      canonicalRunId: state.row.canonical_run_id,
      status: state.row.status,
    }
  }
  await logSchedulerResult(env.KV, 'evening-chain', {
    status: 'running',
    summary: options.summary ??
      `event-driven chain queued post-screener continuation for ${options.triggerTime}; run_id=${options.runId}; source=${options.source}`,
    duration_ms: 0,
    run_date: options.triggerTime,
    run_id: state.row.canonical_run_id,
  })
  try {
    await env.UPDATE_QUEUE.send({
      type: 'post_screener_pipeline',
      cursor: 0,
      triggerTime: options.triggerTime,
      runId: state.row.canonical_run_id,
      shardCount,
      attempt: 1,
    })
  } catch (error) {
    await markPipelineStageFenced(env.DB, {
      businessDate: options.triggerTime,
      stage: POST_SCREENER_CONTINUATION_STAGE,
      canonicalRunId: state.row.canonical_run_id,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
  await env.KV.put(
    `cron:indicator-queue:${options.triggerTime}:${state.row.canonical_run_id}:post-screener-enqueued`,
    new Date().toISOString(),
    { expirationTtl: 7 * 86400 },
  ).catch((e) => console.warn('[Queue] Post-screener enqueue marker write failed:', e))
  return { queued: true, canonicalRunId: state.row.canonical_run_id, status: 'queued' }
}
