import { explainExecutionEvent } from './executionEvent'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const stale = explainExecutionEvent('execution:stale_quote:stale_quote-59467ms')

assert(stale?.includes('報價過期'), 'stale quote should be shown as a human-readable execution gate')
assert(stale?.includes('59 秒'), 'stale quote should convert raw milliseconds into seconds')
assert(!stale?.includes('59467ms'), 'stale quote should not expose raw millisecond noise in the UI')
