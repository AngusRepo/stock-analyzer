import assert from 'node:assert/strict'
import fs from 'node:fs'

const wrangler = fs.readFileSync('wrangler.toml', 'utf8')
const expected: Record<string, string> = {
  DB: 'migrations',
  MARKET_DB: 'domain-migrations/market',
  LEARNING_DB: 'domain-migrations/learning',
  OPS_DB: 'domain-migrations/ops',
  CORE_DB: 'domain-migrations/core',
  EXECUTION_DB: 'domain-migrations/execution',
  PAPER_DB: 'domain-migrations/paper',
  RESEARCH_DB: 'domain-migrations/research',
}

for (const [binding, migrationsDir] of Object.entries(expected)) {
  const block = wrangler.match(new RegExp(`\\[\\[d1_databases\\]\\][\\s\\S]*?binding = "${binding}"[\\s\\S]*?(?=\\n\\[\\[|$)`))?.[0]
  assert(block, `missing D1 binding ${binding}`)
  assert.match(block, new RegExp(`migrations_dir = "${migrationsDir.replaceAll('/', '\\/')}"`))
}

const execution = fs.readFileSync('domain-migrations/execution/0001_execution_baseline.sql', 'utf8')
const paper = fs.readFileSync('domain-migrations/paper/0001_paper_baseline.sql', 'utf8')
assert.equal((execution.match(/CREATE TABLE IF NOT EXISTS broker_/g) ?? []).length, 3)
assert.equal((paper.match(/CREATE TABLE IF NOT EXISTS paper_/g) ?? []).length, 11)
assert.match(paper, /CREATE TABLE IF NOT EXISTS paper_execution_events/)
assert.match(paper, /CREATE TABLE IF NOT EXISTS paper_daily_snapshots/)

console.log('domain migration layout contract passed')
