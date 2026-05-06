import { buildPaperBuyIntentKey, completePaperBuyIntent, shouldRecoverPaperBuyIntent } from './paperOrderIntent'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

assert(
  buildPaperBuyIntentKey('2026-04-28', '2330') === '1:2026-04-28:2330:buy:auto_ml',
  'paper buy intent key should be stable',
)

assert(
  shouldRecoverPaperBuyIntent({ status: 'failed', updated_at: '2026-04-28 01:01:00' }, new Date('2026-04-28T09:03:00+08:00')),
  'failed intent should be recoverable for retry',
)

assert(
  shouldRecoverPaperBuyIntent({ status: 'running', updated_at: '2026-04-28 01:00:00' }, new Date('2026-04-28T09:20:01+08:00')),
  'stale running intent should be recoverable after timeout',
)

assert(
  !shouldRecoverPaperBuyIntent({ status: 'running', updated_at: '2026-04-28 01:10:00' }, new Date('2026-04-28T09:12:00+08:00')),
  'fresh running intent should not be recovered',
)

assert(
  !shouldRecoverPaperBuyIntent({ status: 'filled', updated_at: '2026-04-28 01:01:00' }, new Date('2026-04-28T09:30:00+08:00')),
  'filled intent must never be recovered',
)

assert(
  !shouldRecoverPaperBuyIntent({ status: 'partial', updated_at: '2026-04-28 01:01:00' }, new Date('2026-04-28T09:30:00+08:00')),
  'partial intent should not be auto-recovered without an explicit remaining-order policy',
)

const partialIntentStatus: Parameters<typeof completePaperBuyIntent>[2] = 'partial'
assert(partialIntentStatus === 'partial', 'completePaperBuyIntent should accept partial status')
