import {
  describeAllocatorDecision,
  parseAllocatorDecisionWatchPoint,
} from './pendingBuyAllocatorUi.ts'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  const parsed = parseAllocatorDecisionWatchPoint(
    'allocator:replace:replace_weak_holding:target=180000;current=0;budget=150000;replace=1234;weakness=58.5;rank=2;exposure=0.90',
  )
  assert(parsed?.action === 'replace', 'allocator parser should read replacement action')
  assert(parsed?.replaceSymbol === '1234', 'allocator parser should expose replacement symbol')
  assert(parsed?.replaceWeakness === 58.5, 'allocator parser should expose weakness score')
  assert(parsed?.candidateRank === 2, 'allocator parser should expose candidate rank')
}

{
  const summary = describeAllocatorDecision([
    'allocator:add:add_underweight_holding:target=160000;current=90000;budget=70000;rank=1;exposure=0.65',
  ])
  assert(summary?.title.includes('加碼'), 'allocator summary should use zh-TW action wording')
  assert(summary?.detail.includes('目標部位'), 'allocator summary should explain target sizing')
  assert(summary?.tone === 'ok', 'add/buy allocator decisions should use ok tone')
}

{
  const summary = describeAllocatorDecision([
    'allocator:skip:full_book_no_weak_replacement:target=0;current=0;budget=0;exposure=0.45',
  ])
  assert(summary?.title.includes('不新增'), 'skip allocator decisions should say no new slot')
  assert(summary?.tone === 'warn', 'skip allocator decisions should use warn tone')
}
