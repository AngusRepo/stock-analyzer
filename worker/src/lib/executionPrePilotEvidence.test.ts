import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  buildExecutionPrePilotEvidenceReport,
  REQUIRED_PRE_PILOT_EVENT_TYPES,
} from './executionPrePilotEvidence'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  const actualJson = JSON.stringify(actual)
  const expectedJson = JSON.stringify(expected)
  if (actualJson !== expectedJson) {
    throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`)
  }
}

type FakeResult = { results?: any[] }

class FakeStatement {
  private binds: unknown[] = []

  constructor(
    private readonly sql: string,
    private readonly handler: (sql: string, binds: unknown[]) => FakeResult,
  ) {}

  bind(...values: unknown[]) {
    this.binds = values
    return this
  }

  async all<T = unknown>(): Promise<{ results: T[] }> {
    return { results: (this.handler(this.sql, this.binds).results ?? []) as T[] }
  }
}

class FakeD1 {
  readonly calls: Array<{ sql: string; binds: unknown[] }> = []

  prepare(sql: string) {
    return new FakeStatement(sql, (statementSql, binds) => {
      this.calls.push({ sql: statementSql, binds })
      if (statementSql.includes('GROUP BY event_type, status') && statementSql.includes('event_type IN')) {
        return {
          results: [
            { event_type: 'finlab_l5_market_data', status: 'pass', count: 2, latest_created_at: '2026-05-28 10:00:10' },
            { event_type: 'intraday_technical_decision', status: 'constructive', count: 1, latest_created_at: '2026-05-28 10:00:20' },
            { event_type: 'paper_broker_reconciliation', status: 'matched', count: 1, latest_created_at: '2026-05-28 10:00:30' },
          ],
        }
      }
      if (statementSql.includes('ORDER BY created_at DESC') && statementSql.includes('LIMIT ?')) {
        return {
          results: [
            {
              id: 12,
              trade_date: '2026-05-28',
              symbol: '2330',
              event_type: 'paper_broker_reconciliation',
              status: 'matched',
              reason: 'paper_order_created',
              created_at: '2026-05-28 10:00:30',
            },
          ],
        }
      }
      if (statementSql.includes("status = 'adaptive_gate_shadow'") && statementSql.includes('created_at >= ?')) {
        return { results: [] }
      }
      if (statementSql.includes("status = 'adaptive_gate_shadow'")) {
        return {
          results: [
            { event_type: 'pending_buy', status: 'adaptive_gate_shadow', count: 1, latest_created_at: '2026-05-28 04:55:00' },
          ],
        }
      }
      if (statementSql.includes('FROM paper_orders')) {
        return { results: [{ count: 0, latest_created_at: null }] }
      }
      return { results: [] }
    })
  }
}

;(async () => {
  assertDeepEqual(REQUIRED_PRE_PILOT_EVENT_TYPES, [
    'finlab_l5_market_data',
    'intraday_technical_decision',
    'paper_broker_reconciliation',
  ], 'pre-pilot evidence must require all production-simulated execution event types')

  const db = new FakeD1()
  const report = await buildExecutionPrePilotEvidenceReport(db as unknown as D1Database, {
    date: '2026-05-28',
    sinceUtc: '2026-05-28 11:00:00',
    limit: 20,
  })

  assert(report.success === true, 'report should be successful read-only output')
  assert(report.mode === 'read_only', 'report must be read-only')
  assert(report.loop === 'production_simulated', 'report must identify production-simulated loop')
  assert(report.complete === true, 'all required event types with count > 0 should mark evidence complete')
  assert(report.missing_event_types.length === 0, 'complete evidence should have no missing event types')
  assert(report.event_counts.finlab_l5_market_data.total === 2, 'event count should aggregate by required event type')
  assert(report.event_counts.paper_broker_reconciliation.by_status.matched === 1, 'event count should retain status breakdown')
  assert(report.latest_events[0]?.event_type === 'paper_broker_reconciliation', 'latest events should expose newest execution evidence')
  assert(report.legacy_shadow_snapshot.total === 1, 'legacy shadow/snapshot recurrence should be called out separately')
  assert(report.legacy_shadow_snapshot_since?.total === 0, 'legacy shadow/snapshot recurrence after sinceUtc should be isolated')
  assert(report.paper_orders_since?.count === 0, 'paper order count after sinceUtc should be visible')

  const root = fs.existsSync(path.join(process.cwd(), 'worker'))
    ? process.cwd()
    : path.join(process.cwd(), '..')
  const adminReadRoutes = fs.readFileSync(path.join(root, 'worker', 'src', 'routes', 'adminReadRoutes.ts'), 'utf8')
  assert(
    adminReadRoutes.includes("adminReadRoutes.get('/api/admin/execution/pre-pilot-evidence'"),
    'admin route must expose pre-pilot evidence endpoint',
  )
  assert(adminReadRoutes.includes('requireAdminOrServiceToken'), 'pre-pilot evidence endpoint must require admin/service auth')
  assert(
    adminReadRoutes.includes('buildExecutionPrePilotEvidenceReport'),
    'admin route must delegate to the pre-pilot evidence read model',
  )
})()
