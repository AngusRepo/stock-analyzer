import { capEntryToLatestClose } from './entryPricePolicy'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  const capped = capEntryToLatestClose({
    entryPrice: 142.5,
    stopLoss: 125.86,
    target1: 154.98,
    target2: 168,
    latestClose: 135.5,
    maxPremiumPct: 0.01,
  })

  assert(capped.entryPrice === 136.86, 'entry should cap to latest close plus configured premium')
  assert(capped.stopLoss === 120.88, 'stop should scale with the capped entry ratio')
  assert(capped.target1 === 148.85, 'target1 should scale with the capped entry ratio')
  assert(capped.watchPoint === 'Entry capped to latest close + 1.0% (135.5 -> 136.86)', 'cap should leave an auditable watch point')
}

{
  const unchanged = capEntryToLatestClose({
    entryPrice: 100,
    stopLoss: 92,
    target1: 112,
    target2: null,
    latestClose: 100,
    maxPremiumPct: 0.01,
  })

  assert(unchanged.entryPrice === 100, 'entry below cap should stay unchanged')
  assert(unchanged.watchPoint == null, 'unchanged entry should not add a watch point')
}
