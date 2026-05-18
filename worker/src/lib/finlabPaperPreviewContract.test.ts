import {
  buildFinLabPaperPreviewPolicy,
  buildFinLabPreviewAuditEvent,
  detectFinLabPaperLifecycleViolations,
  validateFinLabPaperPreviewIntegration,
} from './finlabPaperPreviewContract'

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

{
  const policy = buildFinLabPaperPreviewPolicy()
  assert(policy.schemaVersion === 'finlab-paper-preview-v1', 'policy should expose a stable schema version')
  assert(policy.stockvisionPaperFillWriter === 'stockvision_worker_paper_trade', 'StockVision Worker must remain the paper fill writer')
  assert(policy.finlabRole === 'preview_audit_only', 'FinLab must stay preview/audit only')
  assert(policy.canWritePaperOrders === false, 'FinLab preview must not write paper_orders')
  assert(policy.canWritePaperPositions === false, 'FinLab preview must not write paper_positions')
  assert(policy.canWritePaperSettlements === false, 'FinLab preview must not write paper_settlements')
  assert(policy.canCreatePendingBuys === false, 'FinLab preview must not create pending buys')
  assertDeepEqual(policy.auditSink, {
    table: 'paper_execution_events',
    eventType: 'finlab_preview',
  }, 'FinLab preview should have one audit sink')
}

{
  const event = buildFinLabPreviewAuditEvent({
    accountId: 1,
    tradeDate: '2026-05-15',
    symbol: '2330',
    side: 'buy',
    pendingRunId: 42,
    status: 'blocked',
    reason: 'insufficient_settlement_cash',
    detail: {
      requestedShares: 1000,
      previewCashShortfall: 120000,
    },
  })

  assertDeepEqual(event, {
    accountId: 1,
    tradeDate: '2026-05-15',
    symbol: '2330',
    side: 'buy',
    eventType: 'finlab_preview',
    status: 'blocked',
    reason: 'insufficient_settlement_cash',
    detail: {
      previewOnly: true,
      requestedShares: 1000,
      previewCashShortfall: 120000,
    },
    orderId: null,
    pendingRunId: 42,
    source: 'finlab_preview',
  }, 'FinLab preview should normalize into one audit event')
}

{
  const violations = detectFinLabPaperLifecycleViolations({
    paper_order_id: 7,
    pending_buy: { symbol: '2330' },
    execution_status: 'filled',
    nested: {
      fill: {
        filled_shares: 1000,
      },
    },
  })

  assertDeepEqual(violations, [
    'finlab_preview_must_not_write_paper_order',
    'finlab_preview_must_not_create_pending_buy',
    'finlab_preview_must_not_mark_execution_filled',
    'finlab_preview_must_not_create_fill',
    'finlab_preview_must_not_create_filled_shares',
  ], 'FinLab preview lifecycle violations should be explicit and deterministic')
}

{
  const violations = validateFinLabPaperPreviewIntegration({
    symbol: '2330',
    status: 'pass',
    raw: {
      order_id: 'finlab-order-1',
      paper_position: { shares: 1000 },
      paper_settlement: { amount: 50000 },
    },
  })

  assertDeepEqual(violations, [
    'finlab_preview_must_not_create_order_id',
    'finlab_preview_must_not_write_paper_position',
    'finlab_preview_must_not_write_paper_settlement',
  ], 'validation should reject FinLab payloads that try to create a second paper lifecycle')
}

{
  const violations = detectFinLabPaperLifecycleViolations({
    previewRows: [
      {
        paperOrder: { id: 9 },
        fill: { filledShares: 1000 },
      },
    ],
  })

  assertDeepEqual(violations, [
    'finlab_preview_must_not_write_paper_order',
    'finlab_preview_must_not_create_fill',
    'finlab_preview_must_not_create_filled_shares',
  ], 'FinLab preview validation should inspect array payload rows')
}
