import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const routes = fs.readFileSync('src/routes/adminWriteRoutes.ts', 'utf8')
const learning = fs.readFileSync('src/lib/strategyLearning.ts', 'utf8')
const orchestrator = fs.readFileSync('src/lib/updateOrchestrator.ts', 'utf8')
const types = fs.readFileSync('src/types.ts', 'utf8')

test('historical strategy evidence has a bounded standalone admin lifecycle', () => {
  assert(routes.includes("/api/admin/strategy/evidence-v5/rebuild"))
  assert(routes.includes('X-Confirm-Strategy-Learning'))
  assert(routes.includes("mode: 'dry_run'"))
  assert(routes.includes('listHistoricalStrategyEvidenceV5Dates'))
  assert(routes.includes("type: 'strategy_evidence_rebuild'"))
  assert(routes.includes("mode: 'queued'"))
  assert(routes.includes('UPDATE_QUEUE.sendBatch(candidateDates.map((signalDate)'))
  assert(routes.includes('triggerTime: signalDate'))
  assert(routes.includes('strategyEvidenceMaxDates: 1'))
  assert(routes.includes('queued_dates: candidateDates'))
  assert(routes.includes('never marks evening-chain complete'))
})

test('persisted rebuild runs on the durable queue owner', () => {
  assert(types.includes("| 'strategy_evidence_rebuild'"))
  assert(orchestrator.includes("msg.type === 'strategy_evidence_rebuild'"))
  assert(orchestrator.includes('rebuildHistoricalStrategyEvidenceV5'))
  assert(orchestrator.includes('priorityOnly: true'))
  assert(orchestrator.includes('report.successfulDates !== 1 || report.blockedDates !== 0'))
})

test('historical strategy evidence preview and rebuild share one eligibility owner', () => {
  assert(learning.includes('export async function listHistoricalStrategyEvidenceV5Dates'))
  assert(learning.includes('const candidateDates = await listHistoricalStrategyEvidenceV5Dates(db, options)'))
  assert(learning.includes("COALESCE(r.evaluation_contract_version, '') <> 'strategy-evaluation-v2'"))
  assert(learning.includes("r.status NOT IN ('success','blocked')"))
  assert(learning.includes('Math.min(5'))
})

test('standalone route does not call the chain finalizer', () => {
  const route = routes.slice(routes.indexOf("/api/admin/strategy/evidence-v5/rebuild"), routes.indexOf("/api/admin/strategy/reward-ledger/refresh"))
  assert(!route.includes('finalizeStrategyLearningEvidenceV5'))
})

test('marginal edge refresh is evidence-only and cannot promote', () => {
  const route = routes.slice(
    routes.indexOf("/api/admin/strategy/marginal-edge-v4/refresh"),
    routes.indexOf("/api/admin/strategy/reward-ledger/refresh"),
  )
  assert(route.includes('X-Confirm-Strategy-Learning'))
  assert(route.includes('refreshStrategyMarginalEdgeV4'))
  assert(route.includes('{ allowPromotion: false }'))
  assert(!route.includes('finalizeStrategyLearningEvidenceV5'))
})
