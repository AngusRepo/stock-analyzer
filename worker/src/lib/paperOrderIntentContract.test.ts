import assert from 'node:assert'
import { acquirePaperBuyIntent, completePaperBuyIntent } from './paperOrderIntent'

class MissingTableDB {
  prepare() {
    throw new Error('no such table: paper_order_intents')
  }
}

async function run(): Promise<void> {
  {
    const intent = await acquirePaperBuyIntent(
      { DB: new MissingTableDB() } as any,
      '2026-06-16',
      '2330',
    )
    assert.equal(intent.acquired, false)
    assert.equal(intent.fallback, false)
    assert.equal(intent.reason, 'paper_order_intents_missing')
  }

  await assert.rejects(
    () => completePaperBuyIntent(
      { DB: new MissingTableDB() } as any,
      '1:2026-06-16:2330:buy:auto_ml',
      'failed',
    ),
    /paper_order_intents_missing/,
    'completion must not swallow missing intent table',
  )
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
