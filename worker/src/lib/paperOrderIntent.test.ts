import { buildPaperBuyIntentKey } from './paperOrderIntent'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

assert(
  buildPaperBuyIntentKey('2026-04-28', '2330') === '1:2026-04-28:2330:buy:auto_ml',
  'paper buy intent key should be stable',
)
