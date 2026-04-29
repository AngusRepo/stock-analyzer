import { shouldFailClosedPendingDebate } from './pendingDebateSla'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  assert(shouldFailClosedPendingDebate(new Date('2026-04-29T01:09:00.000Z'), 10) === false, '09:09 TW should still allow debate to finish')
  assert(shouldFailClosedPendingDebate(new Date('2026-04-29T01:10:00.000Z'), 10) === true, '09:10 TW should fail closed if debate is still pending')
  assert(shouldFailClosedPendingDebate(new Date('2026-04-29T00:59:00.000Z'), 10) === false, 'before market open should not expire pending debate')
}
