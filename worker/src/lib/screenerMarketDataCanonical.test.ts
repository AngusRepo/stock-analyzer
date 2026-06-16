import {
  canonicalChipRowsToFmChips,
  chipIdentity,
  type CanonicalScreenerChip,
  type CanonicalScreenerPrice,
  mergeCanonicalFirstChips,
} from './screenerMarketData'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const canonical = canonicalChipRowsToFmChips(
  [
    {
      stock_id: '2330',
      date: '2026-05-15',
      market_segment: 'LISTED',
      foreign_net: 1000,
      trust_net: -200,
      dealer_net: 300,
      source: 'finlab.institutional_investors_trading_summary',
    },
  ],
  [
    {
      stock_id: '6682',
      date: '2026-05-15',
      market_segment: 'EMERGING',
      net_shares: 12000,
      estimated_amount: 180000,
      broker_count: 9,
      concentration: 0.6,
      source: 'finlab.rotc_broker_transactions',
    },
    {
      stock_id: '9999',
      date: '2026-05-15',
      market_segment: 'EMERGING',
      net_shares: 0,
      estimated_amount: 0,
      broker_count: 4,
      concentration: 0.4,
      source: 'finlab.rotc_broker_transactions',
    },
  ],
)

assert(canonical.length === 5, 'canonical rows should convert institutional and ROTC broker flow into canonical chip rows')
const canonicalChip: CanonicalScreenerChip = canonical[0]
const canonicalPrice: CanonicalScreenerPrice = {
  date: '2026-05-15',
  stock_id: '2330',
  Trading_Volume: 1000,
  Trading_money: 100000,
  open: 100,
  max: 101,
  min: 99,
  close: 100,
  spread: 0,
  Trading_turnover: 0,
}
assert(canonicalChip.stock_id === '2330' && canonicalPrice.stock_id === '2330', 'screener should expose canonical adapter types, with FM aliases kept only for backward compatibility')
assert(canonical.some(row => row.name === 'broker_flow' && row.stock_id === '6682'), 'ROTC broker flow must become broker_flow chip input')
assert(canonical.find(row => row.name === 'broker_flow' && row.stock_id === '6682')?.broker_count === 9, 'broker_count should be preserved for watch points')
assert(canonical.find(row => row.name === 'broker_flow' && row.stock_id === '9999')?.concentration === 0.4, 'zero-net broker rows should preserve metadata evidence')

const fallback = [
  { date: '2026-05-15', stock_id: '2330', name: 'foreign', buy: 1, sell: 0, source: 'legacy.chip_data' },
  { date: '2026-05-15', stock_id: '9999', name: 'foreign', buy: 2, sell: 0, source: 'legacy.chip_data' },
]
const merged = mergeCanonicalFirstChips(canonical, fallback)

assert(merged.filter(row => chipIdentity(row) === '2330|2026-05-15|foreign').length === 1, 'canonical chip should override same legacy chip identity')
assert(merged.some(row => row.stock_id === '9999'), 'legacy chip rows should remain when canonical is absent')
