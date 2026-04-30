import { summarizeGateChecks } from './deployGate'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  const status = summarizeGateChecks([
    { id: 'compile', status: 'ok', summary: 'ok' },
    { id: 'data_quality', status: 'warn', summary: 'warn' },
  ])
  assert(status === 'warn', 'deploy gate should surface warning checks')
}

{
  const status = summarizeGateChecks([
    { id: 'compile', status: 'ok', summary: 'ok' },
    { id: 'scheduler', status: 'fail', summary: 'failed24h=1' },
  ])
  assert(status === 'fail', 'deploy gate should block on any failed check')
}
