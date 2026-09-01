import assert from 'node:assert/strict'
import fs from 'node:fs'

const recovery = fs.readFileSync('src/lib/pitResidualFunnelEnrichment.ts', 'utf8')
const postMarket = fs.readFileSync('src/lib/postMarketChain.ts', 'utf8')
const admin = fs.readFileSync('src/routes/adminWriteRoutes.ts', 'utf8')

assert(recovery.includes('export async function recoverMissingPitResidualFunnels'))
assert(recovery.includes("authority.stage='pipeline_execution'"))
assert(recovery.includes("authority.status='success'"))
assert(recovery.includes("h.logical_run_key='screener:' || r.date || ':TW:production:market_screener'"))
assert(recovery.includes("receipt.status='success'"))
assert(recovery.includes("decision_effect='none'"))
assert(recovery.includes('availableDates.has(String(row.business_date))'))
assert(recovery.includes('Math.min(5'))
assert(postMarket.includes("'pit-residual-funnel-recovery'"))
assert(postMarket.includes('excludeBusinessDate: ctx.runDate!'))
assert(admin.includes("'/api/admin/pit-residual/funnel-enrichment/recover'"))
assert(admin.includes('requireAdminOrServiceToken(c)'))
assert(admin.includes("decision_effect: 'none'"))
assert(admin.includes('candidate_set_mutation_allowed: false'))

console.log('pit residual funnel recovery contract tests passed')
