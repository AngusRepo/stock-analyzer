import {
  evaluateHistoricalLearningLineageBoundary,
  historicalLearningLineageBlockedMessage,
  historicalLearningLineageDecision,
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
  adminTriggerRoutes.includes("routes.get('/api/admin/historical-lineage-boundary'")
    && adminTriggerRoutes.includes("calendar_owner: 'worker.schedulerPolicy.nextTwTradingDate'"),
  'controller snapshot recovery must read the existing Worker calendar owner without triggering a pipeline',
)
assert(
  adminTriggerRoutes.includes("historicalLearningLineageDecision(databaseForDataDomain(c.env, 'market'), c.env.KV, task, requestedRunDate)"),
  'all manual canonical writers must pass the historical event-time boundary',
)
assert(
  updateOrchestrator.includes("historicalLearningLineageDecision(databaseForDataDomain(env, 'market'), env.KV, 'evening-chain', twDate)"),
  'direct evening-chain calls must pass the historical event-time boundary',
)

void (async () => {
  const nowMs = Date.parse('2026-07-18T04:00:00Z')
  const db = {
    prepare() {
      return {
        bind() {
          return { first: async () => null }
        },
      }
    },
  } as unknown as D1Database
  const kv = {
    get: async (key: string) => key === 'market:twse_holiday_schedule:v2:2026'
      ? {
          schemaVersion: 'twse-holiday-schedule-v2',
          dates: [],
          loadedAt: '2026-07-18T00:00:00Z',
          source: 'twse.openapi.holidaySchedule',
        }
      : null,
  } as unknown as KVNamespace

  const decision = await historicalLearningLineageDecision(
    db,
    kv,
    'evening-chain',
    '2026-07-17',
    nowMs,
  )
  assert(decision.allowed, 'weekend rerun before Monday open must remain legal')
  assert(decision.nextSessionDate === '2026-07-20', `expected 7/20 next session, got ${decision.nextSessionDate}`)
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
void (async () => {
  const { createAdminTriggerRoutes } = await import('../routes/adminTriggerRoutes')
  let marketReads = 0
  const routes = createAdminTriggerRoutes({ buildTaskMap: () => ({}) })
  const response = await routes.request('/api/admin/historical-lineage-boundary?task=pipeline&date=2026-07-14', {}, {
    LOCAL_AUTH_BYPASS: '1', ENVIRONMENT: 'test', MULTI_D1_ACTIVE_DOMAINS: 'market', MULTI_D1_STRICT: 'true',
    DB: { prepare() { throw new Error('legacy calendar must not be read') } },
    MARKET_DB: { prepare(sql: string) {
      assert(sql.includes('FROM canonical_market_daily'), 'calendar must use canonical market bars')
      return { bind(day: string) {
        assert(day === '2026-07-14', 'signal date must reach Market D1 unchanged')
        return { async first() { marketReads++; return { next_session_date: '2026-07-15' } } }
      } }
    } }, KV: { get: async () => null },
  } as any)
  assert(response.status === 200, `historical boundary route failed: ${response.status}`)
  const body = await response.json() as any
  assert(marketReads === 1 && body.boundary.nextSessionDate === '2026-07-15', 'route must consume the formal Market calendar')
})().catch(error => { console.error(error); process.exitCode = 1 })
