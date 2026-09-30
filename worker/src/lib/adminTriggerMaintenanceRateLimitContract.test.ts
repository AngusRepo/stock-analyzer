import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const source = readFileSync(
  fileURLToPath(new URL('../routes/adminTriggerRoutes.ts', import.meta.url)),
  'utf8',
)

test('D1 shadow backfill has a scoped service-token maintenance bucket', () => {
  assert.match(source, /const authError = await requireServiceToken\(c\)/)
  assert.match(source, /maintenanceBackfill = task === 'data-domain-shadow-backfill'/)
  assert.match(source, /'admin-maintenance:data-domain-shadow-backfill'/)
  assert.match(source, /const rateLimit = maintenanceBackfill \? 500 : minuteTask \? 90 : 100/)
})

test('the broader admin trigger bucket remains 100 per hour', () => {
  assert.match(source, /: 'admin'/)
  assert.doesNotMatch(source, /maintenanceBackfill = task === 'data-domain-shadow-backfill-next'/)
})

test('minute trading tasks have separate bounded hourly budgets', () => {
  assert.match(source, /minuteTask = task === 'intraday-check' \|\| task === 'paired-native-execution'/)
  assert.match(source, /minuteTask \? `admin-minute:\$\{task\}` : 'admin'/)
  assert.match(source, /minuteTask \? 90 : 100/)
})
