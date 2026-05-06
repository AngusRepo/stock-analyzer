import { formatDebateEvent, formatExecutionStatusEvent, parseExecutionEvent } from './executionEvent'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const requote = formatExecutionStatusEvent('requote', 'limit_up_chase:9.8%', '100->98')
assert(requote === 'execution:requote:limit_up_chase-9.8%:100->98', 'execution event should sanitize separators')

const parsed = parseExecutionEvent(requote)
assert(parsed?.kind === 'execution', 'parser should recover execution kind')
assert(parsed?.status === 'requote', 'parser should recover status')
assert(parsed?.reason === 'limit_up_chase-9.8%', 'parser should recover sanitized reason')
assert(parsed?.detail === '100->98', 'parser should recover detail')

const debate = parseExecutionEvent(formatDebateEvent('failed', 'controller_unavailable'))
assert(debate?.kind === 'debate' && debate.status === 'failed', 'debate event should parse')
