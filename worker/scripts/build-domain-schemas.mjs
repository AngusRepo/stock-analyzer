import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const registry = fs.readFileSync(path.join(root, 'src/lib/dataDomainRegistry.ts'), 'utf8')
const domains = ['core', 'market', 'learning', 'ops', 'execution', 'paper', 'research']
const permanentLegacyControlTable = (table) => (
  table.startsWith('data_domain_') || table.startsWith('domain_projection_')
)
const owner = new Map()
const baselineOwner = new Map()

for (const domain of domains) {
  const match = registry.match(new RegExp('\\b' + domain + ': new Set\\(\\[([\\s\\S]*?)\\]\\)', 'm'))
  if (!match) throw new Error('domain registry block missing: ' + domain)
  for (const item of match[1].matchAll(/'([^']+)'/g)) {
    owner.set(item[1], domain)
    baselineOwner.set(item[1], domain)
  }
}

for (const match of registry.matchAll(/\{\s*table:\s*'([^']+)',\s*domain:\s*'([^']+)'/g)) {
  const [, table, domain] = match
  if (!domains.includes(domain)) throw new Error('invalid explicit ownership domain: ' + domain)
  const existing = owner.get(table)
  if (existing && existing !== domain) throw new Error(`conflicting domain owner: ${table}:${existing}:${domain}`)
  owner.set(table, domain)
}

function stripComments(input) {
  return input.replace(/--.*$/gm, '')
}

function stripRuntimeTriggers(input) {
  // Writer/revision triggers are installed by the cutover control plane after
  // both source and target bindings exist; they are not immutable shard schema.
  return input.replace(/CREATE TRIGGER[\s\S]*?\nEND;/gi, '')
}

function sqlStatements(input) {
  const output = []
  let current = ''
  let quoted = false
  for (let index = 0; index < input.length; index++) {
    const char = input[index]
    if (char === "'") {
      if (quoted && input[index + 1] === "'") {
        current += "''"
        index += 1
        continue
      }
      quoted = !quoted
    }
    if (char === ';' && !quoted) {
      output.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current.trim()) output.push(current)
  return output
}

function statementIdentity(statement) {
  const table = statement.match(/CREATE TABLE(?: IF NOT EXISTS)?\s+([A-Za-z0-9_]+)/i)?.[1]
  if (table) return { kind: 'table', table: table.toLowerCase(), name: table.toLowerCase() }
  const index = statement.match(/CREATE(?:\s+UNIQUE)?\s+INDEX(?: IF NOT EXISTS)?\s+([A-Za-z0-9_]+)\s+ON\s+([A-Za-z0-9_]+)/i)
  if (index) return { kind: 'index', table: index[2].toLowerCase(), name: index[1].toLowerCase() }
  const insert = statement.match(/INSERT(?: OR IGNORE)? INTO\s+([A-Za-z0-9_]+)/i)?.[1]
  if (insert) return { kind: 'insert', table: insert.toLowerCase(), name: insert.toLowerCase() }
  return null
}

function normalizeCreate(statement) {
  return statement
    .replace(/^CREATE TABLE\s+(?!IF NOT EXISTS)/i, 'CREATE TABLE IF NOT EXISTS ')
    .replace(/^CREATE UNIQUE INDEX\s+(?!IF NOT EXISTS)/i, 'CREATE UNIQUE INDEX IF NOT EXISTS ')
    .replace(/^CREATE INDEX\s+(?!IF NOT EXISTS)/i, 'CREATE INDEX IF NOT EXISTS ')
}

function stripCrossDomainInlineReferences(statement, domain) {
  return statement.replace(
    /\s+REFERENCES\s+([A-Za-z0-9_]+)\s*\([^)]+\)(?:\s+ON\s+(?:DELETE|UPDATE)\s+[A-Za-z_]+)*/gi,
    (clause, targetTable) => {
      const normalized = String(targetTable).toLowerCase()
      const targetDomain = owner.get(normalized) ?? (normalized.startsWith('paper_') ? 'paper' : null)
      if (!targetDomain) throw new Error(`foreign key target has no domain owner: ${targetTable}`)
      return targetDomain === domain ? clause : ''
    },
  )
}

const grouped = Object.fromEntries(domains.map((domain) => [domain, []]))
const baselineGrouped = Object.fromEntries(domains.map((domain) => [domain, []]))
const runtimeGrouped = Object.fromEntries(domains.map((domain) => [domain, []]))
const seenTables = new Set()
const seenIndexes = new Set()

function addStatement(raw, source, strict) {
  const statement = raw.trim()
  if (!statement) return
  const identity = statementIdentity(statement)
  if (!identity) {
    if (strict) throw new Error(`unclassified ${source} statement: ${statement.slice(0, 120)}`)
    return
  }
  const domain = owner.get(identity.table) ?? (identity.table.startsWith('paper_') ? 'paper' : null)
  if (!domain) {
    if (permanentLegacyControlTable(identity.table)) return
    if (strict) throw new Error(`unowned schema table: ${identity.table}`)
    return
  }
  if (identity.kind === 'table' && seenTables.has(identity.name)) return
  if (identity.kind === 'index' && seenIndexes.has(identity.name)) return
  if (identity.kind === 'table') seenTables.add(identity.name)
  if (identity.kind === 'index') seenIndexes.add(identity.name)
  const normalized = stripCrossDomainInlineReferences(normalizeCreate(statement), domain) + ';'
  grouped[domain].push(normalized)
  const target = baselineOwner.has(identity.table) ? baselineGrouped : runtimeGrouped
  target[domain].push(normalized)
}

const primary = stripRuntimeTriggers(stripComments(fs.readFileSync(path.join(root, 'schema.sql'), 'utf8')))
for (const statement of sqlStatements(primary)) addStatement(statement, 'primary', true)

const supplementalPath = path.join(root, 'bootstrap/schema.production.snapshot.sql')
if (fs.existsSync(supplementalPath)) {
  const supplemental = stripRuntimeTriggers(stripComments(fs.readFileSync(supplementalPath, 'utf8')))
  for (const statement of sqlStatements(supplemental)) addStatement(statement, 'production snapshot', false)
}

const schemaOutput = path.join(root, 'domain-schemas')
const migrationOutput = path.join(root, 'domain-migrations')
fs.mkdirSync(schemaOutput, { recursive: true })
fs.mkdirSync(migrationOutput, { recursive: true })

for (const domain of domains) {
  const statements = grouped[domain].join('\n\n')
  const body = statements ? statements + '\n' : ''
  const schema = (`-- Generated from schema.sql plus production snapshot fallback; do not edit by hand.\n${body}`)
    .replace(/[ \t]+$/gm, '')
  fs.writeFileSync(path.join(schemaOutput, `${domain}.sql`), schema)

  const domainMigrationDir = path.join(migrationOutput, domain)
  fs.mkdirSync(domainMigrationDir, { recursive: true })
  const migrationPath = path.join(domainMigrationDir, `0001_${domain}_baseline.sql`)
  if (!fs.existsSync(migrationPath)) throw new Error(`immutable domain migration missing: ${migrationPath}`)
  const runtimeMigrationName = '0002_runtime_owned_tables.sql'
  const existingIdentities = new Set(fs.readdirSync(domainMigrationDir)
    .filter((name) => name.endsWith('.sql') && name !== runtimeMigrationName)
    .flatMap((name) => sqlStatements(stripComments(
      fs.readFileSync(path.join(domainMigrationDir, name), 'utf8'),
    )))
    .flatMap((statement) => {
      const identity = statementIdentity(statement.trim())
      return identity ? [`${identity.kind}:${identity.name}`] : []
    }))
  const runtimeStatements = grouped[domain].filter((statement) => {
    const identity = statementIdentity(statement)
    return identity && !existingIdentities.has(`${identity.kind}:${identity.name}`)
  }).join('\n\n')
  const runtimeBody = runtimeStatements ? runtimeStatements + '\n' : ''
  const runtimeMigrationPath = path.join(domainMigrationDir, runtimeMigrationName)
  const runtimeMigration = (`-- Add runtime-owned tables deferred from the immutable domain baseline.\n${runtimeBody}`)
    .replace(/[ \t]+$/gm, '')
  if (!fs.existsSync(runtimeMigrationPath)) {
    fs.writeFileSync(runtimeMigrationPath, runtimeMigration)
  } else if (fs.readFileSync(runtimeMigrationPath, 'utf8') !== runtimeMigration) {
    throw new Error(`immutable domain migration drift: ${runtimeMigrationPath}`)
  }
  console.log(`${domain}: existing=${existingIdentities.size} runtime=${runtimeStatements ? sqlStatements(runtimeStatements).length : 0}`)
}
