import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeD1BatchStatement } from './d1BatchStatement'

test('normalizes terminal SQL delimiters without triggering multi-statement fallback', () => {
  assert.deepEqual(
    normalizeD1BatchStatement({ sql: 'INSERT INTO sample (id) VALUES (?);', params: [1] }, 0),
    { sql: 'INSERT INTO sample (id) VALUES (?)', params: [1] },
  )
  assert.deepEqual(
    normalizeD1BatchStatement({ sql: 'UPDATE sample SET id = ?;;;  ', params: [2] }, 1),
    { sql: 'UPDATE sample SET id = ?', params: [2] },
  )
})

test('rejects internal statement delimiters and non-DML verbs', () => {
  assert.throws(
    () => normalizeD1BatchStatement({ sql: 'DELETE FROM sample; DROP TABLE sample;' }, 0),
    /multiple SQL statements are not allowed/,
  )
  assert.throws(
    () => normalizeD1BatchStatement({ sql: 'SELECT 1;' }, 0),
    /only INSERT\/UPDATE\/DELETE\/REPLACE are allowed/,
  )
})
