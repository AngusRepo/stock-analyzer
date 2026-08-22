import fs from 'node:fs'

const source = fs.readFileSync('src/lib/auditJsonArchive.ts', 'utf8')
if (!source.includes("databaseForTable(env, target.table)")) {
  throw new Error('audit JSON payload scans and scrubs must use the current table owner D1')
}
if (!source.includes("const opsDb = databaseForDataDomain(env, 'ops')")) {
  throw new Error('audit JSON retention cursors and run ledgers must use Ops D1')
}
if (source.includes('env.DB.prepare')) {
  throw new Error('audit JSON retention must not hard-code legacy DB after domain cutover')
}
