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

function assertInsertArity(table: string, expectedPlaceholders: number): void {
  const match = source.match(new RegExp(
    `INSERT(?: OR IGNORE)? INTO ${table}\\s*\\(([\\s\\S]*?)\\)\\s*VALUES\\s*\\(([\\s\\S]*?)\\)`,
  ))
  assert.ok(match, `${table} INSERT must exist`)
  const columns = csvArity(match[1])
  const values = csvArity(match[2])
  const placeholders = (match[2].match(/\?/g) ?? []).length
  assert.equal(values, columns, `${table} INSERT values must match columns`)
  assert.equal(placeholders, expectedPlaceholders, `${table} INSERT bind arity changed unexpectedly`)
}

assertInsertArity('selection_reference_snapshots_v1', 24)
assertInsertArity('strategy_label_matrix_v4', 26)
