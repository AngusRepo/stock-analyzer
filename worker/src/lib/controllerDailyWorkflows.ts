import type { Bindings } from '../types'
import { controllerFetch, controllerJson } from './controllerClient'

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
  return res.ok ? await res.json() : `HTTP ${res.status}`
}

export async function runRegimeCompute(env: Bindings, runDate?: string) {
  requireController(env)

  const prevLabel = await env.KV.get('ml:regime')
  const res = await controllerFetch(env, '/regime/compute', {
    method: 'POST',
    jsonBody: { force_retrain: false, history_days: 180, run_date: runDate },
    timeoutMs: 180_000,
  })
  if (!res.ok) {
    throw new Error(`Controller /regime/compute HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }

  const data = await res.json() as any
  const newLabel = data.regime_label_en as string | null
  let shiftSummary = 'n/a'
  try {
    const { detectRegimeShift } = await import('./riskTriggers')
    shiftSummary = await detectRegimeShift(env, prevLabel, newLabel)
  } catch (e: any) {
    shiftSummary = `hook_error(${String(e?.message ?? e).slice(0, 30)})`
  }

  return `regime=${newLabel} idx=${data.regime_index} kv=${data.kv_push_ok ? 'ok' : 'fail'} shift=${shiftSummary}`
}

export async function runModelIcTrackerChain(env: Bindings) {
  requireController(env)

  const icData = await controllerJson<any>(env, '/model_pool/compute_weekly_ic', {
    method: 'POST',
    jsonBody: { lookback_days: 7, history_max: 26, min_samples: 50, update_pool: true, append_history: true },
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
      jsonBody: { apply: true, confirm: true },
      timeoutMs: 60_000,
    })
    if (promoRes.ok) {
      const promoteDecision = await promoRes.json() as any
      const transitions = (promoteDecision.actions || [])
        .filter((a: any) => a.transition !== 'promote_blocked')
        .map((a: any) => `${a.model}:${a.transition}`)
        .join(',') || 'none'
      stage4 = `applied=${promoteDecision.applied_count}/${promoteDecision.actions_count} [${transitions}]`
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
      lookback_days: 7,
      history_max: 26,
      min_samples: 50,
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

export async function runVerifyV2(env: Bindings, runDate?: string) {
  requireController(env)

  const data = await controllerJson<any>(env, '/verify/run', {
    method: 'POST',
    jsonBody: {
      lookback_days: 5,
      limit: 600,
      run_date: runDate || undefined,
      async_mode: true,
      callback_task: 'verify-v2',
    },
    timeoutMs: 30_000,
  })

  if (data?.status === 'triggered') {
    return `triggered run_id=${data.run_id} callback expected`
  }

  return `verified ${data.verified}/${data.pending} correct ${data.correct} pnl ${(data.total_pnl_pct * 100).toFixed(1)}% arf ${data.arf_updated}`
}
