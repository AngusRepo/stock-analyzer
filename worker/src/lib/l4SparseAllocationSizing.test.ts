import {
  buildL4SparseAllocationWatchPoint,
  l4SparseSizingFromWatchPoints,
  resolveL4SparseBudgetFloor,
} from './l4SparseAllocationSizing'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  const point = buildL4SparseAllocationWatchPoint({
    allocation_weight: 0.18,
    allocation_rank: 2,
    allocation_capacity: 5,
    expected_return: 0.032,
    risk_estimate: 0.014,
    selection_reason: 'selected_positive_edge_sparse_weight',
  })
  assert(point?.startsWith('l4_sparse_allocation:weight=0.18'), 'watch point should expose L4 sparse allocation weight')
  const parsed = l4SparseSizingFromWatchPoints(['other', point])
  assert(parsed?.weight === 0.18, 'parser should recover allocation weight')
  assert(parsed?.allocationRank === 2, 'parser should recover allocation rank')
  assert(parsed?.allocationCapacity === 5, 'parser should recover allocation capacity')
}

{
  const resolved = resolveL4SparseBudgetFloor({
    totalPortfolio: 1_000_000,
    baseBudget: 80_000,
    allocationWeight: 0.18,
  })
  assert(resolved.budget === 180_000, 'L4 sparse allocation weight should lift risk-parity budget when larger')
  assert(resolved.sizingMode === 'l4_sparse_weight', 'sizing mode should explain weight-driven budget floor')
}

{
  const resolved = resolveL4SparseBudgetFloor({
    totalPortfolio: 1_000_000,
    baseBudget: 210_000,
    allocationWeight: 0.18,
  })
  assert(resolved.budget === 210_000, 'risk-parity budget should remain when it is already larger than L4 target')
  assert(resolved.sizingMode === 'risk_parity', 'sizing mode should remain risk_parity when L4 weight is not binding')
}
