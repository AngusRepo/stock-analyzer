import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inspectMatureSelectionEvidenceGaps } from './matureSelectionEvidenceRecovery'

const KEY = 'mature-selection-evidence:verified-heads:v1'
const HEADS = Array.from({ length: 10 }, (_, index) => ({
  signal_date: `2026-07-${String(index + 10).padStart(2, '0')}`,
  run_id: `screener-${index}`,
}))

class FakeD1 {
  scanned: string[][] = []
  gaps = new Set<string>()
  heads = HEADS
  matureDate = '2026-07-19'
  failOnCall = 0
  prepare(sql: string) {
    const normalized = sql.replace(/\s+/g, ' ')
    let args: unknown[] = []
    const statement = {
      bind: (...values: unknown[]) => { args = values; return statement },
      first: async () => {
        if (normalized.includes('FROM market_trading_sessions')) return { session_date: '2026-07-29' }
        if (normalized.includes('FROM canonical_run_heads')) return { signal_date: this.matureDate }
        throw new Error(`unexpected first: ${normalized}`)
      },
      all: async () => {
        if (normalized.includes('FROM canonical_run_heads')) return { results: this.heads }
        if (normalized.includes('WITH target_heads(signal_date, producer_run_id)')) {
          const pairs: Array<[string, string]> = []
          const heads = (args.length - 10) / 2 // ten contract binds follow the head pairs
          for (let index = 0; index < heads; index += 1) pairs.push([String(args[index * 2]), String(args[index * 2 + 1])])
          this.scanned.push(pairs.map(([date]) => date))
          if (this.failOnCall && this.scanned.length === this.failOnCall) throw new Error('boom')
          return {
            results: pairs.map(([date, run]) => {
              const labels = this.gaps.has(date) ? 99 : 100
              return {
                signal_date: date, producer_run_id: run, reference_rows: 100, identity_rows: 100,
                matrix_rows: 2500, expected_matrix_rows: 2500, persisted_matrix_rows: 2500,
                horizon_rows: 100, horizon_unavailable_rows: 0, label_rows: labels, label_unavailable_rows: 0,
              }
            }),
          }
        }
        throw new Error(`unexpected all: ${normalized}`)
      },
    }
    return statement
  }
}

class FakeKV {
  store = new Map<string, string>()
  puts = 0
  failGet = false
  failPut = false
  async get(key: string, type?: string) {
    if (this.failGet) throw new Error('kv get down')
    const value = this.store.get(key)
    return value == null ? null : type === 'json' ? JSON.parse(value) : value
  }
  async put(key: string, value: string) {
    this.puts += 1
    if (this.failPut) throw new Error('kv put 429')
    this.store.set(key, value)
  }
  heads(): Record<string, string> { return JSON.parse(this.store.get(KEY) ?? '{"heads":{}}').heads }
}

const envFor = (db: FakeD1, kv?: FakeKV): any => ({ DB: db, KV: kv, MULTI_D1_ACTIVE_DOMAINS: '' })
const scannedDates = (db: FakeD1) => db.scanned.flat()

test('first inspection scans every head and remembers only complete ones', async () => {
  const db = new FakeD1(); const kv = new FakeKV()
  db.gaps.add('2026-07-19')
  const result = await inspectMatureSelectionEvidenceGaps(envFor(db, kv), '2026-07-30')
  assert.equal(result.inspectedDates, 10)
  assert.equal(result.scannedDates, 10)
  assert.deepEqual(result.gaps.map((gap) => gap.signalDate), ['2026-07-19'])
  assert.equal(Object.keys(kv.heads()).length, 9)
  assert.ok(!('2026-07-19|screener-9' in kv.heads()))
  assert.equal(kv.puts, 2)
})

test('later inspections scan unverified heads plus one rolling page of the oldest verifications', async () => {
  const db = new FakeD1(); const kv = new FakeKV()
  db.gaps.add('2026-07-19')
  await inspectMatureSelectionEvidenceGaps(envFor(db, kv), '2026-07-30')
  db.scanned = []
  const result = await inspectMatureSelectionEvidenceGaps(envFor(db, kv), '2026-07-30')
  assert.equal(result.inspectedDates, 10)
  assert.equal(result.scannedDates, 9)
  // 2026-07-18 was verified last (second page), so it is the one head skipped.
  assert.deepEqual(scannedDates(db).sort(), HEADS.map((head) => head.signal_date).filter((date) => date !== '2026-07-18'))
  assert.deepEqual(result.gaps.map((gap) => gap.signalDate), ['2026-07-19'])
})

test('a verified head that regresses is reported and forgotten', async () => {
  const db = new FakeD1(); const kv = new FakeKV()
  await inspectMatureSelectionEvidenceGaps(envFor(db, kv), '2026-07-30')
  db.gaps.add('2026-07-10')
  const result = await inspectMatureSelectionEvidenceGaps(envFor(db, kv), '2026-07-30')
  assert.deepEqual(result.gaps.map((gap) => gap.signalDate), ['2026-07-10'])
  assert.ok(!('2026-07-10|screener-0' in kv.heads()))
})

test('a page that fails keeps the verifications of earlier pages', async () => {
  const db = new FakeD1(); const kv = new FakeKV()
  db.failOnCall = 2
  await assert.rejects(inspectMatureSelectionEvidenceGaps(envFor(db, kv), '2026-07-30'), /boom/)
  assert.deepEqual(Object.keys(kv.heads()).sort(), HEADS.slice(0, 8).map((head) => `${head.signal_date}|${head.run_id}`))
})

test('another contract version, dropped heads and a missing KV fall back safely', async () => {
  const db = new FakeD1(); const kv = new FakeKV()
  kv.store.set(KEY, JSON.stringify({ contract: 'old', heads: Object.fromEntries(HEADS.map((head) => [`${head.signal_date}|${head.run_id}`, '2026-01-01T00:00:00.000Z'])) }))
  assert.equal((await inspectMatureSelectionEvidenceGaps(envFor(db, kv), '2026-07-30')).scannedDates, 10)
  db.heads = HEADS.slice(2)
  await inspectMatureSelectionEvidenceGaps(envFor(db, kv), '2026-07-30')
  assert.ok(!('2026-07-10|screener-0' in kv.heads()))
  const plain = new FakeD1()
  assert.equal((await inspectMatureSelectionEvidenceGaps(envFor(plain), '2026-07-30')).scannedDates, 10)
  assert.equal((await inspectMatureSelectionEvidenceGaps(envFor(plain), '2026-07-30')).scannedDates, 10)
})

test('unverified heads are scanned before the recheck page', async () => {
  const db = new FakeD1(); const kv = new FakeKV()
  db.gaps.add('2026-07-19')
  await inspectMatureSelectionEvidenceGaps(envFor(db, kv), '2026-07-30')
  db.scanned = []
  const result = await inspectMatureSelectionEvidenceGaps(envFor(db, kv), '2026-07-30')
  assert.equal(db.scanned[0][0], '2026-07-19')
  assert.deepEqual(result.gaps.map((gap) => gap.signalDate), ['2026-07-19'])
})

test('KV failures fall back to a full scan and never fail the inspection', async () => {
  const db = new FakeD1(); const kv = new FakeKV()
  kv.failGet = true
  db.gaps.add('2026-07-11')
  const unread = await inspectMatureSelectionEvidenceGaps(envFor(db, kv), '2026-07-30')
  assert.equal(unread.scannedDates, 10)
  assert.equal(kv.puts, 0)
  kv.failGet = false; kv.failPut = true
  const unsaved = await inspectMatureSelectionEvidenceGaps(envFor(db, kv), '2026-07-30')
  assert.equal(unsaved.scannedDates, 10)
  assert.deepEqual(unsaved.gaps.map((gap) => gap.signalDate), ['2026-07-11'])
  assert.equal(kv.puts, 1) // stops writing after the first failure
})

test('a historical replay keeps markers newer than its window', async () => {
  const db = new FakeD1(); const kv = new FakeKV()
  await inspectMatureSelectionEvidenceGaps(envFor(db, kv), '2026-07-30')
  db.matureDate = '2026-07-14'; db.heads = HEADS.slice(0, 5)
  await inspectMatureSelectionEvidenceGaps(envFor(db, kv), '2026-07-30')
  assert.equal(Object.keys(kv.heads()).length, 10)
})
