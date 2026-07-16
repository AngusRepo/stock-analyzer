import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const workerDir = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const snapshot = readFileSync(resolve(workerDir, 'schema.production.snapshot.sql'), 'utf8')
const tableCount = [...snapshot.matchAll(/CREATE TABLE\s+/gi)].length
const indexCount = [...snapshot.matchAll(/CREATE (?:UNIQUE )?INDEX\s+/gi)].length
const viewCount = [...snapshot.matchAll(/CREATE VIEW\s+/gi)].length
assert.equal(tableCount, 157, 'canonical snapshot table inventory drifted')
assert.equal(indexCount, 223, 'canonical snapshot index inventory drifted')
assert.equal(viewCount, 1, 'canonical snapshot view inventory drifted')

const manifest = readFileSync(resolve(workerDir, 'legacy-migrations.manifest.txt'), 'utf8')
  .split(/\r?\n/)
  .filter((line) => line && !line.startsWith('#'))
  .map((line) => {
    const [sha256, name] = line.split(/\s{2,}/)
    return { sha256, name }
  })
const actualLegacy = readdirSync(workerDir).filter((name) => /^migration_.*\.sql$/.test(name)).sort()
assert.deepEqual(actualLegacy, manifest.map((entry) => entry.name), 'legacy flat migration inventory changed')
for (const entry of manifest) {
  const canonicalSql = readFileSync(resolve(workerDir, entry.name), 'utf8').replace(/\r\n?/g, '\n')
  const digest = createHash('sha256').update(canonicalSql, 'utf8').digest('hex')
  assert.equal(digest, entry.sha256, `legacy migration mutated: ${entry.name}`)
}

const ordered = readdirSync(resolve(workerDir, 'migrations')).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort()
assert(ordered.length > 0, 'ordered migration directory must not be empty')
assert.equal(new Set(ordered.map((name) => name.slice(0, 4))).size, ordered.length, 'migration sequence numbers must be unique')
