import assert from 'node:assert'
import { checkP2Accuracy } from './riskChecks/p2Accuracy'
import { DEFAULT_TRADING_CONFIG } from './tradingConfig'

const deps = {
  defaults: {
    halt: false,
    maxPositionPct: 0.08,
    buyConfThreshold: 0.6,
    sellConfThreshold: 0.65,
  },
  effectiveBuy: 0.6,
  effectiveSell: 0.65,
}

class FakeStmt {
  constructor(private row: any, private error?: Error) {}
  bind() { return this }
  async first() {
    if (this.error) throw this.error
    return this.row
  }
}

class FakeDB {
  constructor(private row: any, private error?: Error) {}
  prepare() { return new FakeStmt(this.row, this.error) }
}

class FakeKV {
  constructor(private value: any) {}
  async get(_key: string, mode?: string) {
    if (this.value instanceof Error) throw this.value
    if (this.value == null) return null
    return mode === 'json' ? this.value : JSON.stringify(this.value)
  }
}

async function run(): Promise<void> {
  {
    const result = await checkP2Accuracy(
      new FakeDB(null) as unknown as D1Database,
      new FakeKV(null) as unknown as KVNamespace,
      DEFAULT_TRADING_CONFIG,
      deps,
    )
    assert(result?.halt === true, 'missing adaptive params and model_accuracy must fail closed')
    assert(String(result?.reason ?? '').includes('evidence unavailable'))
  }

  {
    const result = await checkP2Accuracy(
      new FakeDB({ accuracy: 0.4, samples: 80 }) as unknown as D1Database,
      new FakeKV(null) as unknown as KVNamespace,
      DEFAULT_TRADING_CONFIG,
      deps,
    )
    assert(result?.halt !== true, 'available model_accuracy evidence should avoid hard halt')
    assert(result?.buyConfThreshold === DEFAULT_TRADING_CONFIG.circuit.drawdownRaisedConf)
    assert(String(result?.reason ?? '').includes('model_accuracy.active9'))
  }

  {
    const result = await checkP2Accuracy(
      new FakeDB({ accuracy: 0.8, samples: 80 }) as unknown as D1Database,
      new FakeKV(null) as unknown as KVNamespace,
      DEFAULT_TRADING_CONFIG,
      deps,
    )
    assert(result === null, 'healthy active-9 model_accuracy should pass P2')
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
