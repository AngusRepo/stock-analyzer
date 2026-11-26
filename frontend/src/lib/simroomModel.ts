/**
 * 模擬交易室（/bot）推薦候選的 view model。依 Wei 11/25 核准的 mock（audits/simroom-mock-20261125）：
 * 時段決定版面（盤前計畫表／盤中／盤後）、16 項條件一排小方塊、第一個卡住的關卡、價格梯。
 * 只用後端已有欄位（pending-buys 的 execution_preview、planned_allocation、today_fills、market_price）；
 * 沒有資料的欄位（5 分 K 序列、盤後反事實、明日候選）不做也不編造。
 */
import { checklistEvidence, checklistNumbers, checklistUnknownReason, evidenceTime } from './pendingEntryChecklist'
import { buildPendingBuyTradeView, type PendingBuyExecutionPreview } from './pendingBuyTradePreview'
import { currentDisplayPrice } from './pendingBuyDisplay'
import { formatPartialFillRemaining, formatPendingBuyExecutionBadge, formatS12IntradayStructureBadge, formatS12IntradayStructureState, type PendingBuyExecutionBadge } from './pendingBuyExecutionUi'
import { debateObservationLabel } from './paperDecisionUi'
import { humanEntryReason } from './orderReason'

// ─── 時段 ────────────────────────────────────────────────────────────────────
export type SessionPhase = 'night' | 'premarket' | 'intraday' | 'close' | 'postmarket'
export type SimroomView = 'premarket' | 'intraday' | 'postmarket'

/** 時段軸：夜間 00:00–08:00、盤前 08:00–09:00、盤中 09:00–13:30、收盤／零股 13:30–14:30、盤後 14:30–24:00。 */
export const SESSION_SEGMENTS: Array<{ phase: SessionPhase; label: string; detail: string; from: number; to: number; weight: number }> = [
  { phase: 'night', label: '夜間', detail: '00:00–08:00', from: 0, to: 480, weight: 3 },
  { phase: 'premarket', label: '盤前', detail: '08:00–09:00 計畫', from: 480, to: 540, weight: 2 },
  { phase: 'intraday', label: '盤中', detail: '09:00–13:30', from: 540, to: 810, weight: 9 },
  { phase: 'close', label: '收盤', detail: '13:30–14:30 零股', from: 810, to: 870, weight: 2 },
  { phase: 'postmarket', label: '盤後', detail: '14:30 起 結果', from: 870, to: 1440, weight: 4 },
]

export interface TwClock { minutes: number; weekday: number; date: string }

export function twClock(nowMs = Date.now()): TwClock {
  const tw = new Date(nowMs + 8 * 3600_000)
  return { minutes: tw.getUTCHours() * 60 + tw.getUTCMinutes(), weekday: tw.getUTCDay(), date: tw.toISOString().slice(0, 10) }
}

export function sessionPhase(minutes: number): SessionPhase {
  return SESSION_SEGMENTS.find((s) => minutes >= s.from && minutes < s.to)?.phase ?? 'postmarket'
}

export function defaultView(phase: SessionPhase): SimroomView {
  if (phase === 'intraday') return 'intraday'
  if (phase === 'close' || phase === 'postmarket') return 'postmarket'
  return 'premarket'
}

/** 時段軸上現在的位置（0–1）。 */
export function axisPosition(minutes: number): number {
  const total = SESSION_SEGMENTS.reduce((acc, s) => acc + s.weight, 0)
  let offset = 0
  for (const s of SESSION_SEGMENTS) {
    if (minutes < s.to) return (offset + s.weight * (minutes - s.from) / (s.to - s.from)) / total
    offset += s.weight
  }
  return 1
}

/**
 * 休市（都是既有 holiday 機制，前端不另寫行事曆）：
 * 1. Worker /paper/pending-buys 的 trading_day（batch2 起；依週末、KV holiday:YYYY-MM-DD、已記錄的 TWSE 休市判斷），
 *    只在 session_date 就是今天時採用；false＝休市、true＝開市、null／舊 Worker 沒有＝不確定。
 * 2. 週末。
 * 3. 盤中時段 /paper/display-quotes 回 outside_session。
 */
export function isClosedDay(clock: TwClock, displayQuoteStatus?: string | null, session?: { session_date?: unknown; trading_day?: unknown } | null): boolean {
  if (session && session.session_date === clock.date && typeof session.trading_day === 'boolean') return !session.trading_day
  if (clock.weekday === 0 || clock.weekday === 6) return true
  return sessionPhase(clock.minutes) === 'intraday' && displayQuoteStatus === 'outside_session'
}

// ─── 16 項條件 ─────────────────────────────────────────────────────────────────
export const CONDITION_GROUPS: Array<{ title: string; keys: string[] }> = [
  { title: '當日基準', keys: ['plan', 'ma60', 'opening_limit', 'atr_once'] },
  { title: '5 分 K 訊號', keys: ['bars', 'or_touch', 'vwap', 'relative_strength'] },
  { title: '送單前檢查', keys: ['window', 'quote', 'buy_limit', 'chase', 'position', 'allocation', 'l5', 'final'] },
]
export const CONDITION_LABELS: Record<string, string> = {
  plan: '計畫', ma60: 'MA60', opening_limit: '開盤未漲停', atr_once: 'ATR 動能',
  bars: 'K棒完整', or_touch: '觸 ORH', vwap: '≥VWAP', relative_strength: '強於0050',
  window: '送單期限', quote: '新報價', buy_limit: '未漲停', chase: '≤追價上限',
  position: '未持有', allocation: '配置', l5: '五檔', final: '風控',
}
export const CONDITION_KEYS = CONDITION_GROUPS.flatMap((g) => g.keys)

export type CondTone = 'ok' | 'warn' | 'fail' | 'na' | 'rec'
export interface SimCondition { key: string; label: string; tone: CondTone; value: string; /** 原始代碼，只放 title。 */ raw?: string }

/**
 * 五檔品質（Worker finlabL5MarketData L5QuoteQuality.status：pass／degraded／blocked，沒有報價時配置器寫 null）。
 * 與 origin/main 一致：只有 pass 是通過，其他都算未通過；原碼只放 title。
 */
export function l5StatusLabel(status: unknown): string {
  const key = typeof status === 'string' ? status.trim().toLowerCase() : ''
  if (!key) return '缺五檔'
  if (key === 'pass') return 'L5 報價通過'
  if (key === 'degraded') return 'L5 報價品質不足（未通過）'
  if (key === 'missing') return '缺五檔'
  return 'L5 報價未通過'
}

/** 配置器結論（allocator action）：buy／add 才是「可買／可加碼」，skip 由 last_blocker 顯示原因。 */
export function allocatorActionLabel(action: unknown): string | null {
  if (action === 'buy') return 'L4 配置可買'
  if (action === 'add') return 'L4 配置可加碼'
  return null
}

// 一旦為 false 就是當日終局（不會再等到）；其他 false 是「還在等」。
const TERMINAL_KEYS = new Set(['plan', 'opening_limit', 'buy_limit', 'chase', 'position'])

/**
 * 當日終局的原因分兩類（盤後「未觸發」與「規則擋下」靠這個分）。對照 Worker：
 * - 時窗結束、從未觸發：or15VwapEntry.ts 13:30 後 wait('or15_entry_window_closed')；paperSwingPolicy／paperSwingAssessment
 *   的 swing_entry_window_closed；paperSecondBreakout 的 swing_recovery_expired；paperSwingExecution 的
 *   swing_next_bar_submission_missed（訊號後沒趕上送單時窗）；swing_recovery_not_observed_live；paper_outside_continuous_session。
 * - 規則判定擋下：ATR 否決、開盤區間／可成交價漲停、追價上限、計畫未授權、已持有、S12 否決。
 */
export const UNTRIGGERED_REASONS = new Set([
  'or15_entry_window_closed', 'swing_entry_window_closed', 'swing_recovery_expired', 'swing_recovery_not_observed_live',
  'swing_next_bar_submission_missed', 'paper_outside_continuous_session',
])
export const BLOCKING_REASONS = new Set([
  'swing_atr_day_veto', 'swing_opening_range_at_limit', 'swing_buy_at_limit', 'swing_chase_limit',
  'swing_plan_not_authorized', 'swing_existing_position_or_daily_fill', 'daily_plan_existing_position', 's12_hard_veto',
])
const TERMINAL_REASONS = new Set([...UNTRIGGERED_REASONS, ...BLOCKING_REASONS])
const TERMINAL_EXECUTION = new Set(['skipped', 'cancelled', 'expired', 'rejected'])

// ─── 列 ──────────────────────────────────────────────────────────────────────
export type RowStatus = 'filled' | 'trig' | 'near' | 'wait' | 'stop'
export const ROW_STATUS_LABEL: Record<RowStatus, string> = {
  filled: '已成交', trig: '已觸發', near: '接近', wait: '等待', stop: '今日不進場',
}
export const ROW_STATUS_ORDER: RowStatus[] = ['filled', 'trig', 'near', 'wait', 'stop']

export interface DisplayQuote { price: number; as_of: string; reference_price?: number | null }

function lastObservedQuote(...candidates: any[]): any | null {
  const ok = candidates.filter((q) => q && Number(q.price) > 0 && Number.isFinite(Date.parse(q.as_of)))
  return ok.sort((a, b) => Date.parse(b.as_of) - Date.parse(a.as_of))[0] ?? null
}

/**
 * 列的報價：90 秒內的用 currentDisplayPrice（含參考價）；沒有就退回最後一筆有時間的報價，
 * 交給 buildSimRow 依原始 as_of 標成過期（「舊 Ns」、淡化、不算距離）。不能因為過期就讓報價消失，
 * 否則過期和「還沒有報價」看起來一樣。
 */
export function selectSimQuote(live: any, cached: any, nowMs: number, daily?: any): DisplayQuote | null {
  return currentDisplayPrice(live, cached, nowMs, daily) ?? lastObservedQuote(live, cached)
}

/** Worker 事件時間（D1 created_at 'YYYY-MM-DD HH:MM:SS' 是 UTC、無時區）→ ms。 */
function eventMs(value: unknown): number {
  if (typeof value !== 'string' || !value.trim()) return NaN
  const text = value.trim().replace(' ', 'T')
  return Date.parse(/Z$|[+-]\d{2}:?\d{2}$/.test(text) ? text : `${text}Z`)
}

const twDay = (ms: number) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10)

/** 過期報價的短字：時間不明（缺時間或比現在還晚）不寫成「舊 0s」。 */
export function staleQuoteLabel(row: Pick<SimRow, 'quoteAgeSec'>): string {
  return row.quoteAgeSec == null ? '報價時間不明' : `舊 ${formatQuoteAge(row.quoteAgeSec)}`
}

/** 報價年齡的短字：<100 秒寫秒、<1 小時寫分、再久寫小時。 */
export function formatQuoteAge(sec: number | null): string {
  if (sec == null || !Number.isFinite(sec)) return '—'
  if (sec < 100) return `${Math.round(sec)}s`
  if (sec < 3600) return `${Math.floor(sec / 60)} 分`
  return `${Math.floor(sec / 3600)} 小時`
}

export interface SimRow {
  symbol: string
  name: string
  status: RowStatus
  price: number | null
  quoteAsOf: string | null
  quoteAgeSec: number | null
  stale: boolean
  change: number | null
  changePct: number | null
  prevClose: number | null
  refPrice: number | null
  refGapPct: number | null
  refFlag: boolean
  orh: number | null
  orl: number | null
  chase: number | null
  vwap: number | null
  limitUp: number | null
  distancePct: number | null
  /** 進場 owner：OR15 用開盤 15 分鐘高點（ORH）觸發；S12 用結構進場價。 */
  owner: 'or15' | 's12'
  /** 價格梯的觸發價：OR15＝ORH；S12＝結構就緒時的 entry_price，沒有就是 null（不畫梯、不標缺資料）。 */
  trigger: number | null
  /** S12 結構狀態的中文說明（owner='s12' 才有）。 */
  s12Text: string | null
  /** 訊號通過（OR15 pass／S12 ready）之後又被風控／配置擋下（last_blocker 較晚）：不算已觸發，盤後算規則擋下。 */
  blockedAfterSignal: boolean
  /** 部分成交：剩餘股數仍在跑進場檢查，不是終態。 */
  partial: boolean
  /** 部分成交的委託／成交／剩餘股數（Worker execution:partially_filled 註記），沒有就是 null。 */
  partialRemaining: string | null
  /** 這一檔實際的執行狀態（依 execution_status＋最近執行註記），不是由條件推回來的狀態。 */
  executionBadge: PendingBuyExecutionBadge
  /** 狀態欄的覆寫字：部分成交後當日不再加碼時不寫成單純的「今日不進場」。 */
  statusText: string | null
  /** 來源風控（alpha_risk_overlay）標記跳過買入，但仍在今日待買清單。 */
  riskSkip: boolean
  lock: boolean
  conditions: SimCondition[]
  firstBlocker: number
  blockerText: string | null
  reasonCode: string | null
  weight: number | null
  allocValue: number | null
  estimatedShares: number | null
  finalizedAt: string | null
  fill: { shares: number; avgPrice: number | null; at: string | null } | null
  checkedAt: string | null
  debateLabel: string | null
  /** 已結束的待買紀錄（只有終態，沒有價格與條件證據）。 */
  completed: boolean
}

function pos(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null
}

/** 參考價與昨收／現價差超過 20% → 可能除權息、減資或資料過期，不自動算股數。 */
export const REF_GAP_LIMIT = 0.2
/** 距觸發 ≤ 1% 算「接近」。 */
export const NEAR_PCT = 1
/** 報價超過 90 秒不採用（fail-closed）。 */
export const STALE_QUOTE_SEC = 90

export function buildSimRow(item: any, quote: DisplayQuote | null, nowMs = Date.now()): SimRow {
  const preview: PendingBuyExecutionPreview | null | undefined = item?.execution_preview
  const evidence = checklistEvidence(preview, nowMs)
  const signal = evidence.signal
  const daily = preview?.daily_assessment ?? signal
  const or15 = preview?.or15 ?? null
  const conditions: Record<string, boolean | null> = { ...evidence.conditions }
  for (const key of ['ma60', 'opening_limit', 'atr_once']) {
    if (typeof conditions[key] !== 'boolean' && typeof daily?.conditions?.[key] === 'boolean') conditions[key] = daily.conditions[key] as boolean
  }
  const plan = item?.planned_allocation ?? null
  conditions.plan = plan ? plan.target_weight > 0 && !plan.locked : null
  const fills = item?.today_fills
  const exec = String(item?.execution_status ?? '').toLowerCase()
  // Worker paperEntryTasks：L4 partially_filled 的剩餘股數每輪重跑進場檢查（keep 時續等，否則才 cancel／expire）。
  const partial = exec === 'partially_filled'
  if (fills?.shares > 0 && !partial) conditions.position = false
  // Allocator and L5 audit details remain evidence, never an enduring execution authorization.
  conditions.allocation = null; conditions.l5 = null; conditions.final = null

  const atrVeto = (or15?.atr_once ?? signal?.atr_once)?.status === 'veto'
  const conds: SimCondition[] = CONDITION_KEYS.map((key) => {
    const v = conditions[key] ?? null
    const source = ['ma60', 'opening_limit', 'atr_once'].includes(key) && typeof evidence.conditions[key] !== 'boolean' ? daily : signal
    let value = v === null ? checklistUnknownReason(key, !!signal) : ''
    const numbers = checklistNumbers(key, key === 'atr_once' && or15?.atr_once ? or15 : source ?? null)
    if (numbers && numbers !== '等待原始檢查數值') value = numbers
    if (key === 'plan' && plan) value = `權重 ${(plan.target_weight * 100).toFixed(2)}% · 封存 ${evidenceTime(plan.finalized_at)}`
    if (key === 'position' && fills?.shares) value = partial
      ? `已部分成交 ${Number(fills.shares).toLocaleString('en-US')} 股；剩餘股數續跑檢查`
      : `今日已成交 ${Number(fills.shares).toLocaleString('en-US')} 股`
    if (key === 'position' && partial && v !== false) {
      return { key, label: CONDITION_LABELS[key], tone: 'ok' as CondTone, value }
    }
    if (key === 'allocation' && preview?.allocator) {
      const conclusion = allocatorActionLabel(preview.allocator.action)
      value = `最近檢查 ${evidenceTime(preview.allocator.checked_at)}${conclusion ? ` · ${conclusion}` : ''} · 上限 $${preview.allocator.budget_cap?.toLocaleString('en-US') ?? '未記錄'}（送單時重查）`
    }
    if (key === 'l5' && preview?.allocator) {
      value = `最近檢查 ${evidenceTime(preview.allocator.checked_at)} · ${l5StatusLabel(preview.allocator.l5_status)}（送單時重查）`
      return { key, label: CONDITION_LABELS[key], tone: 'na' as CondTone, value, raw: preview.allocator.l5_status ?? undefined }
    }
    if (!value) value = v === true ? '通過' : v === false ? '未通過' : '尚未檢查'
    let tone: CondTone = v === true ? 'ok' : v === false ? 'warn' : 'na'
    if (key === 'ma60') tone = 'rec'
    else if (v === false && (TERMINAL_KEYS.has(key) || (key === 'atr_once' && atrVeto))) tone = 'fail'
    return { key, label: CONDITION_LABELS[key], tone, value }
  })
  const firstBlocker = conds.findIndex((c) => c.tone === 'fail' || c.tone === 'warn')

  const assessed = preview?.daily_assessment ?? or15 ?? preview?.last_or15_assessment ?? null
  const orh = pos(or15?.or_high ?? assessed?.or_high)
  const orl = pos(or15?.or_low ?? assessed?.or_low)
  const owner: 'or15' | 's12' = preview?.entry_owner === 's12' ? 's12' : 'or15'
  const s12 = preview?.s12 ?? null
  const s12Entry = owner === 's12' && s12?.ready ? pos(s12.entry_price) : null
  const chase = owner === 's12'
    ? (s12Entry != null ? pos(s12?.chase_ceiling) : null)
    : pos(or15?.max_buy_price ?? assessed?.max_buy_price) ?? pos(s12?.chase_ceiling)
  const trigger = owner === 's12' ? s12Entry : orh
  // S12 preview 只取 5 分鐘內的事件；過了就退回 watch_points 最後一筆結構狀態（只收中文 label，代碼片語不上畫面）。
  const watchS12Badge = owner === 's12' && !s12 ? formatS12IntradayStructureBadge(item?.watch_points) : null
  const s12Badge = watchS12Badge && /[\u4e00-\u9fff]/.test(watchS12Badge.label) ? watchS12Badge : null
  const s12Text = owner === 's12' ? (s12 ? formatS12IntradayStructureState(String(s12.state ?? ''), String(s12.reason ?? '')) : s12Badge?.label ?? '等待近期盤中結構資料') : null
  const vwap = pos(or15?.vwap ?? assessed?.vwap)
  const limitUp = pos(or15?.limit_up ?? assessed?.limit_up)
  const prevClose = pos(assessed?.previous_close ?? or15?.previous_close)
  const refPrice = pos(item?.ml_entry_price)

  const price = quote ? pos(quote.price) : null
  const asOfMs = quote?.as_of ? Date.parse(quote.as_of) : NaN
  // 報價時間比現在還晚（裝置時鐘落後）＝時間不明，不 clamp 成 0 秒，否則 90 秒 fail-closed 失效。
  const quoteAgeSec = Number.isFinite(asOfMs) && asOfMs <= nowMs ? (nowMs - asOfMs) / 1000 : null
  // fail-closed：有價格但時間缺、解析不了或在未來，也當過期，不拿來算距離。
  const stale = price != null && (quoteAgeSec == null || quoteAgeSec > STALE_QUOTE_SEC)
  // 過期報價不是今天的（或日期不明）：它的漲跌是別天的，不上「漲跌」欄。
  const otherDayQuote = stale && (quoteAgeSec == null || twDay(asOfMs) !== twDay(nowMs))
  const reference = pos(quote?.reference_price) ?? prevClose
  const change = price != null && reference != null && !otherDayQuote ? Number((price - reference).toFixed(6)) : null
  const changePct = change != null && reference ? change / reference * 100 : null
  const basis = price ?? prevClose
  // 現價（或昨收）相對選股參考價的差：+ 表示現價比參考價高。門檻對稱：大的除以小的 −1 超過 20% 才標。
  const refGapPct = refPrice != null && basis != null ? (basis / refPrice - 1) * 100 : null
  const refFlag = refPrice != null && basis != null && Math.max(refPrice, basis) / Math.min(refPrice, basis) - 1 > REF_GAP_LIMIT
  const distancePct = price != null && trigger != null && !stale ? (price / trigger - 1) * 100 : null
  const lock = conditions.opening_limit === false || (orh != null && limitUp != null && orh >= limitUp)

  // 訊號通過後，Worker 仍會經過配置器／L4／下單風控；這些擋下寫成 last_blocker（pendingBuyExecutionPreview kind='blocker'）。
  // 擋下時間晚於訊號 → 以擋下為準：不顯示已觸發，原因用擋下的 reason。時間不明時 fail-closed 視為較晚。
  const blocker = preview?.last_blocker ?? null
  // S12 只有 reaction_ready／limited_takeover_ready（takeoverRole=long_entry）才是 Worker 的 READY；
  // bearish_defense_ready 也帶 ready，但那是不買。
  const signalPass = owner === 's12'
    ? s12?.ready === true && (s12.state === 'reaction_ready' || s12.state === 'limited_takeover_ready')
    : or15?.action === 'pass'
  const signalMs = eventMs(owner === 's12' ? s12?.checked_at : or15?.checked_at)
  const blockerMs = eventMs(blocker?.checked_at)
  // 用 >=：D1 created_at 只到秒；同一輪裡訊號一定先寫（paperEntryTasks 先寫 intraday_technical_decision，
  // 再跑組合閘門 portfolio_risk_halt／P8／P9…），跨輪至少隔一個 cron 週期，所以同秒的擋下必是同輪、較晚的那筆。
  const blockedAfterSignal = signalPass && exec !== 'submitted' && !!blocker?.reason
    && Number.isFinite(blockerMs) && (!Number.isFinite(signalMs) || blockerMs >= signalMs)
  const reason = String((blockedAfterSignal ? blocker?.reason : owner === 's12' ? null : or15?.reason) ?? blocker?.reason ?? '')
  let status: RowStatus
  if (exec === 'filled' || (fills?.shares > 0 && !partial)) status = 'filled'
  else if (TERMINAL_EXECUTION.has(exec) || TERMINAL_REASONS.has(reason) || lock || atrVeto || conditions.plan === false) status = 'stop'
  // S12 結構 READY 等同 OR15 pass：Worker 同一輪就往配置／送單走，不必等 submitted 才算已觸發。
  else if (exec === 'submitted' || (signalPass && !blockedAfterSignal)) status = 'trig'
  else if (distancePct != null && distancePct < 0 && distancePct >= -NEAR_PCT) status = 'near'
  else status = 'wait'

  // 已成交後「未持有」必然不成立；那是成交的結果，不是卡住的關卡，不標成未通過。
  if (status === 'filled') {
    const i = CONDITION_KEYS.indexOf('position')
    if (conds[i].tone === 'fail') conds[i] = { ...conds[i], tone: 'ok', value: fills?.shares ? `成交前通過；${conds[i].value}` : '成交前通過' }
  }
  const trade = buildPendingBuyTradeView(item ?? {})
  const allocatorAction = preview?.allocator?.action
  // 部分成交後當日終止（擋下屬終態、漲停鎖死等）：剩餘股數不再買，但已成交的部分是事實，不寫成「今日不進場」。
  const partialStopped = partial && fills?.shares > 0 && status === 'stop'
  const partialStopText = partialStopped ? `已部分成交 ${Number(fills.shares).toLocaleString('en-US')} 股・今日不再加碼` : null
  return {
    symbol: String(item?.symbol ?? ''),
    name: String(item?.name ?? ''),
    status,
    price,
    quoteAsOf: quote?.as_of ?? null,
    quoteAgeSec,
    stale,
    change,
    changePct,
    prevClose,
    refPrice,
    refGapPct,
    refFlag,
    orh,
    orl,
    chase,
    vwap,
    limitUp,
    distancePct,
    owner,
    trigger,
    s12Text,
    blockedAfterSignal,
    partial,
    partialRemaining: formatPartialFillRemaining(item?.watch_points),
    executionBadge: formatPendingBuyExecutionBadge(item ?? {}),
    statusText: partialStopped ? '部分成交・不再加碼' : null,
    riskSkip: Array.isArray(item?.watch_points) && item.watch_points.some((point: unknown) => typeof point === 'string' && point.startsWith('alpha_risk_overlay:skip=true')),
    lock,
    conditions: conds,
    // 已成交的列不再標「第一個卡住的關卡」（成交後「未持有」必然不通過，標了會誤導）。
    firstBlocker: status === 'filled' ? -1 : firstBlocker,
    // 不認得的代碼不轉成英文片語顯示；畫面寫通用句，原碼在 reasonCode（tooltip）。
    blockerText: partialStopText
      ? (reason ? `${partialStopText}（${humanEntryReason(reason, '進場條件未通過')}）` : partialStopText)
      : status === 'trig' && owner === 's12' && s12Text
      ? s12Text
      : reason ? humanEntryReason(reason, status === 'stop' || blockedAfterSignal ? '今日進場條件未通過' : '進場條件檢查中')
      : trade.gateReason ?? (allocatorAction === 'buy' || allocatorAction === 'add' ? 'L4 配置可買，等待進場條件' : null),
    reasonCode: reason || null,
    weight: plan ? plan.target_weight : null,
    allocValue: trade.targetValue,
    estimatedShares: refFlag ? null : trade.estimatedShares,
    finalizedAt: plan?.finalized_at ?? null,
    fill: fills?.shares > 0 ? { shares: Number(fills.shares), avgPrice: pos(fills.average_price), at: fills.last_fill_at ?? null } : null,
    checkedAt: trade.checkedAt,
    debateLabel: item?.debate_status != null || item?.debate_verdict != null ? debateObservationLabel(item) : null,
    completed: false,
  }
}

const COMPLETED_TEXT: Record<string, string> = {
  filled: '已成交',
  cancelled: '委託已取消',
  skipped: '進場條件未通過，今日略過',
  expired: '未觸發，送單期限已過',
  rejected: '委託被拒',
}

/** 已結束（成交／取消／略過／過期／拒絕）的待買紀錄：只有終態，沒有盤中條件。 */
export function buildCompletedRow(item: any): SimRow {
  const exec = String(item?.execution_status ?? '').toLowerCase()
  const row = buildSimRow({ ...item, execution_preview: null }, null)
  return { ...row, status: exec === 'filled' ? 'filled' : 'stop', reasonCode: exec || null, blockerText: COMPLETED_TEXT[exec] ?? '已結束', firstBlocker: -1, completed: true }
}

/** 盤後結果分類：過期（沒觸發就過了送單期限）算「未觸發」，不算「規則擋下」。 */
export type PostOutcome = 'filled' | 'trig' | 'untriggered' | 'blocked'
export const POST_OUTCOME_LABEL: Record<PostOutcome, string> = { filled: '已成交', trig: '委託未成交', untriggered: '未觸發', blocked: '規則擋下' }
export function postOutcome(row: SimRow): PostOutcome {
  if (row.status === 'filled' || (row.partial && row.fill)) return 'filled'
  if (row.status === 'trig') return 'trig'
  // 訊號通過後被風控／配置擋下：不是沒觸發，是規則擋下。
  if (row.blockedAfterSignal) return 'blocked'
  if (row.status === 'near' || row.status === 'wait') return 'untriggered'
  // 時窗結束、從未觸發（含已結束列的 expired）＝未觸發；只有規則判定才算規則擋下。
  if (row.completed && row.reasonCode === 'expired') return 'untriggered'
  if (row.reasonCode && UNTRIGGERED_REASONS.has(row.reasonCode)) return 'untriggered'
  return 'blocked'
}

export function sortRows(rows: SimRow[]): SimRow[] {
  return [...rows].sort((a, b) => {
    const s = ROW_STATUS_ORDER.indexOf(a.status) - ROW_STATUS_ORDER.indexOf(b.status)
    if (s) return s
    const da = a.distancePct == null ? -Infinity : a.distancePct
    const db = b.distancePct == null ? -Infinity : b.distancePct
    if (da !== db) return db - da
    return (b.weight ?? 0) - (a.weight ?? 0)
  })
}

export function countByStatus(rows: SimRow[]): Record<RowStatus, number> {
  const out: Record<RowStatus, number> = { filled: 0, trig: 0, near: 0, wait: 0, stop: 0 }
  for (const row of rows) out[row.status] += 1
  return out
}

/** 0050 昨收對 MA60（R2b 起僅記錄、不擋單）。取任一列已記錄的數值。 */
export function marketTrend(items: any[]): { ratioPct: number; close: number; ma60: number } | null {
  for (const item of items) {
    const p = item?.execution_preview
    for (const s of [p?.daily_assessment, p?.or15, p?.last_or15_assessment]) {
      const close = pos(s?.benchmark_previous_close)
      const ma60 = pos(s?.ma60)
      if (close != null && ma60 != null) return { ratioPct: (close / ma60 - 1) * 100, close, ma60 }
    }
  }
  return null
}
