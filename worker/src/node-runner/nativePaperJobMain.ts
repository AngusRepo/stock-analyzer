import { createInterface } from 'node:readline'
import { webcrypto } from 'node:crypto'
import * as process from 'node:process'
import { runSealedPaperFrames } from './sealedPaperBindings'
import { DATA_DOMAINS, tablesForDataDomainRouteReady } from '../lib/dataDomainRegistry'

// Private parent-child protocol only. No argv URL, REST credentials, or network
// adapter is accepted. Existing native log output must not corrupt the protocol.
if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto })
console.log = console.warn = console.error = () => undefined
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
let sequence = 0
let started = false
let hostClock = NaN
const lines = createInterface({ input: process.stdin })
const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n')
const bridge = (op: string, payload: Record<string, unknown>) => new Promise((resolve, reject) => {
  const id = ++sequence
  pending.set(id, { resolve, reject })
  emit({ type: 'request', id, op, payload })
})
lines.on('line', line => {
  let packet: any
  try { packet = JSON.parse(line) } catch { process.exit(2) }
  if (!started) {
    started = true
    if (packet.type === 'manifest') {
      emit({ type: 'manifest', tables: Object.fromEntries(DATA_DOMAINS.flatMap(domain =>
        tablesForDataDomainRouteReady(domain).map(table => [table, domain]))) })
      process.exit(0)
    }
    runSealedPaperFrames(bridge, packet, () => hostClock).then(result => {
      emit({ type: 'complete', result }); process.exit(0)
    }, error => {
      emit({ type: 'failed', error: String(error?.message ?? error) }); process.exit(1)
    })
    return
  }
  const waiter = pending.get(packet.id)
  if (!waiter) { emit({ type: 'failed', error: 'sealed_paper_unmatched_reply' }); process.exit(2) }
  pending.delete(packet.id)
  if (packet.error) waiter.reject(new Error(packet.error))
  else {
    if (!Number.isFinite(packet.clock_ms) || (Number.isFinite(hostClock) && packet.clock_ms < hostClock)) {
      waiter.reject(new Error('sealed_paper_host_clock_invalid'))
      return
    }
    hostClock = packet.clock_ms
    waiter.resolve(packet.result)
  }
})
lines.on('close', () => {
  for (const waiter of pending.values()) waiter.reject(new Error('sealed_paper_parent_closed'))
})
