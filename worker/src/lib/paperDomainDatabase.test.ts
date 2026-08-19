import assert from 'node:assert/strict'
import { paperDomainDatabase } from './paperDomainDatabase'

const legacy = { name: 'legacy' } as unknown as D1Database
const paper = { name: 'paper' } as unknown as D1Database

assert.equal(paperDomainDatabase({ DB: legacy }), legacy)
assert.throws(() => paperDomainDatabase({
  DB: legacy,
  PAPER_DB: paper,
  MULTI_D1_ACTIVE_DOMAINS: 'paper',
}), /multi_d1_strict_routing_not_closed/)

console.log('paper domain database resolver tests passed')
