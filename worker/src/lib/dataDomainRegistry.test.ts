import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  activeDataDomains,
  assertSingleDomainOwnership,
  databaseForDataDomain,
  dataDomainForTable,
  shadowDatabaseForDataDomain,
  MULTI_D1_STRICT_ROUTING_READY,
  tablesForDataDomain,
} from './dataDomainRegistry'

const sqlFiles = [
  'schema.sql',
  ...fs.readdirSync('migrations')
    .filter((name) => name.endsWith('.sql'))
    .map((name) => path.join('migrations', name)),
]
const tableNames = [...new Set(sqlFiles.flatMap((file) => (
  [...fs.readFileSync(file, 'utf8').matchAll(/^CREATE TABLE IF NOT EXISTS\s+([A-Za-z0-9_]+)/gm)]
    .map((match) => match[1].toLowerCase())
)))]
assertSingleDomainOwnership(tableNames)

for (const table of new Set(tableNames)) {
  const owner = dataDomainForTable(table)
  if (!owner) throw new Error(`missing owner for ${table}`)
  if (!tablesForDataDomain(owner).includes(table) && !table.startsWith('paper_')) {
    throw new Error(`registry reverse lookup mismatch for ${table}`)
  }
}

if (dataDomainForTable('unknown_future_table') !== null) {
  throw new Error('unknown tables must fail closed instead of silently defaulting to core')
}

const legacy = { kind: 'legacy' } as unknown as D1Database
const market = { kind: 'market' } as unknown as D1Database
const shadowEnv = { DB: legacy, MARKET_DB: market }
assert.equal(databaseForDataDomain(shadowEnv, 'market'), legacy)
assert.equal(shadowDatabaseForDataDomain(shadowEnv, 'market'), market)
assert.equal(databaseForDataDomain({ ...shadowEnv, MULTI_D1_ACTIVE_DOMAINS: 'market' }, 'market'), market)
assert(activeDataDomains({ MULTI_D1_ACTIVE_DOMAINS: ' market,ops ' }).has('ops'))
assert.throws(() => databaseForDataDomain({ DB: legacy, MULTI_D1_ACTIVE_DOMAINS: 'learning' }, 'learning'), /data_domain_binding_missing:learning/)

assert.equal(MULTI_D1_STRICT_ROUTING_READY, false)
assert.throws(
  () => databaseForDataDomain({ ...shadowEnv, MULTI_D1_STRICT: 'true' }, 'market'),
  /multi_d1_strict_routing_not_closed/,
)
