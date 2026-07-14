import { isDayTradeAllowed } from './paperMarketData'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function kvWithEligible(symbols: string[]): KVNamespace {
  return {
    get: async (key: string) => key === 'market:daytrade_eligible' ? JSON.stringify(symbols) : null,
  } as unknown as KVNamespace
}

async function main(): Promise<void> {
  const structuralStop = await isDayTradeAllowed('3556', 2000, 'risk_stop', kvWithEligible(['3556']))
  assert(structuralStop.allowed, 'typed S12 risk exits must not be rejected by human-readable reason text')
  assert(structuralStop.reason === 'daytrade_exit_allowed:risk_stop', 'day-trade result must retain typed exit intent')

  const ineligible = await isDayTradeAllowed('6179', 5000, 'risk_stop', kvWithEligible(['3556']))
  assert(!ineligible.allowed, 'market eligibility remains a hard day-trade requirement')

  const oddLot = await isDayTradeAllowed('3556', 1500, 'take_profit', kvWithEligible(['3556']))
  assert(!oddLot.allowed, 'existing board-lot day-trade contract remains enforced')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
