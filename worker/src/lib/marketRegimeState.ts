export const MARKET_REGIME_STATE_KEY = 'market_regime_state'
export const LEGACY_REGIME_KEY = 'ml:regime'
export const LEGACY_REGIME_META_KEY = 'ml:regime:meta'

export type MarketRegimeFamily = 'bull' | 'bear' | 'volatile' | 'sideways'
export type MarketRegimeLegacyLabel = 'bull_market' | 'bear_market' | 'volatile' | 'sideways'
export type MarketRegimeStateSource = 'hmm' | 'legacy_meta' | 'legacy_label' | 'fallback'

export interface MarketRegimeState {
  schema_version: 'market-regime-state-v1'
  label: MarketRegimeLegacyLabel
  raw_label: MarketRegimeLegacyLabel
  family: MarketRegimeFamily
  run_date: string | null
  computed_at: string
  source: MarketRegimeStateSource
  regime_index: number
  hmm_state: number
  label_zh: string
  regime_surface: Record<string, number>
  consensus_threshold: number
  weight_multipliers: Record<string, number>
  regime_evidence: Record<string, unknown>
  transition_guard: Record<string, unknown>
  monitors: Record<string, unknown>
  downstream_contract: {
    primary_kv_key: typeof MARKET_REGIME_STATE_KEY
    legacy_mirror_keys: [typeof LEGACY_REGIME_KEY, typeof LEGACY_REGIME_META_KEY]
    read_policy: 'market_regime_state_first_legacy_fallback'
    consumers: string[]
  }
  pushed_at?: string
}

export function normalizeRegimeLabel(raw: unknown): { label: MarketRegimeLegacyLabel; family: MarketRegimeFamily } | null {
  const text = String(raw ?? '').trim().toLowerCase()
  if (!text) return null
  if (text.startsWith('bull')) return { label: 'bull_market', family: 'bull' }
  if (text.startsWith('bear')) return { label: 'bear_market', family: 'bear' }
  if (text.startsWith('volatile')) return { label: 'volatile', family: 'volatile' }
  if (text.startsWith('sideway')) return { label: 'sideways', family: 'sideways' }
  return null
}

function asNumber(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function normalizeSurface(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed >= 0) out[key] = parsed
  }
  return out
}

function normalizeNumberMap(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) out[key] = parsed
  }
  return out
}

function normalizeObject(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? { ...(raw as Record<string, unknown>) }
    : {}
}

function contract(): MarketRegimeState['downstream_contract'] {
  return {
    primary_kv_key: MARKET_REGIME_STATE_KEY,
    legacy_mirror_keys: [LEGACY_REGIME_KEY, LEGACY_REGIME_META_KEY],
    read_policy: 'market_regime_state_first_legacy_fallback',
    consumers: [
      'ml_payload_builder',
      'recommendation_service',
      'alpha_framework',
      'adaptive_params',
      'sltp_overlay',
      'paper_entry',
      'paper_exit',
      'risk_triggers',
    ],
  }
}

export function buildMarketRegimeState(input: {
  label?: unknown
  runDate?: string | null
  computedAt?: string | null
  params?: Record<string, unknown> | null
  source?: MarketRegimeStateSource
}): MarketRegimeState {
  const params = input.params ?? {}
  const normalized = normalizeRegimeLabel(input.label ?? params.label ?? 'sideways') ?? {
    label: 'sideways' as const,
    family: 'sideways' as const,
  }
  const computedAt = String(input.computedAt || params.computed_at || new Date().toISOString())
  const runDate = input.runDate ?? String(params.run_date ?? '')
  const rawLabel = normalizeRegimeLabel(params.raw_label)?.label ?? normalized.label
  const regimeEvidence = normalizeObject(params.regime_evidence)
  return {
    schema_version: 'market-regime-state-v1',
    label: normalized.label,
    raw_label: rawLabel,
    family: normalized.family,
    run_date: runDate || null,
    computed_at: computedAt,
    source: input.source ?? 'hmm',
    regime_index: asNumber(params.regime_index, normalized.label === 'bull_market' ? 0 : normalized.label === 'volatile' ? 1 : normalized.label === 'bear_market' ? 3 : 2),
    hmm_state: asNumber(params.hmm_state, -1),
    label_zh: String(params.label_zh ?? ''),
    regime_surface: normalizeSurface(params.regime_surface ?? params.regime_probabilities ?? params.probabilities),
    consensus_threshold: asNumber(params.consensus_threshold, 0.60),
    weight_multipliers: normalizeNumberMap(params.weight_multipliers),
    regime_evidence: regimeEvidence,
    transition_guard: normalizeObject(params.transition_guard ?? regimeEvidence.transition_guard),
    monitors: normalizeObject(params.monitors ?? regimeEvidence.monitors),
    downstream_contract: contract(),
  }
}

function parseMarketRegimeState(raw: unknown): MarketRegimeState | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  if (obj.schema_version !== 'market-regime-state-v1') return null
  const normalized = normalizeRegimeLabel(obj.label)
  if (!normalized) return null
  return {
    schema_version: 'market-regime-state-v1',
    label: normalized.label,
    raw_label: normalizeRegimeLabel(obj.raw_label)?.label ?? normalized.label,
    family: normalized.family,
    run_date: typeof obj.run_date === 'string' && obj.run_date ? obj.run_date : null,
    computed_at: String(obj.computed_at || new Date(0).toISOString()),
    source: (obj.source as MarketRegimeStateSource) || 'fallback',
    regime_index: asNumber(obj.regime_index, 2),
    hmm_state: asNumber(obj.hmm_state, -1),
    label_zh: String(obj.label_zh ?? ''),
    regime_surface: normalizeSurface(obj.regime_surface),
    consensus_threshold: asNumber(obj.consensus_threshold, 0.60),
    weight_multipliers: normalizeNumberMap(obj.weight_multipliers),
    regime_evidence: normalizeObject(obj.regime_evidence),
    transition_guard: normalizeObject(obj.transition_guard),
    monitors: normalizeObject(obj.monitors),
    downstream_contract: contract(),
    pushed_at: typeof obj.pushed_at === 'string' ? obj.pushed_at : undefined,
  }
}

async function readJson(kv: KVNamespace, key: string): Promise<unknown | null> {
  return await kv.get(key, 'json').catch(() => null)
}

export async function readMarketRegimeState(kv: KVNamespace): Promise<MarketRegimeState | null> {
  const current = parseMarketRegimeState(await readJson(kv, MARKET_REGIME_STATE_KEY))
  if (current) return current

  const meta = await readJson(kv, LEGACY_REGIME_META_KEY)
  if (meta && typeof meta === 'object') {
    const legacy = meta as Record<string, unknown>
    const label = normalizeRegimeLabel(legacy.label)
    if (label) {
      return buildMarketRegimeState({
        label: label.label,
        runDate: typeof legacy.run_date === 'string' ? legacy.run_date : null,
        computedAt: typeof legacy.computed_at === 'string' ? legacy.computed_at : typeof legacy.pushed_at === 'string' ? legacy.pushed_at : null,
        params: legacy,
        source: 'legacy_meta',
      })
    }
  }

  const legacyLabel = await kv.get(LEGACY_REGIME_KEY, 'text').catch(() => null)
  const normalized = normalizeRegimeLabel(legacyLabel)
  if (!normalized) return null
  return buildMarketRegimeState({
    label: normalized.label,
    params: {},
    source: 'legacy_label',
  })
}

export async function readCurrentLegacyRegimeLabel(kv: KVNamespace): Promise<MarketRegimeLegacyLabel | null> {
  return (await readMarketRegimeState(kv))?.label ?? null
}

export async function readCurrentRegimeFamily(kv: KVNamespace): Promise<MarketRegimeFamily | null> {
  return (await readMarketRegimeState(kv))?.family ?? null
}

export async function persistMarketRegimeState(
  kv: KVNamespace,
  state: MarketRegimeState,
  options: { expirationTtl?: number } = {},
): Promise<void> {
  const ttl = options.expirationTtl ?? 2 * 86400
  const pushedAt = new Date().toISOString()
  const payload: MarketRegimeState = { ...state, downstream_contract: contract(), pushed_at: pushedAt }
  await kv.put(MARKET_REGIME_STATE_KEY, JSON.stringify(payload), { expirationTtl: ttl })
  await kv.put(LEGACY_REGIME_KEY, payload.label, { expirationTtl: ttl })
  await kv.put(LEGACY_REGIME_META_KEY, JSON.stringify({
    label: payload.label,
    raw_label: payload.raw_label,
    family: payload.family,
    regime_index: payload.regime_index,
    hmm_state: payload.hmm_state,
    label_zh: payload.label_zh,
    regime_surface: payload.regime_surface,
    consensus_threshold: payload.consensus_threshold,
    weight_multipliers: payload.weight_multipliers,
    regime_evidence: payload.regime_evidence,
    transition_guard: payload.transition_guard,
    monitors: payload.monitors,
    run_date: payload.run_date,
    computed_at: payload.computed_at,
    market_regime_state_key: MARKET_REGIME_STATE_KEY,
    pushed_at: pushedAt,
  }), { expirationTtl: ttl })
}
