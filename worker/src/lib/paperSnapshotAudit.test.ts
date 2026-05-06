import { buildPaperSnapshotAuditSummary } from './paperSnapshotAudit'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  const summary = buildPaperSnapshotAuditSummary({
    negative_sell_total_cost: 0,
    settlement_missing_order: 2,
    invalid_open_position: -1,
  })
  assert(!summary.ok, 'summary should fail when positive issue counts exist')
  assert(summary.issue_count === 2, 'summary should count only positive issue counts')
  assert(summary.issues.settlement_missing_order === 2, 'summary should retain named issue counts')
  assert(summary.issues.negative_sell_total_cost == null, 'summary should omit zero counts')
}

{
  const summary = buildPaperSnapshotAuditSummary({})
  assert(summary.ok, 'empty issues should pass')
  assert(summary.issue_count === 0, 'empty issues should have zero issue count')
}
