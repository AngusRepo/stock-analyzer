import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = process.cwd()
const schema = fs.readFileSync(path.join(root, 'schema.sql'), 'utf8')
const learningSchema = fs.readFileSync(path.join(root, 'domain-schemas/learning.sql'), 'utf8')
const migration = fs.readFileSync(path.join(root, 'migrations/0096_strategy_route_calibration_pending_maturity.sql'), 'utf8')

test('route calibration schemas preserve pending maturity without weakening promotion gates', () => {
  const statusContract = /status TEXT NOT NULL CHECK\(status IN \('pending', 'pending_maturity', 'pass', 'fail', 'promoted'\)\)/
  assert.match(schema, statusContract)
  assert.match(learningSchema, statusContract)
  assert.match(migration, statusContract)
  assert.match(migration, /RENAME TO strategy_route_calibration_head_v1_legacy_0096/)
  assert.match(migration, /INSERT INTO strategy_route_calibration_runs_v1/)
  assert.match(migration, /INSERT INTO strategy_route_calibration_head_v1/)
  assert.match(migration, /FOREIGN KEY\(run_id\) REFERENCES strategy_route_calibration_runs_v1\(run_id\)/)
  assert.doesNotMatch(migration, /BEGIN TRANSACTION|COMMIT;/)
})
