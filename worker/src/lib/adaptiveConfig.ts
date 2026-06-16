import { readMarketRegimeState } from './marketRegimeState'

export type AdaptiveRegime = 'bull' | 'bear' | 'volatile' | 'sideways'
export type AdaptiveParamSource = 'ml-controller' | 'risk-assess' | 'manual' | 'fallback' | 'unknown'

export interface AdaptiveParamProvenance {
  owner: 'ml-controller'
  source: AdaptiveParamSource | string
  l2_formula_source?: string
  schema_version: 'adaptive-params-v2'
  update_frequency: 'daily_after_verify'
  computed_at: string
  updated_at: string
  fallback: boolean
  regime?: AdaptiveRegime | 'unknown'
}

export interface AdaptiveScreenerDelta {
  candidate_pool_delta?: number
  coarse_ml_queue_delta?: number
  ml_shortlist_delta?: number
  emerging_research_delta?: number
}

export type AdaptiveThresholdComponents = Record<string, unknown>

export interface AdaptiveRegimeOverride {
  confidence_delta?: number
  threshold_components?: AdaptiveThresholdComponents
  position_pct_delta?: number
  sltp_add?: {
    sl_add: number
    tp_add: number
  } | null
  pf_quality_mult?: Record<string, number>
  screener?: AdaptiveScreenerDelta
  bandit_max_mult?: number
  bandit_force_explore?: boolean
  bandit_context?: Record<string, unknown>
}

export interface AdaptiveMetaLayerGovernance {
  alpha_vote_models: string[]
  formal_layer3_slots: string[]
  state_space_overlays: string[]
  meta_optimizers: string[]
  adaptive_components: Record<string, string>
  immutable_risk_boundaries: string[]
}

export const ADAPTIVE_META_LAYER_GOVERNANCE: AdaptiveMetaLayerGovernance = {
  alpha_vote_models: [
    'LightGBM',
    'XGBoost',
    'ExtraTrees',
    'TabM',
    'GNN',
    'DLinear',
    'PatchTST',
    'iTransformer',
    'TimesFM',
  ],
  formal_layer3_slots: ['DLinear', 'PatchTST', 'TabM', 'GNN', 'iTransformer', 'TimesFM'],
  state_space_overlays: ['KalmanFilter', 'MarkovSwitching'],
  meta_optimizers: ['GAOptimizer'],
  adaptive_components: {
    ARF: 'drift-aware ensemble aggregation, not a standalone alpha vote',
    LinUCB: 'contextual bandit model weighting with delayed reward protection',
    Conformal: 'prediction uncertainty calibration and coverage guard',
    Stacking: 'meta learner for ensemble blending after base-model predictions',
    GAOptimizer: 'meta optimizer for ensemble weights, strategy params, and risk params',
    NeuralUCB: 'counterfactual meta-router for nonlinear model-weight and threshold policy comparison',
    NeuralTS: 'counterfactual Thompson sampler to audit NeuralUCB optimism before production consideration',
    OnlinePortfolioBandit: 'production allocator controller for sparse_tangent_inverse_risk knobs; production-capable without replacing the final weight engine',
    NeuCB: 'research-only neural contextual bandit benchmark until experiment registry evidence exists',
  },
  immutable_risk_boundaries: [
    'circuit',
    'riskOverlay.hardGates',
    'position.maxPctOfPortfolio',
    'paperExecution.impossibleFillGuard',
  ],
}

export interface AdaptiveParams {
  /** Compatibility readback; prefer confidence_delta for new logic. */
  confidence_threshold?: number
  /** Compatibility readback; prefer trading:config.sltp plus sltp_add. */
  sl_mult_base?: number
  /** Compatibility readback; prefer trading:config.sltp plus sltp_add. */
  tp_mult_base?: number
  /** Compatibility readback; prefer trading:config.signal. */
  strong_signal_score?: number
  /** Compatibility readback; prefer trading:config.signal.buySignalScore plus confidence_delta. */
  buy_signal_score?: number
  /** Compatibility readback; prefer trading:config.signal.holdSignalScore. */
  hold_signal_score?: number

  confidence_delta: number
  threshold_components?: AdaptiveThresholdComponents
  position_pct_delta: number
  sltp_add: {
    sl_add: number
    tp_add: number
  } | null
  pf_quality_mult: Record<string, number>
  screener?: AdaptiveScreenerDelta
  bandit_max_mult: number
  bandit_force_explore: boolean
  bandit_context?: Record<string, unknown>
  computed_at: string
  market_risk_score: number
  recent_accuracy_30d: number
  regime_at_compute?: number
  regime_overrides?: Partial<Record<AdaptiveRegime, AdaptiveRegimeOverride>>
  provenance: AdaptiveParamProvenance
  meta_layer: AdaptiveMetaLayerGovernance
  version: number

  /** Compatibility readback; prefer sltp_add. */
  sl_tp_override?: { sl_add: number; tp_add: number } | null
}

export const ADAPTIVE_PARAMS_KV_KEY = 'ml:adaptive_params'
const KV_KEY = ADAPTIVE_PARAMS_KV_KEY
const CACHE_TTL_MS = 300_000

function nowIso(): string {
  return new Date().toISOString()
}

export const DEFAULT_ADAPTIVE_PARAMS: AdaptiveParams = {
  confidence_delta: 0,
  position_pct_delta: 0,
  sltp_add: null,
  pf_quality_mult: {},
  screener: {},
  bandit_max_mult: 2.5,
  bandit_force_explore: false,
  bandit_context: undefined,
  computed_at: '',
  market_risk_score: 50,
  recent_accuracy_30d: 0.6,
  regime_overrides: {},
  provenance: {
    owner: 'ml-controller',
    source: 'fallback',
    schema_version: 'adaptive-params-v2',
    update_frequency: 'daily_after_verify',
    computed_at: '',
    updated_at: '',
    fallback: true,
  },
  meta_layer: ADAPTIVE_META_LAYER_GOVERNANCE,
  version: 0,
}

let _cached: AdaptiveParams | null = null
let _cachedAt = 0

function finiteNumber(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function optionalNumber(value: unknown): number | undefined {
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function finiteBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function normalizeSltpAdd(value: unknown): { sl_add: number; tp_add: number } | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const sl = optionalNumber(raw.sl_add)
  const tp = optionalNumber(raw.tp_add)
  if (sl == null || tp == null) return null
  return { sl_add: sl, tp_add: tp }
}

function normalizeNumberRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object') return {}
  const out: Record<string, number> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const n = Number(raw)
    if (Number.isFinite(n)) out[key] = n
  }
  return out
}

function normalizeScreenerDelta(value: unknown): AdaptiveScreenerDelta {
  if (!value || typeof value !== 'object') return {}
  const raw = value as Record<string, unknown>
  const out: AdaptiveScreenerDelta = {}
  for (const key of ['candidate_pool_delta', 'coarse_ml_queue_delta', 'ml_shortlist_delta', 'emerging_research_delta'] as const) {
    const n = optionalNumber(raw[key])
    if (n != null) out[key] = n
  }
  return out
}

function normalizeThresholdComponents(value: unknown): AdaptiveThresholdComponents | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as AdaptiveThresholdComponents
}

function normalizeRegimeOverride(value: unknown): AdaptiveRegimeOverride {
  if (!value || typeof value !== 'object') return {}
  const raw = value as Record<string, unknown>
  const out: AdaptiveRegimeOverride = {}
  const confidence = optionalNumber(raw.confidence_delta)
  const position = optionalNumber(raw.position_pct_delta)
  const banditMax = optionalNumber(raw.bandit_max_mult)
  if (confidence != null) out.confidence_delta = confidence
  const thresholdComponents = normalizeThresholdComponents(raw.threshold_components)
  if (thresholdComponents) out.threshold_components = thresholdComponents
  if (position != null) out.position_pct_delta = position
  if (Object.prototype.hasOwnProperty.call(raw, 'sltp_add')) out.sltp_add = normalizeSltpAdd(raw.sltp_add)
  if (raw.pf_quality_mult && typeof raw.pf_quality_mult === 'object') out.pf_quality_mult = normalizeNumberRecord(raw.pf_quality_mult)
  if (raw.screener && typeof raw.screener === 'object') out.screener = normalizeScreenerDelta(raw.screener)
  if (banditMax != null) out.bandit_max_mult = banditMax
  if (typeof raw.bandit_force_explore === 'boolean') out.bandit_force_explore = raw.bandit_force_explore
  if (raw.bandit_context && typeof raw.bandit_context === 'object') out.bandit_context = raw.bandit_context as Record<string, unknown>
  return out
}

function normalizeRegimeOverrides(value: unknown): Partial<Record<AdaptiveRegime, AdaptiveRegimeOverride>> {
  if (!value || typeof value !== 'object') return {}
  const raw = value as Record<string, unknown>
  const out: Partial<Record<AdaptiveRegime, AdaptiveRegimeOverride>> = {}
  for (const regime of ['bull', 'bear', 'volatile', 'sideways'] as const) {
    if (raw[regime]) out[regime] = normalizeRegimeOverride(raw[regime])
  }
  return out
}

export function normalizeAdaptiveRegime(raw: unknown): AdaptiveRegime | 'unknown' {
  const value = String(raw ?? '').toLowerCase()
  if (value.includes('bull')) return 'bull'
  if (value.includes('bear')) return 'bear'
  if (value.includes('vol')) return 'volatile'
  if (value.includes('side') || value.includes('range') || value.includes('chop')) return 'sideways'
  return 'unknown'
}

function normalizeProvenance(
  raw: unknown,
  params: Pick<AdaptiveParams, 'computed_at'>,
  options: { source?: AdaptiveParamSource | string; fallback?: boolean } = {},
): AdaptiveParamProvenance {
  const source = options.source ?? ((raw && typeof raw === 'object' ? (raw as Record<string, unknown>).source : undefined) as string | undefined) ?? 'unknown'
  const fallback = options.fallback ?? (source === 'fallback' || source === 'unknown')
  const updated = nowIso()
  const provenance = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const regime = normalizeAdaptiveRegime(provenance.regime)
  return {
    owner: 'ml-controller',
    source,
    ...(provenance.l2_formula_source != null ? { l2_formula_source: String(provenance.l2_formula_source) } : {}),
    schema_version: 'adaptive-params-v2',
    update_frequency: 'daily_after_verify',
    computed_at: String(provenance.computed_at ?? params.computed_at ?? ''),
    updated_at: String(provenance.updated_at ?? updated),
    fallback,
    ...(regime !== 'unknown' ? { regime } : {}),
  }
}

export function normalizeAdaptiveParams(
  value: Partial<AdaptiveParams> | Record<string, unknown> | null | undefined,
  options: { source?: AdaptiveParamSource | string; fallback?: boolean } = {},
): AdaptiveParams {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const computedAt = String(raw.computed_at ?? DEFAULT_ADAPTIVE_PARAMS.computed_at)
  const normalized: AdaptiveParams = {
    confidence_delta: finiteNumber(raw.confidence_delta, DEFAULT_ADAPTIVE_PARAMS.confidence_delta),
    threshold_components: normalizeThresholdComponents(raw.threshold_components),
    position_pct_delta: finiteNumber(raw.position_pct_delta, DEFAULT_ADAPTIVE_PARAMS.position_pct_delta),
    sltp_add: normalizeSltpAdd(raw.sltp_add),
    pf_quality_mult: normalizeNumberRecord(raw.pf_quality_mult),
    screener: normalizeScreenerDelta(raw.screener),
    bandit_max_mult: finiteNumber(raw.bandit_max_mult, DEFAULT_ADAPTIVE_PARAMS.bandit_max_mult),
    bandit_force_explore: finiteBoolean(raw.bandit_force_explore, DEFAULT_ADAPTIVE_PARAMS.bandit_force_explore),
    bandit_context: raw.bandit_context && typeof raw.bandit_context === 'object' ? raw.bandit_context as Record<string, unknown> : undefined,
    computed_at: computedAt,
    market_risk_score: finiteNumber(raw.market_risk_score, DEFAULT_ADAPTIVE_PARAMS.market_risk_score),
    recent_accuracy_30d: finiteNumber(raw.recent_accuracy_30d, DEFAULT_ADAPTIVE_PARAMS.recent_accuracy_30d),
    regime_at_compute: optionalNumber(raw.regime_at_compute),
    regime_overrides: normalizeRegimeOverrides(raw.regime_overrides),
    provenance: normalizeProvenance(raw.provenance, { computed_at: computedAt }, options),
    meta_layer: ADAPTIVE_META_LAYER_GOVERNANCE,
    version: Math.max(0, Math.round(finiteNumber(raw.version, DEFAULT_ADAPTIVE_PARAMS.version))),
  }

  for (const legacyKey of [
    'confidence_threshold',
    'sl_mult_base',
    'tp_mult_base',
    'strong_signal_score',
    'buy_signal_score',
    'hold_signal_score',
  ] as const) {
    const n = optionalNumber(raw[legacyKey])
    if (n != null) normalized[legacyKey] = n
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'sl_tp_override')) {
    normalized.sl_tp_override = normalizeSltpAdd(raw.sl_tp_override)
  }
  return normalized
}

export function resolveAdaptiveParamsForRegime(
  params: AdaptiveParams,
  regime: unknown,
): AdaptiveParams {
  const normalizedRegime = normalizeAdaptiveRegime(regime)
  const normalized = normalizeAdaptiveParams(params, {
    source: params.provenance?.source ?? 'unknown',
    fallback: params.provenance?.fallback ?? false,
  })
  if (normalizedRegime === 'unknown') {
    return {
      ...normalized,
      provenance: { ...normalized.provenance, regime: 'unknown' },
    }
  }

  const override = normalized.regime_overrides?.[normalizedRegime]
  if (!override) {
    return {
      ...normalized,
      provenance: { ...normalized.provenance, regime: normalizedRegime },
    }
  }

  return {
    ...normalized,
    ...override,
    pf_quality_mult: {
      ...normalized.pf_quality_mult,
      ...(override.pf_quality_mult ?? {}),
    },
    screener: {
      ...(normalized.screener ?? {}),
      ...(override.screener ?? {}),
    },
    meta_layer: ADAPTIVE_META_LAYER_GOVERNANCE,
    provenance: { ...normalized.provenance, regime: normalizedRegime },
  }
}

export async function getAdaptiveParams(kv: KVNamespace): Promise<AdaptiveParams> {
  if (_cached && Date.now() - _cachedAt < CACHE_TTL_MS) return _cached
  let raw: AdaptiveParams | null
  try {
    raw = await kv.get(KV_KEY, 'json') as AdaptiveParams | null
  } catch (error: any) {
    throw new Error(`adaptive params read failed: ${error?.message ?? error}`)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`adaptive params missing: ${KV_KEY}`)
  }
  const normalized = normalizeAdaptiveParams(raw, {
    source: raw.provenance?.source ?? 'unknown',
    fallback: !raw.provenance,
  })
  if (normalized.provenance.fallback === true) {
    throw new Error(`adaptive params fallback/legacy provenance: source=${normalized.provenance.source}`)
  }
  _cached = normalized
  _cachedAt = Date.now()
  return _cached
}

async function readCurrentRegime(kv: KVNamespace): Promise<string | null> {
  const state = await readMarketRegimeState(kv)
  return state?.family ?? state?.label ?? null
}

export async function getAdaptiveParamsForRegime(
  kv: KVNamespace,
  regime?: string | null,
): Promise<AdaptiveParams> {
  const params = await getAdaptiveParams(kv)
  const effectiveRegime = regime ?? await readCurrentRegime(kv)
  return resolveAdaptiveParamsForRegime(params, effectiveRegime)
}

export async function setAdaptiveParams(
  kv: KVNamespace,
  params: AdaptiveParams,
  options: { source?: AdaptiveParamSource | string; fallback?: boolean } = {},
): Promise<void> {
  const normalized = normalizeAdaptiveParams(params, options)
  await kv.put(KV_KEY, JSON.stringify(normalized))
  const persisted = await kv.get(KV_KEY, 'json') as AdaptiveParams | null
  if (!persisted || typeof persisted !== 'object') {
    throw new Error(`adaptive params KV write verification failed: ${KV_KEY} missing after put`)
  }
  _cached = normalized
  _cachedAt = Date.now()
}

export function invalidateAdaptiveCache(): void {
  _cached = null
  _cachedAt = 0
}
