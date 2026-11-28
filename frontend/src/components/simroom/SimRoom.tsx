import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import { Activity } from 'lucide-react'
import './simroom.css'
import {
  CONDITION_GROUPS, CONDITION_KEYS, POST_OUTCOME_LABEL, ROW_STATUS_LABEL, SESSION_SEGMENTS,
  axisPosition, countByStatus, formatQuoteAge, postOutcome, staleQuoteLabel, sessionPhase, sortRows, STALE_QUOTE_SEC,
  type CondTone, type PostOutcome, type RowStatus, type SimRow, type SimroomView, type TwClock,
} from '@/lib/simroomModel'
import { formatDateShort, formatNumber, formatPrice, formatShares, formatSignedPct, formatTime, formatTwd } from '@/lib/format'
import { priceArrow } from '@/lib/colorTokens'

const COND_TEXT: Record<CondTone, string> = { ok: '通過', warn: '等待中', fail: '未通過', na: '尚未檢查', rec: '僅記錄' }
const ALLOC_PALETTE = ['#3b82f6', '#6366f1', '#0ea5e9', '#8b5cf6', '#2563eb', '#7c3aed', '#0284c7', '#4f46e5']
const POST_GLYPH: Record<PostOutcome, RowStatus> = { filled: 'filled', trig: 'trig', untriggered: 'wait', blocked: 'stop' }

function StatusGlyph({ status, view, bare = false, outcome, text }: { status: RowStatus; view: SimroomView; bare?: boolean; outcome?: PostOutcome; text?: string | null }) {
  if (view === 'postmarket' && outcome) status = POST_GLYPH[outcome]
  const label = view === 'postmarket' && outcome ? POST_OUTCOME_LABEL[outcome] : text ?? ROW_STATUS_LABEL[status]
  const shape = {
    filled: <><circle cx="6" cy="6" r="5.5" fill="var(--ok)" /><path d="M3.3 6.2 5.2 8 8.8 4.2" stroke="#fff" strokeWidth="1.6" fill="none" /></>,
    trig: <circle cx="6" cy="6" r="5" fill="var(--ok)" />,
    near: <><circle cx="6" cy="6" r="4.5" fill="none" stroke="var(--ok)" strokeWidth="2" /><path d="M6 1.5a4.5 4.5 0 0 1 0 9z" fill="var(--ok)" /></>,
    wait: <circle cx="6" cy="6" r="4.5" fill="none" stroke="#8992a3" strokeWidth="1.5" />,
    stop: <><circle cx="6" cy="6" r="4.5" fill="none" stroke="#8992a3" strokeWidth="1.5" /><path d="M3 9 9 3" stroke="#8992a3" strokeWidth="1.5" /></>,
  }[status]
  return <span className="st" title={label}><svg width="12" height="12" aria-hidden="true">{shape}</svg>{!bare && <span className="stl">{label}</span>}</span>
}

function Change({ row }: { row: SimRow }) {
  if (row.change == null || row.changePct == null) return <span className="text-muted-foreground">—</span>
  const cls = row.change > 0 ? 'sr-up' : row.change < 0 ? 'sr-down' : 'text-muted-foreground'
  return <span className={cls}>{priceArrow(row.change)} {formatPrice(Math.abs(row.change))} {formatNumber(Math.abs(row.changePct), 2)}%</span>
}

/** 價格梯：▏參考價 ┃觸發價（ORH） ░到追價上限 │VWAP ● 現價。 */
export function PriceLadder({ row, width = 190, height = 26, showDistance = true, orhPending = false }: { row: SimRow; width?: number; height?: number; showDistance?: boolean; orhPending?: boolean }) {
  if (row.lock) return <span className="chip lock" title="開盤區間高點已達漲停">鎖漲停 · 買不到</span>
  const px = row.price
  const trigger = row.trigger
  const values = [trigger, row.chase, row.vwap, px, row.refFlag ? null : row.refPrice].filter((v): v is number => v != null)
  if (row.completed) return <span className="text-muted-foreground">—</span>
  // S12 owner 沒有 ORH：結構就緒才有進場價可畫；還沒就緒就寫結構狀態，不標缺資料。
  if (row.owner === 's12' && trigger == null) return <span className="text-muted-foreground" title="S12 盤中結構">S12 結構：{row.s12Text}</span>
  if (trigger == null || values.length < 2) {
    if (trigger == null) return orhPending
      ? <span className="text-muted-foreground" title="觸發價（開盤 15 分鐘高點）09:15 後才確定">觸發價 09:15 定</span>
      : <span className="text-warn" title="09:15 後仍沒有開盤 15 分鐘高點紀錄">缺觸發價資料</span>
    return <span className="text-muted-foreground">等待報價</span>
  }
  const lo = Math.min(...values) * 0.995
  const hi = Math.max(...values) * 1.005
  const x = (v: number) => 4 + (v - lo) / (hi - lo) * (width - 8)
  const triggerLabel = row.owner === 's12' ? 'S12 進場價' : '觸發價 ORH'
  const reached = px != null && px >= trigger
  const over = px != null && row.chase != null && px > row.chase
  const seg = over ? 'var(--fail)' : reached ? 'var(--ok)' : 'var(--warn)'
  const mid = height / 2
  const tip = [
    `${triggerLabel} ${formatPrice(trigger)}`,
    row.chase != null ? `追價上限 ${formatPrice(row.chase)}` : null,
    row.vwap != null ? `VWAP ${formatPrice(row.vwap)}` : null,
    row.refPrice != null ? `選股參考價 ${formatPrice(row.refPrice)}${row.refFlag ? '（與現價差 >20%，不在梯上）' : ''}` : null,
    px != null ? `現價 ${formatPrice(px)}${row.quoteAsOf ? ` · ${formatTime(row.quoteAsOf, '—', true)}` : ''}${row.stale ? (row.quoteAgeSec == null ? '（報價時間不明或晚於本機時間，不採用）' : `（報價已 ${formatQuoteAge(row.quoteAgeSec)}，超過 ${STALE_QUOTE_SEC} 秒）`) : ''}` : '還沒有報價',
  ].filter(Boolean).join('\n')
  return (
    <span className="inline-flex items-center" title={tip}>
      <svg width={width} height={height} style={{ verticalAlign: 'middle' }} aria-label={tip}>
        <line x1="4" x2={width - 4} y1={mid} y2={mid} stroke="#292c37" strokeWidth="2" />
        {row.chase != null && <rect x={x(trigger)} y={mid - 4} width={Math.max(0, x(row.chase) - x(trigger))} height="8" fill="var(--ok)" opacity=".18" />}
        {px != null && !row.stale && <line x1={Math.min(x(px), x(trigger))} x2={Math.max(x(px), x(trigger))} y1={mid} y2={mid} stroke={seg} strokeWidth="3" />}
        {!row.refFlag && row.refPrice != null && <line x1={x(row.refPrice)} x2={x(row.refPrice)} y1={mid - 4} y2={mid + 4} stroke="#5b6272" strokeWidth="1" />}
        {row.vwap != null && <line x1={x(row.vwap)} x2={x(row.vwap)} y1={mid - 3} y2={mid + 3} stroke="#8992a3" strokeWidth="1" />}
        <line x1={x(trigger)} x2={x(trigger)} y1={mid - 8} y2={mid + 8} stroke="#e8ecf3" strokeWidth="2" />
        {row.chase != null && <line x1={x(row.chase)} x2={x(row.chase)} y1={mid - 5} y2={mid + 5} stroke="#e8ecf3" strokeWidth="1" strokeDasharray="2 1" />}
        {px != null && <circle cx={x(px)} cy={mid} r="4" fill={row.stale ? '#5b6272' : '#fff'} />}
      </svg>
      {showDistance && (row.stale
        ? <span className="chip stale" style={{ marginLeft: 4 }} title={row.quoteAgeSec == null ? '報價時間不明或晚於本機時間，不顯示距離' : `報價超過 ${STALE_QUOTE_SEC} 秒，不顯示距離`}>{staleQuoteLabel(row)}</span>
        : row.distancePct != null && <span style={{ color: seg, marginLeft: 4 }}>{formatSignedPct(row.distancePct, 1)}</span>)}
    </span>
  )
}

/** 收盤折線：台股紅漲綠跌，終點標圓點；ma 給天數時畫虛線均線。 */
export function Sparkline({ values, width = 120, height = 24, ma }: { values: number[]; width?: number; height?: number; ma?: number }) {
  if (values.length < 2) return <span className="text-muted-foreground">—</span>
  const lo = Math.min(...values)
  const span = Math.max(...values) - lo || 1
  const x = (i: number) => 2 + i / (values.length - 1) * (width - 6)
  const y = (v: number) => height - 3 - (v - lo) / span * (height - 6)
  const line = (vs: Array<number | null>) => vs.map((v, i) => v == null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`).filter(Boolean).join(' ')
  const avg = ma ? values.map((_, i) => i + 1 >= ma ? values.slice(i + 1 - ma, i + 1).reduce((a, b) => a + b, 0) / ma : null) : null
  const last = values[values.length - 1]
  const color = last > values[0] ? 'var(--up)' : last < values[0] ? 'var(--down)' : 'var(--sr-sub)'
  return (
    <svg width={width} height={height} style={{ verticalAlign: 'middle', display: 'block' }} aria-label={`${values.length} 日收盤 ${formatPrice(values[0])} → ${formatPrice(last)}`}>
      {avg && <polyline points={line(avg)} fill="none" stroke="#8992a3" strokeWidth="1" strokeDasharray="2 2" />}
      <polyline points={line(values)} fill="none" stroke={color} strokeWidth="1.5" />
      <circle cx={x(values.length - 1)} cy={y(last)} r="2.5" fill="#fff" />
    </svg>
  )
}

export type DailyBar = { open: number; high: number; low: number; close: number }

/** 近 20 日 K 棒：收≥開紅、收<開綠（台股慣例），白點標最後收盤。 */
function CandleSpark({ bars, width = 200, height = 44 }: { bars: DailyBar[]; width?: number; height?: number }) {
  if (bars.length < 2) return <span className="text-muted-foreground">—</span>
  const lo = Math.min(...bars.map((b) => b.low))
  const span = Math.max(...bars.map((b) => b.high)) - lo || 1
  const step = (width - 4) / bars.length
  const body = Math.max(1, Math.min(5, step - 2))
  const y = (v: number) => height - 2 - (v - lo) / span * (height - 4)
  const first = bars[0].close
  const last = bars[bars.length - 1].close
  return (
    <svg width={width} height={height} style={{ verticalAlign: 'middle', display: 'block' }} aria-label={`${bars.length} 日 K 線 收盤 ${formatPrice(first)} → ${formatPrice(last)}`}>
      {bars.map((b, i) => {
        const cx = 2 + step * (i + 0.5)
        const color = b.close >= b.open ? 'var(--up)' : 'var(--down)'
        const top = y(Math.max(b.open, b.close))
        return (
          <g key={i}>
            <line x1={cx} x2={cx} y1={y(b.high)} y2={y(b.low)} stroke={color} strokeWidth="1" />
            <rect x={cx - body / 2} y={top} width={body} height={Math.max(1, y(Math.min(b.open, b.close)) - top)} fill={color} />
          </g>
        )
      })}
    </svg>
  )
}

/** 20 日區間：最後收盤在高低之間的位置，距高點百分比。 */
function RangeCell({ values }: { values: number[] }) {
  if (values.length < 2) return <span className="text-muted-foreground">—</span>
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const last = values[values.length - 1]
  const pos = hi > lo ? (last - lo) / (hi - lo) : 1
  return (
    <span className="inline-flex items-center gap-2">
      <svg width="110" height="14" aria-hidden="true">
        <line x1="4" x2="104" y1="7" y2="7" stroke="#292c37" strokeWidth="2" />
        <line x1="104" x2="104" y1="1" y2="13" stroke="#e8ecf3" strokeWidth="2" />
        <circle cx={4 + pos * 100} cy="7" r="4" fill="#fff" />
      </svg>
      <span className="text-muted-foreground">{formatSignedPct((last / hi - 1) * 100, 1)}</span>
    </span>
  )
}

const TONE_COLOR: Record<CondTone, string> = { ok: 'var(--ok)', warn: 'var(--warn)', fail: 'var(--fail)', na: 'var(--sr-sub)', rec: 'var(--sr-sub)' }

/** 關卡進度：每段一條分格條（一格一關）＋通過數；僅記錄的關卡不算在分母。 */
function GateProgress({ row, groups = CONDITION_GROUPS }: { row: SimRow; groups?: typeof CONDITION_GROUPS }) {
  return (
    <span className="gates">
      {groups.map((g) => {
        const conds = g.keys.map((key) => ({ c: row.conditions[CONDITION_KEYS.indexOf(key)], i: CONDITION_KEYS.indexOf(key) }))
        const required = conds.filter(({ c }) => c.tone !== 'rec')
        const passed = required.filter(({ c }) => c.tone === 'ok').length
        const checked = conds.some(({ c }) => c.tone !== 'na' && c.tone !== 'rec')
        const done = checked && passed === required.length
        return (
          <span key={g.title} className="gseg" style={{ width: g.keys.length * 12 + 30 }}>
            <span className="bar">
              {conds.map(({ c, i }) => <i key={c.key} className={`${c.tone} ${i === row.firstBlocker ? 'first' : ''}`} title={`${c.label}：${c.tone === 'na' ? '尚未檢查' : c.value}`} />)}
            </span>
            <em className={done ? 'done' : ''}>{checked ? `${passed}/${required.length}` : '—'}</em>
          </span>
        )
      })}
    </span>
  )
}

function GateHeader({ groups = CONDITION_GROUPS }: { groups?: typeof CONDITION_GROUPS }) {
  return <span className="gates">{groups.map((g) => <span key={g.title} className="gseg" style={{ width: g.keys.length * 12 + 30 }}>{g.title}</span>)}</span>
}

/** 卡在哪：第一個未通過或等待中的關卡＋實際數值；已結束寫結束原因；已成交不另寫。 */
function BlockerCell({ row, premarket = false }: { row: SimRow; premarket?: boolean }) {
  if (row.status === 'filled' && !row.partial) return null
  if (row.completed) return <div className="why">{row.blockerText ?? '已結束'}</div>
  const c = row.firstBlocker >= 0 ? row.conditions[row.firstBlocker] : null
  if (!c) {
    // 沒有卡住的關卡：全部（不含僅記錄）都通過才寫「關卡全過」；還有關卡沒檢查就不下結論。
    const allOk = row.conditions.every((x) => x.tone === 'ok' || x.tone === 'rec')
    if (allOk) return <div className="why" style={{ color: 'var(--ok)' }}>關卡全過</div>
    return premarket ? <div className="why">開盤後檢查</div> : null
  }
  return <div className="why">卡在 <b style={{ color: TONE_COLOR[c.tone], fontWeight: 600 }}>{c.label}</b>：{c.value}</div>
}

const CONDITION_GROUP_LABEL = (key: string) => ({
  plan: '計畫', ma60: 'MA60', opening_limit: '開盤未漲停', atr_once: 'ATR動能', bars: 'K棒完整', or_touch: '觸ORH',
  vwap: '≥VWAP', relative_strength: '強於0050', window: '送單期限', quote: '新報價', buy_limit: '未漲停',
  chase: '≤追價上限', position: '未持有', allocation: '配置', l5: '五檔', final: '風控',
} as Record<string, string>)[key] ?? key

function RefFlag({ row }: { row: SimRow }) {
  if (!row.refFlag || row.refGapPct == null) return null
  return <b className="flag" title={`${row.price != null ? '現價' : '昨收'}比選股參考價 ${formatPrice(row.refPrice)} ${row.refGapPct >= 0 ? '高' : '低'} ${formatNumber(Math.abs(row.refGapPct), 1)}%：可能除權息、減資或資料過期，不自動算股數`}>!</b>
}

function Legend({ view }: { view: SimroomView }) {
  return (
    <div className="legend">
      <span><i style={{ background: 'var(--ok)' }} />通過</span>
      <span><i style={{ background: 'var(--warn)' }} />等待中</span>
      <span><i style={{ background: 'var(--fail)' }} />未通過</span>
      <span><i style={{ background: 'var(--na)' }} />{view === 'premarket' ? '開盤後檢查' : '尚未檢查'}</span>
      <span><i style={{ background: 'repeating-linear-gradient(135deg,#3a4150 0 2px,#22262f 2px 4px)' }} />僅記錄</span>
      <span><i style={{ outline: '2px solid #fff', outlineOffset: 1, background: 'var(--fail)' }} />第一個卡住的關卡</span>
      <span><b className="sr-up">▲</b> 漲 <b className="sr-down">▼</b> 跌</span>
      <span><b className="flag" style={{ margin: 0 }}>!</b> 參考價差 &gt;20%，不自動算股數</span>
    </div>
  )
}

/** 列上的小標記：部分成交、來源風控標記跳過（細節在側欄）。 */
function RowMarks({ row }: { row: SimRow }) {
  return (
    <>
      {row.partial && <span className="chip" style={{ marginLeft: 4 }} title="剩餘股數仍在跑進場檢查">部分成交</span>}
      {row.riskSkip && <b className="flag" title="來源風控標記「跳過買入」，但此檔仍在今日待買清單">風</b>}
    </>
  )
}

function AllocCell({ row, maxWeight }: { row: SimRow; maxWeight: number }) {
  if (row.allocValue == null) return <span className="text-muted-foreground">—</span>
  return <span className="alloc">{formatTwd(row.allocValue)}<em style={{ width: maxWeight > 0 && row.weight ? row.weight / maxWeight * 28 : 0 }} /></span>
}

function SidePanel({ row, onOpenChart, orhPending, panelRef }: { row: SimRow; onOpenChart?: (symbol: string) => void; orhPending: boolean; panelRef?: Ref<HTMLDivElement> }) {
  const view: SimroomView = 'intraday'
  const all: Array<{ k: string; v: ReactNode; tone?: CondTone | '' }> = [
    { k: '現價', v: formatPrice(row.price) },
    { k: '選股參考價', v: formatPrice(row.refPrice), tone: row.refFlag ? 'warn' : '' },
    row.owner === 's12'
      ? { k: 'S12 進場價', v: row.trigger != null ? formatPrice(row.trigger) : '結構未就緒' }
      : { k: '觸發價 ORH', v: row.orh != null ? formatPrice(row.orh) : row.completed ? '—' : orhPending ? '09:15 定' : '缺資料', tone: row.orh == null && !orhPending && !row.completed ? 'warn' : '' },
    { k: '追價上限', v: formatPrice(row.chase) },
    { k: 'VWAP', v: formatPrice(row.vwap) },
    { k: '漲停', v: formatPrice(row.limitUp) },
    { k: '權重', v: row.weight != null ? `${formatNumber(row.weight * 100, 1)}%` : '—', tone: row.weight ? 'ok' : '' },
    { k: '配置', v: formatTwd(row.allocValue) },
    { k: '預估股數', v: row.refFlag ? '待確認' : formatShares(row.estimatedShares), tone: row.refFlag ? 'warn' : '' },
    { k: '計畫封存', v: row.finalizedAt ? formatTime(row.finalizedAt) : '—' },
    ...(row.fill ? [{ k: row.partial ? '部分成交' : '今日成交', v: `${formatShares(row.fill.shares)} @ ${formatPrice(row.fill.avgPrice)}`, tone: 'ok' as const }] : []),
    { k: '最近檢查', v: row.checkedAt ? formatTime(row.checkedAt) : '—' },
  ]
  // 沒有數值的欄位收成一行名稱，不畫一排「—」。
  const cells = all.filter((c) => c.v !== '—')
  const emptyCells = all.filter((c) => c.v === '—').map((c) => c.k)
  return (
    // 不設 aria-live：盤中每 10 秒換報價，整塊 16 項條件會一直被重念。
    <div ref={panelRef} className="sr-panel sr-side scroll-mt-16" aria-label={`${row.symbol} ${row.name} 明細`}>
      <h2>
        {row.symbol} {row.name}
        <StatusGlyph status={row.status} view={view} outcome={postOutcome(row)} text={row.statusText} />
        {onOpenChart && <button type="button" onClick={() => onOpenChart(row.symbol)} className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" title="查看 K 線"><Activity className="h-3.5 w-3.5" /></button>}
      </h2>
      <div className="px">{formatPrice(row.price ?? row.prevClose)}{row.price != null ? <small><Change row={row} /></small> : <small className="text-muted-foreground">{row.prevClose != null ? '昨收' : ''}</small>}</div>
      <PriceLadder row={row} width={290} height={34} orhPending={orhPending} showDistance />
      {row.blockerText && row.status !== 'filled' && (
        <p className="mt-1 text-[11px] text-muted-foreground">{row.blockerText}</p>
      )}
      {row.owner === 's12' && row.s12Text && <p className="mt-1 text-[11px] text-muted-foreground">S12 結構：{row.s12Text}</p>}
      {(() => {
        // 實際執行狀態（item-aware）：execution_status＋最近執行註記，例如報價過期、已重報價、部分成交。
        const executionBadge = row.executionBadge
        return <p className="mt-1 text-[11px] text-muted-foreground" title={executionBadge.description}>執行狀態：{executionBadge.label}</p>
      })()}
      {row.partial && <p className="mt-1 text-[11px] text-muted-foreground">{row.partialRemaining ?? '已部分成交'}；{row.statusText ? '今日不再加碼。' : '剩餘股數每輪重跑進場檢查，不是終態。'}</p>}
      {row.riskSkip && <p className="mt-1 border-l-2 border-warn pl-2 text-[11px] text-warn">來源風控標記「跳過買入」，但此檔仍在今日待買清單；目前等待技術條件不代表風控已否決。</p>}
      {row.debateLabel && <p className="mt-1 text-[11px] text-muted-foreground" title="辯論只做觀察，不影響進場">{row.debateLabel}</p>}
      {cells.length > 0 && <div className="vals">{cells.map((c) => <div key={c.k} className={`v ${c.tone ?? ''}`}><div className="k">{c.k}</div><div className="n">{c.v}</div></div>)}</div>}
      {emptyCells.length > 0 && <p className="pend">尚無數值：{emptyCells.join('、')}</p>}
      {CONDITION_GROUPS.map((g) => {
        // 還沒檢查的條件不畫空框，收成一行名稱；有結果的才畫格子。
        const checked = g.keys.filter((key) => row.conditions[CONDITION_KEYS.indexOf(key)].tone !== 'na')
        const pending = g.keys.filter((key) => row.conditions[CONDITION_KEYS.indexOf(key)].tone === 'na').map((key) => row.conditions[CONDITION_KEYS.indexOf(key)].label)
        return (
        <div key={g.title}>
          <div className="vgroup">{g.title}{!checked.length && <span> · 尚未檢查：{pending.join('、')}</span>}</div>
          {checked.length > 0 && <div className="vals cond">
            {checked.map((key) => {
              const i = CONDITION_KEYS.indexOf(key)
              const c = row.conditions[i]
              // 數值直接寫出來（手機沒有 hover）；左側色條＋符號表示狀態；還沒檢查的寫「—」。
              return <div key={key} className={`v ${c.tone === 'na' ? '' : c.tone} ${i === row.firstBlocker ? 'first' : ''} ${c.tone !== 'na' && c.value.length > 8 ? 'wide' : ''}`} aria-label={`${c.label} ${COND_TEXT[c.tone]}`}>
                <div className="k">{c.label}</div>
                <div className="n">{c.tone === 'na' ? '—' : <>{c.tone === 'ok' ? '✓ ' : c.tone === 'fail' ? '✕ ' : c.tone === 'warn' ? '… ' : ''}{c.value}</>}</div>
              </div>
            })}
          </div>}
          {checked.length > 0 && pending.length > 0 && <p className="pend">尚未檢查：{pending.join('、')}</p>}
        </div>
        )
      })}
    </div>
  )
}

export interface SimRoomProps {
  clock: TwClock
  closed: boolean
  rows: SimRow[]
  view: SimroomView
  onViewChange: (view: SimroomView) => void
  kpis?: ReactNode
  status?: ReactNode
  empty?: ReactNode
  quoteAgeSec: number | null
  trend: { ratioPct: number; close: number; ma60: number } | null
  onOpenChart?: (symbol: string) => void
  /** display-quotes 讀取失敗（503／逾時）：報價 KPI 顯示讀取失敗，不跟「還沒有報價」混在一起。 */
  quoteError?: boolean
  /** 待買清單的資料日（pending-buys 的 date；沒有才用 session_date）。盤前頁尾用，不用時鐘日期。 */
  dataDate?: string | null
  /** 各檔近 20 日收盤（舊到新）；盤前走勢欄與側欄圖用。 */
  bars?: Record<string, DailyBar[]>
}

export function SessionAxis({ clock, view, closed, onViewChange }: { clock: TwClock; view: SimroomView; closed: boolean; onViewChange: (view: SimroomView) => void }) {
  const phase = sessionPhase(clock.minutes)
  return (
    <div className="sr-axis" style={{ gridTemplateColumns: SESSION_SEGMENTS.map((s) => `${s.weight}fr`).join(' ') }} role="tablist" aria-label="時段">
      {SESSION_SEGMENTS.map((s) => (
        <button key={s.phase} type="button" role="tab" aria-selected={s.phase === view}
          className={`${!closed && s.phase === phase ? 'now' : ''} ${s.phase === view ? 'view' : ''}`}
          onClick={() => onViewChange(s.phase)}>
          {s.label}<span className="t"> {s.detail}</span>
        </button>
      ))}
      {!closed && <div className="mark" style={{ left: `calc(${axisPosition(clock.minutes) * 100}% - 1px)` }} title={`現在 ${String(Math.floor(clock.minutes / 60)).padStart(2, '0')}:${String(clock.minutes % 60).padStart(2, '0')}`} />}
    </div>
  )
}

export function SimRoom({ clock, closed, rows, view, onViewChange, kpis, status, empty, quoteAgeSec, trend, onOpenChart, quoteError = false, dataDate = null, bars = {} }: SimRoomProps) {
  const sorted = useMemo(() => sortRows(rows), [rows])
  const [selected, setSelected] = useState<string | null>(null)
  const current = sorted.find((r) => r.symbol === selected) ?? sorted[0] ?? null
  // 沒點過時鎖定第一次看到的第一列；之後排序隨報價變動，側欄不會自己換檔。
  useEffect(() => {
    if (selected == null && sorted[0]) setSelected(sorted[0].symbol)
  }, [selected, sorted])
  const mainRef = useRef<HTMLDivElement>(null)
  const sideRef = useRef<HTMLDivElement>(null)
  const staleCount = rows.filter((r) => r.stale && !r.completed).length
  const counts = countByStatus(rows)
  const maxWeight = Math.max(0, ...rows.map((r) => r.weight ?? 0))
  const planValue = rows.reduce((acc, r) => acc + (r.allocValue ?? 0), 0)
  const weightSum = rows.reduce((acc, r) => acc + (r.weight ?? 0), 0)
  const flagged = rows.filter((r) => r.refFlag).length
  const finalizedAt = rows.find((r) => r.finalizedAt)?.finalizedAt ?? null
  // 09:15 前（且不是看盤後）缺 ORH 是正常的「待定」；之後缺就是缺資料。
  const orhPending = view !== 'postmarket' && clock.minutes < 9 * 60 + 15
  const partialCount = rows.filter((r) => r.partial && r.fill).length
  const outcomes = rows.reduce<Record<PostOutcome, number>>((acc, r) => { acc[postOutcome(r)] += 1; return acc }, { filled: 0, trig: 0, untriggered: 0, blocked: 0 })

  const select = (symbol: string) => {
    setSelected(symbol)
    // 窄螢幕側欄排在清單下面：點列後把側欄捲進視窗，不然手機點了看不到變化。
    const main = mainRef.current
    const side = sideRef.current
    if (!main || !side) return
    const stacked = getComputedStyle(main).gridTemplateColumns.trim().split(/\s+/).length < 2
    if (!stacked) return
    const top = side.getBoundingClientRect().top
    if (top < 0 || top > window.innerHeight * 0.6) side.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }
  // 右側單檔明細只在盤中（有即時報價與逐項檢查）；盤前、盤後表格全寬，點列直接看 K 線。
  const withDetail = view === 'intraday'
  const rowProps = (row: SimRow) => ({
    className: `sr-row ${withDetail && row.symbol === current?.symbol ? 'sel' : ''} ${row.status === 'stop' ? 'term' : ''} ${row.stale && view === 'intraday' ? 'stale' : ''}`,
    onClick: () => withDetail ? select(row.symbol) : onOpenChart?.(row.symbol),
    onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (withDetail) select(row.symbol); else onOpenChart?.(row.symbol) } },
    tabIndex: 0,
    // 表格列不在 grid／listbox 裡，aria-selected 無效；用 aria-current 標目前顯示在側欄的列。
    'aria-current': withDetail && row.symbol === current?.symbol ? ('true' as const) : undefined,
  })

  const trendKpi = trend && (
    <div className="sr-kpi trend" title={`0050 昨收 ${formatPrice(trend.close)} 對 MA60 ${formatPrice(trend.ma60)}：市場趨勢僅記錄，不擋單（R2b，11/24 起）`}>
      0050 ÷ MA60 <b className={trend.ratioPct > 0 ? 'sr-up' : trend.ratioPct < 0 ? 'sr-down' : ''} style={{ fontSize: 12 }}>{priceArrow(trend.ratioPct)}{formatNumber(Math.abs(trend.ratioPct), 1)}%</b><span>僅記錄</span>
    </div>
  )

  const kpiStrip = view === 'premarket' ? (
    <div className="sr-kpis">
      <div className="sr-kpi">計畫 <b>{rows.length}</b> 檔</div>
      <div className="sr-kpi">配置 <b>{formatTwd(planValue)}</b></div>
      {weightSum > 0 && <div className="sr-kpi" title="1 − 各檔權重加總">現金保留 <b>{formatNumber(Math.max(0, 1 - weightSum) * 100, 0)}%</b></div>}
      {finalizedAt && <div className="sr-kpi">計畫封存 <b>{formatTime(finalizedAt)}</b></div>}
      {flagged > 0 && <div className="sr-kpi"><b className="flag" style={{ margin: 0 }}>!</b>需確認 <b>{flagged}</b></div>}
      {kpis}
      {trendKpi}
    </div>
  ) : view === 'intraday' ? (
    <div className="sr-kpis">
      <div className="sr-kpi">計畫 <b>{rows.length}</b> 檔 <span>{formatTwd(planValue)}</span></div>
      {(['filled', 'trig', 'near', 'wait', 'stop'] as RowStatus[]).filter((s) => s !== 'filled' || counts.filled > 0).map((s) => (
        <div key={s} className="sr-kpi"><StatusGlyph status={s} view="intraday" bare />{ROW_STATUS_LABEL[s]} <b>{counts[s]}</b></div>
      ))}
      {quoteError
        ? <div className="sr-kpi" style={{ color: 'var(--fail)' }} title="即時報價讀取失敗；現價與距觸發暫不顯示">報價 <b style={{ color: 'var(--fail)' }}>讀取失敗</b></div>
        : <div className="sr-kpi" title={`畫面報價每 10 秒更新；最新一筆 ${formatQuoteAge(quoteAgeSec)} 前；超過 ${STALE_QUOTE_SEC} 秒的列淡化、標「舊」、不顯示距離`}>報價 <b>{formatQuoteAge(quoteAgeSec)}</b>{staleCount > 0 && <span className="ml-1" style={{ color: 'var(--warn)' }}>· 舊 {staleCount} 檔</span>}</div>}
      {kpis}
      {trendKpi}
    </div>
  ) : (
    <div className="sr-kpis">
      <div className="sr-kpi">今日成交 <b>{outcomes.filled}</b> / {rows.length}{partialCount > 0 && <span className="ml-1">（含部分 {partialCount}）</span>}</div>
      <div className="sr-kpi">規則擋下 <b>{outcomes.blocked}</b></div>
      <div className="sr-kpi" title="含沒觸發就過了送單期限">未觸發 <b>{outcomes.untriggered}</b></div>
      {outcomes.trig > 0 && <div className="sr-kpi">委託未成交 <b>{outcomes.trig}</b></div>}
      {kpis}
      {trendKpi}
    </div>
  )

  let table: ReactNode
  if (!rows.length) {
    table = empty
  } else if (view === 'premarket') {
    const groups = [CONDITION_GROUPS[0]]
    table = (
      <>
        {weightSum > 0 && (
          <div className="allocbar" style={{ margin: '8px 8px 0' }}>
            {sorted.filter((r) => r.weight).map((r, i) => (
              <div key={r.symbol} style={{ width: `${(r.weight ?? 0) * 100}%`, background: ALLOC_PALETTE[i % ALLOC_PALETTE.length] }} aria-hidden="true" />
            ))}
            <div style={{ flex: 1, background: 'var(--sr-muted)' }} aria-hidden="true" />
          </div>
        )}
        {weightSum > 0 && (
          <ul className="alloclegend" aria-label="配置比例">
            {sorted.filter((r) => r.weight).map((r, i) => (
              <li key={r.symbol}><i style={{ background: ALLOC_PALETTE[i % ALLOC_PALETTE.length] }} />{r.symbol} {r.name} · {formatNumber((r.weight ?? 0) * 100, 1)}% · {formatTwd(r.allocValue)}</li>
            ))}
            <li><i style={{ background: 'var(--sr-muted)' }} />現金保留 {formatNumber(Math.max(0, 1 - weightSum) * 100, 1)}%</li>
          </ul>
        )}
        <div className="sr-scroll">
          <div className="sr-ttl"><b>今日計畫</b><span>開盤前 · 點列看 K 線</span></div>
          <table className="sr-rows">
            <thead><tr>
              <th className="l">狀態</th>
              <th className="l">標的</th>
              <th>昨收</th>
              <th>選股參考價</th>
              <th className="l">權重 · 配置</th>
              <th>預估股數</th>
              <th className="l">20 日 K 線</th>
              <th className="l">20 日區間 · 距高點</th>
              <th className="l"><GateHeader groups={groups} /></th>
            </tr></thead>
            <tbody>
              {sorted.map((row) => (
                <tr key={row.symbol} {...rowProps(row)}>
                  <td className="l" data-label="狀態"><StatusGlyph status={row.status} view={view} text={row.statusText} /></td>
                  <td className="l sym" data-label="標的"><b>{row.symbol}</b><span>{row.name}</span><RefFlag row={row} /><RowMarks row={row} /></td>
                  <td className="px" data-label="昨收">{formatPrice(row.prevClose)}</td>
                  <td className={row.refFlag ? 'text-warn' : ''} data-label="選股參考價">{formatPrice(row.refPrice)}</td>
                  <td className="l" data-label="權重 · 配置"><AllocCell row={row} maxWeight={maxWeight} />{row.weight != null && <span className="ml-1 text-muted-foreground">{formatNumber(row.weight * 100, 1)}%</span>}</td>
                  <td data-label="預估股數">{row.refFlag ? <span className="text-warn">待確認</span> : formatShares(row.estimatedShares)}</td>
                  <td className="l wide" data-label="20 日 K 線"><CandleSpark bars={bars[row.symbol] ?? []} /></td>
                  <td className="l wide" data-label="20 日區間 · 距高點"><RangeCell values={(bars[row.symbol] ?? []).map((b) => b.close)} /></td>
                  <td className="l dotcell" data-label="進場關卡"><span className="sr-gate-head"><GateHeader groups={groups} /></span><GateProgress row={row} groups={groups} /><BlockerCell row={row} premarket />{row.debateLabel && <div className="why">{row.debateLabel}</div>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="sr-note">昨收：前一交易日收盤（當日基準評估後才有）。預估股數：配置 ÷ 參考價，含零股、未扣手續費，參考價差超過 20% 時不算。20 日 K 線：紅＝收高於開、綠＝收低於開。</p>
        </div>
      </>
    )
  } else {
    const post = view === 'postmarket'
    let lastGroup: RowStatus | null = null
    table = (
      <div className="sr-scroll">
        {post && <div className="sr-ttl"><b>今天結果</b><span>每檔一個終態 · 點列看 K 線</span></div>}
        <table className="sr-rows">
          <thead><tr>
            <th className="l">{post ? '結果' : '狀態'}</th>
            <th className="l">標的</th>
            <th>{post ? '最後價 · 漲跌' : '現價 · 漲跌'}</th>
            <th className="l">{post ? '價格梯' : '價格梯 · 距觸發'}</th>
            {post && <th>成交</th>}
            <th className="l"><GateHeader /></th>
            <th>配置</th>
          </tr></thead>
          <tbody>
            {sorted.map((row) => {
              const header = !post && row.status !== lastGroup
                ? <tr className="grp"><td colSpan={7}>{GROUP_TITLE[row.status]}</td></tr> : null
              lastGroup = row.status
              return (
                <FragmentRow key={row.symbol} header={header}>
                  <tr {...rowProps(row)}>
                    <td className="l" data-label={post ? '結果' : '狀態'}><StatusGlyph status={row.status} view={view} outcome={postOutcome(row)} text={row.statusText} /></td>
                    <td className="l sym" data-label="標的"><b>{row.symbol}</b><span>{row.name}</span><RefFlag row={row} /><RowMarks row={row} /></td>
                    <td className="px" data-label={post ? '最後價 · 漲跌' : '現價 · 漲跌'}>{formatPrice(row.price)}{row.price != null && <div className="chg"><Change row={row} /></div>}</td>
                    <td className="l ladder wide" data-label={post ? '價格梯' : '價格梯 · 距觸發'}>{row.completed ? <span className="text-muted-foreground">—</span> : <PriceLadder row={row} width={160} showDistance={!post} orhPending={orhPending} />}</td>
                    {post && <td data-label="成交">{row.fill ? `${formatPrice(row.fill.avgPrice)} × ${formatNumber(row.fill.shares, 0)}` : '—'}</td>}
                    <td className="l dotcell" data-label="進場關卡"><span className="sr-gate-head"><GateHeader /></span><GateProgress row={row} /><BlockerCell row={row} /></td>
                    <td data-label="配置"><AllocCell row={row} maxWeight={maxWeight} /></td>
                  </tr>
                </FragmentRow>
              )
            })}
          </tbody>
        </table>
        <p className="sr-note">價格梯：▏參考價　┃觸發價（ORH）　░到追價上限　│VWAP　● 現價</p>
      </div>
    )
  }

  return (
    <div className="simroom" data-view={view}>
      {/* 上方三列（時段、KPI、狀態）併成一張卡，用細線分隔，跟下方表格同一種樣式。 */}
      <div className="sr-panel sr-head">
        <SessionAxis clock={clock} view={view} closed={closed} onViewChange={onViewChange} />
        {kpiStrip}
        {status && <div className="sr-meta">{status}</div>}
      </div>
      <div className={`sr-main ${withDetail && current ? '' : 'solo'}`} ref={mainRef}>
        <div className="sr-panel">
          {table}
          {rows.length > 0 && <Legend view={view} />}
        </div>
        {withDetail && current && <SidePanel row={current} onOpenChart={onOpenChart} orhPending={orhPending} panelRef={sideRef} />}
      </div>
      {view === 'premarket' && rows.length > 0 && <p className="mt-1 text-[11px] text-muted-foreground">資料日 {formatDateShort(dataDate ?? clock.date)}{dataDate && dataDate !== clock.date ? '（不是今天）' : ''} · 觸發價與追價上限 09:15 開盤 15 分鐘高點確定後才有值</p>}
    </div>
  )
}

const GROUP_TITLE: Record<RowStatus, string> = {
  filled: '已成交', trig: '已觸發 · 委託中', near: '接近（≤1%）', wait: '等待', stop: '今日不進場（終態）',
}

function FragmentRow({ header, children }: { header: ReactNode; children: ReactNode }) {
  return <>{header}{children}</>
}

