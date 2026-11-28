import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { useIsFetching, useQuery } from '@tanstack/react-query'
import {
  Activity,
  BarChart3,
  CircleDollarSign,
  Gauge,
  Globe2,
  Loader2,
  Newspaper,
  PieChart,
  ShieldAlert,
  Sparkles,
  TrendingDown,
} from 'lucide-react'
import AppShell from '@/components/AppShell'
import { DeferredRender } from '@/components/DeferredRender'
import { GroupFactorTrajectoryPanel } from '@/components/PitFactorTrajectoryPanel'
import { MarketRiskDetailBreakdown } from '@/components/MarketRiskDetailBreakdown'
import { DataState } from '@/components/ui/data-state'
import { ListDetailLayout } from '@/components/ui/list-detail'
import { PriceChange, StatusBadge, StatusIcon } from '@/components/ui/status'
import { marketApi, recommendationsApi } from '@/lib/api'
import { TW_COLORS } from '@/lib/colorTokens'
import { formatDate, formatDateShort, formatNumber as formatGrouped, formatPct as formatUnsignedPct, formatSignedPct } from '@/lib/format'
import { humanSource, looksInternal } from '@/lib/humanLabels'
import { splitRecommendationLanes } from '@/lib/recommendationLanes'
import { safeExternalUrl } from '@/lib/safeUrl'
import {
  CONFIDENCE_SORT_OPTIONS,
  DEFAULT_CONFIDENCE_SORT,
  sortByConfidence,
  type ConfidenceSortMode,
} from '@/lib/recommendationConfidence'
import { queryTtl, recommendationDailyKey } from '@/lib/queryPolicy'
import { hedgeSentimentView } from '@/lib/hedgeSentimentView'
import { listRefreshState } from '@/lib/listRefreshState'

// 首屏只渲染前 12 張推薦卡（效能上限）；其餘接在後面、捲近時自動渲染。沒有展開按鈕，全部名單不收合。
const HOME_INITIAL_RECOMMENDATION_LIMIT = 12
const loadRecommendationCardClean = () =>
  import('@/components/RecommendationCardClean').then((module) => ({ default: module.RecommendationCardClean }))
const RecommendationCardClean = lazy(loadRecommendationCardClean)
const RecommendationCardDetail = lazy(() =>
  import('@/components/RecommendationCardClean').then((module) => ({ default: module.RecommendationCardDetail })))

// up/down: prices, returns, buy/sell flows (Taiwan convention). ok/warn/fail: status. info: neutral emphasis.
type Tone = 'up' | 'down' | 'ok' | 'warn' | 'fail' | 'info' | 'slate'

type MarketPoint = {
  close?: number | string | null
  value?: number | string | null
}

type IndexTile = {
  label: string
  value: string
  change: string
  pct: string
  delta: number | null
  tone: Tone
  source: string
  status: string
  history: number[]
  available: boolean
  // Each tile carries its own data date: TWSE publishes TWII after the close, FinLab tiles update in the evening.
  date: string | null
}

type RiskFactor = {
  id?: string
  label?: string
  value?: string
  raw_value?: number | string | null
  score?: number
  status?: string
  source?: string
  detail?: string
}

type ScaleBand = { to: number; label: string; tone: Tone; range?: string }

const HOME_RECOMMENDATION_LIMIT = 80
const POTENTIAL_BUY_MIN_EXPECTED_RETURN = 0.005
const OBSERVATIONAL_POTENTIAL_BUY_POLICY = 'non_executable_formal_ml_observation_missing_expected_return_v1'
const EMBEDDED_NEWS_LIMIT = 9
const MISSING = '—'
const NBSP = ' '

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ')
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

function asNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function formatNumber(value: number | null, digits = 2) {
  return formatGrouped(value, digits, MISSING)
}

function formatInteger(value: number | null) {
  return formatGrouped(value == null ? null : Math.round(value), 0, MISSING)
}

function formatSigned(value: number | null, digits = 2) {
  if (value == null) return MISSING
  return `${value > 0 ? '+' : ''}${formatGrouped(value, digits)}`
}

function formatPct(value: number | null, digits = 2, signed = true) {
  return signed ? formatSignedPct(value, digits, MISSING) : formatUnsignedPct(value, digits, MISSING)
}

// Market turnover is read in 億 (TWSE convention); number and unit never wrap apart.
function formatAmountYi(value: number | null) {
  if (value == null) return MISSING
  const abs = Math.abs(value)
  if (abs >= 1e8) return `${formatGrouped(value / 1e8, abs >= 1e10 ? 0 : 1)}${NBSP}億`
  if (abs >= 1e4) return `${formatGrouped(value / 1e4, 1)}${NBSP}萬`
  return formatGrouped(value, 0)
}

function formatCompactCount(value: number | null) {
  if (value == null) return MISSING
  const abs = Math.abs(value)
  if (abs >= 1e8) return `${formatGrouped(value / 1e8, 1)}${NBSP}億`
  if (abs >= 1e4) return `${formatGrouped(value / 1e4, 1)}${NBSP}萬`
  return formatGrouped(Math.round(value), 0)
}

function formatLots(value: number | null) {
  if (value == null) return MISSING
  if (Math.abs(value) >= 10_000) return `${formatGrouped(value / 10_000, 1)}${NBSP}萬張`
  return `${formatGrouped(Math.round(value), 0)}${NBSP}張`
}

// Institutional flow values arrive already in 億.
function formatBillion(value: number | null) {
  if (value == null) return MISSING
  return `${value > 0 ? '+' : ''}${formatGrouped(value, 2)}${NBSP}億`
}

// 數字照原字級、單位縮小一級：窄欄（1440 四欄）時「1,598.3 萬張」不被截。
function WithUnit({ text }: { text: string }) {
  const at = text.lastIndexOf(NBSP)
  if (at < 0) return <>{text}</>
  return <>{text.slice(0, at)}<span className="ml-0.5 text-[0.72em] font-semibold opacity-80">{text.slice(at + 1)}</span></>
}

function toneBySigned(value: number | null): Tone {
  if (value == null || value === 0) return 'slate'
  return value > 0 ? 'up' : 'down'
}

function riskTone(score: number | null): Tone {
  if (score == null) return 'slate'
  if (score >= 70) return 'fail'
  if (score >= 46) return 'warn'
  return 'ok'
}

// Fear/greed is a gauge, not a price move: neutral colour, the band label carries the meaning.
// (batch3 color rule: up/down only for prices and returns; threshold checks use status colours.)
function sentimentTone(score: number | null): Tone {
  return score == null ? 'slate' : 'info'
}

function toneText(tone: Tone) {
  if (tone === 'up') return 'text-up'
  if (tone === 'down') return 'text-down'
  if (tone === 'ok') return 'text-ok'
  if (tone === 'warn') return 'text-warn'
  if (tone === 'fail') return 'text-fail'
  if (tone === 'info') return 'text-foreground'
  return 'text-muted-foreground'
}

function toneBar(tone: Tone) {
  if (tone === 'up') return 'bg-up'
  if (tone === 'down') return 'bg-down'
  if (tone === 'ok') return 'bg-ok'
  if (tone === 'warn') return 'bg-warn'
  if (tone === 'fail') return 'bg-fail'
  if (tone === 'info') return 'bg-slate-300/80'
  return 'bg-slate-500'
}

function panelClass(className?: string) {
  return cx(
    'sv-home-glass-panel rounded-[24px] border border-white/[0.09]',
    'bg-[linear-gradient(180deg,rgba(22,23,30,0.96),rgba(10,11,15,0.985))]',
    className,
  )
}

function scopeLabel(scope: any) {
  return typeof scope?.label === 'string' && scope.label.trim()
    ? scope.label.trim()
    : scope?.includesEmerging === true
      ? '含興櫃'
      : scope?.includesEmerging === false
        ? '上市櫃，不含興櫃'
        : null
}

// The panel header states the common scope once; a card repeats it only when it also covers emerging stocks.
function EmergingScopeBadge({ scope }: { scope: any }) {
  if (scope?.includesEmerging !== true) return null
  return <StatusBadge tone="warn">{scopeLabel(scope) ?? '含興櫃'}</StatusBadge>
}

// A card shows its own data date only when it differs from the date in the block title.
function DateIfDiffers({ date, panelDate }: { date: unknown; panelDate: string | null }) {
  const own = isoDate(date)
  if (!own || !panelDate || own === panelDate) return null
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] tabular-nums text-warn" title="與區塊標題的資料日不同">
      <StatusIcon tone="warn" size={10} />
      {formatDate(own)}
    </span>
  )
}

function SectionHeader({
  icon: Icon,
  title,
  action,
}: {
  icon: ComponentType<{ className?: string }>
  title: string
  action?: ReactNode
}) {
  return (
    <div className="flex min-h-[48px] flex-wrap items-center justify-between gap-x-3 gap-y-1 px-5 py-3">
      <div className="flex min-w-0 items-center gap-2">
        <Icon className="h-4 w-4 shrink-0 text-blue-400" />
        <h2 className="truncate text-[15px] font-bold text-slate-100">{title}</h2>
      </div>
      {action}
    </div>
  )
}

function HeaderMeta({ children }: { children: ReactNode }) {
  return <span className="whitespace-nowrap text-[11px] tabular-nums text-muted-foreground">{children}</span>
}

function isoDate(value: unknown): string | null {
  const raw = String(value ?? '').trim()
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})$/)
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`
  return /^\d{4}[-/]\d{2}[-/]\d{2}/.test(raw) ? raw.slice(0, 10).replace(/\//g, '-') : null
}

function parseHistory(raw: any): number[] {
  return asArray<MarketPoint>(raw?.history)
    .map((point) => asNumber(point.close ?? point.value))
    .filter((value): value is number => value != null)
}

function toIndexTile(raw: any, label: string, source: string): IndexTile {
  const current = asNumber(raw?.current ?? raw?.close ?? raw?.value)
  const change = asNumber(raw?.change)
  const changePct = asNumber(raw?.changePct ?? raw?.change_pct)
  const history = parseHistory(raw)
  const notMaterialized = raw?.status === 'finlab_not_materialized'
  const hasDelta = change != null || changePct != null
  const delta = change ?? changePct

  return {
    label,
    value: current == null ? (notMaterialized ? '尚未匯入' : '待接資料') : formatNumber(current, 2),
    change: current == null ? '' : change == null ? '漲跌待補' : formatSigned(change, 2),
    pct: current == null || changePct == null ? MISSING : formatPct(changePct, 2),
    delta: current == null ? null : delta,
    tone: current == null ? (notMaterialized ? 'warn' : 'slate') : hasDelta ? toneBySigned(delta) : 'info',
    source: raw?.source ?? source,
    status: raw?.status ?? (current == null ? 'missing' : 'ok'),
    history,
    available: current != null,
    date: current == null ? null : isoDate(raw?.date),
  }
}

function pendingIndexTile(label: string, source: string): IndexTile {
  return {
    label,
    value: '待接資料',
    change: '',
    pct: MISSING,
    delta: null,
    tone: 'slate',
    source,
    status: 'missing',
    history: [],
    available: false,
    date: null,
  }
}

// The indices request itself failed: say so instead of showing it as missing data.
function failedIndexTile(label: string, source: string): IndexTile {
  return { ...pendingIndexTile(label, source), value: MISSING, status: 'fetch_failed' }
}

function findFactor(risk: any, ids: string[], labels: string[] = []): RiskFactor | null {
  const factors = [
    ...asArray<RiskFactor>(risk?.factorPacket?.factors),
    ...asArray<RiskFactor>(risk?.contextFactors),
    ...asArray<RiskFactor>(risk?.factors),
  ]

  return factors.find((factor) => {
    const id = String(factor.id ?? '').toLowerCase()
    const label = String(factor.label ?? '')
    return ids.some((item) => id.includes(item.toLowerCase())) || labels.some((item) => label.includes(item))
  }) ?? null
}

function factorDisplay(factor: RiskFactor | null, fallback = MISSING) {
  if (!factor) return fallback
  if (factor.value != null && factor.value !== '' && !looksInternal(factor.value)) return String(factor.value)
  const raw = asNumber(factor.raw_value)
  return raw == null ? fallback : formatNumber(raw, 2)
}

function Sparkline({ values, tone }: { values: number[]; tone: Tone }) {
  if (values.length < 2) return <span className="text-[11px] text-muted-foreground">無走勢</span>

  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const points = values.map((value, index) => {
    const x = (index / Math.max(1, values.length - 1)) * 104
    const y = 38 - ((value - min) / span) * 30
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  const stroke = tone === 'up' ? TW_COLORS.up : tone === 'down' ? TW_COLORS.down : tone === 'warn' ? TW_COLORS.warn : '#60a5fa'

  return (
    <svg viewBox="0 0 104 42" className="h-10 w-24 overflow-visible" aria-label="近期走勢">
      <polyline points={points} fill="none" stroke={stroke} strokeOpacity="0.9" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function IndexTileCard({ tile, panelDate }: { tile: IndexTile; panelDate: string | null }) {
  // The night session always trades ahead of the day-session panel date, so it is labelled, not compared.
  const isNight = tile.label === '台指期貨夜盤'
  const dateDiffers = !isNight && tile.date != null && panelDate != null && tile.date !== panelDate
  const fetchFailed = tile.status === 'fetch_failed'
  const missingLabel = fetchFailed ? '讀取失敗' : tile.status === 'finlab_not_materialized' ? '尚未匯入' : '缺資料'
  return (
    <div
      title={`來源：${humanSource(tile.source, 'FinLab')}`}
      className={cx(
        'relative overflow-hidden border-white/[0.045] px-5 py-3.5 md:border-r',
        tile.tone === 'up' && 'bg-up/[0.045]',
        tile.tone === 'down' && 'bg-down/[0.045]',
        tile.tone === 'warn' && 'bg-warn/[0.04]',
        (tile.tone === 'info' || tile.tone === 'slate') && 'bg-white/[0.02]',
      )}
    >
      <span className={cx('absolute left-0 top-4 h-6 w-0.5 rounded-full', toneBar(tile.tone))} />
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="flex items-center gap-2 truncate text-sm font-bold text-slate-100">
            {tile.label}
            {isNight && tile.date && <span className="text-[11px] font-normal tabular-nums text-muted-foreground">{formatDateShort(tile.date)}</span>}
            {dateDiffers && (
              <span className="inline-flex items-center gap-1 text-[11px] font-normal tabular-nums text-warn" title="與區塊標題的資料日不同">
                <StatusIcon tone="warn" size={10} />
                {formatDateShort(tile.date)}
              </span>
            )}
          </p>
          <p className={cx('mt-2 whitespace-nowrap text-[24px] font-bold leading-none tabular-nums', tile.available ? toneText(tile.tone) : 'text-muted-foreground')}>{tile.value}</p>
          {tile.available && (
            <PriceChange value={tile.delta} className="mt-1 block text-xs font-semibold">
              {tile.change} <span className="mx-1 text-muted-foreground">|</span> {tile.pct}
            </PriceChange>
          )}
        </div>
        {tile.available ? <Sparkline values={tile.history} tone={tile.tone} /> : (
          <StatusBadge tone={fetchFailed ? 'fail' : tile.status === 'finlab_not_materialized' ? 'warn' : 'na'}>{missingLabel}</StatusBadge>
        )}
      </div>
    </div>
  )
}

function SplitBar({ values, colors, title }: { values: number[]; colors: string[]; title?: string }) {
  const cleaned = values.map((value) => Math.max(0, Number.isFinite(value) ? value : 0))
  const total = cleaned.reduce((sum, value) => sum + value, 0)
  return (
    <div className="flex h-1.5 overflow-hidden rounded-full bg-white/[0.08]" title={title}>
      {cleaned.map((value, index) => (
        <span
          key={`${index}-${value}`}
          style={{ width: `${total > 0 ? (value / total) * 100 : 0}%`, backgroundColor: colors[index] }}
        />
      ))}
    </div>
  )
}

// Limited-step scale: neutral segments, the active one filled and its label highlighted.
function SegmentScale({ value, bands, min = 0 }: { value: number | null; bands: ScaleBand[]; min?: number }) {
  const max = bands[bands.length - 1]?.to ?? 100
  const activeIndex = value == null ? -1 : bands.findIndex((band) => value <= band.to)
  const active = activeIndex === -1 && value != null ? bands.length - 1 : activeIndex
  let from = min
  const cells = bands.map((band, index) => {
    const width = ((band.to - from) / (max - min)) * 100
    from = band.to
    return { band, width, isActive: index === active }
  })
  return (
    <div>
      <div className="flex h-1.5 gap-0.5 overflow-hidden rounded-full">
        {cells.map(({ band, width, isActive }) => (
          <span key={band.label} style={{ width: `${width}%` }} className={isActive ? toneBar(band.tone) : 'bg-white/[0.1]'} />
        ))}
      </div>
      <div className="mt-1.5 flex gap-0.5 text-[10px] leading-4">
        {cells.map(({ band, width, isActive }) => (
          <span key={band.label} style={{ width: `${width}%` }} className={cx('truncate text-center', isActive ? cx('font-semibold', toneText(band.tone)) : 'text-muted-foreground')}>
            {band.label}
            {band.range && <span className="block tabular-nums">{band.range}</span>}
          </span>
        ))}
      </div>
    </div>
  )
}

function StatTrack({
  icon: Icon,
  title,
  date,
  panelDate,
  scope,
  bar,
  children,
}: {
  icon: ComponentType<{ className?: string }>
  title: string
  date?: string | null
  panelDate: string | null
  scope?: any
  bar?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="min-w-0 border-t border-border pt-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className="h-4 w-4 shrink-0 text-orange-400" />
          <h3 className="truncate text-sm font-bold text-slate-100">{title}</h3>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          <EmergingScopeBadge scope={scope} />
          <DateIfDiffers date={date} panelDate={panelDate} />
        </div>
      </div>
      {bar}
      <div className={bar ? 'mt-4' : ''}>{children}</div>
    </div>
  )
}

function Metric({ label, value, valueClass = 'text-slate-100', sub, title }: { label: string; value: ReactNode; valueClass?: string; sub?: ReactNode; title?: string }) {
  return (
    <div className="min-w-0" title={title}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cx('mt-1 whitespace-nowrap text-base font-bold tabular-nums 2xl:text-lg', valueClass)}>{typeof value === 'string' ? <WithUnit text={value} /> : value}</p>
      {sub && <p className="whitespace-nowrap text-[11px] tabular-nums text-muted-foreground">{sub}</p>}
    </div>
  )
}

function MarketStatsRibbonClean({ risk, panelDate }: { risk: any; panelDate: string | null }) {
  const breadth = risk?.breadthSnapshot ?? risk?.breadth ?? {}
  const marketStats = risk?.marketStats ?? {}
  const credit = risk?.creditTrading ?? {}
  const dataDepth = risk?.marketRiskDetail ?? risk?.finlabDataDepth ?? {}
  const liquidity = dataDepth.liquidity ?? {}
  const chip = dataDepth.chipPressure ?? {}
  const advance = asNumber(breadth.advance_count ?? breadth.advanceCount ?? breadth.up ?? breadth.rising)
  const unchanged = asNumber(breadth.unchanged_count ?? breadth.unchangedCount ?? breadth.flat ?? breadth.unchanged)
  const decline = asNumber(breadth.decline_count ?? breadth.declineCount ?? breadth.down ?? breadth.falling)
  const total = (advance ?? 0) + (unchanged ?? 0) + (decline ?? 0)
  const share = (value: number | null) => (total > 0 ? formatPct(((value ?? 0) / total) * 100, 1, false) : MISSING)

  const volumeShares = asNumber(risk?.marketVolume ?? risk?.turnoverVolume ?? marketStats.volume)
  const volumeLots = volumeShares == null ? null : volumeShares / 1000
  const amount = asNumber(risk?.marketTurnoverAmount ?? risk?.turnoverAmount ?? marketStats.amount)
  const tradeCount = asNumber(risk?.marketTradeCount ?? risk?.tradeCount ?? liquidity.tradeCount)
  const marketScope = marketStats.scope ?? breadth.scope ?? risk?.marketDataScope

  const marginBalanceValue = asNumber(risk?.marginBalanceValue ?? credit.marginBalanceValue)
  const marginBalanceUnits = asNumber(
    credit.marginBalanceUnits ??
    risk?.marginBalanceUnits ??
    (credit.marginBalanceUnit === 'lots' ? credit.marginBalance : null) ??
    (risk?.marginBalanceUnit === 'lots' ? risk?.marginBalance : null) ??
    breadth.margin_balance,
  )
  const shortBalanceValue = asNumber(risk?.shortBalanceValue ?? credit.shortBalanceValue)
  const shortBalanceUnits = asNumber(credit.shortBalanceUnits ?? risk?.shortBalanceUnits ?? credit.shortBalance ?? risk?.shortBalance ?? breadth.short_balance)
  const estimatedMarginPositionValue = asNumber(risk?.estimatedMarginPositionValue ?? credit.estimatedMarginPositionValue)
  const estimatedShortPositionValue = asNumber(risk?.estimatedShortPositionValue ?? credit.estimatedShortPositionValue)
  const marginAmount = marginBalanceValue ?? estimatedMarginPositionValue
  const shortAmount = shortBalanceValue ?? estimatedShortPositionValue
  const marginAmountNote = marginBalanceValue != null ? '官方餘額金額' : estimatedMarginPositionValue != null ? '估算部位市值' : '金額未提供'
  const shortAmountNote = shortBalanceValue != null ? '官方餘額金額' : estimatedShortPositionValue != null ? '估算部位市值' : '金額未提供'
  const creditScope = credit.scope ?? marketScope
  const marginChangePct = asNumber(risk?.marginBalanceChangePct ?? credit.marginBalanceChangePct)
  const shortChangePct = asNumber(risk?.shortBalanceChangePct ?? credit.shortBalanceChangePct)
  const brokerBalanceIndex = asNumber(risk?.brokerBalanceIndex ?? chip.brokerBalanceIndex)
  const brokerBuySellRatio = asNumber(risk?.brokerBuySellRatio ?? chip.brokerBuySellRatio)
  // Broker absorption is a buy/sell flow: net absorbing reads red, net distributing green.
  const brokerBalanceTone: Tone = toneBySigned(brokerBalanceIndex)
  const brokerBuySellTone: Tone = brokerBuySellRatio == null ? 'slate' : toneBySigned(brokerBuySellRatio - 1)
  const amountSub = (value: number | null, note: string) => <span title={note}>{value == null ? note : `≈${NBSP}${formatAmountYi(value)}`}</span>

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      <StatTrack
        icon={TrendingDown}
        title="漲跌家數"
        date={breadth.date ?? risk?.date}
        panelDate={panelDate}
        scope={breadth.scope ?? marketScope}
        bar={<SplitBar values={[advance ?? 0, unchanged ?? 0, decline ?? 0]} colors={[TW_COLORS.up, '#4b5563', TW_COLORS.down]} title="上漲／平盤／下跌家數比例" />}
      >
        <div className="grid grid-cols-3 gap-2">
          <Metric label="上漲" value={<>▲ {formatInteger(advance)}</>} valueClass="text-up" sub={share(advance)} />
          <Metric label="平盤" value={formatInteger(unchanged)} valueClass="text-slate-300" sub={share(unchanged)} />
          <Metric label="下跌" value={<>▼ {formatInteger(decline)}</>} valueClass="text-down" sub={share(decline)} />
        </div>
      </StatTrack>

      <StatTrack
        icon={BarChart3}
        title="成交量 / 成交額"
        date={risk?.date}
        panelDate={panelDate}
        scope={marketScope}
      >
        <div className="grid grid-cols-3 gap-3">
          <Metric label="成交張數" value={formatLots(volumeLots)} title="全市場成交股數換算張數" />
          <Metric label="成交金額" value={formatAmountYi(amount)} title="全市場成交金額（新台幣）" />
          <Metric label="成交筆數" value={formatCompactCount(tradeCount)} />
        </div>
      </StatTrack>

      <StatTrack
        icon={CircleDollarSign}
        title="融資融券"
        date={credit.date ?? risk?.date}
        panelDate={panelDate}
        scope={creditScope}
        bar={<SplitBar values={[marginBalanceUnits ?? 0, shortBalanceUnits ?? 0]} colors={['#3b82f6', '#8b5cf6']} title="融資／融券餘額張數比例" />}
      >
        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
          <Metric
            label="融資餘額"
            value={formatLots(marginBalanceUnits)}
            sub={<>{amountSub(marginAmount, marginAmountNote)} <PriceChange value={marginChangePct}>{formatPct(marginChangePct)}</PriceChange></>}
          />
          <Metric
            label="融券餘額"
            value={formatLots(shortBalanceUnits)}
            sub={<>{amountSub(shortAmount, shortAmountNote)} <PriceChange value={shortChangePct}>{formatPct(shortChangePct)}</PriceChange></>}
          />
          <Metric label="券商集中度" value={formatNumber(brokerBalanceIndex, 2)} valueClass={toneText(brokerBalanceTone)} title="券商分點買賣集中度；正值偏承接" />
          <Metric label="券商買賣比" value={formatNumber(brokerBuySellRatio, 2)} valueClass={toneText(brokerBuySellTone)} title="大於 1 偏承接" />
        </div>
      </StatTrack>

      <InstitutionFlowStatTrack risk={risk} panelDate={panelDate} />
    </div>
  )
}

function InstitutionFlowStatTrack({ risk, panelDate }: { risk: any; panelDate: string | null }) {
  const flow = risk?.institutionalFlows ?? {}
  const foreign = asNumber(flow.foreignNet ?? flow.foreign ?? risk?.foreignNet5d)
  const trust = asNumber(flow.trustNet ?? flow.trust)
  const dealer = asNumber(flow.dealerNet ?? flow.dealer)
  const available = foreign != null || trust != null || dealer != null
  const total = asNumber(flow.totalNet) ?? (available ? (foreign ?? 0) + (trust ?? 0) + (dealer ?? 0) : null)
  const rows = [
    { label: '外資', value: foreign },
    { label: '投信', value: trust },
    { label: '自營商', value: dealer },
  ]

  return (
    <StatTrack
      icon={PieChart}
      title="主要法人資金動向"
      date={flow.date ?? risk?.date}
      panelDate={panelDate}
      scope={flow.scope ?? risk?.marketDataScope}
      // Segment size only; red/green stay reserved for the signed buy/sell figures below.
      bar={<SplitBar values={rows.map((row) => Math.abs(row.value ?? 0))} colors={['#8b5cf6', '#06b6d4', '#f59e0b']} title="外資／投信／自營商買賣超金額占比" />}
    >
      <p className="text-xs text-muted-foreground">三大法人合計買賣超</p>
      <PriceChange value={total} className="mt-1 block whitespace-nowrap text-xl font-bold"><WithUnit text={formatBillion(total)} /></PriceChange>
      <div className="mt-3 grid grid-cols-3 gap-3">
        {rows.map((row) => (
          <div key={row.label} className="min-w-0">
            <p className="text-xs text-muted-foreground">
              <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle" style={{ backgroundColor: row.label === '外資' ? '#8b5cf6' : row.label === '投信' ? '#06b6d4' : '#f59e0b' }} />
              {row.label}
            </p>
            <PriceChange value={row.value} className="mt-1 block whitespace-nowrap text-sm font-bold"><WithUnit text={formatBillion(row.value)} /></PriceChange>
          </div>
        ))}
      </div>
    </StatTrack>
  )
}

const FEAR_GREED_BANDS: ScaleBand[] = [
  { to: 25, label: '極度恐懼', tone: 'info' },
  { to: 45, label: '恐懼', tone: 'info' },
  { to: 55, label: '中性', tone: 'info' },
  { to: 75, label: '貪婪', tone: 'info' },
  { to: 100, label: '極度貪婪', tone: 'info' },
]

const HEDGE_BANDS: ScaleBand[] = [
  { to: 46, label: '正常', tone: 'ok' },
  { to: 70, label: '偏高', tone: 'warn' },
  { to: 100, label: '高', tone: 'fail' },
]

// NDC business-cycle lights: the light name is the meaning, so the scale is labelled rather than painted.
const BUSINESS_SIGNAL_BANDS: ScaleBand[] = [
  { to: 16, label: '藍燈', range: '9–16', tone: 'info' },
  { to: 22, label: '黃藍燈', range: '17–22', tone: 'info' },
  { to: 31, label: '綠燈', range: '23–31', tone: 'info' },
  { to: 37, label: '黃紅燈', range: '32–37', tone: 'info' },
  { to: 45, label: '紅燈', range: '38–45', tone: 'info' },
]

function businessSignalLabel(score: number | null) {
  if (score == null) return null
  return (BUSINESS_SIGNAL_BANDS.find((band) => score <= band.to) ?? BUSINESS_SIGNAL_BANDS[BUSINESS_SIGNAL_BANDS.length - 1]).label
}

function CardTitle({ icon: Icon, title, iconClass, children }: { icon: ComponentType<{ className?: string }>; title: string; iconClass?: string; children?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2">
        <Icon className={cx('h-4 w-4 shrink-0', iconClass ?? 'text-muted-foreground')} />
        <h3 className="truncate text-sm font-bold text-slate-100">{title}</h3>
      </div>
      {children}
    </div>
  )
}

function FearGreedCard({ risk, panelDate }: { risk: any; panelDate: string | null }) {
  const index = risk?.fearGreedIndex ?? {}
  const score = asNumber(index.score)
  const label = String(index.label ?? (score == null ? '待接資料' : score < 45 ? '恐懼' : score > 55 ? '貪婪' : '中性'))
  const tone = sentimentTone(score)
  const factors = asArray<RiskFactor>(index.factors)
  const byFactorId = (id: string) => factors.find((factor) => String(factor.id ?? '') === id) ?? null
  const momentum = byFactorId('market_momentum')
  const globalRiskAppetite = byFactorId('global_risk_appetite')
  const safeHavenFx = byFactorId('safe_haven_fx')
  const creditStress = byFactorId('credit_stress')
  const factorTone = (factor: RiskFactor | null) => sentimentTone(asNumber(factor?.score))

  return (
    <section className="min-w-0 border-t border-border pt-3">
      <CardTitle icon={Gauge} title="貪婪指數" iconClass={score == null ? 'text-muted-foreground' : toneText(tone)}>
        <DateIfDiffers date={index.date ?? risk?.date} panelDate={panelDate} />
      </CardTitle>

      <div className="mt-3 flex items-end justify-between gap-4">
        <p className={cx('text-2xl font-semibold tabular-nums', toneText(tone))}>
          {score == null ? MISSING : score}
          <span className="ml-1 text-sm font-medium text-muted-foreground">/100</span>
        </p>
        <p className={cx('text-sm font-bold', toneText(tone))}>{label}</p>
      </div>

      <div className="mt-3">
        <SegmentScale value={score} bands={FEAR_GREED_BANDS} />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <HedgeFactor label="市場動能" value={factorDisplay(momentum)} note="20MA 偏離" tone={factorTone(momentum)} />
        <HedgeFactor label="全球風險偏好" value={factorDisplay(globalRiskAppetite)} note="美股 / 半導體" tone={factorTone(globalRiskAppetite)} />
        <HedgeFactor label="避險匯率" value={factorDisplay(safeHavenFx)} note="美元避險壓力" tone={factorTone(safeHavenFx)} />
        <HedgeFactor label="信用風險" value={factorDisplay(creditStress)} note="風險補償需求" tone={factorTone(creditStress)} />
      </div>
    </section>
  )
}

// Short notes stay visible; longer server explanations move into the tooltip.
function HedgeFactor({ label, value, note, tone = 'slate' }: { label: string; value: string; note?: string; tone?: Tone }) {
  const cleanNote = note && !looksInternal(note) ? note : undefined
  const showNote = cleanNote != null && cleanNote.length <= 12
  return (
    <div className="min-w-0" title={cleanNote && !showNote ? cleanNote : undefined}>
      <p className="text-xs text-muted-foreground">{label}</p>
      {/* 純數字不含空白不會斷；「S&P 500 -0.25% / SOX -0.65%」這類組合值在窄欄換行而不是被截。 */}
      <p className={cx('mt-1 text-base font-bold leading-snug tabular-nums', toneText(tone))}>{value}</p>
      {showNote && <p className="mt-0.5 text-[11px] text-muted-foreground">{cleanNote}</p>}
    </div>
  )
}

function HedgeSentimentCard({ risk, panelDate }: { risk: any; panelDate: string | null }) {
  const sentiment = hedgeSentimentView(risk)
  const normalized = sentiment.score
  const hedgeFactors = asArray<RiskFactor>(risk?.hedgeSentimentFactors)
  const byHedgeId = (id: string) => hedgeFactors.find((factor) => String(factor.id ?? '') === id) ?? null
  const foreign5d = byHedgeId('foreign_net_5d')
  const pcr = byHedgeId('put_call_ratio') ?? findFactor(risk, ['put_call', 'pcr', 'options'], ['賣買權', 'PCR'])
  const largeTrader = byHedgeId('large_trader_net') ?? findFactor(risk, ['large_trader', 'smart_money'], ['大戶', '未平倉'])
  const twVolFactor = byHedgeId('twii_vol20')
  const usVixFactor = byHedgeId('us_vix')
  const usdTwdFactor = byHedgeId('usd_twd') ?? findFactor(risk, ['usd_twd', 'fx'], ['匯率', '美元兌台幣'])
  const usdTwd = asNumber(risk?.usdTwd ?? risk?.usdtwd ?? usdTwdFactor?.raw_value)
  const fxChange = asNumber(risk?.usdTwdChangePct ?? risk?.fxChangePct)
  const usVix = asNumber(usVixFactor?.raw_value ?? risk?.vix ?? risk?.usVix)
  const twVol20 = asNumber(twVolFactor?.raw_value ?? risk?.twiiVol20 ?? risk?.realizedVol20)
  const hedgeLabel = sentiment.label
  const hedgeTone = riskTone(normalized)

  return (
    <section className="min-w-0 border-t border-border pt-3">
      <CardTitle icon={ShieldAlert} title="市場避險情緒" iconClass="text-amber-300">
        <DateIfDiffers date={risk?.date} panelDate={panelDate} />
      </CardTitle>

      <div className="mt-3 flex items-end justify-between gap-4">
        <p className={cx('inline-flex items-center gap-1.5 text-sm font-bold', toneText(hedgeTone))}>
          {normalized != null && <StatusIcon tone={hedgeTone === 'slate' ? 'na' : hedgeTone as 'ok' | 'warn' | 'fail'} size={12} />}
          {hedgeLabel}
        </p>
        <p className={cx('text-2xl font-bold tabular-nums', toneText(hedgeTone))} title="避險值 0–100">{normalized == null ? MISSING : normalized.toFixed(0)}</p>
      </div>
      <div className="mt-3">
        <SegmentScale value={normalized} bands={HEDGE_BANDS} />
      </div>

      <div className="mt-4 grid gap-4 border-t border-white/[0.07] pt-4 grid-cols-2">
        <HedgeFactor
          label="外資 5 日買賣超"
          value={factorDisplay(foreign5d)}
          note={foreign5d?.detail ?? '外資連續買超／賣超反映本地籌碼風險。'}
          tone={toneBySigned(asNumber(foreign5d?.raw_value))}
        />
        <HedgeFactor
          label="大戶前五淨部位"
          value={factorDisplay(largeTrader)}
          note={largeTrader?.detail ?? 'TX+MTX/4+TMF/20；買方前五減賣方前五。'}
          tone={toneBySigned(asNumber(largeTrader?.raw_value))}
        />
        <HedgeFactor
          label="賣買權未平倉量比"
          value={factorDisplay(pcr)}
          note={pcr?.detail ?? '賣權未平倉相對買權越高，避險需求越強。'}
          tone="info"
        />
        <HedgeFactor
          label="台股波動率"
          value={twVolFactor ? factorDisplay(twVolFactor) : twVol20 == null ? MISSING : `${formatNumber(twVol20, 2)}%`}
          note={twVolFactor?.detail ?? '加權指數 20 日實現波動率。'}
          tone={riskTone(twVol20)}
        />
        <HedgeFactor
          label="美股 VIX"
          value={usVixFactor ? factorDisplay(usVixFactor) : usVix == null ? MISSING : formatNumber(usVix, 2)}
          note={usVixFactor?.detail ?? 'S&P 500 選擇權隱含波動。'}
          tone={riskTone(usVix == null ? null : usVix * 2.4)}
        />
        <HedgeFactor
          label="美元兌台幣"
          value={usdTwd == null ? factorDisplay(usdTwdFactor) : formatNumber(usdTwd, 3)}
          note={usdTwdFactor?.detail ?? (fxChange == null ? '匯率避險因子。' : `日變動 ${formatPct(fxChange)}`)}
          tone={toneBySigned(fxChange)}
        />
      </div>
    </section>
  )
}

function BusinessSignalCard({ risk }: { risk: any }) {
  const latest = risk?.businessCycle?.latest ?? risk?.businessSignal?.latest
  const months = asArray<any>(risk?.businessCycle?.months ?? risk?.businessSignal?.months)
  const latestRow = latest ?? months[months.length - 1] ?? null
  const score = asNumber(latestRow?.score ?? latestRow?.value)
  const month = String(latestRow?.month ?? latestRow?.sourceDate ?? '').slice(0, 7).replace(/\//g, '-')
  const lightLabel = (typeof latestRow?.label === 'string' && latestRow.label) || businessSignalLabel(score)

  return (
    <section className="min-w-0 border-t border-border pt-3" title="資料來源：國發會景氣對策信號（FinLab）">
      <CardTitle icon={Activity} title="景氣對策信號" iconClass="text-blue-300">
        {month && <HeaderMeta>{month}</HeaderMeta>}
      </CardTitle>

      <div className="mt-3 flex items-end justify-between gap-4">
        <p className="text-2xl font-bold tabular-nums text-slate-100">{score == null ? MISSING : score}</p>
        <p className="text-sm font-bold text-foreground">{score == null ? '尚未匯入' : lightLabel}</p>
      </div>

      <div className="mt-3">
        <SegmentScale value={score} bands={BUSINESS_SIGNAL_BANDS} min={9} />
      </div>
    </section>
  )
}

function MarketOverviewBlock() {
  // Shares the route-prefetch key so a prefetched snapshot is reused instead of fetched again.
  const { data: indices, isError: indicesError, refetch: refetchIndices } = useQuery({
    queryKey: ['market', 'indices'],
    queryFn: marketApi.indices,
    staleTime: 3 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
    retry: 1,
  })
  const { data: risk, isError: riskError, refetch: refetchRisk } = useQuery({
    queryKey: ['market', 'risk', 'home'],
    queryFn: marketApi.risk,
    staleTime: 10 * 60 * 1000,
    retry: 1,
  })

  // Only a failure with nothing cached counts as a read failure; a failed refetch keeps the last snapshot.
  const indicesFailed = indicesError && !indices
  const riskFailed = riskError && !risk
  const missingTile = indicesFailed ? failedIndexTile : pendingIndexTile
  const indexTiles = useMemo(() => [
    indices?.twii ? toIndexTile(indices.twii, '加權指數', 'FinLab benchmark_return') : missingTile('加權指數', 'FinLab benchmark_return'),
    indices?.twoii ? toIndexTile(indices.twoii, '櫃買指數', 'FinLab tw_stock_market_ind') : missingTile('櫃買指數', 'FinLab tw_stock_market_ind'),
    indices?.txfDay ? toIndexTile(indices.txfDay, '台指期貨', indices.txfDay.source ?? 'FinLab futures_price') : missingTile('台指期貨', 'FinLab futures_price'),
    indices?.txfNight ? toIndexTile(indices.txfNight, '台指期貨夜盤', indices.txfNight.source ?? 'TAIFEX MIS') : missingTile('台指期貨夜盤', 'TAIFEX MIS'),
  ], [indices, missingTile])
  // Only the risk packet's business date is a trading date; updatedAt is a UTC cache timestamp.
  const panelDate = isoDate(risk?.date)
  const commonScope = scopeLabel(risk?.marketDataScope ?? risk?.marketStats?.scope)

  return (
    <section className="space-y-4" aria-label="市場概況與風險">
      <div className={panelClass('overflow-hidden')}>
        <SectionHeader
          icon={BarChart3}
          title="市場概況與風險"
          action={(
            <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
              {commonScope && <HeaderMeta>{commonScope}</HeaderMeta>}
              <HeaderMeta>資料日 {formatDate(panelDate ?? indices?.updatedAt)}</HeaderMeta>
            </div>
          )}
        />
        <div className="grid border-t border-white/[0.055] bg-[#101116] md:grid-cols-2 xl:grid-cols-4">
          {indexTiles.map((tile) => <IndexTileCard key={tile.label} tile={tile} panelDate={panelDate} />)}
        </div>
        {indicesFailed && (
          <DataState
            kind="error"
            title="指數資料讀取失敗"
            code="market/indices"
            onRetry={() => refetchIndices()}
            className="border-t border-white/[0.055] bg-[#101116]"
          />
        )}
        <div className="border-t border-white/[0.055] bg-[#101116] p-4">
          {riskFailed ? (
            <DataState kind="error" title="市場風險資料讀取失敗" hint="成交、籌碼與情緒指標暫時讀不到" code="market/risk" onRetry={() => refetchRisk()} />
          ) : (
            <MarketStatsRibbonClean risk={risk} panelDate={panelDate} />
          )}
        </div>
      </div>

      <div className="sv-home-deferred-section grid items-start gap-4 xl:grid-cols-[minmax(360px,0.92fr)_minmax(420px,1.02fr)] 2xl:grid-cols-[minmax(460px,1.06fr)_minmax(420px,0.78fr)_minmax(340px,0.78fr)]">
        {riskFailed ? (
          <div className={panelClass('xl:self-stretch 2xl:col-span-2')}>
            <DataState
              kind="error"
              title="市場風險資料讀取失敗"
              hint="恐懼貪婪、景氣信號、避險情緒與風險拆解暫時讀不到"
              code="market/risk"
              onRetry={() => refetchRisk()}
              className="px-5 py-6"
            />
          </div>
        ) : (
          <>
            {/* 兩欄高度對齊：左欄＝情緒（貪婪＋避險），右欄＝期貨法人＋國際事件＋景氣信號。
                content-start：卡片照內容高度排，不被 grid 拉長留白。 */}
            <div className={panelClass('grid content-start gap-4 p-4 xl:self-stretch')}>
              <FearGreedCard risk={risk} panelDate={panelDate} />
              <HedgeSentimentCard risk={risk} panelDate={panelDate} />
            </div>
            <div className={panelClass('grid content-start gap-4 p-4 xl:self-stretch')}>
              <MarketRiskDetailBreakdown risk={risk} />
              <GlobalEventContextCard risk={risk} />
              <BusinessSignalCard risk={risk} />
            </div>
          </>
        )}
        <div className="grid gap-4 self-stretch xl:col-span-2 2xl:col-span-1">
          <NewsBlock embedded />
        </div>
      </div>
    </section>
  )
}

function newsTime(item: any) {
  const ts = Date.parse(String(item?.published_at ?? item?.publishedAt ?? ''))
  return Number.isFinite(ts) ? ts : 0
}

function pickBalancedNews(items: any[], limit: number) {
  const sorted = [...items].sort((a, b) => newsTime(b) - newsTime(a))
  const picked: any[] = []
  const seen = new Set<string>()
  const usedSources = new Set<string>()
  const add = (item: any) => {
    const key = String(item?.url ?? item?.title ?? `${item?.source}:${picked.length}`)
    if (seen.has(key)) return false
    picked.push(item)
    seen.add(key)
    usedSources.add(String(item?.source ?? 'news'))
    return picked.length >= limit
  }

  for (const item of sorted) {
    const source = String(item?.source ?? 'news')
    if (!usedSources.has(source) && add(item)) return picked
  }
  for (const item of sorted) {
    if (add(item)) return picked
  }
  return picked
}

function NewsBlock({ embedded = false }: { embedded?: boolean }) {
  // No catch here: a failed request must surface as an error, not as an empty news list.
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['market', 'news', 'home'],
    queryFn: marketApi.news,
    staleTime: 10 * 60 * 1000,
    retry: 1,
  })
  const newsItems = asArray<any>(data)
  const rows = embedded ? pickBalancedNews(newsItems, EMBEDDED_NEWS_LIMIT) : newsItems.slice(0, 12)
  const sectionClass = embedded
    ? 'sv-home-glass-panel flex h-full min-h-0 flex-col overflow-hidden rounded-[20px] border border-white/[0.07] bg-white/[0.032]'
    : panelClass('overflow-hidden')
  const gridClass = embedded
    ? 'grid min-h-0 flex-1 auto-rows-fr bg-[#111216]'
    : 'grid gap-px bg-white/[0.06] md:grid-cols-2 xl:grid-cols-3'

  return (
    <section className={sectionClass}>
      <SectionHeader icon={Newspaper} title="最新消息" />
      {isLoading ? (
        <div className={gridClass}>
          {Array.from({ length: embedded ? EMBEDDED_NEWS_LIMIT : 6 }).map((_, index) => (
            <div key={index} className={cx(embedded ? 'min-h-0 px-4 py-2.5' : 'min-h-[126px] p-4', 'animate-pulse bg-[#111216]')}>
              <div className="h-4 w-20 rounded bg-white/[0.06]" />
              <div className="mt-3 h-4 w-4/5 rounded bg-white/[0.06]" />
              <div className="mt-2 h-4 w-2/3 rounded bg-white/[0.05]" />
            </div>
          ))}
        </div>
      ) : isError && !rows.length ? (
        <DataState
          kind="error"
          title="最新消息讀取失敗"
          code={String((error as Error | null)?.message ?? 'market/news')}
          onRetry={() => refetch()}
          className="px-5 py-6"
        />
      ) : rows.length ? (
        <div className={gridClass}>
          {rows.map((item: any, index: number) => (
            <a
              key={`${item.url ?? item.title}-${index}`}
              href={safeExternalUrl(item.url)}
              target={safeExternalUrl(item.url) ? '_blank' : undefined}
              rel="noopener noreferrer"
              className={cx(
                embedded
                  ? 'min-h-0 border-b border-white/[0.055] px-4 py-2.5 last:border-b-0'
                  : 'min-h-[126px] p-4',
                'bg-[#111216] transition-colors hover:bg-[#151823]',
              )}
            >
              <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
                <span className="truncate font-semibold">{item.source ?? '新聞'}</span>
                <span className="shrink-0 tabular-nums">{formatDateShort(item.published_at ?? item.publishedAt, '')}</span>
              </div>
              <p className={cx('font-semibold text-slate-100', embedded ? 'mt-1 text-sm leading-[1.45]' : 'mt-3 text-sm leading-6')}>{item.title}</p>
              {item.stock_symbol && <p className="mt-1 text-[11px] text-sky-300">{item.stock_symbol} {item.stock_name ?? ''}</p>}
            </a>
          ))}
        </div>
      ) : (
        <DataState kind="empty" title="目前沒有股票相關新聞" className="px-5 py-6" />
      )}
    </section>
  )
}

// Backend placeholder rows (e.g. a GDELT fetch status) are not events and must not render as headlines.
function isEventStatusText(text: unknown) {
  const raw = String(text ?? '')
  return /fetch_failed|status\s*:|formal shadow|no_accepted/i.test(raw) || looksInternal(raw)
}

function GlobalEventContextCard({ risk }: { risk: any }) {
  const context = risk?.globalEventContext ?? {}
  const events = asArray<any>(context.events)
  const realEvents = events.filter((event) => event?.title && !isEventStatusText(event.title))
  const placeholder = events.find((event) => isEventStatusText(event?.title))
  const sourceQuality = asNumber(context.sourceQuality)
  const entityConfidence = asNumber(context.entityConfidence)
  const status = String(context.status ?? 'missing')
  const isReady = status === 'ok' && realEvents.length > 0
  const failed = placeholder != null || /fail|error/i.test(status)
  const statusLabel = typeof context.label === 'string' && context.label && !looksInternal(context.label) ? context.label : '全球事件脈絡'
  const statusText = isReady ? statusLabel : failed ? '讀取失敗' : '尚未匯入'
  const qualityText = sourceQuality == null ? MISSING : `${Math.round(sourceQuality * 100)}%`
  const confidenceText = entityConfidence == null ? MISSING : `${Math.round(entityConfidence * 100)}%`
  const rawCode = [placeholder?.title, context.missingReason, status !== 'ok' ? status : null].filter(Boolean).join(' · ')

  return (
    <section className="min-w-0 border-t border-border pt-3" title={`來源：${context.provider ?? 'GDELT'}`}>
      <CardTitle icon={Globe2} title="全球事件風險脈絡" iconClass={isReady ? 'text-cyan-300' : 'text-muted-foreground'} />

      <div className="mt-3 grid grid-cols-3 gap-3">
        <div>
          <p className="text-xs text-muted-foreground">狀態</p>
          <p className={cx('mt-1 inline-flex items-center gap-1 text-sm font-bold', isReady ? 'text-slate-100' : failed ? 'text-fail' : 'text-warn')}>
            {!isReady && <StatusIcon tone={failed ? 'fail' : 'warn'} size={11} />}
            {statusText}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">來源品質</p>
          <p className="mt-1 text-sm font-bold tabular-nums text-slate-100">{qualityText}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">連結信心</p>
          <p className="mt-1 text-sm font-bold tabular-nums text-slate-100">{confidenceText}</p>
        </div>
      </div>

      <div className="mt-3 border-t border-white/[0.07] pt-1">
        {realEvents.length ? realEvents.slice(0, 2).map((event, index) => {
          const themes = asArray<string>(event.themes).filter((theme) => !looksInternal(theme)).slice(0, 3)
          return (
            <a
              key={`${event.url ?? event.title}-${index}`}
              href={safeExternalUrl(event.url)}
              target={safeExternalUrl(event.url) ? '_blank' : undefined}
              rel="noopener noreferrer"
              className="block border-b border-white/[0.055] py-2 transition-colors last:border-b-0 hover:text-cyan-200"
            >
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm font-semibold leading-5 text-slate-200">{event.title}</p>
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{formatDateShort(event.publishedAt, '')}</span>
              </div>
              {themes.length > 0 && <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{themes.join(' / ')}</p>}
            </a>
          )
        }) : (
          <DataState
            kind={failed ? 'error' : 'empty'}
            title={failed ? '國際事件資料暫時讀不到' : '近 14 日沒有可顯示的國際事件'}
            code={rawCode || null}
            className="px-0"
          />
        )}
      </div>
    </section>
  )
}

function recommendationRowsFromPayload(payload: any) {
  const explicitAll = asArray<any>(payload?.all_recommendations)
  if (explicitAll.length) return explicitAll

  const direct = asArray<any>(payload?.recommendations ?? payload?.data)
  if (direct.length) return direct

  const merged = [
    ...asArray<any>(payload?.tradable_recommendations),
    ...asArray<any>(payload?.research_only_recommendations),
  ]
  if (!merged.length) return []

  const seen = new Set<string>()
  return merged.filter((row, index) => {
    const key = String(row?.stock_id ?? row?.symbol ?? index)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function parseRecord(value: unknown): Record<string, any> | null {
  if (!value) return null
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, any> : null
  } catch {
    return null
  }
}

function recommendationSignalText(rec: any): string {
  return String(rec?.signal ?? rec?.trade_signal ?? rec?.tradeSignal ?? rec?.signal_raw ?? '').toUpperCase()
}

function isBuySignalRecommendation(rec: any): boolean {
  if (rec?.has_buy_signal === 1 || rec?.has_buy_signal === true) return true
  return ['BUY', 'STRONG_BUY'].includes(recommendationSignalText(rec))
}

function potentialBuyExpectedReturn(rec: any): number | null {
  const l4Allocation = parseRecord(rec?.l4_sparse_allocation)
  const alphaAllocation = parseRecord(rec?.alpha_allocation)
  const forecastData = parseRecord(rec?.forecast_data)
  const forecastAllocation = parseRecord(forecastData?.alpha_allocation)
  const values = [
    l4Allocation?.expected_return,
    alphaAllocation?.expected_return,
    forecastAllocation?.expected_return,
    rec?.expected_return,
    rec?.ml_forecast_pct,
    rec?.forecast_pct,
    rec?.predicted_return,
  ]
  for (const value of values) {
    const parsed = asNumber(value)
    if (parsed != null) return parsed
  }
  return null
}

function isPotentialBuyRecommendation(rec: any): boolean {
  const allocation = parseRecord(rec?.alpha_allocation)
  const l4Allocation = parseRecord(rec?.l4_sparse_allocation)
  const hasPotentialBuyEvidence =
    recommendationSignalText(rec) === 'POTENTIAL_BUY'
    || allocation?.potential_buy === true
    || allocation?.potential_buy === 1
    || l4Allocation?.potential_buy === true
    || l4Allocation?.potential_buy === 1
  const hasExplicitObservationPolicy = [allocation, l4Allocation].some((payload) => (
    payload?.potential_buy_policy === OBSERVATIONAL_POTENTIAL_BUY_POLICY
    && (
      payload?.potential_buy_execution_eligible === false
      || payload?.potential_buy_execution_eligible === 0
    )
  ))
  const points = Array.isArray(rec?.watch_points)
    ? rec.watch_points
    : typeof rec?.watch_points === 'string'
      ? [rec.watch_points]
      : []
  const hasWatchPoint = points.some((point: any) => String(point).includes('allocation:potential_buy'))
  if (!hasPotentialBuyEvidence && !hasWatchPoint) return false
  if (hasExplicitObservationPolicy) return true
  const expectedReturn = potentialBuyExpectedReturn(rec)
  return expectedReturn != null && expectedReturn >= POTENTIAL_BUY_MIN_EXPECTED_RETURN
}

function selectHomeRecommendationRows(rows: any[], sortMode: ConfidenceSortMode, limit = HOME_RECOMMENDATION_LIMIT) {
  const seen = new Set<string>()
  const takeUnique = (row: any, index: number) => {
    const key = String(row?.stock_id ?? row?.symbol ?? index)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }

  const buyRows = rows.filter(isBuySignalRecommendation)
  const potentialRows = rows
    .filter((row) => !isBuySignalRecommendation(row) && isPotentialBuyRecommendation(row))
    .map((row) => ({
      ...row,
      signal: 'POTENTIAL_BUY',
      home_canonical_signal: recommendationSignalText(row) || null,
      home_display_lane: 'potential_buy',
    }))
  return sortByConfidence([...buyRows, ...potentialRows].filter(takeUnique), sortMode).slice(0, limit)
}

function RecommendationPanel() {
  // 列表＋明細區：列只負責選取，選中那檔的完整明細（含 K 線圖）只渲染一份；不分批載入、不展開卡片。
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [sortMode, setSortMode] = useState<ConfidenceSortMode>(DEFAULT_CONFIDENCE_SORT)
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: recommendationDailyKey(),
    queryFn: () => recommendationsApi.daily(undefined, { view: 'card' }),
    staleTime: queryTtl.dailyDecision,
    retry: 1,
  })
  const { tradable, researchOnly } = splitRecommendationLanes<any>(data)
  const allRows = useMemo(() => recommendationRowsFromPayload(data), [data])
  const eligibleRows = useMemo(() => selectHomeRecommendationRows(allRows, sortMode), [allRows, sortMode])
  const listState = listRefreshState({ isLoading, isError, hasData: !!data, count: eligibleRows.length })
  const rowKey = (rec: any, index: number) => String(rec?.stock_id ?? rec?.symbol ?? index)
  const selectedIndex = Math.max(0, eligibleRows.findIndex((rec: any, index: number) => rowKey(rec, index) === selectedKey))
  const selectedRec = eligibleRows[selectedIndex]
  const buyCount = allRows.filter(isBuySignalRecommendation).length
  const potentialBuyCount = allRows.filter((row) => !isBuySignalRecommendation(row) && isPotentialBuyRecommendation(row)).length
  const heatValues = allRows
    .map((row: any) => asNumber(row?.market_heat_score ?? row?.strategy_router_components?.market_heat_score ?? row?.score_components?.market_heat_score))
    .filter((value): value is number => value != null)
  const avgHeat = heatValues.length ? heatValues.reduce((sum, item) => sum + item, 0) / heatValues.length : null

  useEffect(() => {
    setSelectedKey(null)
  }, [data?.date])

  return (
    // overflow-clip (not hidden) so the sticky detail panel can follow the page scroll.
    <section className={panelClass('overflow-clip')} data-home-reco-empty={listState === 'empty' || listState === 'empty-stale' ? '' : undefined}>
      <SectionHeader
        icon={Sparkles}
        title="選股推薦名單"
        action={<HeaderMeta>{data?.date ? `資料日 ${formatDate(data.date)} · ` : ''}共 {eligibleRows.length} 檔</HeaderMeta>}
      />
      <div className="border-t border-white/[0.06] bg-[#101116] px-5 py-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
              <CountStat label="買進" value={buyCount} />
              <CountStat label="潛在買進" value={potentialBuyCount} />
              <CountStat label="可交易" value={tradable.length} />
              <CountStat label="研究" value={researchOnly.length} />
              <CountStat label="平均熱度" value={avgHeat == null ? MISSING : formatNumber(avgHeat, 1)} />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5" role="group" aria-label="推薦排序">
              <span className="text-[11px] text-muted-foreground" title="預設依 L4 EV 排序（同 EV 再依 R33 分數）；信心度＝R33 排名百分位與校準勝率，僅供顯示、不影響下單。">排序</span>
              {CONFIDENCE_SORT_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  title={option.title}
                  aria-pressed={sortMode === option.value}
                  onClick={() => setSortMode(option.value)}
                  className={sortMode === option.value
                    ? 'rounded-full border border-amber-300/40 bg-amber-400/15 px-2.5 py-1 text-[11px] font-semibold text-amber-100'
                    : 'rounded-full border border-white/[0.08] bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium text-muted-foreground hover:bg-white/[0.07]'}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <button
            type="button"
            onClick={() => refetch()}
            className="inline-flex shrink-0 items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.045] px-3 py-2 text-xs font-semibold text-slate-300 transition-colors hover:bg-white/[0.075]"
            disabled={isLoading}
          >
            更新
          </button>
        </div>
      </div>

      {listState === 'loading' ? (
        <div className="grid gap-px bg-white/[0.06] p-4 md:grid-cols-2">
          {[1, 2, 3, 4].map((index) => (
            <div key={index} className="h-28 animate-pulse rounded-[18px] border border-white/[0.06] bg-white/[0.035]" />
          ))}
        </div>
      ) : listState === 'error' ? (
        <DataState
          kind="error"
          title="選股名單讀取失敗"
          code={String((error as Error | null)?.message ?? 'recommendations/daily')}
          onRetry={() => refetch()}
          className="bg-[#111216] px-5 py-6"
        />
      ) : listState === 'list' || listState === 'list-stale' ? (
        <div className="bg-[#101116] p-4">
          {listState === 'list-stale' && <DataState kind="stale" title="更新失敗，顯示上次的名單" onRetry={() => refetch()} className="mb-2 px-0 py-0" />}
          <Suspense fallback={(
            <div className="grid gap-3 lg:grid-cols-2">
              {[1, 2, 3, 4].map((index) => (
                <div key={index} className="h-28 animate-pulse rounded-[18px] border border-white/[0.06] bg-white/[0.035]" />
              ))}
            </div>
          )}>
            <ListDetailLayout
              listLabel="選股推薦名單"
              detailLabel="選中標的明細"
              listClassName="space-y-3"
              detailKey={selectedRec ? rowKey(selectedRec, selectedIndex) : undefined}
              list={(
                <>
                  {eligibleRows.slice(0, HOME_INITIAL_RECOMMENDATION_LIMIT).map((rec: any, index: number) => (
                    <RecommendationCardClean
                      key={rowKey(rec, index)}
                      rec={rec}
                      rank={index + 1}
                      context="home"
                      selected={index === selectedIndex}
                      onSelect={() => setSelectedKey(rowKey(rec, index))}
                    />
                  ))}
                  {eligibleRows.length > HOME_INITIAL_RECOMMENDATION_LIMIT && (
                    <DeferredRender className="space-y-3" minHeight={(eligibleRows.length - HOME_INITIAL_RECOMMENDATION_LIMIT) * 88}>
                      {eligibleRows.slice(HOME_INITIAL_RECOMMENDATION_LIMIT).map((rec: any, offset: number) => {
                        const index = HOME_INITIAL_RECOMMENDATION_LIMIT + offset
                        return (
                          <RecommendationCardClean
                            key={rowKey(rec, index)}
                            rec={rec}
                            rank={index + 1}
                            context="home"
                            selected={index === selectedIndex}
                            onSelect={() => setSelectedKey(rowKey(rec, index))}
                          />
                        )
                      })}
                    </DeferredRender>
                  )}
                </>
              )}
              detail={selectedRec ? <RecommendationCardDetail key={rowKey(selectedRec, selectedIndex)} rec={selectedRec} context="home" /> : null}
            />
          </Suspense>
        </div>
      ) : (
        <div className="bg-[#111216] px-5 py-6">
          {listState === 'empty-stale' && <DataState kind="stale" title="更新失敗，上次讀到的名單是空的" onRetry={() => refetch()} className="mb-2 px-0 py-0" />}
          <DataState kind="empty" title="今天沒有符合條件的推薦標的" className="px-0 py-0" />
        </div>
      )}
    </section>
  )
}

function CountStat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <span className="whitespace-nowrap">
      {label} <span className="font-semibold tabular-nums text-slate-100">{value}</span>
    </span>
  )
}

function HomeBootOverlay() {
  const [visible, setVisible] = useState(true)
  const observedFetch = useRef(false)
  const pendingQueries = useIsFetching({
    predicate: (query) => {
      const key = query.queryKey
      return (
        (key[0] === 'market' && key[2] === 'home')
        || (key[0] === 'recommendations' && key[1] === 'daily')
        || (key[0] === 'recommendations' && key[1] === 'factor-flow-map' && key[2] === 'groups')
      )
    },
  })

  useEffect(() => {
    if (!visible) return
    if (pendingQueries > 0) {
      observedFetch.current = true
      return
    }
    const timer = window.setTimeout(
      () => setVisible(false),
      observedFetch.current ? 320 : 700,
    )
    return () => window.clearTimeout(timer)
  }, [pendingQueries, visible])

  useEffect(() => {
    const failSafe = window.setTimeout(() => setVisible(false), 12_000)
    return () => window.clearTimeout(failSafe)
  }, [])

  if (!visible) return null
  return (
    <div
      data-home-boot-overlay
      className="fixed inset-0 z-[80] grid place-items-center bg-[#090b10]/95 backdrop-blur-md"
      role="status"
      aria-live="polite"
      aria-label="正在載入首頁最新市場與選股資料"
    >
      <div className="relative grid place-items-center rounded-[28px] border border-cyan-300/15 bg-[#10151f]/90 px-10 py-9 shadow-[0_30px_100px_rgba(0,0,0,0.55)]">
        <div className="absolute inset-3 rounded-[22px] border border-white/[0.045]" />
        <div className="relative grid h-16 w-16 place-items-center rounded-full border border-cyan-300/20 bg-cyan-300/[0.055]">
          <Loader2 className="h-8 w-8 animate-spin text-cyan-300" aria-hidden="true" />
          <span className="absolute h-2 w-2 animate-pulse rounded-full bg-amber-300 shadow-[0_0_16px_rgba(252,211,77,0.75)]" />
        </div>
        <strong className="relative mt-5 text-sm font-semibold tracking-[0.08em] text-slate-100">同步最新市場資料</strong>
        <span className="relative mt-2 text-xs text-muted-foreground">指數、風險、選股與產業資金軌跡</span>
      </div>
    </div>
  )
}

export default function MarketHomePage() {
  useQuery({
    queryKey: recommendationDailyKey(),
    queryFn: () => recommendationsApi.daily(undefined, { view: 'card' }),
    staleTime: queryTtl.dailyDecision,
    retry: 1,
  })
  useQuery({
    queryKey: ['recommendations', 'factor-flow-map', 'groups', 10, 'industry_theme', null],
    queryFn: () => recommendationsApi.factorFlowMap({ days: 10, includeMovers: 0, layer: 'industry_theme' }),
    staleTime: 30 * 60_000,
    retry: 1,
  })

  return (
    <AppShell>
      <HomeBootOverlay />
      {/* No extra min-h-screen here: AppShell's main already fills the viewport, a second one only adds dead scroll. */}
      <div className="overflow-x-clip text-slate-100">
        <main className="w-full max-w-none space-y-4 px-4 py-4 md:px-8 2xl:px-10">
          <h1 className="text-lg font-bold text-slate-100" title="資料來源：FinLab、證交所、櫃買中心、期交所">市場總覽</h1>

          <MarketOverviewBlock />
          {/* DeferredRender shows a labelled loading skeleton until the section nears the viewport. */}
          <DeferredRender className="sv-home-deferred-section" minHeight={760}>
            {/* 桌機 1:1 並排；當天沒有推薦（名單只剩空狀態一行）時改上下排，避免左欄下方整片空白。 */}
            <div className="grid items-start gap-4 xl:has-[[data-home-reco-empty]]:grid-cols-1 xl:grid-cols-2">
              <div className="min-w-0"><RecommendationPanel /></div>
              <div className="min-w-0"><GroupFactorTrajectoryPanel /></div>
            </div>
          </DeferredRender>
        </main>
      </div>
    </AppShell>
  )
}
