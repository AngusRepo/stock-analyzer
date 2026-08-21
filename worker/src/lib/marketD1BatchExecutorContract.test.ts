import assert from 'node:assert/strict'
import fs from 'node:fs'

const sources = {
  s12: fs.readFileSync('src/lib/s12RuntimeBars.ts', 'utf8'),
  maintenance: fs.readFileSync('src/lib/localMaintenance.ts', 'utf8'),
  restrictions: fs.readFileSync('src/lib/tradingRestrictions.ts', 'utf8'),
  tags: fs.readFileSync('src/lib/tagReclassifier.ts', 'utf8'),
}

assert(!sources.s12.includes("env.DB.batch(chunk.map((bar) => databaseForDataDomain(env, 'market').prepare"))
assert(sources.s12.includes('marketDb.batch(chunk.map((bar) => marketDb.prepare'))
assert(!/databaseForDataDomain\(env, 'market'\)\.prepare\(`[\s\S]{0,1800}?env\.DB\.batch\(statements/.test(sources.maintenance))
assert(sources.maintenance.includes('await marketDb.batch(statements.slice(i, i + 50))'))
assert(!/databaseForDataDomain\(env, 'market'\)\.prepare\(`[\s\S]{0,1800}?env\.DB\.batch\(statements/.test(sources.restrictions))
assert(sources.restrictions.includes('await marketDb.batch(statements.slice(i, i + 50))'))
assert(!sources.tags.includes('await env.DB.batch(stmts)'))
assert(sources.tags.includes('await marketDb.batch(stmts)'))

console.log('market D1 batch executor contract passed')