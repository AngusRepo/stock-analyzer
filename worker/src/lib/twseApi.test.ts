import { parseTpexDailyQuoteRows } from './twseApi'
import fs from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  const source = fs.readFileSync('src/lib/twseApi.ts', 'utf8')
  assert(!source.includes("SET market='EMERGING'"), 'bulk update must not write unsupported EMERGING into stocks.market')
}

{
  const rows = parseTpexDailyQuoteRows([
    {
      Date: '1150430',
      SecuritiesCompanyCode: '7584',
      Open: '32.80',
      High: '33.75',
      Low: '32.00',
      Close: '32.60',
      TradingShares: '48,131',
    },
    {
      Date: '1150430',
      SecuritiesCompanyCode: '00679B',
      Open: '26.77',
      High: '26.83',
      Low: '26.76',
      Close: '26.82',
      TradingShares: '26,068,869',
    },
    {
      Date: '1150430',
      SecuritiesCompanyCode: '006201',
      Open: '42.00',
      High: '43.01',
      Low: '41.96',
      Close: '42.41',
      TradingShares: '743,146',
    },
  ])

  assert(rows.length === 1, 'TPEX parser should keep only 4-digit common stocks')
  assert(rows[0]?.symbol === '7584', 'TPEX parser should keep the common-stock symbol')
  assert(rows[0]?.close === 32.6, 'TPEX parser should parse close price')
}
