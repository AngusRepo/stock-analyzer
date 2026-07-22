import fs from 'node:fs'
import {
  assertSingleDomainOwnership,
  dataDomainForTable,
  tablesForDataDomain,
} from './dataDomainRegistry'

const schema = fs.readFileSync('schema.sql', 'utf8')
const tableNames = [...schema.matchAll(/^CREATE TABLE IF NOT EXISTS\s+([A-Za-z0-9_]+)/gm)]
  .map((match) => match[1].toLowerCase())
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
