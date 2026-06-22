import type { Bindings } from '../types'
import { listAdaptiveMetaPolicyReplayRows } from './adaptiveMetaPolicyReplayRunner'

export const LINUCB_MULTIPLIER_REPLAY_DEFAULT_LIMIT = 5000
export const LINUCB_MULTIPLIER_REPLAY_DEFAULT_MAX_GRID_EVALS = 32

export interface LinUcbMultiplierReplayOptions {
  startDate?: string
  endDate?: string
  limit?: number
  minDecisions?: number
  maxGridEvals?: number
  recentLossWindow?: number
  persist?: boolean
  timeoutMs?: number
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function todayTw(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
}

function daysAgoTw(days: number): string {
  return new Date(Date.now() + 8 * 3600_000 - days * 86_400_000).toISOString().slice(0, 10)
}

function replaySummary(report: Record<string, any>, sourceRows: number): string {
  const gates = Array.isArray(report.gates)
    ? report.gates.map((gate: any) => `${gate.name}:${gate.passed ? 'pass' : 'fail'}`).join(',')
    : 'gates=missing'
  const best = report.best_candidate && typeof report.best_candidate === 'object'
    ? `high=${report.best_candidate.bandit_loss_thresh_high ?? 'n/a'} med=${report.best_candidate.bandit_loss_thresh_med ?? 'n/a'} maxLow=${report.best_candidate.bandit_max_mult_low ?? 'n/a'}`
    : 'none'
  return [
    `linucb_multiplier_replay status=${report.status ?? 'unknown'}`,
    `allowed_use=${report.allowed_use ?? 'unknown'}`,
    `source_rows=${sourceRows}`,
    `prepared_rows=${report.prepared_rows ?? 0}`,
    `candidates=${report.candidate_count ?? 0}`,
    `best=${best}`,
    `gates=${gates}`,
  ].join(' ')
}

export async function runLinUcbMultiplierReplay(
  env: Pick<Bindings, 'DB' | 'KV' | 'ML_SERVICE_URL' | 'ML_SERVICE_SECRET'>,
  options: LinUcbMultiplierReplayOptions = {},
): Promise<Record<string, any>> {
  const mlUrl = env.ML_SERVICE_URL?.trim()?.replace(/\/+$/, '')
  if (!mlUrl) throw new Error('ML_SERVICE_URL not set; cannot run LinUCB multiplier replay')

  const startDate = options.startDate ?? daysAgoTw(90)
  const endDate = options.endDate ?? todayTw()
  const rows = await listAdaptiveMetaPolicyReplayRows(env.DB, {
    startDate,
    endDate,
    limit: options.limit ?? LINUCB_MULTIPLIER_REPLAY_DEFAULT_LIMIT,
  })

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (env.ML_SERVICE_SECRET) headers['X-Service-Token'] = env.ML_SERVICE_SECRET
  const response = await fetch(`${mlUrl}/meta-learning/linucb-multiplier-replay`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      rows,
      min_decisions: boundedInt(options.minDecisions, 30, 1, 10000),
      max_grid_evals: boundedInt(options.maxGridEvals, LINUCB_MULTIPLIER_REPLAY_DEFAULT_MAX_GRID_EVALS, 1, 500),
      recent_loss_window: boundedInt(options.recentLossWindow, 5, 1, 60),
    }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 300_000),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`ML service LinUCB multiplier replay HTTP ${response.status}: ${text.slice(0, 300)}`)
  }

  const report = await response.json() as Record<string, any>
  const evidence = {
    ...report,
    production_effect: false,
    mutation_allowed: false,
    real_trading_allowed: false,
    source_query: {
      start_date: startDate,
      end_date: endDate,
      source_rows: rows.length,
      source: 'predictions_active_9_verified_rows',
    },
  }
  const persist = options.persist === true
  if (persist) {
    await env.KV.put('meta:linucb_multiplier_replay:latest', JSON.stringify(evidence), { expirationTtl: 30 * 86400 })
    await env.KV.put(`meta:linucb_multiplier_replay:${endDate}`, JSON.stringify(evidence), { expirationTtl: 180 * 86400 })
  }
  return {
    ...evidence,
    mode: persist ? 'persisted_evidence' : 'dry_run',
    summary: replaySummary(report, rows.length),
  }
}
