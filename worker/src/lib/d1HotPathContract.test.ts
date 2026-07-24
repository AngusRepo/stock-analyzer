import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve('.')
const lifecycle = readFileSync(join(root, 'src', 'lib', 'artifactLifecycle.ts'), 'utf8')
const routes = readFileSync(join(root, 'src', 'routes', 'other.ts'), 'utf8')
const schema = readFileSync(join(root, 'schema.sql'), 'utf8')
const migration = readFileSync(join(root, 'migrations', '0080_d1_hot_path_indexes.sql'), 'utf8')

assert.match(lifecycle, /q\.status='failed' AND q\.next_attempt_at <= \?/)
assert.match(lifecycle, /q\.status='pending' AND q\.next_attempt_at IS NULL/)
assert.doesNotMatch(
  lifecycle,
  /q\.status IN \('pending','failed'\)[\s\S]*q\.next_attempt_at IS NULL OR/,
  'scrub polling must not combine status IN and nullable retry predicates into one broad scan',
)

assert.doesNotMatch(routes, /SELECT MAX\(date\) as d, COUNT\(\*\) as cnt FROM stock_prices/)
assert.match(routes, /SELECT date FROM stock_prices ORDER BY date DESC LIMIT 1/)
assert.match(routes, /rowCountScope: 'latest_session'/)

for (const source of [schema, migration]) {
  assert.match(source, /idx_screener_funnel_items_date_id/)
  assert.match(source, /ON screener_funnel_items\(date, id\)/)
}

console.log('D1 hot-path contract tests passed')
