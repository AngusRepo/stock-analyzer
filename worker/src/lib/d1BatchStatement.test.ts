import assert from 'node:assert/strict'
import { normalizeSingleD1BatchStatement } from './d1BatchStatement'

assert.equal(
  normalizeSingleD1BatchStatement("UPDATE t SET note='a;b' WHERE id=?; -- terminal", 0),
  "UPDATE t SET note='a;b' WHERE id=?",
)
assert.equal(
  normalizeSingleD1BatchStatement('INSERT INTO t(value) VALUES (?); /* terminal */', 0),
  'INSERT INTO t(value) VALUES (?)',
)
assert.equal(normalizeSingleD1BatchStatement('DELETE FROM t WHERE id=?', 0), 'DELETE FROM t WHERE id=?')
assert.throws(
  () => normalizeSingleD1BatchStatement('UPDATE t SET value=?; DELETE FROM t', 3),
  /statement 3: multiple SQL statements are not allowed/,
)
assert.throws(
  () => normalizeSingleD1BatchStatement('SELECT * FROM t', 1),
  /only INSERT\/UPDATE\/DELETE\/REPLACE/,
)
