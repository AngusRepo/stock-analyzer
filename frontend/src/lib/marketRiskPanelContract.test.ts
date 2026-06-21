import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const source = readFileSync('src/components/MarketRiskPanel.tsx', 'utf8')

assert(
  source.includes('marketOutlook?:') &&
    source.includes('function MarketOutlookCard') &&
    source.includes('TWII Optimistic Target'),
  'MarketRiskPanel should render the marketOutlook optimistic TWII target from /market/risk',
)

assert(
  source.includes('optimistic_target') &&
    source.includes('upside_pct') &&
    source.includes('target_basis') &&
    source.includes('horizon_trading_days'),
  'MarketRiskPanel should expose target, upside, basis, and horizon for the market outlook',
)
