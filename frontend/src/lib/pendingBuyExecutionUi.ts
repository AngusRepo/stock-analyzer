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

export interface S12HoldingDefenseContext {
  status?: unknown
  reason?: unknown
  active?: unknown
  action?: unknown
  trailing_stop_before?: unknown
  trailing_stop_after?: unknown
  created_at?: unknown
  detail?: any
}

export interface CanonicalTradeLifecycleContext {
  version?: unknown
  tradeDate?: unknown
  symbol?: unknown
  owners?: {
    context?: unknown
    entry?: unknown
    exit?: unknown
    fallbackExit?: unknown
  }
  context?: Record<string, unknown>
  entry?: {
    entryPrice?: unknown
    stopLoss?: unknown
    chaseCeiling?: unknown
    source?: unknown
    s12?: any
  }
  exit?: {
    initialStop?: unknown
    trailingStop?: unknown
    tp1?: unknown
    tp2?: unknown
    fallbackOwner?: unknown
  }
}

export interface PositionRiskPlanBadge {
  stop: string | null
  stopSource: string | null
  stopTone: PendingBuyExecutionTone
  tp1: string | null
  tp2: string | null
  tpSource: string | null
  tp1Hit: boolean
}

interface ParsedExecutionNote {
  status: string
  reason: string
  detail: string | null
}

const STATUS_BADGES: Record<string, PendingBuyExecutionBadge> = {
  pending: {
    label: '待盤中檢查',
    tone: 'neutral',
    description: '尚未進入盤中檢查流程，或等待下一輪即時報價與技術條件。',
  },
  checked_waiting: {
    label: '盤中已檢查，等待條件',
    tone: 'warn',
    description: '盤中檢查已執行，但價格、量能或技術條件尚未到達進場門檻。',
  },
  submitted: {
    label: '已送出委託',
    tone: 'info',
    description: '模擬委託已建立，等待成交或取消結果。',
  },
  requoted: {
    label: '已重新報價',
    tone: 'warn',
    description: '委託價格依即時報價或追價限制重新校正。',
  },
  partially_filled: {
    label: '部分成交',
    tone: 'warn',
    description: '委託已有部分成交，剩餘張數仍需後續追蹤。',
  },
  stale_quote: {
    label: '報價過舊',
    tone: 'warn',
    description: '五檔或即時報價 freshness 未達標，系統採 fail-closed 不追單。',
  },
  quote_unavailable: {
    label: '報價不可用',
    tone: 'error',
    description: '無法取得可用 bid/ask 或 broker quote，暫停委託。',
  },
  filled: {
    label: '已成交',
    tone: 'ok',
    description: '委託已成交並進入持倉管理。',
  },
  skipped: {
    label: '已略過',
    tone: 'neutral',
    description: '此輪因策略、風控或資料條件未滿足而略過。',
  },
  cancelled: {
    label: '已取消',
    tone: 'neutral',
    description: '委託已取消，未產生新的成交。',
  },
  expired: {
    label: '已逾時',
    tone: 'neutral',
    description: '委託超過 SLA 或盤中有效時間，停止追蹤。',
  },
  rejected: {
    label: '已拒絕',
    tone: 'error',
    description: '風控、資金配置或交易條件拒絕此筆委託。',
  },
}

const EXECUTION_REASON_LABELS: Record<string, string> = {
  volume_ratio_low: '量能不足',
  weak_no_reclaim: '尚未轉強收復',
  between_buy_reference_and_confirmation: '價格位於買入區與確認價之間',
  ohlcv_support_lost: 'OHLCV 支撐失守',
  allocator_no_plan: '資金配置沒有可用方案',
  allocator_full_requires_replacement: '持倉已滿，需要先替換',
  allocator_replace_requires_sell_first: '替換買入需要先賣出',
  allocator_budget_below_min: '配置金額低於最低交易金額',
  technical_distribution_cooldown: '技術分佈冷卻中',
  range_position_low: '區間位置偏低，避免接刀',
  price_above_entry: '價格高於可追價上限',
  broker_quote_required: '需要券商即時報價',
  rod_cancelled: 'ROD 委託已取消',
  paper_order_created: '模擬委託已建立',
  paper_order_partial_fill: '模擬委託部分成交',
  already_filled_today: '今日已成交',
  duplicate_buy_intent: '重複買進意圖',
  s12_waiting_15m_completed_bars: 'S12 等待足夠 15M 完成K',
  s12_waiting_4h_completed_bar: 'S12 等待 4H 完成K',
  s12_waiting_4h_long_bias: 'S12 等待 4H 多方結構成立',
  s12_waiting_1h_completed_bar: 'S12 等待 1H 完成K',
  s12_waiting_1h_demand_zone: 'S12 等待 1H 需求區',
  s12_waiting_15m_zone_touch: 'S12 等待 15M 回踩需求區',
  s12_waiting_sweep: 'S12 等待掃流動性',
  s12_waiting_choch: 'S12 等待 CHoCH 轉強',
  s12_waiting_bos: 'S12 等待 BOS 確認',
  s12_waiting_retest: 'S12 等待 OB/FVG 回測反應',
  s12_reaction_ready: 'S12 反應確認完成',
  s12_assist_entry_ready: 'S12 輔助進場成立',
  s12_structure_advisory_waiting: 'S12 結構觀察，尚未接手',
  s12_structure_primary_waiting: 'S12 主機制等待結構成熟',
  s12_primary_structure_owner_waiting: 'S12 主控結構等待中',
  s12_primary_cleared_momentum_directional_gate: 'S12 已通過方向門檻',
  s12_structure_invalidated: 'S12 結構失效',
  s12_entry_zone_not_overlapping_1h_demand: 'S12 進場區未重疊 1H 需求區',
  s12_invalid_risk_box: 'S12 風險盒無效',
  s12_data_unavailable: 'S12 結構資料不足',
  s12_structure_stale: 'S12 結構等待過久',
  s12_bearish_defense_ready: 'S12 空方防守成立',
  s12_holding_defense_unavailable: 'S12 持倉防守資料不足',
  s12_tp1_partial_take_profit: 'S12 TP1 部分停利',
  s12_tp1_full_take_profit: 'S12 TP1 全部停利',
  s12_tp2_main_take_profit: 'S12 主出場停利',
  s12_bearish_defense_partial_take_profit: 'S12 空方防守部分停利',
  s12_reverse_bos_full_exit: 'S12 反向 BOS 出場',
  s12_tp1_quote_unavailable: 'S12 TP1 報價不可用',
  s12_tp2_quote_unavailable: 'S12 主出場報價不可用',
  s12_bearish_defense_quote_unavailable: 'S12 防守報價不可用',
}

const S12_STATE_LABELS: Record<string, string> = {
  waiting_15m_completed_bars: '等待 15M K 完成',
  waiting_4h_completed_bar: '等待 4H K 完成',
  waiting_4h_long_bias: '等待 4H 多方結構',
  waiting_1h_completed_bar: '等待 1H K 完成',
  waiting_1h_demand_zone: '等待 1H 需求區',
  waiting_15m_zone_touch: '等待 15M 回踩需求區',
  waiting_sweep: '等待掃流動性',
  waiting_choch: '等待 CHoCH',
  waiting_bos: '等待 BOS',
  waiting_retest: '等待回測反應',
  reaction_ready: '多方反應結構成立',
  bearish_defense_ready: '空方防守結構成立',
  invalidated: '結構失效',
}

const S12_DEFENSE_ACTION_LABELS: Record<string, string> = {
  NO_BUY: '不買',
  WAIT_RESET: '等待重置',
  LOWER_CONFIDENCE: '降低信心',
  TIGHTEN_STOP: '提高防守',
  TRIM: '減碼',
  TAKE_PROFIT: '停利',
  EXIT_ON_REVERSE_BOS: '反向 BOS 出場',
  tighten_defense: '提高 trailing stop',
  tighten_stop: '提高防守停損',
  take_profit_or_tighten_stop: '停利或提高防守',
  trim_or_take_profit: '減碼或停利',
  take_profit: '停利',
  full_exit: '全部出場',
  quote_unavailable: '報價不可用',
  observe: '觀察',
}

const OWNER_LABELS: Record<string, string> = {
  market_regime_alpha_context_v1: '市場 regime / alpha context',
  s12_intraday_structure_v1: 'S12 結構進場',
  s12_position_decision_v1: 'S12 持倉出場',
  ohlcv_pre_trade_plan_v1: 'OHLCV 進場計畫',
  paper_sltp_atr_trailing_v1: 'ATR trailing 出場',
}

const S12_TAKEOVER_ROLE_LABELS: Record<string, string> = {
  none: '尚未接手',
  long_entry: '多方進場',
  no_buy_defense: '不買/防守',
  invalidate: '結構失效',
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
  const clean = detail.replace(/_/g, ' ').replace(/;/g, '、').trim()
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

function parseLifecycle(raw: unknown): CanonicalTradeLifecycleContext | null {
  if (!raw) return null
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as CanonicalTradeLifecycleContext
  if (typeof raw !== 'string') return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as CanonicalTradeLifecycleContext
      : null
  } catch {
    return null
  }
}

function fmtPrice(value: unknown): string | null {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  return n.toLocaleString('zh-TW', { maximumFractionDigits: 2 })
}

function positivePrice(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

function yn(value: string | undefined): string | null {
  if (value === 'true') return '已對齊'
  if (value === 'false') return '未對齊'
  return null
}

function directionLabel(value: string | undefined): string | null {
  if (value === 'long') return '多方'
  if (value === 'short') return '空方'
  if (value === 'neutral') return '中性'
  return value || null
}

function confidenceLabel(value: string | undefined): string | null {
  if (value === 'confirmed') return '已確認'
  if (value === 'provisional') return '暫定'
  if (value === 'none') return '未確認'
  return value || null
}

function s12Tone(reason: string): PendingBuyExecutionTone {
  if (
    reason === 's12_reaction_ready' ||
    reason === 's12_assist_entry_ready' ||
    reason === 's12_primary_cleared_momentum_directional_gate'
  ) return 'ok'
  if (
    reason === 's12_structure_invalidated' ||
    reason === 's12_invalid_risk_box' ||
    reason === 's12_bearish_defense_ready'
  ) return 'error'
  if (reason === 's12_structure_stale' || reason === 's12_holding_defense_unavailable') return 'warn'
  return 'warn'
}

function formatS12Detail(detail: string | null): string {
  const parsed = parseDetailMap(detail)
  const parts = [
    parsed.state ? `狀態：${S12_STATE_LABELS[parsed.state] ?? parsed.state}` : null,
    parsed.bars15m || parsed.bars1h || parsed.bars4h
      ? `完成K：15M ${parsed.bars15m ?? 0}、1H ${parsed.bars1h ?? 0}、4H ${parsed.bars4h ?? 0}`
      : null,
    parsed.bias4h ? `4H方向：${directionLabel(parsed.bias4h)}` : null,
    parsed.bias_confidence ? `4H確認度：${confidenceLabel(parsed.bias_confidence)}` : null,
    parsed.bias_channel_align ? `4H通道：${yn(parsed.bias_channel_align)}` : null,
    parsed.bias1h ? `1H方向：${directionLabel(parsed.bias1h)}` : null,
    parsed.zone_low && parsed.zone_high ? `1H需求區：${parsed.zone_low} - ${parsed.zone_high}` : null,
    parsed.supply_zone_low && parsed.supply_zone_high ? `1H供給區：${parsed.supply_zone_low} - ${parsed.supply_zone_high}` : null,
    parsed.bearish_defense_state ? `空方防守：${S12_STATE_LABELS[parsed.bearish_defense_state] ?? parsed.bearish_defense_state}` : null,
    parsed.bearish_defense_action ? `防守動作：${S12_DEFENSE_ACTION_LABELS[parsed.bearish_defense_action] ?? parsed.bearish_defense_action}` : null,
    parsed.vwap_state ? `VWAP：${parsed.vwap_state}${parsed.price_vwap_pct ? ` (${parsed.price_vwap_pct})` : ''}` : null,
    parsed.rvol_state ? `RVOL：${parsed.rvol_state}${parsed.rvol ? ` (${parsed.rvol})` : ''}` : null,
    parsed.takeover_role ? `接手角色：${S12_TAKEOVER_ROLE_LABELS[parsed.takeover_role] ?? parsed.takeover_role}` : null,
    parsed.maturity_stage ? `成熟階段：${parsed.maturity_stage}` : null,
    parsed.entry ? `進場參考：${parsed.entry}` : null,
    parsed.chase_ceiling ? `追價上限：${parsed.chase_ceiling}` : null,
    parsed.stop ? `結構停損：${parsed.stop}` : null,
    parsed.structural_tp1 ? `TP1：${parsed.structural_tp1}` : parsed.t1 ? `TP1：${parsed.t1}` : null,
    parsed.structural_main_exit ? `主出場：${parsed.structural_main_exit}` : parsed.t2 ? `主出場：${parsed.t2}` : null,
    parsed.stale === 'true' ? `等待過久：${parsed.stale_reason ?? '結構未成熟'}` : null,
  ].filter(Boolean)
  return parts.join('；')
}

export function formatExecutionStatusBadge(status: unknown): PendingBuyExecutionBadge {
  const key = String(status ?? 'pending').trim() || 'pending'
  return STATUS_BADGES[key] ?? {
    label: key,
    tone: 'neutral',
    description: '此狀態尚未加入 execution UI contract，請回補狀態說明。',
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
      label: '盤中已檢查，等待條件',
      tone: 'warn',
      description: `盤中檢查已執行，但條件尚未成立：${reason}${detail}。`,
    }
  }
  if (key === event.status || key === 'cancelled' || key === 'skipped' || key === 'expired' || key === 'rejected') {
    return {
      ...base,
      description: `${base.description} 最新原因：${reason}${detail}。`,
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
    description: detail || 'S12 結構尚在觀察，僅作為進場輔助。',
  }
}

export function formatS12HoldingDefenseBadge(raw: unknown): PendingBuyExecutionBadge | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as S12HoldingDefenseContext
  const reason = String(item.reason ?? '').trim()
  const status = String(item.status ?? '').trim()
  const active = Boolean(item.active)
  const action = String(item.action ?? item.detail?.holding_defense?.action ?? '').trim()
  const decisionReason = String(item.detail?.holding_defense?.decision_reason ?? '').trim()
  const before = item.trailing_stop_before ?? item.detail?.holding_defense?.trailing_stop_before ?? null
  const after = item.trailing_stop_after ?? item.detail?.holding_defense?.trailing_stop_after ?? null
  const detail = item.detail?.detail ? formatS12Detail(String(item.detail.detail)) : ''
  const completedBars = item.detail?.completedBars ?? {}
  const hasNoCompletedBars = Number(completedBars.m15 ?? 0) <= 0 && Number(completedBars.h1 ?? 0) <= 0 && Number(completedBars.h4 ?? 0) <= 0
  const h4Source = String(item.detail?.h4Source ?? item.detail?.h4_source ?? '').trim()
  const insufficientData = reason === 's12_holding_defense_unavailable' || hasNoCompletedBars || reason === 's12_waiting_15m_completed_bars'
  const label = active
    ? action === 'take_profit'
      ? decisionReason.includes('tp2') || decisionReason.includes('full')
        ? 'S12 主出場'
        : 'S12 部分停利'
      : action === 'full_exit'
        ? 'S12 全部出場'
        : action === 'quote_unavailable'
          ? 'S12 報價不可用'
          : 'S12 防守啟動'
    : insufficientData
      ? 'S12 防守資料不足'
      : reason === 's12_bearish_defense_ready' || status === 'bearish_defense_ready'
        ? 'S12 空方防守成立'
        : reason === 's12_waiting_4h_completed_bar' && h4Source === 'unavailable'
          ? 'S12 4H錨點不足'
          : 'S12 結構監控'
  const stopText = before != null || after != null
    ? `防守停損：${before ?? '-'} -> ${after ?? '-'}`
    : null
  const actionText = action
    ? `動作：${S12_DEFENSE_ACTION_LABELS[action] ?? action}`
    : null
  return {
    label,
    tone: active
      ? action === 'quote_unavailable' ? 'error' : 'warn'
      : insufficientData ? 'warn' : s12Tone(reason || status),
    description: [actionText, stopText, detail].filter(Boolean).join('；') || humanizeExecutionReason(reason || status || 's12_structure_advisory_waiting'),
  }
}

export function formatPositionRiskPlan(raw: Record<string, unknown> | null | undefined): PositionRiskPlanBadge {
  const lifecycle = parseLifecycle(raw?.canonical_trade_lifecycle)
  const s12Defense = raw?.s12_holding_defense as S12HoldingDefenseContext | null | undefined
  const s12Stop = positivePrice(s12Defense?.trailing_stop_after ?? s12Defense?.detail?.holding_defense?.trailing_stop_after)
  const trailingStop = positivePrice(raw?.trailing_stop)
  const lifecycleStop = positivePrice(lifecycle?.exit?.trailingStop ?? lifecycle?.exit?.initialStop ?? lifecycle?.entry?.stopLoss)
  const initialStop = positivePrice(raw?.initial_stop)
  const stopValue = s12Stop ?? trailingStop ?? lifecycleStop ?? initialStop
  const stopSource = s12Stop != null
    ? 'S12 防守'
    : trailingStop != null
      ? 'ATR trailing'
      : lifecycleStop != null
        ? '生命週期'
        : initialStop != null
          ? '初始停損'
          : null

  const s12ExitPlan = lifecycle?.entry?.s12?.exitPlan ?? {}
  const s12Tp1 = positivePrice(s12ExitPlan.tp1)
  const s12MainExit = positivePrice(s12ExitPlan.mainExit)
  const tp1Value = s12Tp1 ?? positivePrice(lifecycle?.exit?.tp1) ?? positivePrice(raw?.tp1_price)
  const tp2Value = s12MainExit ?? positivePrice(lifecycle?.exit?.tp2) ?? positivePrice(raw?.tp2_price)
  const tpSource = s12Tp1 != null || s12MainExit != null
    ? 'S12 結構'
    : lifecycle?.owners?.exit
      ? OWNER_LABELS[String(lifecycle.owners.exit)] ?? String(lifecycle.owners.exit)
      : tp1Value != null || tp2Value != null
        ? 'paper SLTP'
        : null

  return {
    stop: fmtPrice(stopValue),
    stopSource,
    stopTone: s12Stop != null ? 'warn' : 'neutral',
    tp1: fmtPrice(tp1Value),
    tp2: fmtPrice(tp2Value),
    tpSource,
    tp1Hit: Boolean(raw?.tp1_hit),
  }
}

export function formatCanonicalTradeLifecycleBadge(raw: unknown): PendingBuyExecutionBadge | null {
  const lifecycle = parseLifecycle(raw)
  if (!lifecycle?.owners) return null
  const entryOwner = String(lifecycle.owners.entry ?? '').trim()
  const exitOwner = String(lifecycle.owners.exit ?? '').trim()
  const contextOwner = String(lifecycle.owners.context ?? '').trim()
  const entrySource = String(lifecycle.entry?.source ?? '').trim()
  const s12 = lifecycle.entry?.s12
  const entryLabel = OWNER_LABELS[entryOwner] ?? entryOwner
  const exitLabel = OWNER_LABELS[exitOwner] ?? exitOwner
  const stop = fmtPrice(lifecycle.exit?.trailingStop ?? lifecycle.exit?.initialStop ?? lifecycle.entry?.stopLoss)
  const tp1 = fmtPrice(lifecycle.entry?.s12?.exitPlan?.tp1 ?? lifecycle.exit?.tp1)
  const mainExit = fmtPrice(lifecycle.entry?.s12?.exitPlan?.mainExit ?? lifecycle.exit?.tp2)
  const tp3 = fmtPrice(lifecycle.entry?.s12?.exitPlan?.tp3)
  const tp4 = fmtPrice(lifecycle.entry?.s12?.exitPlan?.tp4)
  const manualTp = fmtPrice(lifecycle.entry?.s12?.exitPlan?.manualTp)
  const plannedTp = String(lifecycle.entry?.s12?.exitPlan?.plannedTakeProfit ?? '').trim()
  const primaryS12 = entryOwner === 's12_intraday_structure_v1' || exitOwner === 's12_position_decision_v1'
  const parts = [
    contextOwner ? `情境：${OWNER_LABELS[contextOwner] ?? contextOwner}` : null,
    entrySource ? `進場來源：${entrySource === 's12_assist_entry' ? 'S12 輔助進場' : '盤前交易計畫'}` : null,
    exitLabel ? `出場：${exitLabel}` : null,
    lifecycle.owners?.fallbackExit ? `備援：${OWNER_LABELS[String(lifecycle.owners.fallbackExit)] ?? String(lifecycle.owners.fallbackExit)}` : null,
    stop ? `防守停損 ${stop}` : null,
    tp1 ? `TP1 ${tp1}` : null,
    mainExit ? `主出場 ${mainExit}` : null,
    tp3 ? `TP3 ${tp3}` : null,
    tp4 ? `TP4 ${tp4}` : null,
    manualTp ? `手動 TP ${manualTp}` : null,
    plannedTp ? `計畫 ${plannedTp}` : null,
    s12?.quality?.vwapState ? `VWAP ${s12.quality.vwapState}` : null,
    s12?.quality?.rvolState ? `RVOL ${s12.quality.rvolState}` : null,
  ].filter(Boolean)

  return {
    label: primaryS12 ? 'S12 買賣主機制' : entryLabel || '交易生命週期',
    tone: primaryS12 ? 'info' : 'neutral',
    description: parts.join('；') || '此持倉已寫入 canonical lifecycle owner。',
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
  return `部分成交：已成交 ${filled} / 委託 ${requested}，剩餘 ${remaining} 股`
}
