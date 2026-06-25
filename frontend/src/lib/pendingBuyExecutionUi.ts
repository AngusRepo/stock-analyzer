export type PendingBuyExecutionTone = 'ok' | 'warn' | 'error' | 'neutral' | 'info'

export interface PendingBuyExecutionBadge {
  label: string
  tone: PendingBuyExecutionTone
  description: string
}

export interface PendingBuyExecutionContext {
  execution_status?: unknown
  watch_points?: unknown
}

interface ParsedExecutionNote {
  status: string
  reason: string
  detail: string | null
}

const STATUS_BADGES: Record<string, PendingBuyExecutionBadge> = {
  pending: {
    label: '等待盤中檢查',
    tone: 'neutral',
    description: '尚未進入下單檢查，仍需即時報價與風控確認。',
  },
  submitted: {
    label: '已送出紙上委託',
    tone: 'info',
    description: '已通過報價與風控檢查，等待成交或後續重估。',
  },
  requoted: {
    label: '已重估限價',
    tone: 'warn',
    description: '原限價與即時盤勢偏離，系統已下修或重掛更保守價格。',
  },
  partially_filled: {
    label: '部分成交',
    tone: 'warn',
    description: '只成交部分股數，剩餘委託需持續追蹤、取消或到期。',
  },
  stale_quote: {
    label: '報價過期',
    tone: 'warn',
    description: '即時報價太舊，系統 fail-closed，不用過期價格假裝成交。',
  },
  quote_unavailable: {
    label: '報價缺失',
    tone: 'error',
    description: '缺少可交易 bid/ask 或五檔快照，禁止用昨日收盤價成交。',
  },
  filled: {
    label: '已成交',
    tone: 'ok',
    description: '紙上成交已寫入訂單與持倉。',
  },
  skipped: {
    label: '已跳過',
    tone: 'neutral',
    description: '因流動性、追高、風控或資料缺失而不進場。',
  },
  cancelled: {
    label: '已取消',
    tone: 'neutral',
    description: '委託已取消，不再等待成交。',
  },
  expired: {
    label: '已到期',
    tone: 'neutral',
    description: '超過本交易時段或 SLA，委託失效。',
  },
  rejected: {
    label: '已拒絕',
    tone: 'error',
    description: '辯論或硬 gate 拒絕，不允許進入交易。',
  },
}

const EXECUTION_REASON_LABELS: Record<string, string> = {
  volume_ratio_low: '成交量不足',
  weak_no_reclaim: '技術轉弱，尚未收復',
  between_buy_reference_and_confirmation: '價格位於買入區與確認價之間',
  ohlcv_support_lost: '跌破 OHLCV 支撐',
  allocator_no_plan: '配置器尚未產生可執行方案',
  allocator_full_requires_replacement: '持倉額度已滿，需先替換',
  allocator_replace_requires_sell_first: '替換交易需先完成賣出',
  allocator_budget_below_min: '配置金額低於最低交易金額',
  broker_quote_required: '缺少券商即時報價',
  rod_cancelled: 'ROD 盤後取消',
  paper_order_created: '紙上委託已建立',
  already_filled_today: '今日已成交',
}

function parseNumberMap(detail: string): Record<string, number> {
  return detail.split(';').reduce<Record<string, number>>((acc, part) => {
    const [rawKey, rawValue] = part.split('=')
    const key = rawKey?.trim()
    const value = Number(rawValue)
    if (key && Number.isFinite(value)) acc[key] = value
    return acc
  }, {})
}

function parseExecutionNote(raw: unknown): ParsedExecutionNote | null {
  const parts = String(raw ?? '').split(':')
  if (parts[0] !== 'execution' || !parts[1] || !parts[2]) return null
  return {
    status: parts[1],
    reason: parts[2],
    detail: parts.length > 3 ? parts.slice(3).join(':') : null,
  }
}

function latestExecutionNote(watchPoints: unknown): ParsedExecutionNote | null {
  const points = Array.isArray(watchPoints) ? watchPoints : []
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const event = parseExecutionNote(points[index])
    if (event) return event
  }
  return null
}

function humanizeExecutionReason(reason: string): string {
  const key = reason.trim()
  return EXECUTION_REASON_LABELS[key] ?? key.replace(/_/g, ' ').replace(/-/g, ' ')
}

function formatExecutionDetail(detail: string | null): string {
  if (!detail) return ''
  const clean = detail.replace(/_/g, ' ').replace(/;/g, '；').trim()
  return clean ? `（${clean}）` : ''
}

export function formatExecutionStatusBadge(status: unknown): PendingBuyExecutionBadge {
  const key = String(status ?? 'pending').trim() || 'pending'
  return STATUS_BADGES[key] ?? {
    label: key,
    tone: 'neutral',
    description: '尚未納入前端狀態字典，請檢查 execution contract 是否新增狀態。',
  }
}

export function formatPendingBuyExecutionBadge(item: PendingBuyExecutionContext): PendingBuyExecutionBadge {
  const key = String(item?.execution_status ?? 'pending').trim() || 'pending'
  const base = formatExecutionStatusBadge(key)
  const event = latestExecutionNote(item?.watch_points)
  if (!event) return base

  const reason = humanizeExecutionReason(event.reason)
  const detail = formatExecutionDetail(event.detail)
  if (key === 'pending') {
    return {
      label: '已檢查，等待條件',
      tone: 'warn',
      description: `盤中檢查已執行，暫不進場：${reason}${detail}。`,
    }
  }
  if (key === event.status || key === 'cancelled' || key === 'skipped' || key === 'expired' || key === 'rejected') {
    return {
      ...base,
      description: `${base.description} 原因：${reason}${detail}。`,
    }
  }
  return base
}

export function formatPartialFillRemaining(watchPoints: unknown): string | null {
  const points = Array.isArray(watchPoints) ? watchPoints : []
  const event = points
    .map((point) => String(point ?? ''))
    .find((point) => point.startsWith('execution:partially_filled:paper_order_partial_fill:'))
  if (!event) return null

  const detail = event.split(':').slice(3).join(':')
  const parsed = parseNumberMap(detail)
  const requested = parsed.requested
  const filled = parsed.filled
  const remaining = parsed.remaining
  if (![requested, filled, remaining].every((value) => Number.isFinite(value))) return null
  return `部分成交：已成交 ${filled} / 原訂 ${requested}，剩餘 ${remaining} 股`
}
