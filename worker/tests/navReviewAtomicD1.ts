// Driven by Python's actual _freeze SQL. Isolated workerd D1; no cloud I/O.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { Miniflare } from 'miniflare'

test('original multi-part review is all-or-nothing and idempotent in native D1', async () => {
  const fixture = JSON.parse(fs.readFileSync(process.env.NAV_REVIEW_ATOMIC_FIXTURE!, 'utf8'))
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("isolated") } }',
    d1Databases: ['LEARNING'] })
  try {
    const db = await mf.getD1Database('LEARNING')
    for (const sql of fixture.schema) await db.prepare(sql).run()
    const commit = () => db.batch(fixture.batch.map(([sql, params]: [string, any[]]) => db.prepare(sql).bind(...params)))
    const rows = () => db.prepare('SELECT * FROM paired_nav_review_records_v1').all()
    const parts = () => db.prepare('SELECT * FROM paired_nav_review_parts_v1 ORDER BY part_no').all()
    for (const part of [0, fixture.batch.length - 2]) {
      await db.prepare(`CREATE TRIGGER fail_review_part BEFORE INSERT ON paired_nav_review_parts_v1
        WHEN NEW.part_no=${part} BEGIN SELECT RAISE(ABORT,'fixture_atomic_part_failure'); END`).run()
      await assert.rejects(commit(), /fixture_atomic_part_failure/)
      assert.equal((await rows()).results.length, 0)
      assert.equal((await parts()).results.length, 0)
      await db.prepare('DROP TRIGGER fail_review_part').run()
    }
    await commit()
    const first = await rows()
    const body = (await parts()).results.map(p => p.payload_text).join('')
    assert.equal(body, fixture.raw)
    assert.equal(createHash('sha256').update(body).digest('hex'), fixture.checksum)
    assert.equal(first.results[0].payload_checksum, fixture.checksum)
    await commit() // Same whole record after an acknowledgement loss.
    assert.deepEqual((await rows()).results, first.results)
    assert.equal((await parts()).results.length, fixture.batch.length - 1)
  } finally {
    await mf.dispose()
  }
})
