import assert from 'node:assert/strict'
import type { Bindings } from '../types'
import { runRegimeCompute } from './controllerDailyWorkflows'
import { buildMarketRegimeState, MARKET_REGIME_STATE_KEY } from './marketRegimeState'

class FakeKV {
  store = new Map<string, string>()

  async get(key: string, mode?: string) {
    const raw = this.store.get(key)
    if (raw == null) return null
    return mode === 'json' ? JSON.parse(raw) : raw
  }

  async put(key: string, value: string) {
    this.store.set(key, value)
  }
}

void (async () => {
  const state = {
    ...buildMarketRegimeState({
      label: 'bull_market',
      runDate: '2026-08-26',
      computedAt: '2026-08-26T21:28:40.309533+08:00',
      params: {
        regime_index: 0,
        hmm_state: 3,
        regime_surface: {
          bull_market: 0.7,
          volatile: 0.1,
          sideways: 0.15,
          bear_market: 0.05,
        },
      },
    }),
    pushed_at: '2026-08-26T13:28:40.500Z',
  }
  const stateJson = JSON.stringify(state)
  const stateChecksum = [...new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(stateJson),
  ))].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  const marketDb = {
    prepare: () => ({
      bind: () => ({
        first: async () => ({ state_json: stateJson, state_checksum: stateChecksum }),
      }),
    }),
  }
  const kv = new FakeKV()
  const env = {
    KV: kv,
    DB: marketDb,
    MARKET_DB: marketDb,
    MULTI_D1_ACTIVE_DOMAINS: 'market',
    MULTI_D1_STRICT: 'true',
  } as unknown as Bindings

  const summary = await runRegimeCompute(env, '2026-08-26')

  assert.match(summary, /kv=restored source=immutable_market_d1_history/)
  assert.equal(kv.store.get(MARKET_REGIME_STATE_KEY), stateJson)
  assert.equal((env as any).ML_CONTROLLER_URL, undefined)
  console.log('controller daily immutable regime recovery test passed')
})()
