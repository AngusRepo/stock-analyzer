import assert from 'node:assert/strict'
import test from 'node:test'
import { navOwnsStrategyReplacement } from './strategyAtomicNavReceipt'

function db(owner: string | null, adoption: Record<string, unknown> | null = null): D1Database {
  return {
    prepare(sql: string) {
      return {
        async first() {
          if (sql.includes('strategy_replacement_authority_v1')) return owner ? { owner } : null
          if (sql.includes('strategy_atomic_nav_adoptions_v1')) return adoption
          throw new Error('unexpected query')
        },
      }
    },
  } as unknown as D1Database
}

test('Paper NAV governance is active before any NAV PASS adoption', async () => {
  assert.equal(await navOwnsStrategyReplacement(db('original_paired_daily_nav')), true)
})

test('missing authority never revives legacy V7', async () => {
  await assert.rejects(navOwnsStrategyReplacement(db(null)), /strategy_replacement_nav_authority_missing/)
})

test('invalid historical adoption receipt cannot be treated as valid', async () => {
  await assert.rejects(navOwnsStrategyReplacement(db('original_paired_daily_nav', {
    receipt_json: '{}', receipt_checksum: 'invalid',
  })), /strategy_atomic_nav_receipt_invalid/)
})
