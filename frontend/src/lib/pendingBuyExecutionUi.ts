export type PendingBuyExecutionTone = 'ok' | 'warn' | 'error' | 'neutral' | 'info'

export interface PendingBuyExecutionBadge {
  label: string
  tone: PendingBuyExecutionTone
  description: string
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

function parseNumberMap(detail: string): Record<string, number> {
  return detail.split(';').reduce<Record<string, number>>((acc, part) => {
    const [rawKey, rawValue] = part.split('=')
    const key = rawKey?.trim()
    const value = Number(rawValue)
    if (key && Number.isFinite(value)) acc[key] = value
    return acc
  }, {})
}

export function formatExecutionStatusBadge(status: unknown): PendingBuyExecutionBadge {
  const key = String(status ?? 'pending').trim() || 'pending'
  return STATUS_BADGES[key] ?? {
    label: key,
    tone: 'neutral',
    description: '尚未納入前端狀態字典，請檢查 execution contract 是否新增狀態。',
  }
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
