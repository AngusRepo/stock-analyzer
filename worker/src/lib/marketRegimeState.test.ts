import { adminOptunaRoutes } from '../routes/adminOptunaRoutes'
import type { Bindings } from '../types'
import { getCurrentRegime as getPaperExitRegime } from './paperMarketData'
import { getCurrentRegime as getTradingConfigRegime } from './tradingConfig'
import {
  LEGACY_REGIME_KEY,
  LEGACY_REGIME_META_KEY,
  MARKET_REGIME_STATE_KEY,
  buildMarketRegimeState,
  normalizeRegimeLabel,
  persistMarketRegimeState,
  readCurrentLegacyRegimeLabel,
  readCurrentRegimeFamily,
  readMarketRegimeState,
} from './marketRegimeState'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

class FakeKV {
  store = new Map<string, string>()

  async get(key: string, mode?: string) {
    const raw = this.store.get(key)
    if (!raw) return null
    return mode === 'json' ? JSON.parse(raw) : raw
  }

  async put(key: string, value: string) {
    this.store.set(key, value)
  }

  async delete(key: string) {
    this.store.delete(key)
  }
}

void (async () => {
  assert(normalizeRegimeLabel('bull_market')?.family === 'bull', 'bull_market must normalize to bull family')
  assert(normalizeRegimeLabel('bear')?.label === 'bear_market', 'bear short label must normalize to bear_market')
  assert(normalizeRegimeLabel('unknown') === null, 'unknown labels must not silently become sideways')

  const kv = new FakeKV() as unknown as KVNamespace
  const state = buildMarketRegimeState({
    label: 'bear_market',
    runDate: '2026-05-16',
    computedAt: '2026-05-16T10:30:00.000Z',
    params: {
      regime_index: 3,
      hmm_state: 2,
      label_zh: '空頭',
      regime_surface: { bear_market: 0.71, sideways: 0.20 },
      consensus_threshold: 0.67,
      weight_multipliers: { lightgbm: 0.8 },
      raw_label: 'bear_market',
      regime_evidence: {
        schema_version: 'regime-evidence-v1',
        raw_label: 'bear_market',
        effective_label: 'bear_market',
        support_counts: { bearish: 4, bullish: 0, available: 5 },
      },
      transition_guard: { status: 'confirmed', reason: 'cross_evidence_confirmed' },
      monitors: {
        lppls_weekly_bubble: { status: 'pending', decision_effect: 'context_only' },
        hawkes_contagion: { status: 'pending', decision_effect: 'context_only' },
      },
    },
  })
  await persistMarketRegimeState(kv, state)

  assert((kv as any).store.has(MARKET_REGIME_STATE_KEY), 'new market_regime_state key must be written')
  assert((kv as any).store.get(LEGACY_REGIME_KEY) === 'bear_market', 'legacy ml:regime mirror must remain during migration')
  assert(JSON.parse((kv as any).store.get(LEGACY_REGIME_META_KEY)).label === 'bear_market', 'legacy meta mirror must preserve label')

  const readState = await readMarketRegimeState(kv)
  assert(readState?.schema_version === 'market-regime-state-v1', 'reader must return v1 state envelope')
  assert(readState?.label === 'bear_market', 'reader must prefer market_regime_state over legacy keys')
  assert(readState?.family === 'bear', 'reader must expose normalized family for alpha/adaptive consumers')
  assert(readState?.raw_label === 'bear_market', 'reader must preserve raw HMM label')
  assert(readState?.transition_guard?.status === 'confirmed', 'reader must preserve transition guard')
  assert(readState?.regime_evidence?.schema_version === 'regime-evidence-v1', 'reader must preserve evidence pack')
  const lppls = readState?.monitors?.lppls_weekly_bubble as { decision_effect?: string } | undefined
  assert(lppls?.decision_effect === 'context_only', 'monitors must stay context-only')
  assert(await readCurrentLegacyRegimeLabel(kv) === 'bear_market', 'legacy label helper must read new state first')
  assert(await readCurrentRegimeFamily(kv) === 'bear', 'family helper must read new state first')
  assert(await getTradingConfigRegime(kv) === 'bear_market', 'tradingConfig SLTP regime must consume new state')
  assert(await getPaperExitRegime(kv) === 'bear', 'paper exit regime must consume new state')

  const legacyOnly = new FakeKV() as unknown as KVNamespace
  await legacyOnly.put(LEGACY_REGIME_META_KEY, JSON.stringify({ label: 'volatile', regime_index: 1 }))
  const fallback = await readMarketRegimeState(legacyOnly)
  assert(fallback?.label === 'volatile', 'reader must fallback to legacy meta during migration')
  assert(fallback?.source === 'legacy_meta', 'legacy fallback must be explicit in provenance')

  const env = {
    KV: new FakeKV(),
    STOCKVISION_AUTH_TOKEN: 'service-token',
  } as unknown as Bindings
  const res = await adminOptunaRoutes.request('/api/admin/optuna-push', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer service-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      source: 'regime',
      params: {
        label: 'bull_market',
        regime_index: 0,
        hmm_state: 1,
        label_zh: '多頭',
        regime_surface: { bull_market: 0.64, sideways: 0.24 },
        consensus_threshold: 0.56,
        weight_multipliers: { lightgbm: 1.1 },
      },
      meta: { computed_at: '2026-05-16T10:35:00.000Z', run_date: '2026-05-16' },
    }),
  }, env)

  assert(res.status === 200, 'regime push should be accepted')
  const body = await res.json() as any
  assert(body.updatedKeys.includes(MARKET_REGIME_STATE_KEY), 'regime push must report market_regime_state')
  const pushed = JSON.parse((env.KV as any).store.get(MARKET_REGIME_STATE_KEY))
  assert(pushed.label === 'bull_market', 'admin route must write new market_regime_state label')
  assert(pushed.family === 'bull', 'admin route must write normalized family for downstream consumers')
  assert((env.KV as any).store.get(LEGACY_REGIME_KEY) === 'bull_market', 'admin route must keep legacy mirror during migration')
})()
