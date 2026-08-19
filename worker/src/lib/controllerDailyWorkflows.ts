import type { Bindings } from '../types'
import { controllerFetch, controllerJson } from './controllerClient'
import { readCurrentLegacyRegimeLabel, readMarketRegimeState } from './marketRegimeState'
import { recordPaperActivePostmarketReport } from './paperActiveChallenger'

function requireController(env: Bindings): void {
  if (!env.ML_CONTROLLER_URL) {
    throw new Error('ML_CONTROLLER_URL not set')
  }
}

export async function runObsidianDaily(env: Bindings, date: string) {
  requireController(env)

  const res = await controllerFetch(env, '/obsidian/daily', {
    method: 'POST',
    jsonBody: { date },
    timeoutMs: 60_000,
  })
  if (!res.ok) {
    throw new Error(`Controller /obsidian/daily HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }
  return await res.json()
}

const REGIME_SURFACE_LABELS = ['bull_market', 'volatile', 'sideways', 'bear_market'] as const
const REGIME_KV_READBACK_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000, 12_000, 15_000, 15_000] as const

export function assertRegimeComputeClosure(data: any, runDate?: string): void {
  if (data?.kv_push_ok !== true) {
    throw new Error('Controller /regime/compute did not persist market_regime_state')
  }
  if (runDate && data?.run_date !== runDate) {
    throw new Error(`Regime run_date mismatch: expected=${runDate} actual=${String(data?.run_date ?? 'missing')}`)
  }
  const surface = data?.regime_surface
  if (!surface || typeof surface !== 'object') {
    throw new Error('Regime posterior surface missing')
  }
  const keys = Object.keys(surface).sort()
  const expectedKeys = [...REGIME_SURFACE_LABELS].sort()
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error(`Regime posterior keys invalid: ${keys.join(',')}`)
  }
  const total = REGIME_SURFACE_LABELS.reduce((sum, label) => {
    const probability = Number(surface[label])
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new Error(`Regime posterior probability invalid: ${label}=${String(surface[label])}`)
    }
    return sum + probability
  }, 0)
  if (Math.abs(total - 1) > 0.001) {
    throw new Error(`Regime posterior total invalid: ${total}`)
  }
}

export async function runRegimeCompute(env: Bindings, runDate?: string) {
  requireController(env)

  const prevLabel = await readCurrentLegacyRegimeLabel(env.KV)
  const res = await controllerFetch(env, '/regime/compute', {
    method: 'POST',
    jsonBody: { force_retrain: false, history_days: 180, run_date: runDate },
    timeoutMs: 180_000,
  })
  if (!res.ok) {
    throw new Error(`Controller /regime/compute HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }

  const data = await res.json() as any
  assertRegimeComputeClosure(data, runDate)
  const expectedRunDate = runDate ?? String(data.run_date ?? '')
  let persisted = null
  for (let attempt = 0; attempt <= REGIME_KV_READBACK_DELAYS_MS.length; attempt += 1) {
    persisted = await readMarketRegimeState(env.KV)
    if (
      persisted?.run_date === expectedRunDate &&
      Object.keys(persisted.regime_surface).length === REGIME_SURFACE_LABELS.length
    ) {
      break
    }
    const delayMs = REGIME_KV_READBACK_DELAYS_MS[attempt]
    if (delayMs != null) await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  if (persisted?.run_date !== expectedRunDate) {
    throw new Error(
      `market_regime_state readback mismatch: expected=${expectedRunDate} actual=${persisted?.run_date ?? 'missing'}`,
    )
  }
  assertRegimeComputeClosure({
    kv_push_ok: true,
    run_date: persisted.run_date,
    regime_surface: persisted.regime_surface,
  }, expectedRunDate)

  const newLabel = persisted.label
  let shiftSummary = 'n/a'
  try {
    const { detectRegimeShift } = await import('./riskTriggers')
    shiftSummary = await detectRegimeShift(env, prevLabel, newLabel)
  } catch (e: any) {
    shiftSummary = `hook_error(${String(e?.message ?? e).slice(0, 30)})`
  }

  return `regime=${newLabel} idx=${persisted.regime_index} kv=verified shift=${shiftSummary}`
}
export async function runModelIcFullCheck(env: Bindings) {
  requireController(env)

  const icData = await controllerJson<any>(env, '/model_pool/compute_weekly_ic', {
    method: 'POST',
    jsonBody: {
      lookback_days: 35,
      history_max: 26,
      min_samples: 50,
      min_dates: 10,
      update_pool: true,
      append_history: true,
    },
    timeoutMs: 120_000,
  })

  const computed = Object.entries(icData.per_model_ic || {})
    .filter(([_, v]: any) => v.status === 'computed')
    .map(([k, v]: any) => `${k}:${v.ic?.toFixed(3)}`)
    .join(' ')

  let stage4 = '(skip)'
  try {
    const promoRes = await controllerFetch(env, '/model_pool/promote_check', {
      method: 'POST',
      jsonBody: { apply: false, confirm: false },
      timeoutMs: 60_000,
    })
    if (promoRes.ok) {
      const promoteDecision = await promoRes.json() as any
      const transitions = (promoteDecision.actions || [])
        .filter((a: any) => a.transition !== 'promote_blocked')
        .map((a: any) => `${a.model}:${a.transition}`)
        .join(',') || 'none'
      stage4 = `dry_run=${promoteDecision.actions_count} [${transitions}]`
    } else {
      stage4 = `chain failed HTTP ${promoRes.status}`
    }
  } catch (e: any) {
    stage4 = `chain exception ${e?.message || e}`
  }

  let configEval = '(skip)'
  try {
    const ceRes = await controllerFetch(env, '/config_pool/weekly_eval', {
      method: 'POST',
      jsonBody: { lookback_days: 90, apply: true },
      timeoutMs: 300_000,
    })
    if (ceRes.ok) {
      const cd = await ceRes.json() as any
      if (cd.status === 'no_challenger') {
        configEval = 'no_challenger'
      } else {
        const sd = cd.sharpe_delta?.toFixed?.(3) ?? cd.sharpe_delta
        configEval = `${cd.action}(wins=${cd.consecutive_wins} losses=${cd.consecutive_losses} sharpe=${sd})`
      }
    } else {
      configEval = `HTTP ${ceRes.status}`
    }
  } catch (e: any) {
    configEval = `exception ${e?.message?.slice(0, 40) ?? 'unknown'}`
  }

  return `IC n_rows=${icData.n_rows_total} | ${computed} || Stage4 ${stage4} || ConfigEval ${configEval}`
}

export async function runModelIcRollingRefresh(env: Bindings, runDate?: string) {
  requireController(env)

  const icData = await controllerJson<any>(env, '/model_pool/compute_weekly_ic', {
    method: 'POST',
    jsonBody: {
      lookback_days: 35,
      history_max: 26,
      min_samples: 50,
      min_dates: 10,
      update_pool: true,
      append_history: false,
      run_date: runDate || undefined,
    },
    timeoutMs: 120_000,
  })

  const computed = Object.entries(icData.per_model_ic || {})
    .filter(([_, v]: any) => v.status === 'computed')
    .map(([k, v]: any) => `${k}:${v.ic?.toFixed(3)}(${v.n_samples})`)
    .join(' ') || 'none'

  return `rolling_ic run_date=${runDate ?? 'latest'} n_rows=${icData.n_rows_total} | ${computed}`
}

export async function runArtifactAutoPromotion(env: Bindings) {
  requireController(env)
  const result = await controllerJson<any>(env, '/model_pool/artifact_registry/auto_promote', {
    method: 'POST',
    jsonBody: {
      confirm: true,
      max_candidates: 16,
      reason: 'scheduled_post_verify_evidence_based_auto_promotion',
    },
    timeoutMs: 120_000,
  })
  return `artifact auto-promotion eligible=${result.eligible ?? 0} promoted=${result.promoted ?? 0} readback=${result.readback_verified === true ? 'verified' : 'failed'}`
}

export async function runVerifyV2(env: Bindings, runDate?: string, idempotencyKey?: string) {
  requireController(env)

  let data: any
  try {
    data = await controllerJson<any>(env, '/verify/run', {
      method: 'POST',
      jsonBody: {
        lookback_days: 5,
        limit: 600, // page size; controller cursor-pagination drains the mature workset
        run_date: runDate || undefined,
        idempotency_key: idempotencyKey || undefined,
        async_mode: true,
        callback_task: 'verify-v2',
      },
      timeoutMs: 30_000,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('verify-v2 already has an active execution')) {
      throw new Error(
        `verify_v2_active_execution_conflict:${runDate ?? 'current-date'}:retry_required`,
      )
    }
    throw error
  }

  if (data?.status === 'triggered') {
    return `triggered run_id=${data.run_id} callback expected`
  }

  return `verified ${data.verified}/${data.pending} correct ${data.correct} pnl ${(data.total_pnl_pct * 100).toFixed(1)}% arf ${data.arf_updated}`
}

export async function runPaperActivePostmarketPromotion(env: Bindings, runDate?: string): Promise<string> {
  requireController(env)

  const res = await controllerFetch(env, '/paper_challenger/postmarket_report', {
    method: 'POST',
    jsonBody: { run_date: runDate || undefined },
    timeoutMs: 60_000,
  })
  if (res.status === 404) {
    return 'SKIP: paper-active postmarket controller route unavailable'
  }
  if (!res.ok) {
    throw new Error(`Controller /paper_challenger/postmarket_report HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }

  const report = await res.json() as Record<string, unknown>
  const persisted = await recordPaperActivePostmarketReport(env, report)
  return [
    `paper-active-postmarket run_date=${runDate ?? 'latest'}`,
    `candidate_count=${Number(report.candidate_count ?? 0)}`,
    `evaluated=${Number(report.evaluated_count ?? 0)}`,
    `persisted candidates=${persisted.candidates} metrics=${persisted.dailyMetrics} audits=${persisted.auditEvents}`,
  ].join(' ')
}
