import { normalizeShioajiSnapshot } from './paperIntradayData'

export function displayQuoteSymbols(value: string): string[] {
  const symbols = [...new Set(value.split(',').filter(Boolean))].sort()
  if (symbols.length > 20 || symbols.some(s => !/^[0-9]{4,6}[A-Z]?$/.test(s))) throw new Error('invalid_display_symbols')
  return symbols
}

/** Read-only display projection. Never write execution KV, confirm a quote or create an order. */
export function projectDisplayQuotes(data: Record<string, unknown>, symbols: string[], nowMs: number) {
  const prices: Record<string, {price:number;reference_price:number|null;as_of:string;source:string}> = {}
  for (const symbol of symbols) {
    const quote = normalizeShioajiSnapshot(data[symbol], {includeExecutableBook:false})
    const observed = Date.parse(quote?.quoteTime ?? '')
    if (!quote || !Number.isFinite(observed) || observed>nowMs || nowMs-observed>90_000) continue
    // TickSTKv1 reports price_chg rather than an explicit reference_price.
    const raw = data[symbol] as Record<string, unknown>
    const change = raw.price_chg
    const derived = typeof change === 'number' && Number.isFinite(change) ? quote.last - change : null
    const reference = quote.referencePrice ?? (derived != null && derived > 0 ? Number(derived.toFixed(6)) : null)
    prices[symbol] = {price:quote.last,reference_price:reference,as_of:new Date(observed).toISOString(),source:'shioaji_streaming_display'}
  }
  return prices
}
