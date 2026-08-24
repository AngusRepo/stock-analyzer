import assert from 'node:assert/strict'
import fs from 'node:fs'

const riskChain = fs.readFileSync('src/lib/riskChain.ts', 'utf8')
const pending = fs.readFileSync('src/lib/pendingBuyOrchestrator.ts', 'utf8')
const paper = fs.readFileSync('src/routes/paper.ts', 'utf8')

assert(riskChain.includes('checkP6Momentum(databases.market, deps)'))
assert(!riskChain.includes('checkP6Momentum(databases.core, deps)'))
assert(pending.includes('checkP6Momentum(databases.market, deps)'))
assert(!pending.includes('checkP6Momentum(databases.core, deps)'))

assert(paper.includes('resolvePendingBuySourceRecoDate('))
assert.match(paper, /FROM daily_recommendations[\s\S]*WHERE date < \?[\s\S]*score_components LIKE '%score_v2%'[\s\S]*ORDER BY date DESC/)
assert.match(paper, /resolvePendingBuySourceRecoDate\([\s\S]*snapshot\.date,[\s\S]*snapshot\.meta/)
assert.match(paper, /enrichPendingBuyContext\([\s\S]*databaseForDataDomain\(c\.env, 'core'\),[\s\S]*databaseForDataDomain\(c\.env, 'market'\)/)
assert(!paper.includes('enrichPendingBuyContext(c.env.DB'))

console.log('pending-buy P6 owner and source-date contracts passed')
