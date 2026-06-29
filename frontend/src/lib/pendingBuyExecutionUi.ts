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
  checked_waiting: {
    label: '已檢查，等待條件',
    tone: 'warn',
    description: '盤中檢查已執行，但價格、量能或技術條件尚未達到進場門檻。',
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
  technical_distribution_cooldown: '盤中技術分布仍在冷卻',
  range_position_low: '盤中價格位置偏低',
  price_above_entry: '價格高於允許進場價',
  broker_quote_required: '缺少券商即時報價',
  rod_cancelled: 'ROD 盤後取消',
  paper_order_created: '紙上委託已建立',
  already_filled_today: '今日已成交',
  s12_waiting_15m_completed_bars: 'S12 等待完成更多 15 分 K',
  s12_waiting_4h_completed_bar: 'S12 等待完成 4H 方向 K',
  s12_waiting_4h_long_bias: 'S12 等待 4H 多方結構成立',
  s12_waiting_1h_completed_bar: 'S12 等待完成 1H 區域 K',
  s12_waiting_1h_demand_zone: 'S12 尚未形成 1H 需求區',
  s12_waiting_15m_zone_touch: 'S12 等待 15M 回踩 1H 需求區',
  s12_waiting_sweep: 'S12 等待 15M 掃低點',
  s12_waiting_choch: 'S12 等待 15M 結構轉多',
  s12_waiting_bos: 'S12 等待 15M 結構突破',
  s12_waiting_retest: 'S12 等待回測 OB/FVG 進場區',
  s12_reaction_ready: 'S12 結構進場訊號成熟',
  s12_assist_entry_ready: 'S12 進場輔助已啟用',
  s12_primary_structure_owner_waiting: 'S12 主控結構，等待條件成熟',
  s12_primary_cleared_momentum_directional_gate: 'S12 已接手方向判斷',
  s12_structure_invalidated: 'S12 盤中結構失效',
  s12_entry_zone_not_overlapping_1h_demand: 'S12 進場區未與 1H 需求區重疊',
  s12_invalid_risk_box: 'S12 風險框不合理',
  s12_data_unavailable: 'S12 盤中結構資料不足',
}

const S12_STATE_LABELS: Record<string, string> = {
  waiting_15m_completed_bars: '等待 15 分 K 累積',
  waiting_4h_completed_bar: '等待 4H 收線',
  waiting_4h_long_bias: '等待 4H 多方結構成立',
  waiting_1h_completed_bar: '等待 1H 收線',
  waiting_1h_demand_zone: '等待 1H 需求區',
  waiting_15m_zone_touch: '等待 15M 回踩需求區',
  waiting_sweep: '等待掃低點',
  waiting_choch: '等待結構轉多',
  waiting_bos: '等待結構突破',
  waiting_retest: '等待回測反應',
  reaction_ready: '進場結構成熟',
  invalidated: '結構失效',
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

function latestS12ExecutionNote(watchPoints: unknown): ParsedExecutionNote | null {
  const points = Array.isArray(watchPoints) ? watchPoints : []
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const event = parseExecutionNote(points[index])
    if (event?.reason?.startsWith('s12_')) return event
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

function parseDetailMap(detail: string | null): Record<string, string> {
  if (!detail) return {}
  return detail.split(';').reduce<Record<string, string>>((acc, part) => {
    const [rawKey, ...rawValue] = part.split('=')
    const key = rawKey?.trim()
    const value = rawValue.join('=').trim()
    if (key && value) acc[key] = value
    return acc
  }, {})
}

function s12Tone(reason: string): PendingBuyExecutionTone {
  if (
    reason === 's12_reaction_ready' ||
    reason === 's12_assist_entry_ready' ||
    reason === 's12_primary_cleared_momentum_directional_gate'
  ) return 'ok'
  if (reason === 's12_structure_invalidated' || reason === 's12_invalid_risk_box') return 'error'
  return 'warn'
}

function formatS12Detail(detail: string | null): string {
  const parsed = parseDetailMap(detail)
  const channelAlign = parsed.bias_channel_align === 'true'
    ? '已對齊'
    : parsed.bias_channel_align === 'false'
      ? '未對齊'
      : null
  const parts = [
    parsed.state ? `狀態：${S12_STATE_LABELS[parsed.state] ?? parsed.state}` : null,
    parsed.bars15m || parsed.bars1h || parsed.bars4h
      ? `完成K：15M ${parsed.bars15m ?? 0}、1H ${parsed.bars1h ?? 0}、4H ${parsed.bars4h ?? 0}`
      : null,
    parsed.bias4h ? `4H方向：${parsed.bias4h === 'long' ? '多方' : parsed.bias4h === 'short' ? '空方' : '中性'}` : null,
    parsed.bias_confidence ? `4H確認度：${parsed.bias_confidence === 'confirmed' ? '已確認' : parsed.bias_confidence === 'provisional' ? '暫定' : '不足'}` : null,
    channelAlign ? `4H通道：${channelAlign}` : null,
    parsed.zone_low && parsed.zone_high ? `1H需求區：${parsed.zone_low} - ${parsed.zone_high}` : null,
    parsed.entry ? `進場參考：${parsed.entry}` : null,
    parsed.chase_ceiling ? `不追價上限：${parsed.chase_ceiling}` : null,
    parsed.stop ? `停損：${parsed.stop}` : null,
    parsed.t1 ? `T1：${parsed.t1}` : null,
  ].filter(Boolean)
  return parts.join('；')
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

export function formatS12IntradayStructureBadge(watchPoints: unknown): PendingBuyExecutionBadge | null {
  const event = latestS12ExecutionNote(watchPoints)
  if (!event) return null
  const label = humanizeExecutionReason(event.reason)
  const detail = formatS12Detail(event.detail)
  return {
    label,
    tone: s12Tone(event.reason),
    description: detail || 'S12 已檢查，但目前沒有足夠細節可顯示。',
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
