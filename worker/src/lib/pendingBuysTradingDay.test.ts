import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { recordedClosure } from './twRecordedClosure'

// /api/paper/pending-buys carries session_date + trading_day so /bot can show a closed day
// before the open and after the close, from the same cache-only closure reader as premarket.
const source = readFileSync('src/routes/paper.ts', 'utf8')
const route = source.slice(source.indexOf("paper.get('/pending-buys'"), source.indexOf("paper.get('/execution-events'"))

test('pending-buys exposes session_date and trading_day from recordedClosure', () => {
  assert.ok(route.length > 0)
  assert.match(route, /const tradingDay = await recordedClosure\(c\.env\.KV, twToday\)\.then\(\(closed\) => !closed, \(\) => null\)/)
  assert.match(route, /session_date: twToday,\s*trading_day: tradingDay,/)
  assert.match(source, /import \{ recordedClosure \} from '\.\.\/lib\/twRecordedClosure'/)
})

test('recordedClosure: weekend and holiday:YYYY-MM-DD are closed, an ordinary weekday is open', async () => {
  const store = new Map<string, string>([['holiday:2026-07-10', '巴威颱風休市']])
  const kv = { get: async (key: string, type?: string) => { const raw = store.get(key) ?? null; return type === 'json' && raw ? JSON.parse(raw) : raw } }
  assert.equal(await recordedClosure(kv as any, '2026-07-10'), true)
  assert.equal(await recordedClosure(kv as any, '2026-07-11'), true, 'Saturday')
  assert.equal(await recordedClosure(kv as any, '2026-07-09'), false)
})
