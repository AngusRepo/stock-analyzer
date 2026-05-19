import type { PaperExecutionEventInput } from './paperExecutionEvents'

export const FINLAB_PAPER_PREVIEW_SCHEMA_VERSION = 'finlab-paper-preview-v1' as const

export type FinLabPaperPreviewStatus = 'pass' | 'blocked' | 'warning' | 'error'

export interface FinLabPaperPreviewInput {
  accountId?: number
  tradeDate?: string
  symbol: string
  side?: 'buy' | 'sell' | null
  pendingRunId?: number | null
  status?: FinLabPaperPreviewStatus | string
  reason?: string | null
  detail?: Record<string, unknown> | null
  raw?: Record<string, unknown> | null
}

export function buildFinLabPaperPreviewPolicy() {
  return {
    schemaVersion: FINLAB_PAPER_PREVIEW_SCHEMA_VERSION,
    stockvisionPaperFillWriter: 'stockvision_worker_paper_trade',
    finlabRole: 'preview_audit_only',
    canWritePaperOrders: false,
    canWritePaperPositions: false,
    canWritePaperSettlements: false,
    canCreatePendingBuys: false,
    auditSink: {
      table: 'paper_execution_events',
      eventType: 'finlab_preview',
    },
  } as const
}

const VIOLATION_BY_FIELD: Record<string, string> = {
  paper_order: 'finlab_preview_must_not_write_paper_order',
  paper_orders: 'finlab_preview_must_not_write_paper_order',
  paper_order_id: 'finlab_preview_must_not_write_paper_order',
  pending_buy: 'finlab_preview_must_not_create_pending_buy',
  pending_buys: 'finlab_preview_must_not_create_pending_buy',
  pending_buy_item: 'finlab_preview_must_not_create_pending_buy',
  pending_buy_items: 'finlab_preview_must_not_create_pending_buy',
  pending_buy_run: 'finlab_preview_must_not_create_pending_buy',
  pending_buy_runs: 'finlab_preview_must_not_create_pending_buy',
  fill: 'finlab_preview_must_not_create_fill',
  fills: 'finlab_preview_must_not_create_fill',
  filled_shares: 'finlab_preview_must_not_create_filled_shares',
  order_id: 'finlab_preview_must_not_create_order_id',
  paper_position: 'finlab_preview_must_not_write_paper_position',
  paper_positions: 'finlab_preview_must_not_write_paper_position',
  paper_settlement: 'finlab_preview_must_not_write_paper_settlement',
  paper_settlements: 'finlab_preview_must_not_write_paper_settlement',
}

function normalizeFieldName(fieldName: string): string {
  return fieldName
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase()
}

function appendViolation(violations: string[], violation: string): void {
  if (!violations.includes(violation)) {
    violations.push(violation)
  }
}

function walkPayload(value: unknown, violations: string[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      walkPayload(entry, violations)
    }
    return
  }

  if (!value || typeof value !== 'object') {
    return
  }

  for (const [fieldName, fieldValue] of Object.entries(value as Record<string, unknown>)) {
    const normalized = normalizeFieldName(fieldName)
    const directViolation = VIOLATION_BY_FIELD[normalized]
    if (directViolation) {
      appendViolation(violations, directViolation)
    }

    if (normalized === 'execution_status' && String(fieldValue).toLowerCase() === 'filled') {
      appendViolation(violations, 'finlab_preview_must_not_mark_execution_filled')
    }

    walkPayload(fieldValue, violations)
  }
}

export function detectFinLabPaperLifecycleViolations(payload: Record<string, unknown> | null | undefined): string[] {
  const violations: string[] = []
  walkPayload(payload, violations)
  return violations
}

export function validateFinLabPaperPreviewIntegration(input: FinLabPaperPreviewInput): string[] {
  const violations: string[] = []
  for (const payload of [input.raw, input.detail]) {
    for (const violation of detectFinLabPaperLifecycleViolations(payload ?? undefined)) {
      appendViolation(violations, violation)
    }
  }
  return violations
}

export function buildFinLabPreviewAuditEvent(input: FinLabPaperPreviewInput): PaperExecutionEventInput {
  return {
    accountId: input.accountId,
    tradeDate: input.tradeDate,
    symbol: input.symbol,
    side: input.side ?? null,
    eventType: 'finlab_preview',
    status: String(input.status || 'unknown'),
    reason: input.reason ?? null,
    detail: {
      previewOnly: true,
      ...(input.detail ?? {}),
    },
    orderId: null,
    pendingRunId: input.pendingRunId ?? null,
    source: 'finlab_preview',
  }
}
