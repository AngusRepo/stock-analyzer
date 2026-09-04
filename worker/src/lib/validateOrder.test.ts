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
    symbol: '2330',
    side: 'buy',
    shares: 301,
    limitPrice: 1000,
    refClose: 1000,
    avgVolume20d: 100_000,
    }, DEFAULT_RISK_CONFIG)

    assert(!result.approved, 'buy order above NT$300,000 must be blocked by G5')
    assert(result.violations.some((v) => v.gate === 'G5'), 'buy-side fat-finger cap must be enforced')
  }

  {
    const result = await validateOrder({
      symbol: '2330',
      side: 'buy',
      shares: 500,
      limitPrice: 800,
      refClose: 800,
      avgVolume20d: 100_000,
      sizingAuthorization: {
        owner: 'sparse_allocator',
        authorizedValue: 400_000,
        portfolioValue: 2_000_000,
      },
    }, DEFAULT_RISK_CONFIG)

    assert(result.approved, 'allocator-authorized NT$400,000 high-price odd-lot target must not be clipped by the manual NT$300,000 guard')
    assert(
      !result.violations.some((v) => v.gate === 'G5'),
      'valid sparse authorization must override only the manual absolute-value guard',
    )
  }

  {
    const result = await validateOrder({
      symbol: '2330',
      side: 'buy',
      shares: 500,
      limitPrice: 800,
      refClose: 800,
      avgVolume20d: 100_000,
      sizingAuthorization: {
        owner: 'sparse_allocator',
        authorizedValue: 400_000,
        portfolioValue: 1_000_000,
      },
    }, DEFAULT_RISK_CONFIG)

    assert(!result.approved, 'sparse authorization must still obey maxSingleNamePct')
    assert(
      result.violations.some((v) => v.gate === 'G5' && v.allowedValue === 250_000),
      'sparse authorization must be bounded by the portfolio single-name limit',
    )
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
