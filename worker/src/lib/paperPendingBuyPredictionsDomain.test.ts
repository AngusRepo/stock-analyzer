import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

// predictions is a learning-domain table. The pending-buys enrichment used to join it
// with core daily_recommendations in one statement on the core DB, which failed after
// the domain split and was swallowed by .catch, so the enrichment was always empty.
const source = readFileSync('src/routes/paper.ts', 'utf8')
const schema = readFileSync('domain-schemas/learning.sql', 'utf8')
const enrich = source.slice(source.indexOf('async function enrichPendingBuyContext('), source.indexOf('const contextBySymbol = new Map'))

test('pending-buys enrichment reads predictions from learning-db only', () => {
  assert.ok(enrich.length > 0)
  for (const statement of enrich.split('.prepare(`').slice(1)) {
    const sql = statement.slice(0, statement.indexOf('`)'))
    if (!/\bFROM predictions\b/.test(sql)) continue
    assert.doesNotMatch(sql, /daily_recommendations|\bstocks\b/, 'predictions must not share a statement with core tables')
  }
  const callers = [...enrich.matchAll(/await (\w+)\.prepare\(`[\s\S]*?`\)/g)]
  const predictionCallers = callers.filter((match) => /\bFROM predictions\b/.test(match[0])).map((match) => match[1])
  assert.deepEqual(predictionCallers, ['learningDb', 'learningDb'])
  assert.match(source, /enrichPendingBuyContext\(\s*databaseForDataDomain\(c\.env, 'core'\),\s*databaseForDataDomain\(c\.env, 'learning'\),/)
})

test('ensemble lookup seeks the prediction_date index', () => {
  const sql = enrich.match(/learningDb\.prepare\(`(\s*WITH keys[\s\S]*?)`\)/)?.[1]
  assert.ok(sql, 'ensemble lookup SQL not found')
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(schema.match(/CREATE TABLE IF NOT EXISTS predictions \([\s\S]*?\n\);/)![0])
    for (const index of schema.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS \w+\s+ON predictions\s*\([^;]*\);/g)) db.exec(index[0])
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql.replace('${keyPlaceholders}', '(?, ?),(?, ?)')}`)
      .all('2026-11-12', 1, '2026-11-12', 2).map((row) => String(row.detail))
    assert.ok(plan.some((detail) => /^SEARCH p /.test(detail) && /prediction_date=\?/.test(detail)), plan.join(' | '))
    assert.ok(!plan.some((detail) => /^SCAN p\b/.test(detail)), plan.join(' | '))
  } finally {
    db.close()
  }
})
