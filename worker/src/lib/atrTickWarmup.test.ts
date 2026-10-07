import assert from 'node:assert/strict'
import test from 'node:test'
import { loadAtrTickWarmupBars } from './s12RuntimeBars'
import { previousAtrTR } from './paperAtrOnce'

const env = { S12_RESEARCH_KBARS_URL: 'https://research.example', PROXY_SERVICE_TOKEN: 'test-token' } as Parameters<typeof loadAtrTickWarmupBars>[0]
const rows = Array.from({ length: 6 }, (_, index) => ({
  ts: `2026-10-06T13:${20 + index}:00+08:00`,
  open: index < 4 ? 122 : 121.5, high: index < 4 ? 122 : 121.5,
  low: index < 4 ? 122 : 121.5, close: index < 4 ? 122 : 121.5,
  volume: [1, 0, 0, 0, 1, 7][index],
}))
const verified = { status: 'ok', source: 'shioaji_ticks_atr_warmup_v1', completed_only: true, data: rows }

test('verified 3004 zero-trade tail repairs TR without auction or price-basis change', async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), 'https://research.example/atr-warmup/3004?date=2026-10-06')
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer test-token')
      return Response.json(verified)
    }
    const bars = await loadAtrTickWarmupBars(env, '3004', '2026-10-06')
    const starts = bars.map(bar => ({ ...bar, startMs: bar.startMs - 60_000 }))
    assert.equal(previousAtrTR(starts, '2026-10-06', 121.5, 121.5), 0.5)
    assert.equal(previousAtrTR(starts, '2026-10-06', 121.5, 60.75), 0.25)
  } finally { globalThis.fetch = original }
})

test('unknown source, missing minutes, wrong date and HTTP failures remain blocked', async () => {
  const original = globalThis.fetch
  try {
    for (const payload of [
      { ...verified, source: 'unverified' }, { ...verified, completed_only: false },
      { ...verified, data: rows.slice(1) },
      { ...verified, data: rows.map(row => ({ ...row, volume: -1 })) },
      { ...verified, data: rows.map(row => ({ ...row, high: 1 })) },
      { ...verified, data: rows.map(row => ({ ...row, ts: row.ts.replace('10-06', '10-05') })) },
    ]) {
      globalThis.fetch = async () => Response.json(payload)
      await assert.rejects(loadAtrTickWarmupBars(env, '3004', '2026-10-06'), /atr_tick_warmup_/)
    }
    globalThis.fetch = async () => new Response('busy', { status: 429 })
    await assert.rejects(loadAtrTickWarmupBars(env, '3004', '2026-10-06'), /http_429/)
  } finally { globalThis.fetch = original }
})
