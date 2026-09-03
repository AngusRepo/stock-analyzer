import { getAdaptiveParams, setAdaptiveParams } from './adaptiveConfig'
import { summarizeSellOrderLosses } from './paperOrderAccounting'
import {
  listLinUcbRewardSourceRowsAcrossDomains,
  refreshLinUcbRewardLedger,
} from './metaLearningRewardLedger'
import { getTradingConfig } from './tradingConfig'
import { databaseForDataDomain } from './dataDomainRegistry'
import { paperDomainDatabase } from './paperDomainDatabase'
import {
  GA_CANDIDATE_LATEST_KEY,
  GA_CHAMPION_KEY,
  GA_LEGACY_LATEST_KEY,
  evaluateGaPromotion,
  isApprovedGaRelease,
} from './gaPromotion'
import { readLatestMarketRegimeStateOnOrBefore } from './marketRegimeState'
import type { Bindings } from '../types'

type AdaptiveEngineEnv = Pick<Bindings, 'DB' | 'KV'> & Partial<Bindings>

const ACTIVE_8_MODELS = [
  'LightGBM',
  'XGBoost',
  'ExtraTrees',
  'TabM',
  'GNN',
  'DLinear',
  'PatchTST',
  'iTransformer',
] as const

function objectValue(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : null
}

function finiteNumberOrNull(value: unknown): number | null {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

function stringOrNull(value: unknown): string | null {
  const text = String(value ?? '').trim()
  return text ? text : null
}

function stringList(value: unknown, limit = 12): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item ?? '').trim()).filter(Boolean).slice(0, limit)
    : []
}

async function loadGaOptimizerAdaptiveContext(kv: KVNamespace): Promise<Record<string, unknown>> {
  let candidate: Record<string, any> | null = null
  let champion: Record<string, any> | null = null
  let legacy: Record<string, any> | null = null
  try {
    const [candidateRaw, championRaw, legacyRaw] = await Promise.all([
      kv.get(GA_CANDIDATE_LATEST_KEY, 'json'),
      kv.get(GA_CHAMPION_KEY, 'json'),
      kv.get(GA_LEGACY_LATEST_KEY, 'json'),
    ])
    candidate = objectValue(candidateRaw)
    champion = objectValue(championRaw)
    legacy = objectValue(legacyRaw)
  } catch (error: any) {
    return {
      source: GA_CHAMPION_KEY,
      status: 'unavailable',
      runtime_role: 'ga_champion_context_unavailable',
      error: String(error?.message ?? error),
      applies_to_trading_config: false,
    }
  }

  const legacyChampion = isApprovedGaRelease(legacy) ? legacy : null
  const latest = champion ?? legacyChampion ?? candidate
  const runtimeSource = champion
    ? GA_CHAMPION_KEY
    : legacyChampion
      ? GA_LEGACY_LATEST_KEY
      : GA_CANDIDATE_LATEST_KEY
  if (!latest) {
    return {
      source: GA_CHAMPION_KEY,
      status: 'missing',
      runtime_role: 'ga_learning_not_initialized',
      applies_to_trading_config: false,
    }
  }

  const promotion = objectValue(latest.promotion) ?? {}
  const evaluatedPromotion = evaluateGaPromotion(latest)
  const best = objectValue(latest.best) ?? {}
  const metrics = objectValue(best.metrics) ?? {}
  const gate = objectValue(best.gate) ?? {}
  const bestCandidate = objectValue(best.candidate) ?? {}
  const candidateParams = objectValue(bestCandidate.params) ?? {}
  const learnedAlphaFramework = objectValue(latest.best_alphaFramework)
    ?? objectValue(latest.bestAlphaFramework)
    ?? objectValue(candidateParams.alphaFramework)
  const level = evaluatedPromotion.level
  const promotionStatus = evaluatedPromotion.status
  const approvedLevel = promotionStatus === 'approved' ? stringOrNull(promotion.approved_level) : null
  const runtimeRole =
    promotionStatus === 'approved' && level === 'L4'
      ? 'approved_full_production_meta_policy_context'
      : promotionStatus === 'approved' && level === 'L3'
        ? 'approved_limited_production_meta_policy_context'
        : evaluatedPromotion.approvalRequiredForNextLevel || evaluatedPromotion.canRequestNextLevel
          ? 'promotion_review_candidate_context'
          : 'shadow_learning_context'
  const approvedProductionContext =
    runtimeSource !== GA_CANDIDATE_LATEST_KEY &&
    isApprovedGaRelease(latest)
  const effectPolicy = {
    enabled: approvedProductionContext,
    scope: level === 'L4' && promotionStatus === 'approved'
      ? 'full_production_meta_policy_ready_requires_explicit_release'
      : level === 'L3' && promotionStatus === 'approved'
        ? 'limited_capped_meta_policy_context'
        : 'shadow_or_review_context_only',
    max_bandit_max_mult: level === 'L3' && promotionStatus === 'approved' ? 1.25 : null,
    mutates_trading_config: false,
    requires_wei_approval: evaluatedPromotion.approvalRequiredForNextLevel,
  }
  const candidatePromotion = candidate ? evaluateGaPromotion(candidate) : null

  return {
    source: runtimeSource,
    optimizer: stringOrNull(latest.optimizer) ?? 'GAOptimizer',
    status: promotionStatus,
    runtime_role: runtimeRole,
    applies_to_trading_config: false,
    requires_trading_config_review: true,
    candidate_latest: candidate ? {
      key: GA_CANDIDATE_LATEST_KEY,
      status: candidatePromotion?.status ?? candidate.status ?? 'learning',
      level: candidatePromotion?.level ?? 'L0',
      updated_at: stringOrNull(candidate.updated_at),
      validation: objectValue(candidate.validation),
    } : null,
    champion_release: {
      key: runtimeSource,
      available: approvedProductionContext,
      level: approvedProductionContext ? level : null,
      released_at: stringOrNull(objectValue(latest.release)?.released_at),
    },
    promotion: {
      level,
      approved_level: approvedLevel,
      requested_level: stringOrNull(promotion.requested_level),
      next_level: evaluatedPromotion.nextLevel,
      pending_approval_level: evaluatedPromotion.pendingApprovalLevel,
      approval_required_for_next_level: evaluatedPromotion.approvalRequiredForNextLevel,
      can_request_next_level: evaluatedPromotion.canRequestNextLevel,
      evaluated_at: stringOrNull(promotion.evaluated_at),
    },
    best: {
      score: finiteNumberOrNull(best.score),
      sharpe: finiteNumberOrNull(metrics.sharpe),
      pbo: finiteNumberOrNull(metrics.pbo),
      mdd_95th: finiteNumberOrNull(metrics.mdd_95th),
      trade_count: finiteNumberOrNull(metrics.trade_count),
      gate_passed: gate.passed === true,
      gate_decision: stringOrNull(gate.decision),
      failed_gates: stringList(gate.failed_gates),
    },
    learned_alpha_framework: {
      available: learnedAlphaFramework != null,
      top_level_sections: learnedAlphaFramework ? Object.keys(learnedAlphaFramework).sort() : [],
    },
    effect_policy: effectPolicy,
    updated_at: stringOrNull(latest.updated_at),
  }
}

async function queryAdaptiveInputs(env: AdaptiveEngineEnv, asOfDate: string) {
  const regimeState = await readLatestMarketRegimeStateOnOrBefore(
    databaseForDataDomain(env, 'market'),
    asOfDate,
  )
  if (!regimeState?.run_date || regimeState.source !== 'hmm') {
    throw new Error(
      'adaptive_regime_evidence_missing:' + asOfDate + ':' + (regimeState?.source ?? 'not_materialized'),
    )
  }

  const riskRow = await databaseForDataDomain(env, 'core').prepare(
    'SELECT risk_score, risk_level FROM market_risk ORDER BY date DESC LIMIT 1',
  ).first<{ risk_score: number; risk_level: string }>()

  const active8Placeholders = ACTIVE_8_MODELS.map(() => '?').join(', ')
  const accGlobal = await databaseForDataDomain(env, 'learning').prepare(`
    SELECT CAST(SUM(correct_count) AS REAL) / NULLIF(SUM(total_count), 0) AS avg_acc,
           SUM(total_count) AS sample_count,
           COUNT(DISTINCT model_name) AS model_count
    FROM model_accuracy
    WHERE period='30d' AND total_count >= 3
      AND model_name IN (${active8Placeholders})
  `).bind(...ACTIVE_8_MODELS).first<{ avg_acc: number | null; sample_count: number | null; model_count: number | null }>()

  const { results: rows30d } = await databaseForDataDomain(env, 'learning').prepare(`
    SELECT model_name,
           SUM(total_count) AS total_count,
           CAST(SUM(correct_count) AS REAL) / NULLIF(SUM(total_count), 0) AS accuracy,
           CASE WHEN SUM(total_count) > 0 AND SUM(CASE WHEN profit_factor IS NOT NULL THEN total_count ELSE 0 END) > 0
                THEN SUM(COALESCE(profit_factor, 0) * total_count) / SUM(CASE WHEN profit_factor IS NOT NULL THEN total_count ELSE 0 END)
                ELSE NULL END AS profit_factor
    FROM model_accuracy
    WHERE period='30d'
      AND model_name IN (${active8Placeholders})
    GROUP BY model_name
  `).bind(...ACTIVE_8_MODELS).all<any>().catch(() => ({ results: [] as any[] }))

  const { results: rows90d } = await databaseForDataDomain(env, 'learning').prepare(`
    SELECT model_name,
           SUM(total_count) AS total_count,
           CAST(SUM(correct_count) AS REAL) / NULLIF(SUM(total_count), 0) AS accuracy,
           CASE WHEN SUM(CASE WHEN profit_factor IS NOT NULL THEN total_count ELSE 0 END) > 0
                THEN SUM(COALESCE(profit_factor, 0) * total_count) / SUM(CASE WHEN profit_factor IS NOT NULL THEN total_count ELSE 0 END)
                ELSE NULL END AS profit_factor
    FROM model_accuracy
    WHERE period='90d'
      AND model_name IN (${active8Placeholders})
    GROUP BY model_name
  `).bind(...ACTIVE_8_MODELS).all<any>().catch(() => ({ results: [] as any[] }))

  const fiveDaysAgo = new Date(Date.now() + 8 * 3600_000 - 5 * 86_400_000).toISOString().slice(0, 10)
  const { results: recentSellRows } = await paperDomainDatabase(env).prepare(`
    SELECT price, shares, commission, tax, note
    FROM paper_orders
    WHERE side='sell' AND created_at >= ?
  `).bind(fiveDaysAgo).all<any>().catch(() => ({ results: [] as any[] }))
  const recentOrders = summarizeSellOrderLosses(recentSellRows ?? [])

  return {
    regime: regimeState.family,
    regimeAsOfDate: regimeState.run_date,
    regimeSource: regimeState.source,
    riskScore: riskRow?.risk_score ?? 50,
    riskLevel: riskRow?.risk_level ?? 'medium',
    accuracy30d: accGlobal?.avg_acc ?? 0.6,
    active8Samples30d: accGlobal?.sample_count ?? 0,
    active8ModelCount30d: accGlobal?.model_count ?? 0,
    rows30d: rows30d ?? [],
    rows90d: rows90d ?? [],
    losses5d: recentOrders.losses,
    total5d: recentOrders.total,
  }
}

function dateDaysAgo(days: number): string {
  return new Date(Date.now() + 8 * 3600_000 - days * 86_400_000).toISOString().slice(0, 10)
}

export async function refreshLinUcbLedgerForAdaptive(env: AdaptiveEngineEnv, endDate: string): Promise<Record<string, unknown>> {
  try {
    const predictionDb = databaseForDataDomain(env, 'learning')
    const sourceOptions = {
      startDate: dateDaysAgo(90),
      endDate,
      limit: 5000,
    }
    const sourceRows = await listLinUcbRewardSourceRowsAcrossDomains(
      predictionDb,
      databaseForDataDomain(env, 'core'),
      sourceOptions,
    )
    const report = await refreshLinUcbRewardLedger(predictionDb, {
      ...sourceOptions,
      sourceRows,
      dryRun: false,
    })
    const totalSamples = report.ledger_rows.reduce((sum, row) => sum + row.samples, 0)
    const armCount = new Set(report.ledger_rows.map((row) => row.arm_id)).size
    return {
      reward_ledger: 'meta_reward_ledger',
      reward_ledger_status: 'updated',
      source_rows: report.source_rows,
      ledger_rows: report.persisted_rows ?? report.ledger_rows.length,
      total_samples: totalSamples,
      arm_count: armCount,
      context_version: 'meta-context-v2',
    }
  } catch (error: any) {
    return {
      reward_ledger: 'meta_reward_ledger',
      reward_ledger_status: 'degraded',
      error: error?.message ?? String(error),
      context_version: 'meta-context-v2',
    }
  }
}

export async function runLinUcbRewardLedgerRefresh(env: AdaptiveEngineEnv, endDate?: string): Promise<string> {
  const targetDate = endDate ?? new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const ledger = await refreshLinUcbLedgerForAdaptive(env, targetDate)
  const status = String(ledger.reward_ledger_status ?? 'unknown')
  const sourceRows = Number(ledger.source_rows ?? 0)
  const ledgerRows = Number(ledger.ledger_rows ?? 0)
  const totalSamples = Number(ledger.total_samples ?? 0)
  if (status === 'degraded') {
    throw new Error(`LinUCB reward ledger degraded: ${String(ledger.error ?? 'unknown')}`)
  }
  if (sourceRows > 0 && ledgerRows <= 0) {
    throw new Error(`LinUCB reward ledger empty despite source_rows=${sourceRows}`)
  }
  return `linucb reward ledger ${status}: source_rows=${sourceRows} ledger_rows=${ledgerRows} total_samples=${totalSamples}`
}

export async function runAdaptiveUpdate(env: AdaptiveEngineEnv, options: { refreshLedger?: boolean } = {}): Promise<string> {
  if (!env.ML_CONTROLLER_URL) {
    throw new Error('ML_CONTROLLER_URL is required for adaptive update; Worker local adaptive computation is disabled')
  }

  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const inputs = await queryAdaptiveInputs(env, today)
  const current = await getAdaptiveParams(env.KV)
  const tradingConfig = await getTradingConfig(env.KV)
  const gaOptimizerContext = await loadGaOptimizerAdaptiveContext(env.KV)
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (env.ML_CONTROLLER_SECRET) headers['X-Controller-Token'] = env.ML_CONTROLLER_SECRET

  const res = await fetch(`${env.ML_CONTROLLER_URL}/risk-assess`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      date: today,
      market: {
        risk_score: inputs.riskScore,
        risk_level: inputs.riskLevel,
        regime: inputs.regime,
        regime_as_of_date: inputs.regimeAsOfDate,
        regime_source: inputs.regimeSource,
      },
      accuracy: {
        global_30d: inputs.accuracy30d,
        active_9_quality_30d: inputs.accuracy30d,
        active_9_samples_30d: inputs.active8Samples30d,
        active_9_model_count_30d: inputs.active8ModelCount30d,
        rows_30d: inputs.rows30d,
        rows_90d: inputs.rows90d,
      },
      trading: { losses_5d: inputs.losses5d, total_5d: inputs.total5d },
      adaptive_config: {
        L2_formula: tradingConfig.L2_formula,
        baseline_buy_signal_score: tradingConfig.signal?.buySignalScore,
        ga_optimizer: gaOptimizerContext,
      },
      current_version: current.version ?? 0,
    }),
    signal: AbortSignal.timeout(30_000),
  })

  if (!res.ok) throw new Error(`Controller /risk-assess HTTP ${res.status}`)
  const data = await res.json() as any
  const params = data.adaptive_params
  if (!params || typeof params !== 'object') {
    throw new Error('Controller /risk-assess returned invalid adaptive_params')
  }

  const ledgerContext = options.refreshLedger === false
    ? { reward_ledger: 'meta_reward_ledger', reward_ledger_status: 'handled_by_post_verify_chain', context_version: 'meta-context-v2' }
    : await refreshLinUcbLedgerForAdaptive(env, today)
  // The Meta controller is the sole owner of model_allocator. Risk-assess owns
  // the remaining daily adaptive fields and must not erase a live Meta canary.
  if (current.model_allocator && typeof current.model_allocator === 'object') {
    params.model_allocator = current.model_allocator
  }
  const currentBanditContext = params.bandit_context && typeof params.bandit_context === 'object' && !Array.isArray(params.bandit_context)
    ? params.bandit_context
    : {}
  params.bandit_context = {
    ...currentBanditContext,
    expanded_context: {
      version: 'meta-context-v2',
      features: [
        'model_ic',
        'coverage',
        'prediction_dispersion',
        'data_quality',
        'market_breadth',
        'sector_heat',
        'liquidity',
        'fill_quality',
        'regime',
        'volatility',
        'market_risk',
        'bias',
      ],
    },
    linucb_reward_ledger: ledgerContext,
    ga_optimizer: gaOptimizerContext,
  }

  const summary = data.summary ?? 'Controller OK'
  await setAdaptiveParams(env.KV, params, { source: 'ml-controller', fallback: false })
  console.log(`[AdaptiveEngine] Controller: ${summary}`)
  return summary
}
