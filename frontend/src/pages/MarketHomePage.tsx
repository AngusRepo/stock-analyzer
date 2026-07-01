import { useMemo, type ComponentType, type CSSProperties, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Activity,
  BarChart3,
  CalendarDays,
  CircleDollarSign,
  Gauge,
  Globe2,
  Newspaper,
  PieChart,
  Radar,
  ShieldAlert,
  Sparkles,
  TrendingDown,
  Waves,
} from 'lucide-react'
import AppShell from '@/components/AppShell'
import { MarketRiskDetailBreakdown } from '@/components/MarketRiskDetailBreakdown'
import { RecommendationCardClean } from '@/components/RecommendationCardClean'
import { marketApi, recommendationsApi } from '@/lib/api'
import { splitRecommendationLanes } from '@/lib/recommendationLanes'

type Tone = 'red' | 'green' | 'blue' | 'amber' | 'slate'

type MarketPoint = {
  close?: number | string | null
  value?: number | string | null
}

type IndexTile = {
  label: string
  value: string
  change: string
  pct: string
  tone: Tone
  source: string
  status: string
  history: number[]
  available: boolean
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

const HOME_RECOMMENDATION_LIMIT = 80
const POTENTIAL_BUY_MIN_EXPECTED_RETURN = 0.005

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
  if (value == null) return '待接資料'
  return value.toLocaleString('zh-TW', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

function formatInteger(value: number | null) {
  if (value == null) return '待接資料'
  return Math.round(value).toLocaleString('zh-TW')
}

function formatSigned(value: number | null, digits = 2) {
  if (value == null) return '待接資料'
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`
}

function formatPct(value: number | null, digits = 2, signed = true) {
  if (value == null) return '待接資料'
  const sign = signed && value >= 0 ? '+' : ''
  return `${sign}${value.toFixed(digits)}%`
}

function formatCompactAmount(value: number | null) {
  if (value == null) return '待接資料'
  const abs = Math.abs(value)
  if (abs >= 1_000_000_000_000) return `${(value / 1_000_000_000_000).toFixed(2)}兆`
  if (abs >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}億`
  if (abs >= 10_000) return `${(value / 10_000).toFixed(1)}萬`
  return value.toLocaleString('zh-TW', { maximumFractionDigits: 1 })
}

function formatCompactCount(value: number | null) {
  if (value == null) return '待接資料'
  const abs = Math.abs(value)
  if (abs >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}億`
  if (abs >= 10_000) return `${(value / 10_000).toFixed(1)}萬`
  return Math.round(value).toLocaleString('zh-TW')
}

function formatLots(value: number | null) {
  if (value == null) return '待匯入'
  const abs = Math.abs(value)
  if (abs >= 10_000) return `${(value / 10_000).toFixed(1)}萬張`
  return `${Math.round(value).toLocaleString('zh-TW')}張`
}

function formatBillion(value: number | null) {
  if (value == null) return '待接資料'
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}億`
}

function toneBySigned(value: number | null): Tone {
  if (value == null || value === 0) return 'slate'
  return value >= 0 ? 'red' : 'green'
}

function riskTone(score: number | null): Tone {
  if (score == null) return 'slate'
  if (score >= 70) return 'red'
  if (score >= 46) return 'amber'
  if (score >= 28) return 'blue'
  return 'green'
}

function fearGreedTone(score: number | null): Tone {
  if (score == null) return 'slate'
  if (score < 20) return 'green'
  if (score < 45) return 'amber'
  if (score < 55) return 'blue'
  if (score < 75) return 'red'
  return 'red'
}

function toneText(tone: Tone) {
  if (tone === 'red') return 'text-red-400'
  if (tone === 'green') return 'text-emerald-400'
  if (tone === 'blue') return 'text-blue-300'
  if (tone === 'amber') return 'text-amber-300'
  return 'text-slate-400'
}

function toneBar(tone: Tone) {
  if (tone === 'red') return 'bg-red-500'
  if (tone === 'green') return 'bg-emerald-500'
  if (tone === 'blue') return 'bg-blue-500'
  if (tone === 'amber') return 'bg-amber-400'
  return 'bg-slate-500'
}

function panelClass(className?: string) {
  return cx(
    'rounded-[24px] border border-white/[0.09]',
    'bg-[linear-gradient(180deg,rgba(22,23,30,0.96),rgba(10,11,15,0.985))]',
    'shadow-[inset_0_1px_0_rgba(255,255,255,0.045),0_18px_52px_rgba(0,0,0,0.42)] backdrop-blur-xl',
    className,
  )
}

function SourceBadge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-white/[0.08] bg-white/[0.045] px-2.5 py-1 text-[11px] font-semibold text-slate-400">
      {children}
    </span>
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

function ScopeBadge({ scope }: { scope: any }) {
  const label = scopeLabel(scope)
  if (!label) return null
  const includesEmerging = scope?.includesEmerging === true
  return (
    <span className={cx(
      'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold',
      includesEmerging
        ? 'border-amber-300/25 bg-amber-400/10 text-amber-200'
        : 'border-emerald-300/25 bg-emerald-400/10 text-emerald-200',
    )}>
      {label}
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
    <div className="flex min-h-[56px] items-center justify-between gap-3 px-5 py-4">
      <div className="flex min-w-0 items-center gap-2">
        <Icon className="h-4 w-4 shrink-0 text-blue-400" />
        <h2 className="truncate text-[15px] font-bold text-slate-100">{title}</h2>
      </div>
      {action}
    </div>
  )
}

function shortDate(value: unknown) {
  const raw = String(value ?? '')
  return raw ? raw.slice(0, 10).replace(/-/g, '/') : 'latest'
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

  return {
    label,
    value: current == null ? (notMaterialized ? '待匯入' : '待接資料') : formatNumber(current, current >= 1000 ? 2 : 2),
    change: current == null ? (notMaterialized ? 'FinLab未匯入' : '待接資料') : change == null ? '漲跌待補' : formatSigned(change, 2),
    pct: current == null ? '--' : changePct == null ? '--' : formatPct(changePct, 2),
    tone: current == null ? (notMaterialized ? 'amber' : 'slate') : hasDelta ? toneBySigned(change ?? changePct) : 'blue',
    source: raw?.source ?? source,
    status: raw?.status ?? (current == null ? 'missing' : 'ok'),
    history,
    available: current != null,
  }
}

function pendingIndexTile(label: string, source: string): IndexTile {
  return {
    label,
    value: '待接資料',
    change: '等待資料源',
    pct: '--',
    tone: 'amber',
    source,
    status: 'missing',
    history: [],
    available: false,
  }
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

function factorDisplay(factor: RiskFactor | null, fallback = '待接資料') {
  if (!factor) return fallback
  if (factor.value != null && factor.value !== '') return String(factor.value)
  const raw = asNumber(factor.raw_value)
  return raw == null ? fallback : formatNumber(raw, 2)
}

function riskLevelLabel(score: number | null, level: unknown) {
  const raw = String(level ?? '').toLowerCase()
  if (raw.includes('red')) return '偏高'
  if (raw.includes('orange')) return '升溫'
  if (raw.includes('yellow')) return '中性偏高'
  if (raw.includes('green')) return '低檔'
  if (score == null) return '待接資料'
  if (score >= 70) return '高風險'
  if (score >= 46) return '中高風險'
  if (score >= 28) return '表現中性'
  return '低風險'
}

function clampScore(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)))
}

function volatilityStressScore(usVix: number | null, twVol20: number | null) {
  const scores: number[] = []

  if (usVix != null) {
    scores.push(usVix >= 35 ? 85 : usVix >= 25 ? 65 : usVix >= 20 ? 52 : usVix <= 16 ? 25 : 40)
  }

  if (twVol20 != null) {
    scores.push(twVol20 >= 40 ? 80 : twVol20 >= 25 ? 60 : twVol20 >= 18 ? 45 : 30)
  }

  if (!scores.length) return null
  return scores.reduce((sum, value) => sum + value, 0) / scores.length
}

function deriveHedgeSentimentScore(risk: any) {
  const hedgeSource = risk?.hedgeSentiment?.source ?? '專屬避險分數'
  if (risk?.hedgeSentiment) {
    const explicitHedgeScore = asNumber(risk.hedgeSentiment.score)
    if (explicitHedgeScore != null) return { score: clampScore(explicitHedgeScore), source: hedgeSource }
  }
  const hedgeFactors = asArray<RiskFactor>(risk?.hedgeSentimentFactors)
  const hedgeRaw = (id: string) => asNumber(hedgeFactors.find((factor) => String(factor.id ?? '') === id)?.raw_value)
  const explicit = asNumber(risk?.hedgeScore ?? risk?.hedgeRiskValue)
  const riskScore = asNumber(risk?.riskScore ?? risk?.risk_score)
  const usVix = asNumber(risk?.vix ?? risk?.usVix ?? hedgeRaw('us_vix'))
  const twVol20 = asNumber(risk?.twiiVol20 ?? risk?.realizedVol20 ?? hedgeRaw('twii_vol20'))
  const volScore = volatilityStressScore(usVix, twVol20)

  if (explicit != null) return { score: clampScore(explicit), source: hedgeSource }
  if (riskScore != null && volScore != null) return { score: clampScore(riskScore * 0.75 + volScore * 0.25), source: '市場風險 + 波動 overlay' }
  if (riskScore != null) return { score: clampScore(riskScore), source: '市場風險 fallback' }
  if (volScore != null) return { score: clampScore(volScore), source: 'VIX / 台股波動 fallback' }
  return { score: null, source: '待接資料' }
}

function Sparkline({ values, tone }: { values: number[]; tone: Tone }) {
  if (values.length < 2) {
    return (
      <span className="rounded-full border border-white/[0.08] bg-white/[0.04] px-2 py-1 text-[11px] font-semibold text-slate-500">
        無歷史序列
      </span>
    )
  }

  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const points = values.map((value, index) => {
    const x = (index / Math.max(1, values.length - 1)) * 104
    const y = 38 - ((value - min) / span) * 30
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  const stroke = tone === 'red' ? '#ef4444' : tone === 'green' ? '#22c55e' : tone === 'amber' ? '#f59e0b' : '#60a5fa'

  return (
    <svg viewBox="0 0 104 42" className="h-10 w-24 overflow-visible" aria-label="真實走勢">
      <polyline points={points} fill="none" stroke={stroke} strokeOpacity="0.9" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function IndexTileCard({ tile }: { tile: IndexTile }) {
  return (
    <div className={cx(
      'relative min-h-[122px] overflow-hidden border-white/[0.045] px-5 py-4 md:border-r',
      tile.tone === 'red' && 'bg-red-500/[0.045]',
      tile.tone === 'green' && 'bg-emerald-500/[0.045]',
      tile.tone === 'amber' && 'bg-amber-400/[0.04]',
      tile.tone === 'blue' && 'bg-blue-500/[0.04]',
      tile.tone === 'slate' && 'bg-white/[0.02]',
    )}>
      <span className={cx('absolute left-0 top-5 h-6 w-0.5 rounded-full', toneBar(tile.tone))} />
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="truncate text-sm font-bold text-slate-100">{tile.label}</p>
          <p className={cx('mt-3 text-[24px] font-bold leading-none tabular-nums', toneText(tile.tone))}>{tile.value}</p>
          <p className={cx('mt-1 text-xs font-semibold tabular-nums', toneText(tile.tone))}>
            {tile.change} <span className="mx-1 text-slate-600">|</span> {tile.pct}
          </p>
        </div>
        {tile.available ? <Sparkline values={tile.history} tone={tile.tone} /> : (
          <span className="rounded-full border border-amber-300/20 bg-amber-300/10 px-2 py-1 text-[11px] font-semibold text-amber-200">
            {tile.status === 'finlab_not_materialized' ? '待匯入' : '缺資料'}
          </span>
        )}
      </div>
      <p className="mt-3 truncate text-[11px] text-slate-500" title={tile.source}>
        {tile.status === 'missing' ? 'source missing' : tile.status === 'finlab_not_materialized' ? 'FinLab 尚未 materialize' : tile.source}
      </p>
    </div>
  )
}

function SplitBar({ values, colors }: { values: number[]; colors: string[] }) {
  const cleaned = values.map((value) => Math.max(0, Number.isFinite(value) ? value : 0))
  const total = cleaned.reduce((sum, value) => sum + value, 0)
  return (
    <div className="flex h-1.5 overflow-hidden rounded-full bg-white/[0.08]">
      {cleaned.map((value, index) => (
        <span
          key={`${index}-${value}`}
          style={{ width: `${total > 0 ? (value / total) * 100 : index === 0 ? 100 : 0}%`, backgroundColor: colors[index] }}
        />
      ))}
    </div>
  )
}

function StatTrack({
  icon: Icon,
  title,
  date,
  scope,
  bar,
  children,
}: {
  icon: ComponentType<{ className?: string }>
  title: string
  date?: string | null
  scope?: any
  bar: ReactNode
  children: ReactNode
}) {
  return (
    <div className="min-h-[154px] rounded-[18px] border border-white/[0.065] bg-white/[0.032] p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className="h-4 w-4 shrink-0 text-orange-400" />
          <h3 className="truncate text-sm font-bold text-slate-100">{title}</h3>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
          <ScopeBadge scope={scope} />
          <span className="rounded-full bg-white/[0.055] px-2 py-1 text-[11px] text-slate-500">{shortDate(date)}</span>
        </div>
      </div>
      {bar}
      <div className="mt-5">{children}</div>
    </div>
  )
}

function MarketStatsRibbon({ risk }: { risk: any }) {
  return <MarketStatsRibbonClean risk={risk} />
}

function MarketStatsRibbonClean({ risk }: { risk: any }) {
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
  const brokerBalanceTone: Tone = brokerBalanceIndex == null ? 'slate' : brokerBalanceIndex >= 0 ? 'green' : 'red'
  const brokerBuySellTone: Tone = brokerBuySellRatio == null ? 'slate' : brokerBuySellRatio >= 1 ? 'green' : 'red'

  return (
    <div className="grid gap-4 xl:grid-cols-4">
      <StatTrack
        icon={TrendingDown}
        title="漲跌家數"
        date={breadth.date ?? risk?.date}
        scope={breadth.scope ?? marketScope}
        bar={<SplitBar values={[advance ?? 0, unchanged ?? 0, decline ?? 0]} colors={['#ef4444', '#6b7280', '#22c55e']} />}
      >
        <div className="grid grid-cols-3 gap-2">
          <div>
            <p className="text-xs text-slate-500">上漲</p>
            <p className="mt-1 text-lg font-bold tabular-nums text-red-400">{formatInteger(advance)}</p>
            <p className="text-[11px] text-slate-500">{total > 0 ? formatPct(((advance ?? 0) / total) * 100, 1, false) : '--'}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">平盤</p>
            <p className="mt-1 text-lg font-bold tabular-nums text-slate-300">{formatInteger(unchanged)}</p>
            <p className="text-[11px] text-slate-500">{total > 0 ? formatPct(((unchanged ?? 0) / total) * 100, 1, false) : '--'}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">下跌</p>
            <p className="mt-1 text-lg font-bold tabular-nums text-emerald-400">{formatInteger(decline)}</p>
            <p className="text-[11px] text-slate-500">{total > 0 ? formatPct(((decline ?? 0) / total) * 100, 1, false) : '--'}</p>
          </div>
        </div>
      </StatTrack>

      <StatTrack
        icon={BarChart3}
        title="成交量 / 成交額"
        date={risk?.date}
        scope={marketScope}
        bar={<SplitBar values={[volumeLots ?? 0, amount == null ? 0 : amount / 100_000_000]} colors={['#3b82f6', '#8b5cf6']} />}
      >
        <div className="grid grid-cols-3 gap-3">
          <div>
            <p className="text-xs text-slate-500">全市場成交張數</p>
            <p className="mt-1 text-lg font-bold tabular-nums text-slate-100">{formatLots(volumeLots)}</p>
            <p className="text-[11px] text-slate-500">由股數換算</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">全市場成交金額</p>
            <p className="mt-1 text-lg font-bold tabular-nums text-slate-100">{formatCompactAmount(amount)}</p>
            <p className="text-[11px] text-slate-500">成交金額（TWD）</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">成交筆數</p>
            <p className="mt-1 text-lg font-bold tabular-nums text-slate-100">{formatCompactCount(tradeCount)}</p>
            <p className="text-[11px] text-slate-500">交易密度</p>
          </div>
        </div>
      </StatTrack>

      <StatTrack
        icon={CircleDollarSign}
        title="融資融券"
        date={credit.date ?? risk?.date}
        scope={creditScope}
        bar={<SplitBar values={[marginBalanceUnits ?? 0, shortBalanceUnits ?? 0]} colors={['#22c55e', '#8b5cf6']} />}
      >
        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
          <div>
            <p className="text-xs text-slate-500">融資餘額（張數）</p>
            <p className="mt-1 text-lg font-bold tabular-nums text-slate-100">{formatLots(marginBalanceUnits)}</p>
            <p className="text-[11px] text-slate-500">{formatCompactAmount(marginAmount)} · {marginAmountNote}</p>
            <p className={cx('text-[11px] tabular-nums', toneText(toneBySigned(marginChangePct)))}>{formatPct(marginChangePct)}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">融券餘額（張數）</p>
            <p className="mt-1 text-lg font-bold tabular-nums text-slate-100">{formatLots(shortBalanceUnits)}</p>
            <p className="text-[11px] text-slate-500">{formatCompactAmount(shortAmount)} · {shortAmountNote}</p>
            <p className={cx('text-[11px] tabular-nums', toneText(toneBySigned(shortChangePct)))}>{formatPct(shortChangePct)}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">券商集中度</p>
            <p className={cx('mt-1 text-lg font-bold tabular-nums', toneText(brokerBalanceTone))}>{formatNumber(brokerBalanceIndex, 2)}</p>
            <p className="text-[11px] text-slate-500">broker balance index</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">券商買賣比</p>
            <p className={cx('mt-1 text-lg font-bold tabular-nums', toneText(brokerBuySellTone))}>{formatNumber(brokerBuySellRatio, 2)}</p>
            <p className="text-[11px] text-slate-500">大於 1 偏承接</p>
          </div>
        </div>
      </StatTrack>

      <InstitutionFlowStatTrack risk={risk} />
    </div>
  )
}

function InstitutionFlowStatTrack({ risk }: { risk: any }) {
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
      scope={flow.scope ?? risk?.marketDataScope}
      bar={<SplitBar values={rows.map((row) => Math.abs(row.value ?? 0))} colors={['#22c55e', '#ef4444', '#14b8a6']} />}
    >
      <div>
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-xs text-slate-500">當日合計買賣超</p>
            <p className={cx('mt-1 text-xl font-bold tabular-nums', toneText(toneBySigned(total)))}>
              {total == null ? '待匯入' : formatBillion(total)}
            </p>
          </div>
          <span className="text-[11px] text-slate-500">三大法人</span>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-3">
          {rows.map((row) => (
            <div key={row.label}>
              <p className="text-xs text-slate-500">{row.label}</p>
              <p className={cx('mt-1 text-sm font-bold tabular-nums', toneText(toneBySigned(row.value)))}>
                {row.value == null ? '待匯入' : formatBillion(row.value)}
              </p>
            </div>
          ))}
        </div>
      </div>
    </StatTrack>
  )
}

function FearGreedCard({ risk }: { risk: any }) {
  const index = risk?.fearGreedIndex ?? {}
  const score = asNumber(index.score)
  const label = String(index.label ?? (score == null ? '待匯入' : score < 45 ? '恐懼' : score > 55 ? '貪婪' : '中性'))
  const marker = score == null ? 0 : Math.max(0, Math.min(100, score))
  const tone = fearGreedTone(score)
  const factors = asArray<RiskFactor>(index.factors)
  const byFactorId = (id: string) => factors.find((factor) => String(factor.id ?? '') === id) ?? null
  const momentum = byFactorId('market_momentum')
  const globalRiskAppetite = byFactorId('global_risk_appetite')
  const safeHavenFx = byFactorId('safe_haven_fx')
  const creditStress = byFactorId('credit_stress')
  const factorTone = (factor: RiskFactor | null) => fearGreedTone(asNumber(factor?.score))

  return (
    <section className="rounded-[20px] border border-white/[0.07] bg-white/[0.032] p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-2">
          <Gauge className={cx('h-4 w-4 shrink-0', score == null ? 'text-slate-500' : toneText(tone))} />
          <h3 className="truncate font-bold text-slate-100">貪婪指數</h3>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="rounded-full bg-white/[0.055] p-2">
            <BarChart3 className="h-3.5 w-3.5 text-slate-400" />
          </span>
          <SourceBadge>{shortDate(index.date ?? risk?.date)}</SourceBadge>
        </div>
      </div>

      <div className="mt-5 flex items-end justify-between gap-4">
        <p className={cx('text-2xl font-semibold tabular-nums', score == null ? 'text-slate-500' : toneText(tone))}>
          {score == null ? '--' : score}
          <span className="ml-1 text-sm font-medium text-slate-500">/100</span>
        </p>
        <p className={cx('text-sm font-bold', score == null ? 'text-slate-500' : toneText(tone))}>{label}</p>
      </div>

      <div className="relative mt-4 h-1.5 rounded-full bg-[linear-gradient(90deg,#10b981_0%,#a3e635_26%,#f59e0b_50%,#f97316_72%,#db2777_100%)]">
        {score != null && (
          <span
            className="absolute top-1/2 h-2.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_0_12px_rgba(255,255,255,0.45)]"
            style={{ left: `${marker}%` }}
          />
        )}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <HedgeFactor label="市場動能" value={factorDisplay(momentum, '待接資料')} note="20MA 偏離" tone={factorTone(momentum)} />
        <HedgeFactor label="全球風險偏好" value={factorDisplay(globalRiskAppetite, '待接資料')} note="美股 / 半導體外溢" tone={factorTone(globalRiskAppetite)} />
        <HedgeFactor label="避險匯率" value={factorDisplay(safeHavenFx, '待接資料')} note="美元避險壓力" tone={factorTone(safeHavenFx)} />
        <HedgeFactor label="信用風險" value={factorDisplay(creditStress, '待接資料')} note="風險補償需求" tone={factorTone(creditStress)} />
      </div>
    </section>
  )
}

function HedgeFactor({ label, value, note, tone = 'slate' }: { label: string; value: string; note?: string; tone?: Tone }) {
  return (
    <div>
      <p className="text-xs text-slate-500">{label}</p>
      <p className={cx('mt-1 text-lg font-bold tabular-nums', toneText(tone))}>{value}</p>
      {note && <p className="mt-1 text-[11px] text-slate-500">{note}</p>}
    </div>
  )
}

function HedgeSentimentCard({ risk }: { risk: any }) {
  const sentiment = deriveHedgeSentimentScore(risk)
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
  const hedgeLabel = risk?.hedgeSentiment?.label ?? riskLevelLabel(normalized, null)
  const hedgeMarker = normalized == null ? 0 : Math.max(0, Math.min(100, normalized))

  return (
    <section className="rounded-[20px] border border-white/[0.07] bg-white/[0.032] p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-amber-300" />
          <h3 className="font-bold text-slate-100">市場避險情緒</h3>
        </div>
        <SourceBadge>{shortDate(risk?.date)}</SourceBadge>
      </div>

      <div className="mt-4">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="text-xs text-slate-500">避險評級</p>
            <p className={cx('mt-1 text-sm font-bold', toneText(riskTone(normalized)))}>{hedgeLabel}</p>
          </div>
          <div className="text-right">
            <p className="text-xs text-slate-500">避險值</p>
            <p className={cx('mt-1 text-2xl font-bold tabular-nums', toneText(riskTone(normalized)))}>{normalized == null ? '待接資料' : normalized.toFixed(0)}</p>
          </div>
        </div>
        <div className="relative mt-3 h-1.5 rounded-full bg-[linear-gradient(90deg,#22c55e_0%,#84cc16_28%,#f59e0b_52%,#f97316_73%,#ef4444_100%)]">
          {normalized != null && (
            <span
              className="absolute top-1/2 h-2.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_0_12px_rgba(255,255,255,0.45)]"
              style={{ left: `${hedgeMarker}%` }}
            />
          )}
        </div>
        <div className="mt-2 flex justify-between text-[11px] text-slate-500">
          <span>正常</span>
          <span>中性</span>
          <span>偏高</span>
        </div>
      </div>

      <div className="mt-4 grid gap-4 border-t border-white/[0.07] pt-4 sm:grid-cols-2">
        <HedgeFactor
          label="外資5日買賣超"
          value={factorDisplay(foreign5d, '待接資料')}
          note={foreign5d?.detail ?? '外資連續買超/賣超反映本地籌碼風險。'}
          tone={toneBySigned(asNumber(foreign5d?.raw_value))}
        />
        <HedgeFactor
          label="期貨大戶淨部位"
          value={factorDisplay(largeTrader, '待接資料')}
          note={largeTrader?.detail ?? '前五大交易人買方減賣方部位。'}
          tone={toneBySigned(asNumber(largeTrader?.raw_value))}
        />
        <HedgeFactor
          label="賣買權量比"
          value={factorDisplay(pcr, '待接 PCR')}
          note={pcr?.detail ?? '賣權相對買權越高，代表避險需求越強。'}
          tone="blue"
        />
        <HedgeFactor
          label="台股波動率"
          value={twVolFactor ? factorDisplay(twVolFactor) : twVol20 == null ? '待接資料' : `${twVol20.toFixed(2)}%`}
          note={twVolFactor?.detail ?? '加權指數 20 日實現波動率。'}
          tone={riskTone(twVol20)}
        />
        <HedgeFactor
          label="美股 VIX"
          value={usVixFactor ? factorDisplay(usVixFactor) : usVix == null ? '待接資料' : usVix.toFixed(2)}
          note={usVixFactor?.detail ?? 'S&P 500 選擇權隱含波動。'}
          tone={riskTone(usVix == null ? null : usVix * 2.4)}
        />
        <HedgeFactor
          label="美元兌台幣"
          value={usdTwd == null ? factorDisplay(usdTwdFactor) : usdTwd.toFixed(3)}
          note={usdTwdFactor?.detail ?? (fxChange == null ? '匯率避險因子。' : `日變動 ${formatPct(fxChange)}`)}
          tone={toneBySigned(fxChange)}
        />
      </div>
    </section>
  )
}

function businessSignalTone(score: number | null) {
  if (score == null) return 'bg-slate-600 shadow-none'
  if (score <= 16) return 'bg-blue-600 shadow-[0_0_18px_rgba(37,99,235,0.38)]'
  if (score <= 22) return 'bg-yellow-400 shadow-[0_0_18px_rgba(250,204,21,0.34)]'
  if (score <= 31) return 'bg-emerald-500 shadow-[0_0_18px_rgba(16,185,129,0.34)]'
  if (score <= 37) return 'bg-orange-500 shadow-[0_0_18px_rgba(249,115,22,0.34)]'
  return 'bg-red-500 shadow-[0_0_18px_rgba(239,68,68,0.38)]'
}

function BusinessSignalCard({ risk }: { risk: any }) {
  const latest = risk?.businessCycle?.latest ?? risk?.businessSignal?.latest
  const months = asArray<any>(risk?.businessCycle?.months ?? risk?.businessSignal?.months)
  const latestRow = latest ?? months[months.length - 1] ?? null
  const score = asNumber(latestRow?.score ?? latestRow?.value)
  const month = String(latestRow?.month ?? latestRow?.sourceDate ?? '').slice(0, 7)
  const hasData = score != null

  return (
    <section className="rounded-[20px] border border-white/[0.07] bg-white/[0.032] p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-blue-300" />
          <h3 className="font-bold text-slate-100">景氣對策信號</h3>
        </div>
        <SourceBadge>{hasData ? 'FinLab / NDC' : '待匯入'}</SourceBadge>
      </div>

      <div className="mt-5 flex items-center justify-center">
        <div className="text-center">
          <span className={cx('mx-auto block h-5 w-5 rounded-full', businessSignalTone(score))} />
          <span className="mt-3 inline-flex rounded-full bg-white/[0.055] px-3 py-1 text-xs text-slate-500">{month || '上月'}</span>
          <p className="mt-2 text-2xl font-bold tabular-nums text-slate-100">{score == null ? '--' : score}</p>
          <p className="text-xs text-slate-400">{score == null ? '待匯入' : (latestRow?.label ?? '已匯入')}</p>
        </div>
      </div>

      <div className="mt-6 border-t border-white/[0.07] pt-4">
        <div className="mb-2 flex justify-between text-xs text-slate-500">
          <span>冷 (9)</span>
          <span>信號分數區間</span>
          <span>熱 (45)</span>
        </div>
        <div className="grid h-6 grid-cols-5 overflow-hidden rounded-full text-center text-[11px] font-semibold text-white sm:text-sm">
          <div className="bg-blue-600">9-16</div>
          <div className="bg-yellow-400 text-slate-900">17-22</div>
          <div className="bg-emerald-500">23-31</div>
          <div className="bg-orange-500">32-37</div>
          <div className="bg-red-500">38-45</div>
        </div>
        <div className="mt-3 grid grid-cols-5 text-center text-[11px] text-slate-500">
          <span>藍燈</span>
          <span>黃藍燈</span>
          <span>綠燈</span>
          <span>黃紅燈</span>
          <span>紅燈</span>
        </div>
      </div>
    </section>
  )
}

function InstitutionFlowCard({ risk }: { risk: any }) {
  const flow = risk?.institutionalFlows ?? {}
  const foreign = asNumber(flow.foreignNet ?? flow.foreign ?? risk?.foreignNet5d)
  const trust = asNumber(flow.trustNet ?? flow.trust)
  const dealer = asNumber(flow.dealerNet ?? flow.dealer)
  const available = foreign != null || trust != null || dealer != null
  const total = asNumber(flow.totalNet) ?? (available ? (foreign ?? 0) + (trust ?? 0) + (dealer ?? 0) : null)
  const max = Math.max(1, Math.abs(foreign ?? 0), Math.abs(trust ?? 0), Math.abs(dealer ?? 0))
  const rows = [
    { label: '外資', value: foreign, tone: toneBySigned(foreign) },
    { label: '投信', value: trust, tone: toneBySigned(trust) },
    { label: '自營商', value: dealer, tone: toneBySigned(dealer) },
  ]

  return (
    <section className="rounded-[20px] border border-white/[0.07] bg-white/[0.032] p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <PieChart className="h-4 w-4 text-amber-300" />
          <h3 className="font-bold text-slate-100">主要法人資金動向</h3>
        </div>
        <SourceBadge>{shortDate(flow.date ?? risk?.date)}</SourceBadge>
      </div>

      <div className="flex items-end justify-between gap-4 border-b border-white/[0.07] pb-4">
        <div>
          <p className="text-xs text-slate-500">當日合計買賣超</p>
          <p className={cx('mt-1 text-2xl font-bold tabular-nums', toneText(toneBySigned(total)))}>
            {total == null ? '待接資料' : formatBillion(total)}
          </p>
        </div>
        <span className="text-[11px] text-slate-500">全市場三大法人資金流</span>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-3">
        {rows.map((row) => (
          <div key={row.label}>
            <p className="text-xs font-semibold text-slate-500">{row.label}</p>
            <p className={cx('mt-1 text-lg font-bold tabular-nums', toneText(row.tone))}>
              {row.value == null ? '待接資料' : formatBillion(row.value)}
            </p>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.07]">
              <div className={cx('h-full rounded-full', toneBar(row.tone))} style={{ width: `${row.value == null ? 0 : Math.max(8, Math.abs(row.value) / max * 100)}%` }} />
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function InstitutionFlowCardClean({ risk }: { risk: any }) {
  const flow = risk?.institutionalFlows ?? {}
  const foreign = asNumber(flow.foreignNet ?? flow.foreign ?? risk?.foreignNet5d)
  const trust = asNumber(flow.trustNet ?? flow.trust)
  const dealer = asNumber(flow.dealerNet ?? flow.dealer)
  const available = foreign != null || trust != null || dealer != null
  const total = asNumber(flow.totalNet) ?? (available ? (foreign ?? 0) + (trust ?? 0) + (dealer ?? 0) : null)
  const max = Math.max(1, Math.abs(foreign ?? 0), Math.abs(trust ?? 0), Math.abs(dealer ?? 0))
  const rows = [
    { label: '外資', value: foreign, tone: toneBySigned(foreign) },
    { label: '投信', value: trust, tone: toneBySigned(trust) },
    { label: '自營商', value: dealer, tone: toneBySigned(dealer) },
  ]

  return (
    <section className="rounded-[20px] border border-white/[0.07] bg-white/[0.032] p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <PieChart className="h-4 w-4 text-amber-300" />
          <h3 className="font-bold text-slate-100">主要法人資金動向</h3>
        </div>
        <div className="flex flex-wrap justify-end gap-1.5">
          <ScopeBadge scope={flow.scope} />
          <SourceBadge>{shortDate(flow.date ?? risk?.date)}</SourceBadge>
        </div>
      </div>

      <div className="flex items-end justify-between gap-4 border-b border-white/[0.07] pb-4">
        <div>
          <p className="text-xs text-slate-500">當日合計買賣超</p>
          <p className={cx('mt-1 text-2xl font-bold tabular-nums', toneText(toneBySigned(total)))}>
            {total == null ? '待匯入' : formatBillion(total)}
          </p>
        </div>
        <span className="text-[11px] text-slate-500">全市場三大法人資金流</span>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-3">
        {rows.map((row) => (
          <div key={row.label}>
            <p className="text-xs font-semibold text-slate-500">{row.label}</p>
            <p className={cx('mt-1 text-lg font-bold tabular-nums', toneText(row.tone))}>
              {row.value == null ? '待匯入' : formatBillion(row.value)}
            </p>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.07]">
              <div className={cx('h-full rounded-full', toneBar(row.tone))} style={{ width: `${row.value == null ? 0 : Math.max(8, Math.abs(row.value) / max * 100)}%` }} />
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function MarketOverviewBlock() {
  const { data: indices } = useQuery({
    queryKey: ['market', 'indices', 'home'],
    queryFn: marketApi.indices,
    staleTime: 3 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
    retry: 1,
  })
  const { data: risk } = useQuery({
    queryKey: ['market', 'risk', 'home'],
    queryFn: marketApi.risk,
    staleTime: 10 * 60 * 1000,
    retry: 1,
  })

  const indexTiles = useMemo(() => [
    indices?.twii ? toIndexTile(indices.twii, '加權指數', 'FinLab benchmark_return') : pendingIndexTile('加權指數', 'FinLab benchmark_return'),
    indices?.twoii ? toIndexTile(indices.twoii, '櫃買指數', 'FinLab tw_stock_market_ind') : pendingIndexTile('櫃買指數', 'FinLab tw_stock_market_ind'),
    indices?.txfDay ? toIndexTile(indices.txfDay, '台指期貨', indices.txfDay.source ?? 'FinLab futures_price') : pendingIndexTile('台指期貨', 'FinLab futures_price'),
    indices?.txfNight ? toIndexTile(indices.txfNight, '台指期貨夜盤', indices.txfNight.source ?? 'TAIFEX MIS') : pendingIndexTile('台指期貨夜盤', 'TAIFEX MIS'),
  ], [indices])

  return (
    <section className={panelClass('overflow-hidden')}>
      <SectionHeader
        icon={BarChart3}
        title="市場概況與風險"
        action={<SourceBadge>{shortDate(risk?.date ?? indices?.updatedAt)}</SourceBadge>}
      />

      <div className="border-t border-white/[0.055] bg-white/[0.045]">
        <div className="space-y-px bg-white/[0.045]">
          <div className="grid bg-[#101116] md:grid-cols-2 xl:grid-cols-4">
            {indexTiles.map((tile) => <IndexTileCard key={tile.label} tile={tile} />)}
          </div>
          <div className="bg-[#101116] p-4">
            <MarketStatsRibbonClean risk={risk} />
          </div>
          <div className="grid items-start gap-4 bg-[#101116] px-4 pb-4 xl:grid-cols-[minmax(300px,0.58fr)_minmax(0,1.42fr)] 2xl:grid-cols-[minmax(280px,0.62fr)_minmax(520px,1.18fr)_minmax(340px,0.8fr)]">
            <div className="grid gap-4 xl:self-stretch">
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
                <FearGreedCard risk={risk} />
                <BusinessSignalCard risk={risk} />
              </div>
              <HedgeSentimentCard risk={risk} />
            </div>
            <MarketRiskDetailBreakdown risk={risk} />
            <div className="grid gap-4 self-stretch xl:col-span-2 2xl:col-span-1">
              <NewsBlock embedded />
              <GlobalEventContextCard risk={risk} />
            </div>
          </div>
        </div>
      </div>

    </section>
  )
}

function NewsBlock({ embedded = false }: { embedded?: boolean }) {
  const { data, isLoading } = useQuery({
    queryKey: ['market', 'news', 'home'],
    queryFn: () => marketApi.news().catch(() => []),
    staleTime: 10 * 60 * 1000,
    retry: 1,
  })
  const rows = asArray<any>(data).slice(0, embedded ? 3 : 12)
  const sectionClass = embedded
    ? 'h-full overflow-hidden rounded-[20px] border border-white/[0.07] bg-white/[0.032]'
    : panelClass('overflow-hidden')
  const gridClass = embedded
    ? 'grid gap-px bg-white/[0.06]'
    : 'grid gap-px bg-white/[0.06] md:grid-cols-2 xl:grid-cols-3'

  return (
    <section className={sectionClass}>
      <SectionHeader icon={Newspaper} title="最新消息" action={<SourceBadge>{embedded ? '最新 3 則' : '每來源 3 則股票新聞'}</SourceBadge>} />
      {isLoading ? (
        <div className={gridClass}>
          {Array.from({ length: embedded ? 3 : 6 }).map((_, index) => (
            <div key={index} className={cx(embedded ? 'min-h-[92px]' : 'min-h-[126px]', 'animate-pulse bg-[#111216] p-4')}>
              <div className="h-5 w-24 rounded-full bg-white/[0.06]" />
              <div className="mt-4 h-4 w-4/5 rounded bg-white/[0.06]" />
              <div className="mt-2 h-4 w-2/3 rounded bg-white/[0.05]" />
            </div>
          ))}
        </div>
      ) : rows.length ? (
        <div className={gridClass}>
          {rows.map((item: any, index: number) => (
            <a
              key={`${item.url ?? item.title}-${index}`}
              href={item.url ?? '#'}
              target={item.url ? '_blank' : undefined}
              rel="noreferrer"
              className={cx(embedded ? 'min-h-[96px]' : 'min-h-[126px]', 'bg-[#111216] p-4 transition-colors hover:bg-[#151823]')}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="rounded-full border border-white/[0.08] bg-white/[0.05] px-2 py-1 text-[11px] font-semibold text-slate-400">{item.source ?? 'news'}</span>
                <span className="text-[11px] text-slate-600">{String(item.published_at ?? item.publishedAt ?? '').slice(0, 10)}</span>
              </div>
              <p className="mt-3 line-clamp-2 text-sm font-semibold leading-6 text-slate-100">{item.title}</p>
              {item.stock_symbol && <p className="mt-2 text-[11px] text-blue-300">{item.stock_symbol} {item.stock_name ?? ''}</p>}
            </a>
          ))}
        </div>
      ) : (
        <div className="px-5 py-8 text-sm text-slate-500">暫無股票相關新聞；請檢查 /market/news RSS ingestion。</div>
      )}
    </section>
  )
}

function GlobalEventContextCard({ risk }: { risk: any }) {
  const context = risk?.globalEventContext ?? {}
  const events = asArray<any>(context.events)
  const sourceQuality = asNumber(context.sourceQuality)
  const entityConfidence = asNumber(context.entityConfidence)
  const status = String(context.status ?? 'missing')
  const isReady = status === 'ok'
  const statusText = isReady ? String(context.label ?? '全球事件脈絡') : '尚未匯入'
  const qualityText = sourceQuality == null ? '待匯入' : `${Math.round(sourceQuality * 100)}%`
  const confidenceText = entityConfidence == null ? '待匯入' : `${Math.round(entityConfidence * 100)}%`

  return (
    <section className="rounded-[20px] border border-white/[0.07] bg-white/[0.032] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Globe2 className={cx('h-4 w-4 shrink-0', isReady ? 'text-cyan-300' : 'text-slate-500')} />
          <h3 className="truncate font-bold text-slate-100">全球事件風險脈絡</h3>
        </div>
        <SourceBadge>{context.provider ?? 'GDELT'}</SourceBadge>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3">
        <div>
          <p className="text-xs text-slate-500">狀態</p>
          <p className={cx('mt-1 text-sm font-bold', isReady ? 'text-cyan-200' : 'text-amber-300')}>{statusText}</p>
        </div>
        <div>
          <p className="text-xs text-slate-500">來源品質</p>
          <p className="mt-1 text-sm font-bold tabular-nums text-slate-100">{qualityText}</p>
        </div>
        <div>
          <p className="text-xs text-slate-500">連結信心</p>
          <p className="mt-1 text-sm font-bold tabular-nums text-slate-100">{confidenceText}</p>
        </div>
      </div>

      <div className="mt-4 space-y-2 border-t border-white/[0.07] pt-3">
        {events.length ? events.slice(0, 2).map((event, index) => (
          <a
            key={`${event.url ?? event.title}-${index}`}
            href={event.url || undefined}
            target={event.url ? '_blank' : undefined}
            rel="noreferrer"
            className="block rounded-[14px] border border-white/[0.055] bg-black/15 px-3 py-2 transition-colors hover:border-cyan-300/20 hover:bg-cyan-400/[0.04]"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] font-semibold text-cyan-200">risk context only</span>
              <span className="text-[11px] text-slate-600">{String(event.publishedAt ?? '').slice(0, 10)}</span>
            </div>
            <p className="mt-1 line-clamp-2 text-sm font-semibold leading-5 text-slate-200">{event.title}</p>
            {asArray<string>(event.themes).length > 0 && (
              <p className="mt-1 truncate text-[11px] text-slate-500">{asArray<string>(event.themes).slice(0, 3).join(' / ')}</p>
            )}
          </a>
        )) : (
          <div className="rounded-[14px] border border-amber-300/12 bg-amber-400/[0.055] px-3 py-3">
            <p className="text-sm font-semibold text-amber-200">GDELT formal shadow 尚未有可展示事件</p>
            <p className="mt-1 text-[11px] leading-5 text-slate-500">{context.missingReason ?? 'no_accepted_gdelt_events_last_14d'}</p>
          </div>
        )}
      </div>
    </section>
  )
}

function FlowList({ title, rows }: { title: string; rows: any[] }) {
  const max = Math.max(1, ...rows.map((row) => Math.abs(asNumber(row?.total_net ?? row?.net_flow) ?? 0)))
  return (
    <div>
      <p className="mb-3 text-sm font-bold text-slate-200">{title}</p>
      {rows.length ? (
        <div className="space-y-3">
          {rows.map((row) => {
            const name = row?.sector ?? row?.industry ?? row?.name ?? '-'
            const value = asNumber(row?.total_net ?? row?.net_flow) ?? 0
            const tone = toneBySigned(value)
            return (
              <div key={name} className="grid grid-cols-[112px_1fr_84px] items-center gap-3 text-sm">
                <span className="truncate text-slate-400" title={name}>{name}</span>
                <div className="h-2 overflow-hidden rounded-full bg-white/[0.06]">
                  <div className={cx('h-full rounded-full', toneBar(tone))} style={{ width: `${Math.max(6, Math.abs(value) / max * 100)}%` }} />
                </div>
                <span className={cx('text-right text-xs font-bold tabular-nums', toneText(tone))}>
                  {value >= 0 ? '+' : ''}{value.toFixed(1)}億
                </span>
              </div>
            )
          })}
        </div>
      ) : (
        <p className="rounded-[16px] border border-white/[0.06] bg-white/[0.03] p-4 text-sm text-slate-500">尚無 sector-flow 資料。</p>
      )}
    </div>
  )
}

function keywordFromFlowRow(row: any): string | null {
  const raw = row?.theme ?? row?.concept ?? row?.industry ?? row?.sector ?? row?.name
  const text = String(raw ?? '').trim()
  return text && text !== '-' ? text : null
}

function flowRowValue(row: any): number | null {
  return asNumber(row?.total_net ?? row?.net_flow ?? row?.turnover_share_delta ?? row?.avg_momentum_5d ?? row?.score)
}

function HotKeywordCloud({ rows }: { rows: any[] }) {
  const seen = new Set<string>()
  const keywords = rows
    .map((row) => {
      const keyword = keywordFromFlowRow(row)
      if (!keyword || seen.has(keyword)) return null
      seen.add(keyword)
      const value = flowRowValue(row)
      return {
        keyword,
        value,
        tone: value == null ? (seen.size % 2 === 0 ? 'red' : 'green') : toneBySigned(value),
      }
    })
    .filter((item): item is { keyword: string; value: number | null; tone: Tone } => Boolean(item))
    .slice(0, 14)

  if (!keywords.length) return null

  return (
    <div className="mt-5 overflow-hidden border-t border-white/[0.07] pt-4">
      <p className="mb-3 text-sm font-bold text-slate-200">熱門關鍵字</p>
      <div className="relative min-h-[104px] rounded-[18px] border border-white/[0.055] bg-[#0b0d12] px-3 py-4">
        <div className="flex flex-wrap justify-center gap-x-5 gap-y-4">
          {keywords.map((item, index) => {
            const size = index < 3 ? 'text-base sm:text-lg' : index < 8 ? 'text-sm sm:text-base' : 'text-xs sm:text-sm'
            const style = {
              ['--wc-dx' as any]: `${6 + (index % 4) * 3}`,
              ['--wc-dy' as any]: `${5 + (index % 5) * 2}`,
              ['--wc-rot' as any]: `${(index % 5) - 2}deg`,
              animation: `wc-float-${(index % 3) + 1} ${8 + (index % 4)}s ease-in-out infinite`,
              animationDelay: `${index * -0.55}s`,
            } as CSSProperties
            return (
              <span
                key={item.keyword}
                style={style}
                className={cx(
                  'inline-flex rounded-full border px-3 py-1.5 font-extrabold leading-none tracking-normal shadow-[0_0_24px_rgba(0,0,0,0.25)]',
                  size,
                  item.tone === 'red'
                    ? 'border-red-400/25 bg-red-500/[0.07] text-red-300'
                    : item.tone === 'green'
                      ? 'border-emerald-400/25 bg-emerald-500/[0.07] text-emerald-300'
                      : 'border-cyan-400/20 bg-cyan-500/[0.06] text-cyan-200',
                )}
                title={item.value == null ? item.keyword : `${item.keyword} ${item.value >= 0 ? '+' : ''}${item.value.toFixed(1)}`}
              >
                {item.keyword}
              </span>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function ThemeFlowPanel({ compact = false }: { compact?: boolean }) {
  const { data: themeData, error: themeError, isError: themeIsError } = useQuery({
    queryKey: ['recommendations', 'sector-flow', 'theme', 'home'],
    queryFn: () => recommendationsApi.sectorFlow(undefined, 'theme'),
    staleTime: 30 * 60 * 1000,
    retry: 1,
  })
  const { data: industryData, error: industryError, isError: industryIsError } = useQuery({
    queryKey: ['recommendations', 'sector-flow', 'industry', 'home'],
    queryFn: () => recommendationsApi.sectorFlow(undefined, 'industry'),
    staleTime: 30 * 60 * 1000,
    retry: 1,
  })
  const limit = 15
  const themeRows = asArray<any>(themeData?.flows).slice(0, limit)
  const industryRows = asArray<any>(industryData?.flows).slice(0, limit)
  const hotKeywordRows = [...themeRows, ...industryRows]
  const errorText = themeIsError || industryIsError
    ? String((themeError as Error | null)?.message ?? (industryError as Error | null)?.message ?? 'sector-flow API error')
    : null

  return (
    <section className={panelClass('h-full p-5')}>
      <div className="mb-5 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Radar className="h-4 w-4 text-cyan-300" />
          <h2 className="font-bold text-slate-100">法人資金流與題材輪動</h2>
        </div>
        <SourceBadge>{themeData?.date ?? industryData?.date ?? 'sector-flow'}</SourceBadge>
      </div>
      {errorText ? (
        <div className="rounded-[16px] border border-amber-300/15 bg-amber-400/[0.055] p-4 text-sm text-amber-100">
          法人資金流與題材輪動讀取失敗：{errorText}
        </div>
      ) : (
        <>
          <HotKeywordCloud rows={hotKeywordRows} />
          <div className={cx('mt-5 grid gap-6 border-t border-white/[0.07] pt-4', compact ? 'grid-cols-1' : 'xl:grid-cols-2')}>
            <FlowList title="題材資金流" rows={themeRows} />
            <FlowList title="產業資金流" rows={industryRows} />
          </div>
        </>
      )}
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
  const points = Array.isArray(rec?.watch_points)
    ? rec.watch_points
    : typeof rec?.watch_points === 'string'
      ? [rec.watch_points]
      : []
  const hasWatchPoint = points.some((point: any) => String(point).includes('allocation:potential_buy'))
  if (!hasPotentialBuyEvidence && !hasWatchPoint) return false
  const expectedReturn = potentialBuyExpectedReturn(rec)
  return expectedReturn != null && expectedReturn >= POTENTIAL_BUY_MIN_EXPECTED_RETURN
}

function recommendationScoreValue(rec: any): number {
  const scoreComponents = parseRecord(rec?.score_components)
  const direct = asNumber(
    rec?.score_v2_final
      ?? rec?.final_score
      ?? rec?.finalScore
      ?? scoreComponents?.finalScore
      ?? scoreComponents?.final_score
      ?? rec?.score
      ?? rec?.total_score,
  )
  return direct ?? Number.NEGATIVE_INFINITY
}

function selectHomeRecommendationRows(rows: any[], limit = HOME_RECOMMENDATION_LIMIT) {
  const seen = new Set<string>()
  const takeUnique = (row: any, index: number) => {
    const key = String(row?.stock_id ?? row?.symbol ?? index)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }

  const buyRows = rows.filter(isBuySignalRecommendation)
  const potentialRows = rows.filter((row) => !isBuySignalRecommendation(row) && isPotentialBuyRecommendation(row))
  const priorityRows = [...buyRows, ...potentialRows].filter(takeUnique).slice(0, limit)
  const remainingCapacity = Math.max(0, limit - priorityRows.length)
  const fillerRows = rows
    .filter((row, index) => takeUnique(row, index))
    .sort((a, b) => recommendationScoreValue(b) - recommendationScoreValue(a))
    .slice(0, remainingCapacity)

  return [...priorityRows, ...fillerRows].map((row) => {
    if (recommendationSignalText(row) !== 'POTENTIAL_BUY' || isPotentialBuyRecommendation(row)) return row
    return {
      ...row,
      signal: 'HOLD',
      signal_raw: row?.signal_raw ?? row?.signal,
    }
  })
}

function RecommendationPanel() {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['recommendations', 'daily', 'home'],
    queryFn: () => recommendationsApi.daily(undefined, { view: 'card' }),
    staleTime: 30 * 60 * 1000,
    retry: 1,
  })
  const { tradable, researchOnly } = splitRecommendationLanes<any>(data)
  const allRows = recommendationRowsFromPayload(data)
  const displayRows = selectHomeRecommendationRows(allRows)
  const buyCount = allRows.filter(isBuySignalRecommendation).length
  const potentialBuyCount = allRows.filter((row) => !isBuySignalRecommendation(row) && isPotentialBuyRecommendation(row)).length
  const heatValues = allRows
    .map((row: any) => asNumber(row?.market_heat_score ?? row?.strategy_router_components?.market_heat_score ?? row?.score_components?.market_heat_score))
    .filter((value): value is number => value != null)
  const avgHeat = heatValues.length ? heatValues.reduce((sum, item) => sum + item, 0) / heatValues.length : null

  return (
    <section className={panelClass('overflow-hidden')}>
      <SectionHeader
        icon={Sparkles}
        title="選股推薦名單"
        action={<SourceBadge>{data?.date ?? 'latest'} · 顯示 {displayRows.length}/{allRows.length} 檔</SourceBadge>}
      />
      <div className="border-t border-white/[0.06] bg-[#101116] px-5 py-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2.5 py-1 text-[11px] font-bold text-emerald-300">
                BUY {buyCount}
              </span>
              <span className="rounded-full border border-amber-400/25 bg-amber-400/10 px-2.5 py-1 text-[11px] font-bold text-amber-300">
                potential BUY {potentialBuyCount}
              </span>
              <span className="rounded-full border border-emerald-400/20 bg-emerald-400/[0.07] px-2.5 py-1 text-[11px] font-bold text-emerald-300">
                可交易 {tradable.length}
              </span>
              <span className="rounded-full border border-sky-400/20 bg-sky-400/10 px-2.5 py-1 text-[11px] font-bold text-sky-300">
                研究 {researchOnly.length}
              </span>
              <span className="rounded-full border border-blue-400/20 bg-blue-400/10 px-2.5 py-1 text-[11px] font-bold text-blue-300">
                平均熱度 {avgHeat == null ? '待接資料' : avgHeat.toFixed(1)}
              </span>
            </div>
            <p className="mt-2 text-xs leading-5 text-slate-500">依最新交易日條件排序，點開牌卡快速查看個股籌碼、技術分數與交易計劃摘要。</p>
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

      {isLoading ? (
        <div className="grid gap-px bg-white/[0.06] p-4 md:grid-cols-2">
          {[1, 2, 3, 4].map((index) => (
            <div key={index} className="h-28 animate-pulse rounded-[18px] border border-white/[0.06] bg-white/[0.035]" />
          ))}
        </div>
      ) : isError ? (
        <div className="bg-[#111216] p-8 text-center text-sm text-slate-500">
          <div className="mx-auto max-w-md rounded-[18px] border border-amber-300/15 bg-amber-400/[0.055] p-6 text-left">
            <Sparkles className="mb-3 h-8 w-8 text-amber-300" />
            <p className="font-semibold text-amber-100">選股推薦名單讀取失敗</p>
            <p className="mt-2 break-words text-xs leading-5 text-slate-400">{String((error as Error | null)?.message ?? 'recommendations/daily API error')}</p>
          </div>
        </div>
      ) : displayRows.length ? (
        <div className="grid gap-3 bg-[#101116] p-4 lg:grid-cols-2">
          {displayRows.map((rec: any, index: number) => (
            <RecommendationCardClean key={rec.stock_id ?? rec.symbol ?? index} rec={rec} rank={index + 1} context="home" />
          ))}
        </div>
      ) : (
        <div className="bg-[#111216] p-8 text-center text-sm text-slate-500">
          <div className="mx-auto max-w-md rounded-[18px] border border-white/[0.07] bg-white/[0.032] p-6">
            <Sparkles className="mx-auto mb-3 h-8 w-8 text-slate-600" />
            <p>目前沒有可列入推薦名單的標的。</p>
            <p className="mt-1 text-xs text-slate-600">請檢查 recommendations/daily payload 或登入狀態。</p>
          </div>
        </div>
      )}
    </section>
  )
}

export default function MarketHomePage() {
  return (
    <AppShell>
      <div className="min-h-screen overflow-x-hidden text-slate-100">
        <main className="w-full max-w-none space-y-4 px-4 py-5 md:px-8 2xl:px-10">
          <div className="relative overflow-hidden rounded-[24px] border border-amber-300/12 bg-[radial-gradient(circle_at_78%_48%,rgba(196,154,76,0.18),transparent_34%),linear-gradient(100deg,rgba(42,36,25,0.92),rgba(18,19,24,0.97)_44%,rgba(38,34,24,0.92))] px-6 py-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_24px_70px_rgba(0,0,0,0.28)]">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <span className="inline-flex rounded-full border border-amber-300/25 bg-amber-300/10 px-3 py-1 text-xs font-bold text-amber-300">市場總覽</span>
                <h1 className="mt-3 text-2xl font-bold text-white">StockVision 晨間概覽</h1>
                <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-400">
                  指數、信用交易、法人資金、避險情緒、景氣信號與題材輪動集中在同一張高密度儀表板。
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <SourceBadge>FinLab / D1 / TWSE-TPEX</SourceBadge>
                <SourceBadge>risk factor packet</SourceBadge>
              </div>
            </div>
          </div>

          <MarketOverviewBlock />
          <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(360px,1fr)]">
            <RecommendationPanel />
            <ThemeFlowPanel compact />
          </div>
        </main>
      </div>
    </AppShell>
  )
}
