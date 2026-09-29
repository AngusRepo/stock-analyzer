export interface PendingBuyExecutionPreview {
  s12: {
    state: string
    reason: string
    ready: boolean
    entry_price: number | null
    chase_ceiling: number | null
    checked_at: string
  } | null
  allocator: {
    action: string
    reason: string
    budget_cap: number | null
    target_value: number | null
    available_cash: number | null
    l5_status: string | null
    l5_reasons: string[]
    s12_hard_veto: boolean
    checked_at: string
  } | null
}

interface PendingBuyTradeInput {
  ml_entry_price?: number | null
  execution_preview?: PendingBuyExecutionPreview | null
}

export interface PendingBuyTradeView {
  entryPrice: number | null
  referencePrice: number | null
  chaseCeiling: number | null
  l5Status: string | null
  entrySource: 's12' | 'waiting'
  estimatedShares: number | null
  budgetCap: number | null
  targetValue: number | null
  availableCash: number | null
  quantityBasis: 's12' | 'reference' | null
  gateReason: string | null
  checkedAt: string | null
}

function positive(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

function nonnegative(value: unknown): number | null {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

export function buildPendingBuyTradeView(item: PendingBuyTradeInput): PendingBuyTradeView {
  const preview = item.execution_preview
  const referencePrice = positive(item.ml_entry_price)
  const s12Price = preview?.s12?.ready ? positive(preview.s12.entry_price) : null
  const budgetCap = nonnegative(preview?.allocator?.budget_cap)
  const targetValue = nonnegative(preview?.allocator?.target_value)
  const l5ReasonLabels: Record<string, string> = {
    missing_l5_quote: '缺少 L5 報價',
    stale_l5_quote: 'L5 報價過期',
    wide_l5_spread: '買賣價差過寬',
    thin_top_ask: '第一檔賣量不足',
    weak_l5_imbalance: '委託簿買盤不足',
    missing_executable_l1: '缺少可成交一檔報價',
    l5_depth_incomplete: '五檔深度不足',
  }
  const l5Reasons = (preview?.allocator?.l5_reasons ?? []).map((reason) => l5ReasonLabels[reason] ?? reason)
  const availableCash = nonnegative(preview?.allocator?.available_cash)
  const allocatorAction = preview?.allocator?.action
  const sizingPrice = s12Price ?? referencePrice
  const executableBudget = allocatorAction === 'buy' || allocatorAction === 'add' ? budgetCap : null
  const boardLots = executableBudget && sizingPrice
    ? Math.floor(executableBudget / (sizingPrice * 1000))
    : 0
  const estimatedShares = executableBudget && sizingPrice
    ? boardLots > 0 ? boardLots * 1000 : Math.floor(executableBudget / sizingPrice)
    : null

  let gateReason: string | null = null
  if (preview?.allocator?.reason === 'l4_hard_risk_veto') {
    gateReason = preview.allocator.l5_status === 'blocked' || preview.allocator.l5_status === 'missing'
      ? `L5 即時報價未通過${l5Reasons.length ? `：${l5Reasons.join('、')}` : ''}`
      : preview.allocator.s12_hard_veto
        ? 'S12 結構風控否決'
        : 'L4 進場保護門檻未通過'
  } else if (preview?.s12 && !preview.s12.ready) {
    gateReason = '等待 S12 結構成立'
  }

  return {
    entryPrice: s12Price,
    referencePrice,
    chaseCeiling: s12Price != null ? positive(preview?.s12?.chase_ceiling) : null,
    l5Status: preview?.allocator?.l5_status ?? null,
    entrySource: s12Price != null ? 's12' : 'waiting',
    estimatedShares: estimatedShares && estimatedShares > 0 ? estimatedShares : null,
    budgetCap,
    targetValue,
    availableCash,
    quantityBasis: estimatedShares && estimatedShares > 0
      ? s12Price != null ? 's12' : 'reference'
      : null,
    gateReason,
    checkedAt: preview?.s12?.checked_at ?? preview?.allocator?.checked_at ?? null,
  }
}
