import { DEFAULT_RISK_CONFIG } from './riskConfig'
import { validateOrder } from './validateOrder'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

async function run(): Promise<void> {
  {
    const result = await validateOrder({
    symbol: '4953',
    side: 'buy',
    shares: 209,
    limitPrice: 141.6,
    refClose: 141.5,
    avgVolume20d: 100_000,
    }, DEFAULT_RISK_CONFIG)

    assert(result.approved, 'odd-lot buy should be legal when it can be represented as TW order legs')
    assert(result.adjustedOrder?.limitPrice === 141.5, 'buy limit should snap down to legal TW tick')
    assert(!result.violations.some((v) => v.gate === 'G7'), 'G7 must not reject legal odd-lot orders')
  }

  {
    const result = await validateOrder({
    symbol: '4953',
    side: 'sell',
    shares: 3209,
    limitPrice: 141.6,
    refClose: 141.5,
    avgVolume20d: 100_000,
    }, DEFAULT_RISK_CONFIG)

    assert(!result.approved, 'oversized sell should still respect fat-finger cap')
    assert(result.adjustedOrder === null, 'blocked orders should not expose an adjusted order')
    assert(result.violations.some((v) => v.gate === 'G5'), 'fat-finger cap should remain active')
    assert(!result.violations.some((v) => v.gate === 'G7'), 'mixed board/odd sell quantity should be legal')
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
