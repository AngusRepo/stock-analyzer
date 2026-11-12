import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// INDEXED BY turns a missing index into "no such index" instead of a slower plan.
// For the P7 risk check that fails closed and halts trading, so every pinned index
// must stay defined in a domain schema or migration and no migration may drop it.
const worker = fileURLToPath(new URL('../..', import.meta.url))
const repo = join(worker, '..')

function walk(dir: string, keep: (path: string) => boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      return ['node_modules', 'tests', '__pycache__', '.venv'].includes(name) ? [] : walk(path, keep)
    }
    return keep(path) ? [path] : []
  })
}

const sources = [
  ...walk(join(worker, 'src'), (path) => path.endsWith('.ts') && !path.endsWith('.test.ts')),
  ...walk(join(repo, 'ml-controller'), (path) => path.endsWith('.py') && !/\/test_[^/]+\.py$/.test(path)),
]

const pinned = new Map<string, string[]>()
for (const path of sources) {
  const text = readFileSync(path, 'utf8')
  for (const match of text.matchAll(/INDEXED BY (?:\$\{(\w+)\}|(\w+))/g)) {
    // A template parameter resolves through a string constant in the same file.
    const name = match[2] ?? text.match(new RegExp(`const ${match[1]}\\s*=\\s*'(\\w+)'`))?.[1]
    assert.ok(name, `${path}: INDEXED BY \${${match[1]}} does not resolve to a string constant`)
    pinned.set(name, [...(pinned.get(name) ?? []), path.slice(repo.length + 1)])
  }
}
assert.ok(pinned.has('idx_pred_model_verified_date'), 'p7Streak pin not found; the scan pattern is broken')

const ddl = [
  ...walk(join(worker, 'domain-schemas'), (path) => path.endsWith('.sql')),
  ...walk(join(worker, 'domain-migrations'), (path) => path.endsWith('.sql')),
  ...walk(join(worker, 'migrations'), (path) => path.endsWith('.sql')),
].map((path) => ({ path: path.slice(repo.length + 1), text: readFileSync(path, 'utf8') }))

for (const [name, users] of pinned) {
  const created = ddl.some(({ text }) => new RegExp(`CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?${name}\\b`).test(text))
  assert.ok(created, `${name} (INDEXED BY in ${users.join(', ')}) is not created by any domain schema or migration`)
  const drops = ddl.filter(({ text }) => new RegExp(`DROP INDEX (?:IF EXISTS )?${name}\\b`).test(text))
  assert.deepEqual(drops.map(({ path }) => path), [], `${name} is pinned by INDEXED BY in ${users.join(', ')}`)
}
