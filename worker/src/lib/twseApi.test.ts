import { fetchTpexStockDayAll, parseTpexChipRows, parseTpexDailyQuoteRows, parseTpexHistoricalDailyQuoteRows, parseTwseChipRows } from './twseApi'
import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  const rows = parseTwseChipRows([[
    '2330',
    '台積電',
    '10,000',
    '7,000',
    '3,000',
    '100',
    '50',
    '50',
    '2,000',
    '1,000',
    '1,000',
    '500',
    '300',
    '100',
    '200',
    '900',
    '600',
    '300',
    '4,500',
  ]])

  assert(rows.length === 1, 'TWSE chip parser should keep common stocks')
  assert(rows[0]?.foreign_net === 3000, 'TWSE foreign_net should use official foreign net shares')
  assert(rows[0]?.trust_net === 1000, 'TWSE trust_net should use official trust net shares')
  assert(rows[0]?.dealer_buy === 1200, 'TWSE dealer_buy should include proprietary and hedge buys')
  assert(rows[0]?.dealer_sell === 700, 'TWSE dealer_sell should include proprietary and hedge sells')
  assert(rows[0]?.dealer_net === 500, 'TWSE dealer_net should use official total dealer net shares')
}

{
  const rows = parseTpexChipRows([[
    '4938',
    '和碩',
    '10,000',
    '7,000',
    '3,000',
    '0',
    '0',
    '0',
    '10,000',
    '7,000',
    '3,000',
    '2,000',
    '1,000',
    '1,000',
    '0',
    '0',
    '0',
    '300',
    '100',
    '200',
    '300',
    '100',
    '200',
    '4,200',
  ]])

  assert(rows.length === 1, 'TPEX chip parser should keep common stocks')
  assert(rows[0]?.foreign_net === 3000, 'TPEX foreign_net should use foreign net shares')
  assert(rows[0]?.trust_net === 1000, 'TPEX trust_net should use trust net shares, not foreign total')
  assert(rows[0]?.dealer_net === 200, 'TPEX dealer_net should use dealer total net shares')
}

{
  const source = readFileSync('src/lib/twseApi.ts', 'utf8')
  assert(!source.includes("SET market='EMERGING'"), 'bulk update must not write unsupported EMERGING into stocks.market')
}

{
  const rows = parseTpexHistoricalDailyQuoteRows({
    date: '20260512',
    tables: [{
      data: [
        ['006201', '元大富櫃50', '48.65', '+0.94', '48.80', '49.11', '48.28', '48.62', '568,588'],
        ['7584', '樂意', '101.50', '+1.50', '100.00', '102.00', '99.00', '100.80', '42,000'],
      ],
    }],
  })

  assert(rows.length === 1, 'TPEX historical parser should keep only 4-digit common stocks')
  assert(rows[0]?.symbol === '7584', 'TPEX historical parser should keep common stock symbol')
  assert(rows[0]?.close === 101.5, 'TPEX historical parser should parse close price')
  assert(rows[0]?.avg_price === 100.8, 'TPEX historical parser should parse average price')
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

void (async () => {
  let attempts = 0
  const partial = [{ Date: '1150507', SecuritiesCompanyCode: '1563', Open: '43', High: '44', Low: '42', Close: '43.55', TradingShares: '1,870,291' }]
  const full = Array.from({ length: 701 }, (_, idx) => ({
    Date: '1150507',
    SecuritiesCompanyCode: String(3000 + idx),
    Open: '10.0',
    High: '10.5',
    Low: '9.8',
    Close: '10.2',
    TradingShares: '1,000',
  }))
  const makeResponse = (body: unknown) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  }) as Response

  const rows = await fetchTpexStockDayAll({
    minRows: 700,
    maxReadinessAttempts: 2,
    readinessDelayMs: 0,
    fetcher: async () => {
      attempts += 1
      return makeResponse(attempts === 1 ? partial : full)
    },
  })

  assert(attempts === 2, 'TPEX quote fetch should retry an incomplete partial feed before returning')
  assert(rows.length === 701, 'TPEX quote fetch should return the complete feed after readiness retry')
})()

void (async () => {
  const latest = Array.from({ length: 701 }, (_, idx) => ({
    Date: '1150507',
    SecuritiesCompanyCode: String(3000 + idx),
    Open: '10.0',
    High: '10.5',
    Low: '9.8',
    Close: '10.2',
    TradingShares: '1,000',
  }))
  const fallbackRows = Array.from({ length: 701 }, (_, idx) => [
    String(3000 + idx),
    `Stock ${idx}`,
    '12.2',
    '+0.1',
    '12.0',
    '12.5',
    '11.8',
    '12.1',
    '1,000',
  ])
  let latestCalls = 0
  let fallbackCalls = 0
  const makeResponse = (body: unknown) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  }) as Response

  const rows = await fetchTpexStockDayAll({
    date: '2026-05-12',
    minRows: 700,
    maxReadinessAttempts: 1,
    readinessDelayMs: 0,
    fetcher: async () => {
      latestCalls += 1
      return makeResponse(latest)
    },
    fallbackFetcher: async () => {
      fallbackCalls += 1
      return makeResponse({ date: '20260512', tables: [{ data: fallbackRows }] })
    },
  })

  assert(latestCalls === 1, 'TPEX latest should be attempted first')
  assert(fallbackCalls === 1, 'TPEX date-specific fallback should run when latest date is stale')
  assert(rows.length === 701, 'TPEX date-specific fallback should return complete requested-date rows')
  assert(rows[0]?.close === 12.2, 'TPEX fallback rows should replace stale latest rows')
})()
