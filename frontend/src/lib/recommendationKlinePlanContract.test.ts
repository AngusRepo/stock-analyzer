import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const card = readFileSync('src/components/RecommendationCardClean.tsx', 'utf8')

assert(card.includes('function positivePrice'), 'K-line plan should normalize price fields before charting')
assert(!card.includes('Number(item.open)'), 'K-line plan must not convert null open to 0')
assert(card.includes('const open = rawOpen ?? prevClose ?? avg ?? close'), 'Missing open should fall back to previous close / avg / close')
assert(card.includes('priceRowsToVolume(rows: any[], candles: KlineCandle[]'), 'Volume color should use derived candles')
assert(!card.includes('createSeriesMarkers(candleSeries'), 'Recommendation K-line plan should not render marker check/circle overlays')
