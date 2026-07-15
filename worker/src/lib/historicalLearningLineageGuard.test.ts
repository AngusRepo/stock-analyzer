import {
  evaluateHistoricalLearningLineageBoundary,
  historicalLearningLineageBlockedMessage,
} from './historicalLearningLineageGuard'
import fs from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const preOpen = evaluateHistoricalLearningLineageBoundary({
  task: 'evening-chain',
  signalDate: '2026-07-14',
  nextSessionDate: '2026-07-15',
  nowMs: Date.parse('2026-07-14T17:08:52Z'),
})
assert(preOpen.allowed, '7/14 prediction generated at 7/15 01:08 Taipei must remain pre-open eligible')

const postOpen = evaluateHistoricalLearningLineageBoundary({
  task: 'evening-chain',
  signalDate: '2026-07-14',
  nextSessionDate: '2026-07-15',
  nowMs: Date.parse('2026-07-15T01:08:52Z'),
})
assert(!postOpen.allowed, 'historical full-chain writes after the next market open must be blocked')
assert(
  historicalLearningLineageBlockedMessage(postOpen).includes('allocator-ev-feature-snapshot-backfill'),
  'blocked historical writes must direct operators to snapshot-only repair',
)

const snapshotRepair = evaluateHistoricalLearningLineageBoundary({
  task: 'allocator-ev-feature-snapshot-backfill',
  signalDate: '2026-07-14',
  nextSessionDate: '2026-07-15',
  nowMs: Date.parse('2026-07-15T01:08:52Z'),
})
assert(snapshotRepair.allowed, 'snapshot-only repair must remain available after next open')

const missingCalendarEvidence = evaluateHistoricalLearningLineageBoundary({
  task: 'pipeline',
  signalDate: '2026-07-14',
  nextSessionDate: null,
  nowMs: Date.parse('2026-07-15T01:08:52Z'),
})
assert(!missingCalendarEvidence.allowed, 'historical canonical writes require an actual next-session calendar row')

const adminTriggerRoutes = fs.readFileSync('src/routes/adminTriggerRoutes.ts', 'utf8')
const updateOrchestrator = fs.readFileSync('src/lib/updateOrchestrator.ts', 'utf8')
assert(
  adminTriggerRoutes.includes('historicalLearningLineageDecision(c.env.DB, task, requestedRunDate)'),
  'all manual canonical writers must pass the historical event-time boundary',
)
assert(
  updateOrchestrator.includes("historicalLearningLineageDecision(env.DB, 'evening-chain', twDate)"),
  'direct evening-chain calls must pass the historical event-time boundary',
)
