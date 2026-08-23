import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./selectionReferenceEvidence.ts', import.meta.url), 'utf8')

function csvArity(value: string): number {
  let count = 1
  let quoted = false
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (char === "'") {
      if (quoted && value[index + 1] === "'") {
        index += 1
      } else {
        quoted = !quoted
      }
    } else if (char === ',' && !quoted) {
      count += 1
    }
  }
  return count
}

function assertValuesInsertArity(table: string, expectedPlaceholders: number): void {
  const match = source.match(new RegExp(
    `INSERT(?: OR IGNORE)? INTO ${table}\\s*\\(([\\s\\S]*?)\\)\\s*VALUES\\s*\\(([\\s\\S]*?)\\)`,
  ))
  assert.ok(match, `${table} VALUES INSERT must exist`)
  const columns = csvArity(match[1])
  const values = csvArity(match[2])
  const placeholders = (match[2].match(/\?/g) ?? []).length
  assert.equal(values, columns, `${table} INSERT values must match columns`)
  assert.equal(placeholders, expectedPlaceholders, `${table} INSERT bind arity changed unexpectedly`)
}

assertValuesInsertArity('selection_reference_snapshots_staging_v1', 25)

for (const table of [
  'strategy_label_matrix_staging_v4',
  'selection_reference_snapshots_v1',
  'strategy_label_matrix_v4',
]) {
  assert.match(source, new RegExp(`INSERT INTO ${table}\\s*\\([\\s\\S]*?\\)\\s*SELECT`),
    `${table} must be populated through INSERT SELECT`)
}

assert.match(source, /FROM json_each\(\?\)/, 'matrix staging must retain bounded JSON chunk ingestion')
assert.match(source, /FROM selection_reference_snapshots_staging_v1 st/)
assert.match(source, /FROM strategy_label_matrix_staging_v4 st/)
