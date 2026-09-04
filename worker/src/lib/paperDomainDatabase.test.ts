import assert from 'node:assert/strict'
import { paperDomainDatabase } from './paperDomainDatabase'

const legacy = { name: 'legacy' } as unknown as D1Database
const paper = { name: 'paper' } as unknown as D1Database

assert.equal(paperDomainDatabase({ DB: legacy }), legacy)
assert.equal(paperDomainDatabase({
  DB: legacy,
  PAPER_DB: paper,
  MULTI_D1_ACTIVE_DOMAINS: 'paper',
}), paper, 'paper domain has completed per-domain routing closure and must use PAPER_DB')

console.log('paper domain database resolver tests passed')
