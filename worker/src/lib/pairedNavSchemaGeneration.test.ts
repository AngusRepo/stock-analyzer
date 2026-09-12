import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

// An isolated generator workspace: never run the writer against the real repo.
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'nav-schema-generation-'))
const root = path.join(fixture, 'worker')
fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
fs.mkdirSync(path.join(root, 'src/lib'), { recursive: true })
fs.copyFileSync('scripts/build-domain-schemas.mjs', path.join(root, 'scripts/build-domain-schemas.mjs'))
fs.copyFileSync('src/lib/dataDomainRegistry.ts', path.join(root, 'src/lib/dataDomainRegistry.ts'))
const oldHead = fs.readFileSync('domain-migrations/learning/0001_learning_baseline.sql', 'utf8')
  .match(/CREATE TABLE IF NOT EXISTS strategy_route_calibration_head_v1 \([\s\S]*?\n\);/)![0]
fs.writeFileSync(path.join(root, 'schema.sql'), '-- minimal generator fixture\n' + oldHead)
for (const domain of ['core', 'market', 'learning', 'ops', 'execution', 'paper', 'research']) {
  fs.mkdirSync(path.join(root, 'domain-migrations', domain), { recursive: true })
  fs.writeFileSync(path.join(root, 'domain-migrations', domain, `0001_${domain}_baseline.sql`), '-- fixture baseline\n')
}
const names = ['0040_paired_nav_shadow_journal.sql', '0043_paired_nav_lifecycle.sql', '0047_atomic_nav_adoption.sql']
fs.copyFileSync('domain-migrations/learning/0046_route_nav_diagnostic_floor.sql',
  path.join(root, 'domain-migrations/learning/0046_route_nav_diagnostic_floor.sql'))
for (const name of names) fs.copyFileSync(`domain-migrations/learning/${name}`, path.join(root, 'domain-migrations/learning', name))
const run = () => {
  const result = spawnSync(process.execPath, ['scripts/build-domain-schemas.mjs'], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
}
run()
const schema = fs.readFileSync(path.join(root, 'domain-schemas/learning.sql'), 'utf8')
for (const name of names) {
  const original = fs.readFileSync(`domain-migrations/learning/${name}`, 'utf8')
  assert.ok(schema.includes(original.trimEnd()))
  assert.equal(fs.readFileSync(path.join(root, 'domain-migrations/learning', name), 'utf8'), original)
}
assert.ok(schema.includes('paired_nav_lifecycle_no_replace_v1'))
assert.ok(schema.includes('paired_nav_journal_no_replace_v1'))
assert.ok(schema.includes('strategy_atomic_nav_adoptions_no_replace_v1'))
const atomicSql = (text: string) => text.match(/CREATE TABLE IF NOT EXISTS strategy_atomic_nav_adoptions_v1 \([\s\S]*?\n\);|CREATE TRIGGER IF NOT EXISTS strategy_atomic_nav_adoptions_[\s\S]*?END;/g)
const atomicMigration = fs.readFileSync('domain-migrations/learning/0047_atomic_nav_adoption.sql', 'utf8')
for (const file of ['schema.sql', 'domain-schemas/learning.sql'])
  assert.deepEqual(atomicSql(fs.readFileSync(file, 'utf8')), atomicSql(atomicMigration), file)
assert.ok(schema.includes("CHECK(route_floor IS NOT NULL OR artifact_version='strategy-route-nav-adoption-v1')"))
assert.ok(!schema.includes('route_floor REAL NOT NULL'))
run()
assert.equal(fs.readFileSync(path.join(root, 'domain-schemas/learning.sql'), 'utf8'), schema)
console.log('paired NAV schema generation: immutable extensions survive repeat build in isolated fixture', fixture)
