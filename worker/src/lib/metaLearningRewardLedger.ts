import {
  buildExpandedMetaLearningContext,
  hashExpandedMetaLearningContext,
} from './metaLearningContext'

export interface LinUcbRewardSourceRow {
  date?: string | null
  stock_id?: string | null
  model_name?: string | null
  market_segment?: string | null
  recommendation_lane?: string | null
  has_buy_signal?: number | boolean | null
  trade_pnl_pct?: number | string | null
  actual_return_pct?: number | string | null
  score_components?: string | null
  ml_vote_summary?: string | null
  alpha_context?: string | null
  alpha_allocation?: string | null
  model_ic?: number | string | null
  coverage?: number | string | null
  prediction_dispersion?: number | string | null
  data_quality?: number | string | null
  market_breadth?: number | string | null
  sector_heat?: number | string | null
  liquidity?: number | string | null
  fill_quality?: number | string | null
  regime?: string | number | null
  volatility?: number | string | null
  market_risk?: number | string | null
}

export interface LinUcbRewardLedgerRow {
  policy_id: 'LinUCB'
  arm_id: string
  context_hash: string
  samples: number
  reward_sum: number
  reward_mean: number
  last_reward_at: string | null
  updated_at: string
  evidence_json: string
}

export interface LinUcbRewardRefreshOptions {
  startDate?: string
  endDate?: string
  limit?: number
  nowIso?: string
}

export interface LinUcbRewardRefreshReport {
  success: boolean
  mode: 'dry_run' | 'persisted'
  source_rows: number
  ledger_rows: LinUcbRewardLedgerRow[]
  persisted_rows?: number
}

export interface NeuralMetaBanditTrainingPayload {
  policy_id: 'NeuralUCB' | 'NeuralTS'
  contexts: number[][]
  arms: number[]
  rewards: number[]
  arm_names: string[]
  business_date: string
  symbols: string[]
  baseline_actions: string[]
}

type Bucket = {
  armId: string
  contextHash: string
  contextHashes: Set<string>
  rewards: number[]
  dates: string[]
  stockIds: string[]
  missingContext: Set<string>
}

function toFiniteNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function normalizeMetaReward(value: unknown): number | null {
  const n = toFiniteNumber(value)
  if (n == null) return null
  return clamp(n / 100, -0.2, 0.2)
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'string') return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function nestedValue(record: Record<string, unknown>, path: string): unknown {
  let current: unknown = record
  for (const part of path.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function firstPresent(...values: unknown[]): unknown {
  return values.find((value) => value != null && value !== '')
}

function normalizedToken(value: unknown, fallback: string): string {
  const raw = String(value ?? '').trim()
  if (!raw) return fallback
  return raw.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase() || fallback
}

function normalizedMarketSegment(value: unknown): string {
  const token = normalizedToken(value, 'unknown')
  if (token === 'twse') return 'TWSE'
  if (token === 'otc') return 'OTC'
  if (token === 'emerging') return 'EMERGING'
  return token
}

function pickAlphaBucket(row: LinUcbRewardSourceRow): string {
  const score = parseJsonRecord(row.score_components)
  const context = parseJsonRecord(row.alpha_context)
  const allocation = parseJsonRecord(row.alpha_allocation)
  return normalizedToken(
    score.alpha_bucket ?? score.bucket ?? context.bucket ?? context.alpha_bucket ?? allocation.bucket ?? allocation.alpha_bucket,
    'unknown',
  )
}

function rewardForRow(row: LinUcbRewardSourceRow): number | null {
  const tradeReward = normalizeMetaReward(row.trade_pnl_pct)
  if (tradeReward != null) return tradeReward
  return normalizeMetaReward(row.actual_return_pct)
}

function armIdsForRow(row: LinUcbRewardSourceRow): string[] {
  const segment = normalizedMarketSegment(row.market_segment)
  const lane = normalizedToken(row.recommendation_lane, 'unknown')
  const signal = row.has_buy_signal === true || row.has_buy_signal === 1 ? 'buy' : 'non_buy'
  const alphaBucket = pickAlphaBucket(row)
  return [
    `market_segment:${segment}`,
    `lane:${lane}`,
    `signal:${signal}`,
    `alpha_bucket:${alphaBucket}`,
  ]
}

function modelFamilyArm(modelName: unknown): string {
  const name = String(modelName ?? '').toLowerCase()
  if (['xgboost', 'catboost', 'extratrees', 'lightgbm'].some((part) => name.includes(part))) {
    return 'feature_family'
  }
  if (['dlinear', 'patchtst'].some((part) => name.includes(part))) {
    return 'time_series_family'
  }
  return 'do_nothing'
}

function expandedContextForSourceRow(row: LinUcbRewardSourceRow) {
  const score = parseJsonRecord(row.score_components)
  const vote = parseJsonRecord(row.ml_vote_summary)
  const contextJson = parseJsonRecord(row.alpha_context)
  const allocation = parseJsonRecord(row.alpha_allocation)
  return buildExpandedMetaLearningContext({
    model_ic: firstPresent(row.model_ic, nestedValue(vote, 'ic_4w_avg'), nestedValue(vote, 'model_ic'), nestedValue(score, 'model_ic')),
    coverage: firstPresent(row.coverage, nestedValue(vote, 'coverage'), nestedValue(score, 'ml_coverage')),
    prediction_dispersion: firstPresent(row.prediction_dispersion, nestedValue(vote, 'dispersion.rawRankStd'), nestedValue(vote, 'raw_rank_std'), nestedValue(score, 'prediction_dispersion')),
    data_quality: firstPresent(row.data_quality, nestedValue(score, 'data_quality'), nestedValue(contextJson, 'data_quality')),
    market_breadth: firstPresent(row.market_breadth, nestedValue(contextJson, 'market_breadth'), nestedValue(allocation, 'market_breadth')),
    sector_heat: firstPresent(row.sector_heat, nestedValue(score, 'sector_heat'), nestedValue(contextJson, 'sector_heat'), nestedValue(allocation, 'sector_heat')),
    liquidity: firstPresent(row.liquidity, nestedValue(contextJson, 'liquidity'), nestedValue(contextJson, 'liquidity_score'), nestedValue(score, 'liquidity')),
    fill_quality: firstPresent(row.fill_quality, nestedValue(score, 'fill_quality'), nestedValue(contextJson, 'fill_quality')),
    regime: firstPresent(row.regime, nestedValue(contextJson, 'regime'), nestedValue(allocation, 'regime')),
    volatility: firstPresent(row.volatility, nestedValue(contextJson, 'volatility'), nestedValue(contextJson, 'volatility_score'), nestedValue(score, 'volatility')),
    market_risk: firstPresent(row.market_risk, nestedValue(contextJson, 'market_risk'), nestedValue(contextJson, 'market_risk_score'), nestedValue(score, 'market_risk')),
  })
}

export function buildLinUcbRewardLedgerRows(
  rows: LinUcbRewardSourceRow[],
  options: Pick<LinUcbRewardRefreshOptions, 'nowIso'> = {},
): LinUcbRewardLedgerRow[] {
  const nowIso = options.nowIso ?? new Date().toISOString()
  const buckets = new Map<string, Bucket>()

  for (const row of rows) {
    const reward = rewardForRow(row)
    if (reward == null) continue
    const context = expandedContextForSourceRow(row)
    const contextHash = hashExpandedMetaLearningContext(context)
    for (const armId of armIdsForRow(row)) {
      const bucketKey = armId
      const bucket = buckets.get(bucketKey) ?? { armId, contextHash, contextHashes: new Set<string>(), rewards: [], dates: [], stockIds: [], missingContext: new Set<string>() }
      bucket.contextHashes.add(contextHash)
      bucket.rewards.push(reward)
      if (row.date) bucket.dates.push(String(row.date))
      if (row.stock_id) bucket.stockIds.push(String(row.stock_id))
      for (const feature of context.coverage.missing) bucket.missingContext.add(feature)
      buckets.set(bucketKey, bucket)
    }
  }

  return [...buckets.values()]
    .filter((bucket) => bucket.rewards.length > 0)
    .map((bucket) => {
      const rewardSum = bucket.rewards.reduce((sum, reward) => sum + reward, 0)
      const dates = [...new Set(bucket.dates)].sort()
      const stockIds = [...new Set(bucket.stockIds)].sort()
      const evidence = {
        version: 'linucb-reward-ledger-v1',
        reward_source: 'trade_pnl_pct_or_actual_return_pct',
        source_rows: bucket.rewards.length,
        date_start: dates[0] ?? null,
        date_end: dates.at(-1) ?? null,
        sample_symbols_preview: stockIds.slice(0, 12),
        context_hash: bucket.contextHash,
        context_hashes: [...bucket.contextHashes].sort(),
        missing_context_features: [...bucket.missingContext].sort(),
      }
      const row: LinUcbRewardLedgerRow = {
        policy_id: 'LinUCB',
        arm_id: bucket.armId,
        context_hash: bucket.contextHash,
        samples: bucket.rewards.length,
        reward_sum: Math.round(rewardSum * 1_000_000) / 1_000_000,
        reward_mean: Math.round((rewardSum / bucket.rewards.length) * 1_000_000) / 1_000_000,
        last_reward_at: dates.at(-1) ?? null,
        updated_at: nowIso,
        evidence_json: JSON.stringify(evidence),
      }
      return row
    })
    .sort((a, b) => a.arm_id.localeCompare(b.arm_id))
}

export function buildNeuralMetaBanditTrainingPayload(
  policyId: 'NeuralUCB' | 'NeuralTS',
  rows: LinUcbRewardSourceRow[],
  options: { businessDate?: string; maxRows?: number } = {},
): NeuralMetaBanditTrainingPayload {
  const armNames = ['feature_family', 'time_series_family', 'do_nothing']
  const armIndex = new Map(armNames.map((name, idx) => [name, idx]))
  const contexts: number[][] = []
  const arms: number[] = []
  const rewards: number[] = []
  const symbols: string[] = []
  const baselineActions: string[] = []
  const maxRows = Math.max(1, Math.min(options.maxRows ?? 5000, 20000))
  for (const row of rows) {
    if (contexts.length >= maxRows) break
    const reward = rewardForRow(row)
    if (reward == null) continue
    const family = modelFamilyArm(row.model_name)
    contexts.push(expandedContextForSourceRow(row).vector)
    arms.push(armIndex.get(family) ?? armIndex.get('do_nothing') ?? 2)
    rewards.push(reward)
    symbols.push(String(row.stock_id ?? 'unknown'))
    baselineActions.push(family)
  }
  return {
    policy_id: policyId,
    contexts,
    arms,
    rewards,
    arm_names: armNames,
    business_date: options.businessDate ?? rows.find((row) => row.date)?.date ?? new Date().toISOString().slice(0, 10),
    symbols: symbols.slice(0, 200),
    baseline_actions: baselineActions.slice(0, 200),
  }
}

export async function listLinUcbRewardSourceRows(
  db: D1Database,
  options: LinUcbRewardRefreshOptions = {},
): Promise<LinUcbRewardSourceRow[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 5000, 20000))
  const clauses = ['(p.trade_pnl_pct IS NOT NULL OR p.actual_return_pct IS NOT NULL)']
  const binds: unknown[] = []
  if (options.startDate) {
    clauses.push('dr.date >= ?')
    binds.push(options.startDate)
  }
  if (options.endDate) {
    clauses.push('dr.date <= ?')
    binds.push(options.endDate)
  }
  binds.push(limit)

  const { results } = await db.prepare(`
    SELECT dr.date,
           dr.stock_id,
           p.model_name,
           dr.market_segment,
           dr.recommendation_lane,
           dr.has_buy_signal,
           dr.score_components,
           dr.ml_vote_summary,
           dr.alpha_context,
           dr.alpha_allocation,
           p.trade_pnl_pct,
           p.actual_return_pct
      FROM daily_recommendations dr
      JOIN predictions p
        ON p.stock_id = dr.stock_id
       AND p.prediction_date = dr.date
     WHERE ${clauses.join(' AND ')}
     ORDER BY dr.date DESC, dr.rank ASC
     LIMIT ?
  `).bind(...binds).all<LinUcbRewardSourceRow>()
  return results ?? []
}

export async function refreshLinUcbRewardLedger(
  db: D1Database,
  options: LinUcbRewardRefreshOptions & { dryRun?: boolean } = {},
): Promise<LinUcbRewardRefreshReport> {
  const sourceRows = await listLinUcbRewardSourceRows(db, options)
  const ledgerRows = buildLinUcbRewardLedgerRows(sourceRows, { nowIso: options.nowIso })
  if (options.dryRun !== false) {
    return {
      success: true,
      mode: 'dry_run',
      source_rows: sourceRows.length,
      ledger_rows: ledgerRows,
    }
  }

  let persisted = 0
  for (const row of ledgerRows) {
    await db.prepare(`
      INSERT INTO meta_reward_ledger (
        policy_id, arm_id, context_hash, samples, reward_sum, reward_mean,
        last_reward_at, updated_at, evidence_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(policy_id, arm_id, context_hash) DO UPDATE SET
        samples = excluded.samples,
        reward_sum = excluded.reward_sum,
        reward_mean = excluded.reward_mean,
        last_reward_at = excluded.last_reward_at,
        updated_at = excluded.updated_at,
        evidence_json = excluded.evidence_json
    `).bind(
      row.policy_id,
      row.arm_id,
      row.context_hash,
      row.samples,
      row.reward_sum,
      row.reward_mean,
      row.last_reward_at,
      row.updated_at,
      row.evidence_json,
    ).run()
    persisted += 1
  }

  return {
    success: true,
    mode: 'persisted',
    source_rows: sourceRows.length,
    ledger_rows: ledgerRows,
    persisted_rows: persisted,
  }
}
