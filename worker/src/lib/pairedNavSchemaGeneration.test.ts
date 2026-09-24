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
fs.copyFileSync('schema.sql', path.join(root, 'schema.sql'))
for (const domain of ['core', 'market', 'learning', 'ops', 'execution', 'paper', 'research']) {
  fs.mkdirSync(path.join(root, 'domain-migrations', domain), { recursive: true })
  fs.writeFileSync(path.join(root, 'domain-migrations', domain, `0001_${domain}_baseline.sql`), '-- fixture baseline\n')
}
const extensions = {
  ops: ['0019_workers_ai_debate_budget.sql', '0014_retention_history_lookup.sql', '0015_retention_source_release.sql',
    '0016_retention_history_coverage.sql', '0017_ten_year_archive_windows.sql'],
  market: ['0008_retention_source_release.sql', '0009_retention_anchor_index.sql'],
  execution: ['0003_retention_source_release.sql', '0004_retention_reference_indexes.sql'],
  research: ['0005_retention_source_release.sql', '0006_retention_release_lookup.sql'],
  learning: ['0040_paired_nav_shadow_journal.sql', '0043_paired_nav_lifecycle.sql',
    '0046_route_nav_diagnostic_floor.sql', '0047_atomic_nav_adoption.sql',
    '0048_paired_nav_cold_storage.sql', '0049_paired_nav_orphan_archive.sql',
    '0050_retention_source_release.sql', '0051_retention_release_lookup.sql',
    '0052_strategy_paper_nav_authority.sql'],
}
for (const [domain, files] of Object.entries(extensions)) {
  for (const name of files) fs.copyFileSync(`domain-migrations/${domain}/${name}`,
    path.join(root, 'domain-migrations', domain, name))
}
const names = ['0040_paired_nav_shadow_journal.sql', '0043_paired_nav_lifecycle.sql',
  '0047_atomic_nav_adoption.sql', '0048_paired_nav_cold_storage.sql',
  '0049_paired_nav_orphan_archive.sql', '0052_strategy_paper_nav_authority.sql']
// Exercise the real one-line trigger bodies and CASE expressions in primary input.
fs.appendFileSync(path.join(root, 'schema.sql'), '\n' + fs.readFileSync('domain-migrations/learning/0048_paired_nav_cold_storage.sql', 'utf8'))
const run = () => {
  const result = spawnSync(process.execPath, ['scripts/build-domain-schemas.mjs'], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
}
run()
const opsSchema = fs.readFileSync(path.join(root, 'domain-schemas/ops.sql'), 'utf8')
assert.ok(opsSchema.includes('CREATE TABLE IF NOT EXISTS workers_ai_debate_budget_v1'))
const schema = fs.readFileSync(path.join(root, 'domain-schemas/learning.sql'), 'utf8')
for (const name of names) {
  const original = fs.readFileSync(`domain-migrations/learning/${name}`, 'utf8')
  assert.ok(schema.includes(original.trimEnd()))
  assert.equal(fs.readFileSync(path.join(root, 'domain-migrations/learning', name), 'utf8'), original)
}
assert.ok(schema.includes('paired_nav_cold_objects_v1_no_replace'))
assert.ok(schema.includes('paired_nav_orphan_retired_no_manifest'))
assert.ok(schema.includes('paired_nav_parts_retired_no_insert'))
assert.ok(schema.includes('paired_nav_lifecycle_no_replace_v1'))
assert.ok(schema.includes('paired_nav_journal_no_replace_v1'))
assert.ok(schema.includes('strategy_atomic_nav_adoptions_no_replace_v1'))
assert.ok(schema.includes('strategy_replacement_authority_no_update_v1'))
assert.ok(schema.includes('strategy_route_nav_only_head_insert_v1'))
assert.ok(schema.includes('strategy_route_nav_only_head_update_v1'))
assert.ok(schema.includes('strategy_marginal_edge_nav_only_head_insert_v1'))
assert.ok(schema.includes('strategy_marginal_edge_nav_only_head_update_v1'))
const atomicSql = (text: string) => text.replace(/\r\n/g, '\n').match(/CREATE TABLE IF NOT EXISTS strategy_atomic_nav_adoptions_v1 \([\s\S]*?\n\);|CREATE TRIGGER IF NOT EXISTS strategy_atomic_nav_adoptions_[\s\S]*?END;/g)
const atomicMigration = fs.readFileSync('domain-migrations/learning/0047_atomic_nav_adoption.sql', 'utf8')
for (const file of ['schema.sql', 'domain-schemas/learning.sql'])
  assert.deepEqual(atomicSql(fs.readFileSync(file, 'utf8')), atomicSql(atomicMigration), file)
assert.ok(schema.includes("CHECK(route_floor IS NOT NULL OR artifact_version='strategy-route-nav-adoption-v1')"))
assert.ok(!schema.includes('route_floor REAL NOT NULL'))
run()
assert.equal(fs.readFileSync(path.join(root, 'domain-schemas/learning.sql'), 'utf8'), schema)
assert.equal(fs.readFileSync(path.join(root, 'domain-schemas/ops.sql'), 'utf8'), opsSchema)
console.log('paired NAV schema generation: immutable extensions survive repeat build in isolated fixture', fixture)
