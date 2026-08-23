import assert from 'node:assert/strict'
import test from 'node:test'
import { loadS12TwCalibrationEvidence } from './s12TwEquityCalibration'

type Row = Record<string, unknown>

class EvidenceStatement {
  private values: unknown[] = []

  constructor(
    readonly sql: string,
    private readonly owner: EvidenceDb,
  ) {}

  bind(...values: unknown[]): EvidenceStatement {
    const bound = new EvidenceStatement(this.sql, this.owner)
    bound.values = values
    return bound
  }

  async first<T>(): Promise<T> {
    const maxId = Math.max(0, ...this.owner.rows.map((row) => Number(row.id)))
    this.owner.onSnapshot?.()
    return { max_id: maxId } as T
  }

  async all<T>(): Promise<{ results: T[] }> {
    const [lastId, snapshotMaxId] = this.values
    const limit = this.values.at(-1)
    this.owner.cursors.push(Number(lastId))
    const page = this.owner.rows
      .filter((row) => Number(row.id) > Number(lastId) && Number(row.id) <= Number(snapshotMaxId))
      .slice(0, Number(limit))
    return { results: page as T[] }
  }
}

class EvidenceDb {
  cursors: number[] = []
  onSnapshot?: () => void

  constructor(readonly rows: Row[]) {}

  prepare(sql: string): EvidenceStatement {
    return new EvidenceStatement(sql, this)
  }
}

function row(id: number): Row {
  return {
    id,
    symbol: String(id).padStart(4, '0'),
    trade_date: id % 2 === 0 ? '2026-08-13' : '2026-08-14',
    assessment_state: 'reaction_ready',
    market: 'LISTED',
    market_segment: 'LISTED',
    alpha_bucket: 'high',
    entry_ms: Date.parse('2026-08-14T01:30:00.000Z'),
    entry_price: 100,
    stop_price: 98,
    pnl_pct: 0.01,
    max_favorable_pct: 0.03,
    max_adverse_pct: -0.01,
    assessment_detail: [
      'atr15m=2',
      'equity_mutation_score=5',
      'vwap_fast_reasons=reclaim|volume',
      'vwap_fast_blockers=',
      'session_60m_move_atr=0.8',
      'session_60m_close_position=0.75',
    ].join(';'),
  }
}

test('loads 129 rows in two keyset pages without duplicates or full JSON hydration', async () => {
  const db = new EvidenceDb(Array.from({ length: 129 }, (_, index) => row(index + 1)))
  db.onSnapshot = () => db.rows.push(row(130))
  const evidence = await loadS12TwCalibrationEvidence(
    db as unknown as D1Database,
    '2026-05-25',
    '2026-08-23',
  )
  assert.equal(evidence.length, 129)
  assert.deepEqual(db.cursors, [0, 128])
  assert.equal(new Set(evidence.map((item) => item.symbol)).size, 129)
  assert.equal(evidence.some((item) => item.symbol === '0130'), false)
  assert.equal(evidence[0].tradeDate, '2026-08-13')
  assert.equal(evidence.at(-1)?.tradeDate, '2026-08-14')
})
