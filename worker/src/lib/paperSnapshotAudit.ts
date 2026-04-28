import type { Bindings } from '../types'
import { writeSystemLog } from './notify'
import { recordPaperExecutionEvent } from './paperExecutionEvents'

const ACCOUNT_ID = 1

export interface PaperSnapshotAuditInput {
  date: string
  cash: number
  positionsValue: number
  totalValue: number
}

export interface PaperSnapshotAuditSummary {
  ok: boolean
  issue_count: number
  issues: Record<string, number>
}

export function buildPaperSnapshotAuditSummary(issues: Record<string, number>): PaperSnapshotAuditSummary {
  const normalized: Record<string, number> = {}
  for (const [key, value] of Object.entries(issues)) {
    const count = Number(value)
    if (Number.isFinite(count) && count > 0) normalized[key] = count
  }
  const issueCount = Object.values(normalized).reduce((sum, count) => sum + count, 0)
  return { ok: issueCount === 0, issue_count: issueCount, issues: normalized }
}

async function countRows(db: D1Database, sql: string, ...params: unknown[]): Promise<number> {
  const row = await db.prepare(sql).bind(...params).first<{ cnt: number }>()
  return Number(row?.cnt ?? 0)
}

export async function auditPaperSnapshotConsistency(
  env: Pick<Bindings, 'DB'>,
  input: PaperSnapshotAuditInput,
): Promise<PaperSnapshotAuditSummary> {
  try {
    const issues = {
      negative_sell_total_cost: await countRows(
        env.DB,
        "SELECT COUNT(*) AS cnt FROM paper_orders WHERE account_id=? AND side='sell' AND total_cost < 0",
        ACCOUNT_ID,
      ),
      settlement_missing_order: await countRows(
        env.DB,
        'SELECT COUNT(*) AS cnt FROM paper_settlements WHERE account_id=? AND (order_id IS NULL OR order_id <= 0)',
        ACCOUNT_ID,
      ),
      nonpositive_settlement_amount: await countRows(
        env.DB,
        'SELECT COUNT(*) AS cnt FROM paper_settlements WHERE account_id=? AND amount <= 0',
        ACCOUNT_ID,
      ),
      invalid_open_position: await countRows(
        env.DB,
        'SELECT COUNT(*) AS cnt FROM paper_positions WHERE account_id=? AND (shares <= 0 OR avg_cost <= 0)',
        ACCOUNT_ID,
      ),
    }
    const summary = buildPaperSnapshotAuditSummary(issues)
    if (!summary.ok) {
      await writeSystemLog(env.DB, 'warn', 'paper-snapshot-audit', 'Paper snapshot consistency issues detected', {
        ...summary,
        date: input.date,
        cash: Math.round(input.cash),
        positions_value: Math.round(input.positionsValue),
        total_value: Math.round(input.totalValue),
      })
      await recordPaperExecutionEvent(env, {
        tradeDate: input.date,
        eventType: 'snapshot_audit',
        status: 'warn',
        reason: 'consistency_issues',
        detail: {
          ...summary,
          cash: Math.round(input.cash),
          positions_value: Math.round(input.positionsValue),
          total_value: Math.round(input.totalValue),
        },
        source: 'daily_snapshot',
      })
    }
    return summary
  } catch (error) {
    await writeSystemLog(env.DB, 'warn', 'paper-snapshot-audit', 'Paper snapshot audit failed', {
      date: input.date,
      error: error instanceof Error ? error.message : String(error),
    })
    return buildPaperSnapshotAuditSummary({ audit_failed: 1 })
  }
}
