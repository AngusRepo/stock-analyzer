import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

// strategy_label_matrix_runs_v4.summary_* counts stay true only while the cells
// change in the two places that refresh them (strategyLabelMatrixRunSummary.ts).
// Any other INSERT/UPDATE/DELETE of matrix cells has to refresh or clear the summary.
const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const ALLOWED = ['worker/src/lib/selectionReferenceEvidence.ts', 'worker/src/lib/strategyLearning.ts']
const SKIP = new Set(['node_modules', '.venv', 'venv', '__pycache__', 'dist', '.wrangler', 'tests', 'fixtures'])
const WRITE = /\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+["`]?strategy_label_matrix_v4\b/i

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* sources(path)
    else if (/\.(ts|mts|js|mjs|py|sql)$/.test(entry.name) && !/\.test\.|^test_|_test\.py$/.test(entry.name)) yield path
  }
}

test('only the summary-refreshing writers touch strategy_label_matrix_v4 cells', () => {
  const writers: string[] = []
  for (const top of ['worker/src', 'ml-controller', 'ml-service', 'tools']) {
    for (const path of sources(join(ROOT, top))) {
      if (WRITE.test(readFileSync(path, 'utf8'))) writers.push(relative(ROOT, path))
    }
  }
  assert.deepEqual(writers.sort(), ALLOWED)
})

test('migrations after the summary columns do not rewrite matrix cells', () => {
  const dir = join(ROOT, 'worker/domain-migrations/learning')
  const later = readdirSync(dir).filter((name) => name.endsWith('.sql') && name > '0065')
  for (const name of later) assert.doesNotMatch(readFileSync(join(dir, name), 'utf8'), WRITE, name)
})
