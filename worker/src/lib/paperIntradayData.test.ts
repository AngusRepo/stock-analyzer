import { normalizeShioajiSnapshot } from './paperIntradayData'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  const quote = normalizeShioajiSnapshot({
    price: 299.5,
    open: 305,
    high: 305,
    low: 305,
  })
  assert(quote?.last === 305, 'snapshot price below intraday low must not become executable last price')
  assert(quote.low === 305 && quote.high === 305, 'snapshot OHLC should be preserved')
}

{
  const quote = normalizeShioajiSnapshot({
    close: 299.5,
    open: 305,
    high: 305,
    low: 305,
  })
  assert(quote?.last === 305, 'snapshot close below intraday low must be clamped before execution')
}

{
  const quote = normalizeShioajiSnapshot({
    close: 299.5,
    last: 305,
    open: 305,
    high: 306,
    low: 304,
  })
  assert(quote?.last === 305, 'snapshot last should take precedence over close')
}
