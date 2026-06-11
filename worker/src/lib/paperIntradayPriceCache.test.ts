import { clearOpenPositionIntradayPriceCache, putIntradayPrice } from './paperIntradayPriceCache'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

class FakeKV {
  deleted: string[] = []
  putCalls: Array<{ key: string; value: string; ttl?: number }> = []

  async delete(key: string): Promise<void> {
    this.deleted.push(key)
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.putCalls.push({ key, value, ttl: options?.expirationTtl })
  }
}

class FakeStatement {
  bind(): FakeStatement {
    return this
  }

  async all(): Promise<{ results: Array<{ symbol: string }> }> {
    return {
      results: [
        { symbol: '4953' },
        { symbol: '2330' },
        { symbol: '4953' },
      ],
    }
  }
}

class FakeDB {
  prepare(sql: string): FakeStatement {
    assert(sql.includes('paper_positions'), 'cache cleanup should read open paper positions')
    return new FakeStatement()
  }
}

(async () => {
  const writeKv = new FakeKV()
  await putIntradayPrice(writeKv as unknown as KVNamespace, '4953', 134.5, 123)
  assert(writeKv.putCalls.length === 1, 'intraday price cache should write one key')
  assert(writeKv.putCalls[0]?.key === 'intraday:price:4953', 'intraday price cache key should be stable')
  assert(writeKv.putCalls[0]?.value === '134.5', 'intraday price cache value should be stringified')
  assert(writeKv.putCalls[0]?.ttl === 123, 'intraday price cache should preserve ttl')

  const cleanupKv = new FakeKV()
  const result = await clearOpenPositionIntradayPriceCache({
    DB: new FakeDB(),
    KV: cleanupKv,
  } as any)
  assert(cleanupKv.deleted.length === 2, 'cache cleanup should delete unique open-position symbols')
  assert(cleanupKv.deleted.includes('intraday:price:4953'), 'cache cleanup should delete 4953 intraday key')
  assert(cleanupKv.deleted.includes('intraday:price:2330'), 'cache cleanup should delete 2330 intraday key')
  assert(result === 'intraday_price_cache_cleared=2/2', 'cache cleanup summary should be auditable')
})()
