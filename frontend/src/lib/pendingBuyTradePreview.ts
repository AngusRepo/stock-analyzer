export interface PendingBuyExecutionPreview {
  entry_owner?: 's12' | 'or15_vwap_v1'
  or15?: {
    action: string
    reason: string
    or_high: number | null
    or_low: number | null
    vwap: number | null
    latest_bar_ms: number | null
    bar_source: string | null
    bar_error: string | null
    checked_at: string
  } | null
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

const OR15_REASONS: Record<string, string> = {
  or15_opening_bars_missing: '等待開盤 15 分鐘的一分鐘 K 棒補齊',
  or15_waiting_breakout: '等待收盤價突破開盤 15 分鐘高點，且站上 VWAP',
  or15_minute_bars_stale: '最新一分鐘 K 棒過期，等待更新',
  or15_latest_bar_gap: '最近 K 棒有缺口，等待補齊',
  or15_signal_expired: '突破訊號超過 3 分鐘，等待下一次有效突破',
  or15_breakout_lost: '突破後跌回區間高點或 VWAP 下方，等待重新站穩',
  or15_market_data_unavailable: '盤中行情暫不可用，等待更新',
  or15_quote_below_breakout_or_vwap: '即時報價未站上區間高點與 VWAP',
  or15_limit_above_selection_max_buy: '委託價超過選股最高可買價',
  or15_depth_fill_above_selection_max_buy: '委託簿可成交價超過選股最高可買價',
  or15_market_risk_guard: '市場風險條件未通過',
  or15_entry_window_closed: '今日進場時段已結束',
  or15_vwap_breakout: '開盤區間突破且站上 VWAP，等待即時報價與風控確認',
}

export function describeOr15Reason(reason: string): string {
  return OR15_REASONS[reason] ?? reason.replace(/^or15_/, '').replace(/_/g, ' ')
}

export function buildPendingBuyTradeView(item: PendingBuyTradeInput): PendingBuyTradeView {
  const preview = item.execution_preview
  const referencePrice = positive(item.ml_entry_price)
  const isOr15 = preview?.entry_owner === 'or15_vwap_v1'
  const s12Price = !isOr15 && preview?.s12?.ready ? positive(preview.s12.entry_price) : null
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
      : isOr15
        ? 'L4 進場保護門檻未通過'
        : preview.allocator.s12_hard_veto
        ? 'S12 結構風控否決'
        : 'L4 進場保護門檻未通過'
  } else if (isOr15 && preview?.or15?.action !== 'pass') {
    gateReason = preview?.or15 ? describeOr15Reason(preview.or15.reason) : '等待 A 盤中檢查結果'
  } else if (!isOr15 && preview?.s12 && !preview.s12.ready) {
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
    checkedAt: (isOr15 ? preview?.or15?.checked_at : preview?.s12?.checked_at) ?? preview?.allocator?.checked_at ?? null,
  }
}
