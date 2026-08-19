import type { Bindings } from '../types'
import { paperDomainDatabase } from './paperDomainDatabase'
import { twToday } from './dateUtils'
import { writeEvidenceArtifact } from './artifactLifecycle'

export interface PaperExecutionEventInput {
  accountId?: number
  tradeDate?: string
  symbol?: string | null
  side?: 'buy' | 'sell' | null
  eventType: 'pending_buy' | 'paper_order' | 'paper_position_update' | 'debate' | 'snapshot_audit' | 'finlab_preview' | 'finlab_l5_market_data' | 'finlab_execution_preview' | 'paper_broker_reconciliation' | 'live_execution_shadow' | 'intraday_technical_decision' | 's12_intraday_structure'
  status: string
  reason?: string | null
  detail?: Record<string, unknown> | null
  orderId?: number | null
  pendingRunId?: number | null
  source?: string | null
}

export function normalizePaperExecutionEvent(input: PaperExecutionEventInput): Required<PaperExecutionEventInput> {
  return {
    accountId: input.accountId ?? 1,
    tradeDate: input.tradeDate ?? twToday(),
    symbol: input.symbol ?? null,
    side: input.side ?? null,
    eventType: input.eventType,
    status: String(input.status || 'unknown'),
    reason: input.reason ?? null,
    detail: input.detail ?? null,
    orderId: input.orderId ?? null,
    pendingRunId: input.pendingRunId ?? null,
    source: input.source ?? null,
  }
}

function isMissingTableError(error: unknown): boolean {
  return /no such table/i.test(String(error))
}

export async function recordPaperExecutionEvent(
  env: Pick<Bindings, 'DB'> & Partial<Pick<Bindings, 'ARTIFACTS'>>,
  input: PaperExecutionEventInput,
): Promise<void> {
  const event = normalizePaperExecutionEvent(input)
  const executionCritical = (
    event.eventType === 'paper_broker_reconciliation' ||
    event.eventType === 'live_execution_shadow' ||
    (event.eventType === 'paper_order' && ['filled', 'partial'].includes(event.status))
  )
  let detail = event.detail
  if (executionCritical && env.ARTIFACTS && event.detail) {
    const producerRunId = `paper-execution:${event.tradeDate}:${event.symbol ?? 'market'}:${event.eventType}:${crypto.randomUUID()}`
    const manifest = await writeEvidenceArtifact(env as Pick<Bindings, 'DB' | 'ARTIFACTS'>, {
      domain: 'paper_execution',
      businessDate: event.tradeDate,
      producerRunId,
      canonicalRunId: producerRunId,
      retentionClass: 'canonical_execution',
      schemaVersion: 'paper_execution_evidence_v1',
      rowCount: 1,
      payload: {
        account_id: event.accountId,
        symbol: event.symbol,
        side: event.side,
        event_type: event.eventType,
        status: event.status,
        reason: event.reason,
        order_id: event.orderId,
        pending_run_id: event.pendingRunId,
        source: event.source,
        detail: event.detail,
      },
      metadata: { symbol: event.symbol, side: event.side, event_type: event.eventType, status: event.status },
    })
    detail = {
      evidence_pointer: {
        artifact_id: manifest.artifact_id,
        r2_key: manifest.r2_key,
        checksum: manifest.checksum,
        checksum_verified_at: manifest.checksum_verified_at,
        retention_class: manifest.retention_class,
      },
      summary: {
        source: event.source,
        order_id: event.orderId,
        pending_run_id: event.pendingRunId,
        reason: event.reason,
      },
    }
  }
  try {
    await paperDomainDatabase(env).prepare(`
      INSERT INTO paper_execution_events
        (account_id, trade_date, symbol, side, event_type, status, reason,
         detail_json, order_id, pending_run_id, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).bind(
      event.accountId,
      event.tradeDate,
      event.symbol,
      event.side,
      event.eventType,
      event.status,
      event.reason,
      detail ? JSON.stringify(detail) : null,
      event.orderId,
      event.pendingRunId,
      event.source,
    ).run()
  } catch (error) {
    if (executionCritical || !isMissingTableError(error)) {
      console.warn(`[PaperExecutionEvents] insert failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (executionCritical) throw error
  }
}

export async function recordPaperExecutionEvents(
  env: Pick<Bindings, 'DB'> & Partial<Pick<Bindings, 'ARTIFACTS'>>,
  events: PaperExecutionEventInput[],
): Promise<void> {
  for (const event of events) {
    await recordPaperExecutionEvent(env, event)
  }
}
