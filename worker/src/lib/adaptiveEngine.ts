import { getAdaptiveParams, setAdaptiveParams } from './adaptiveConfig'
import { summarizeSellOrderLosses } from './paperOrderAccounting'
import { refreshLinUcbRewardLedger } from './metaLearningRewardLedger'
import { getTradingConfig } from './tradingConfig'

interface AdaptiveEngineEnv {
  DB: D1Database
  KV: KVNamespace
  ML_CONTROLLER_URL?: string
  ML_CONTROLLER_SECRET?: string
}

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
  let latest: Record<string, any> | null = null
  try {
    latest = objectValue(await kv.get('optimizer:ga:latest', 'json'))
  } catch (error: any) {
    return {
      source: 'optimizer:ga:latest',
      status: 'unavailable',
      runtime_role: 'ga_learning_context_unavailable',
      error: String(error?.message ?? error),
      applies_to_trading_config: false,
    }
  }

  if (!latest) {
    return {
      source: 'optimizer:ga:latest',
      status: 'missing',
      runtime_role: 'ga_learning_not_initialized',
      applies_to_trading_config: false,
    }
  }

  const promotion = objectValue(latest.promotion) ?? {}
  const best = objectValue(latest.best) ?? {}
  const metrics = objectValue(best.metrics) ?? {}
  const gate = objectValue(best.gate) ?? {}
  const candidate = objectValue(best.candidate) ?? {}
  const candidateParams = objectValue(candidate.params) ?? {}
  const learnedAlphaFramework = objectValue(latest.best_alphaFramework)
    ?? objectValue(latest.bestAlphaFramework)
    ?? objectValue(candidateParams.alphaFramework)
  const level = stringOrNull(promotion.level) ?? 'L0'
  const promotionStatus = stringOrNull(promotion.status) ?? stringOrNull(latest.status) ?? 'learning'
  const approvedLevel = stringOrNull(promotion.approved_level)
  const runtimeRole =
    promotionStatus === 'approved' && level === 'L4'
      ? 'approved_full_production_meta_policy_context'
      : promotionStatus === 'approved' && level === 'L3'
        ? 'approved_limited_production_meta_policy_context'
        : promotion.approvalRequiredForNextLevel === true || promotion.canRequestNextLevel === true
          ? 'promotion_review_candidate_context'
          : 'shadow_learning_context'
  const approvedProductionContext = promotionStatus === 'approved' && (level === 'L3' || level === 'L4')
  const effectPolicy = {
    enabled: approvedProductionContext,
    scope: level === 'L4' && promotionStatus === 'approved'
      ? 'full_production_meta_policy_ready_requires_explicit_release'
      : level === 'L3' && promotionStatus === 'approved'
        ? 'limited_capped_meta_policy_context'
        : 'shadow_or_review_context_only',
    max_bandit_max_mult: level === 'L3' && promotionStatus === 'approved' ? 1.25 : null,
    mutates_trading_config: false,
    requires_wei_approval: !(promotionStatus === 'approved' && (level === 'L3' || level === 'L4')),
  }

  return {
    source: 'optimizer:ga:latest',
    optimizer: stringOrNull(latest.optimizer) ?? 'GAOptimizer',
    status: promotionStatus,
    runtime_role: runtimeRole,
    applies_to_trading_config: false,
    requires_trading_config_review: true,
    promotion: {
      level,
      approved_level: approvedLevel,
      requested_level: stringOrNull(promotion.requested_level),
      next_level: stringOrNull(promotion.nextLevel),
      pending_approval_level: stringOrNull(promotion.pendingApprovalLevel),
      approval_required_for_next_level: promotion.approvalRequiredForNextLevel === true,
      can_request_next_level: promotion.canRequestNextLevel === true,
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

async function queryAdaptiveInputs(env: { DB: D1Database }) {
  const riskRow = await env.DB.prepare(
    'SELECT risk_score, risk_level FROM market_risk ORDER BY date DESC LIMIT 1',
  ).first<{ risk_score: number; risk_level: string }>()

  const active8Placeholders = ACTIVE_8_MODELS.map(() => '?').join(', ')
  const accGlobal = await env.DB.prepare(`
    SELECT CAST(SUM(correct_count) AS REAL) / NULLIF(SUM(total_count), 0) AS avg_acc,
           SUM(total_count) AS sample_count,
           COUNT(DISTINCT model_name) AS model_count
    FROM model_accuracy
    WHERE period='30d' AND total_count >= 3
      AND model_name IN (${active8Placeholders})
  `).bind(...ACTIVE_8_MODELS).first<{ avg_acc: number | null; sample_count: number | null; model_count: number | null }>()

  const { results: rows30d } = await env.DB.prepare(`
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

  const { results: rows90d } = await env.DB.prepare(`
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
  const { results: recentSellRows } = await env.DB.prepare(`
    SELECT price, shares, commission, tax, note
    FROM paper_orders
    WHERE side='sell' AND created_at >= ?
  `).bind(fiveDaysAgo).all<any>().catch(() => ({ results: [] as any[] }))
  const recentOrders = summarizeSellOrderLosses(recentSellRows ?? [])

  return {
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
    const report = await refreshLinUcbRewardLedger(env.DB, {
      startDate: dateDaysAgo(90),
      endDate,
      limit: 5000,
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

  const inputs = await queryAdaptiveInputs(env)
  const current = await getAdaptiveParams(env.KV)
  const tradingConfig = await getTradingConfig(env.KV)
  const gaOptimizerContext = await loadGaOptimizerAdaptiveContext(env.KV)
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (env.ML_CONTROLLER_SECRET) headers['X-Controller-Token'] = env.ML_CONTROLLER_SECRET

  const res = await fetch(`${env.ML_CONTROLLER_URL}/risk-assess`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      date: today,
      market: { risk_score: inputs.riskScore, risk_level: inputs.riskLevel },
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
