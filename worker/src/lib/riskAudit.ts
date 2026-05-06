/**
 * riskAudit.ts — #20/#26 R3 audit trail writer (2026-04-21)
 *
 * Fire-and-forget D1 inserts into risk_audit_log. Never blocks production
 * path. Row retention 90d via weekly cron (R3b).
 */
import type { CircuitBreakerState } from './riskTypes'
import type { OrderValidation } from './riskTypes'

export type RiskTriggerEvent =
  | 'morning_setup'
  | 'intraday_buy'
  | 'intraday_exit'
  | 'eod_exit'
  | 'force_day_trade_close'
  | 'kill_switch'

export type RiskDecision = 'executed' | 'blocked' | 'adjusted' | 'deferred' | 'halt'

export interface RiskAuditEntry {
  triggerEvent: RiskTriggerEvent
  symbol?: string | null
  side?: 'buy' | 'sell' | null
  decision: RiskDecision
  riskState: CircuitBreakerState & { triggeredLayers?: string[]; haltReasons?: string[] }
  orderValidation?: OrderValidation | null
  configVersion?: string
}

function severityFromState(s: RiskAuditEntry['riskState']): string {
  if (s.halt) return 'halted'
  const triggered = (s.triggeredLayers ?? []).length
  if (triggered >= 3) return 'critical'
  if (triggered === 2) return 'high'
  if (triggered === 1) return 'elevated'
  return 'normal'
}

export async function writeAuditEntry(
  db: D1Database,
  entry: RiskAuditEntry,
): Promise<void> {
  try {
    const severity = severityFromState(entry.riskState)
    const triggeredCount = (entry.riskState.triggeredLayers ?? []).length
    await db.prepare(
      `INSERT INTO risk_audit_log
        (trigger_event, account_id, symbol, side, decision, halt,
         triggered_count, severity, max_position_pct, buy_conf_threshold,
         sell_conf_threshold, risk_state_json, order_validation_json, config_version)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      entry.triggerEvent,
      entry.symbol ?? null,
      entry.side ?? null,
      entry.decision,
      entry.riskState.halt ? 1 : 0,
      triggeredCount,
      severity,
      entry.riskState.maxPositionPct ?? null,
      entry.riskState.buyConfThreshold ?? null,
      entry.riskState.sellConfThreshold ?? null,
      JSON.stringify(entry.riskState),
      entry.orderValidation ? JSON.stringify(entry.orderValidation) : null,
      entry.configVersion ?? null,
    ).run()
  } catch (e: any) {
    console.warn(`[RiskAudit] insert failed (non-fatal): ${e?.message ?? e}`)
  }
}

/** Cron target: purge rows older than 90 days. */
export async function pruneOldAuditEntries(db: D1Database): Promise<number> {
  try {
    const res = await db.prepare(
      "DELETE FROM risk_audit_log WHERE timestamp < datetime('now', '-90 days')"
    ).run()
    const changes = (res.meta as any)?.changes ?? 0
    console.log(`[RiskAudit] pruned ${changes} rows older than 90d`)
    return changes
  } catch (e: any) {
    console.warn(`[RiskAudit] prune failed: ${e?.message ?? e}`)
    return 0
  }
}
