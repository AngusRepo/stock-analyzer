import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const registry = fs.readFileSync(path.join(root, 'src/lib/dataDomainRegistry.ts'), 'utf8')
const schema = fs.readFileSync(path.join(root, 'schema.sql'), 'utf8').replace(/--.*$/gm, '')
const domains = ['core', 'market', 'learning', 'ops', 'execution', 'paper', 'research']
const owner = new Map()
for (const domain of domains) {
  const match = registry.match(new RegExp('\\b' + domain + ': new Set\\(\\[([\\s\\S]*?)\\]\\)', 'm'))
  if (!match) throw new Error('domain registry block missing: ' + domain)
  for (const item of match[1].matchAll(/'([^']+)'/g)) owner.set(item[1], domain)
}
const grouped = Object.fromEntries(domains.map((domain) => [domain, []]))
function stripCrossDomainInlineReferences(statement, domain) {
  return statement.replace(
    /\s+REFERENCES\s+([A-Za-z0-9_]+)\s*\([^)]+\)(?:\s+ON\s+(?:DELETE|UPDATE)\s+[A-Za-z_]+)*/gi,
    (clause, targetTable) => {
      const targetDomain = owner.get(String(targetTable).toLowerCase()) ?? (String(targetTable).startsWith('paper_') ? 'paper' : null)
      if (!targetDomain) throw new Error(`foreign key target has no domain owner: ${targetTable}`)
      return targetDomain === domain ? clause : ''
    },
  )
}
function sqlStatements(input) {
  const output = []
  let current = ''
  let quoted = false
  for (let index = 0; index < input.length; index++) {
    const char = input[index]
    if (char === "'") {
      if (quoted && input[index + 1] === "'") { current += "''"; index++; continue }
      quoted = !quoted
    }
    if (char === ';' && !quoted) { output.push(current); current = ''; continue }
    current += char
  }
  if (current.trim()) output.push(current)
  return output
}
for (const raw of sqlStatements(schema)) {
  const statement = raw.trim()
  if (!statement) continue
  const table = statement.match(/CREATE TABLE IF NOT EXISTS\s+([A-Za-z0-9_]+)/i)?.[1]
    ?? statement.match(/CREATE INDEX IF NOT EXISTS\s+[A-Za-z0-9_]+\s+ON\s+([A-Za-z0-9_]+)/i)?.[1]
    ?? statement.match(/INSERT(?: OR IGNORE)? INTO\s+([A-Za-z0-9_]+)/i)?.[1]
  if (!table) throw new Error('unclassified schema statement: ' + statement.slice(0, 120))
  const domain = owner.get(table) ?? (table.startsWith('paper_') ? 'paper' : null)
  if (!domain) throw new Error('unowned schema table: ' + table)
  grouped[domain].push(stripCrossDomainInlineReferences(statement, domain) + ';')
}
const output = path.join(root, 'domain-schemas')
fs.mkdirSync(output, { recursive: true })
for (const domain of domains) {
  const statements = grouped[domain].join('\n\n')
  const rendered = ('-- Generated from schema.sql; do not edit by hand.\n' + statements + (statements ? '\n' : ''))
    .replace(/[ \t]+$/gm, '')
  fs.writeFileSync(path.join(output, domain + '.sql'), rendered)
  console.log(domain + ': ' + grouped[domain].length + ' statements')
}
