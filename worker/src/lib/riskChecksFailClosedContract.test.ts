import assert from 'node:assert'
import { checkP5Losses } from './riskChecks/p5Losses'
import { checkP6Momentum } from './riskChecks/p6Momentum'
import { checkP7Streak } from './riskChecks/p7Streak'
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

class ThrowingStmt {
  bind() { return this }
  async all() {
    throw new Error('db unavailable')
  }
  async first() {
    throw new Error('db unavailable')
  }
}

class ThrowingDB {
  prepare() { return new ThrowingStmt() }
}

function assertFailClosed(layer: string, result: any) {
  assert(result?.halt === true, `${layer} must halt when risk evidence is unavailable`)
  assert(result?.maxPositionPct === 0, `${layer} must zero position sizing`)
  assert(result?.buyConfThreshold === 1, `${layer} must max buy confidence threshold`)
  assert(result?.sellConfThreshold === 1, `${layer} must max sell confidence threshold`)
  assert(String(result?.reason ?? '').includes(`${layer} risk check unavailable`))
}

async function run(): Promise<void> {
  const db = new ThrowingDB() as unknown as D1Database

  assertFailClosed('P5', await checkP5Losses(db, deps))
  assertFailClosed('P6', await checkP6Momentum(db, deps))
  assertFailClosed('P7', await checkP7Streak(db, DEFAULT_TRADING_CONFIG, deps))
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
