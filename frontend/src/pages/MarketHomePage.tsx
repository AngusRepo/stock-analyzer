import { useMemo, type ComponentType, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Activity,
  BarChart3,
  CalendarDays,
  CircleDollarSign,
  Gauge,
  Newspaper,
  PieChart,
  Radar,
  Shield,
  ShieldAlert,
  Sparkles,
  TrendingDown,
  Waves,
} from 'lucide-react'
import AppShell from '@/components/AppShell'
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

  return {
    label,
    value: current == null ? (notMaterialized ? '待匯入' : '待接資料') : formatNumber(current, current >= 1000 ? 2 : 2),
    change: current == null ? (notMaterialized ? 'FinLab未匯入' : '待接資料') : formatSigned(change, 2),
    pct: current == null ? '--' : formatPct(changePct, 2),
    tone: current == null ? (notMaterialized ? 'amber' : 'slate') : toneBySigned(change),
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
  const explicit = asNumber(risk?.hedgeScore ?? risk?.hedgeRiskValue)
  const riskScore = asNumber(risk?.riskScore ?? risk?.risk_score)
  const usVix = asNumber(risk?.vix ?? risk?.usVix)
  const twVol20 = asNumber(risk?.twiiVol20 ?? risk?.realizedVol20)
  const volScore = volatilityStressScore(usVix, twVol20)

  if (explicit != null) return { score: clampScore(explicit), source: '專屬避險分數' }
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
  bar,
  children,
}: {
  icon: ComponentType<{ className?: string }>
  title: string
  date?: string | null
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
        <span className="rounded-full bg-white/[0.055] px-2 py-1 text-[11px] text-slate-500">{shortDate(date)}</span>
      </div>
      {bar}
      <div className="mt-5">{children}</div>
    </div>
  )
}

function MarketStatsRibbon({ risk }: { risk: any }) {
  const breadth = risk?.breadthSnapshot ?? risk?.breadth ?? {}
  const advance = asNumber(breadth.advance_count ?? breadth.advanceCount ?? breadth.up ?? breadth.rising)
  const unchanged = asNumber(breadth.unchanged_count ?? breadth.unchangedCount ?? breadth.flat ?? breadth.unchanged)
  const decline = asNumber(breadth.decline_count ?? breadth.declineCount ?? breadth.down ?? breadth.falling)
  const total = (advance ?? 0) + (unchanged ?? 0) + (decline ?? 0)
  const volume = asNumber(risk?.marketVolume ?? risk?.turnoverVolume ?? risk?.marketStats?.volume)
  const amount = asNumber(risk?.marketTurnoverAmount ?? risk?.turnoverAmount ?? risk?.marketStats?.amount)
  const marginBalanceValue = asNumber(risk?.marginBalanceValue ?? risk?.creditTrading?.marginBalanceValue)
  const marginBalanceUnits = asNumber(breadth.margin_balance ?? risk?.marginBalanceUnits ?? risk?.creditTrading?.marginBalanceUnits)
  const marginBalance = marginBalanceUnits ?? asNumber(risk?.marginBalance ?? risk?.creditTrading?.marginBalance)
  const shortBalance = asNumber(breadth.short_balance ?? risk?.shortBalanceUnits ?? risk?.creditTrading?.shortBalanceUnits ?? risk?.shortBalance ?? risk?.creditTrading?.shortBalance)
  const marginBalanceDisplay = marginBalanceValue != null
    ? formatCompactAmount(marginBalanceValue)
    : marginBalance == null ? '待接資料' : `${formatCompactAmount(marginBalance)}張`
  const maintenance = asNumber(breadth.margin_maintenance ?? risk?.marginMaintenanceRate ?? risk?.creditTrading?.maintenanceRate)
  const marginChangePct = asNumber(risk?.marginBalanceChangePct ?? risk?.creditTrading?.marginBalanceChangePct)
  const shortChangePct = asNumber(risk?.shortBalanceChangePct ?? risk?.creditTrading?.shortBalanceChangePct)

  return (
    <div className="grid gap-4 xl:grid-cols-4">
      <StatTrack
        icon={TrendingDown}
        title="漲跌家數"
        date={breadth.date ?? risk?.date}
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
        title="成交量"
        date={risk?.date}
        bar={<SplitBar values={[volume ?? 0, amount ?? 0]} colors={['#3b82f6', '#8b5cf6']} />}
      >
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-xs text-slate-500">總成交量</p>
            <p className="mt-1 text-lg font-bold tabular-nums text-slate-100">{formatCompactAmount(volume)}</p>
            <p className="text-[11px] text-slate-500">TWSE/TPEX daily</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">總成交額</p>
            <p className="mt-1 text-lg font-bold tabular-nums text-slate-100">{formatCompactAmount(amount)}</p>
            <p className="text-[11px] text-slate-500">market turnover</p>
          </div>
        </div>
      </StatTrack>

      <StatTrack
        icon={CircleDollarSign}
        title="融資融券"
        date={breadth.date ?? risk?.date}
        bar={<SplitBar values={[marginBalance ?? 0, shortBalance ?? 0]} colors={['#22c55e', '#8b5cf6']} />}
      >
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-xs text-slate-500">融資餘額</p>
            <p className="mt-1 text-lg font-bold tabular-nums text-slate-100">{marginBalanceDisplay}</p>
            <p className={cx('text-[11px] tabular-nums', toneText(toneBySigned(marginChangePct)))}>{formatPct(marginChangePct)}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">融券餘額</p>
            <p className="mt-1 text-lg font-bold tabular-nums text-slate-100">{shortBalance == null ? '待接資料' : `${formatCompactAmount(shortBalance)}張`}</p>
            <p className={cx('text-[11px] tabular-nums', toneText(toneBySigned(shortChangePct)))}>{formatPct(shortChangePct)}</p>
          </div>
        </div>
      </StatTrack>

      <StatTrack
        icon={Shield}
        title="融資維持率"
        date={breadth.date ?? risk?.date}
        bar={<SplitBar values={[maintenance ?? 0, maintenance == null ? 0 : Math.max(0, 220 - maintenance)]} colors={['#14b8a6', '#30343d']} />}
      >
        <div>
          <p className="text-xs text-slate-500">當前維持率</p>
          <p className={cx('mt-1 text-xl font-bold tabular-nums', maintenance != null && maintenance < 150 ? 'text-amber-300' : 'text-emerald-400')}>
            {maintenance == null ? '待接資料' : `${maintenance.toFixed(2)}%`}
          </p>
          <p className="mt-2 text-[11px] leading-5 text-slate-500">信用交易日況來源接上後，這裡會用真實維持率與日變化。</p>
        </div>
      </StatTrack>
    </div>
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
  const pcr = findFactor(risk, ['put_call', 'pcr', 'options'], ['賣買權', 'PCR'])
  const largeTrader = findFactor(risk, ['large_trader', 'smart_money'], ['大戶', '未平倉'])
  const usdTwdFactor = findFactor(risk, ['usd_twd', 'fx'], ['匯率', '美元兌台幣'])
  const usdTwd = asNumber(risk?.usdTwd ?? risk?.usdtwd ?? usdTwdFactor?.raw_value)
  const fxChange = asNumber(risk?.usdTwdChangePct ?? risk?.fxChangePct)
  const usVix = asNumber(risk?.vix ?? risk?.usVix)
  const twVol20 = asNumber(risk?.twiiVol20 ?? risk?.realizedVol20)

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
            <p className={cx('mt-1 text-sm font-bold', toneText(riskTone(normalized)))}>{riskLevelLabel(normalized, null)}</p>
          </div>
          <div className="text-right">
            <p className="text-xs text-slate-500">避險值</p>
            <p className={cx('mt-1 text-2xl font-bold tabular-nums', toneText(riskTone(normalized)))}>{normalized == null ? '待接資料' : normalized.toFixed(0)}</p>
          </div>
        </div>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[linear-gradient(90deg,#22c55e_0%,#84cc16_28%,#f59e0b_52%,#f97316_73%,#ef4444_100%)]" />
        <div className="mt-2 flex justify-between text-[11px] text-slate-500">
          <span>正常</span>
          <span>中性</span>
          <span>偏高</span>
        </div>
      </div>

      <div className="mt-4 grid gap-4 border-t border-white/[0.07] pt-4 sm:grid-cols-2">
        <HedgeFactor label="賣買權量比" value={factorDisplay(pcr, '待接 PCR')} note={pcr?.status ?? 'options positioning'} tone="blue" />
        <HedgeFactor label="大戶淨部位" value={factorDisplay(largeTrader, '待接資料')} note="期貨大戶與籌碼壓力" tone={toneBySigned(asNumber(largeTrader?.raw_value))} />
        <HedgeFactor
          label="台股波動率"
          value={twVol20 == null ? '待接資料' : `${twVol20.toFixed(2)}%`}
          note="TWII 20日實現波動率"
          tone={riskTone(twVol20)}
        />
        <HedgeFactor
          label="美股 VIX"
          value={usVix == null ? '待接資料' : usVix.toFixed(2)}
          note={risk?.vixLevel ? `CBOE ${risk.vixLevel}` : 'S&P 500 options implied volatility'}
          tone={riskTone(usVix == null ? null : usVix * 2.4)}
        />
        <HedgeFactor label="美元兌台幣" value={usdTwd == null ? factorDisplay(usdTwdFactor) : usdTwd.toFixed(3)} note={fxChange == null ? '匯率因子' : `日變動 ${formatPct(fxChange)}`} tone={toneBySigned(fxChange)} />
        <HedgeFactor label="匯率狀態" value={risk?.fxStatus ?? '穩定'} note="宏觀避險因子" tone="slate" />
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
        <div className="grid h-6 overflow-hidden rounded-full text-center text-sm font-semibold text-white sm:grid-cols-5">
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
            <MarketStatsRibbon risk={risk} />
          </div>
          <div className="grid gap-px bg-white/[0.045] xl:grid-cols-3">
            <div className="space-y-px bg-white/[0.045]">
              <div className="bg-[#101116] p-4">
                <InstitutionFlowCard risk={risk} />
              </div>
              <div className="bg-[#101116] p-4">
                <BusinessSignalCard risk={risk} />
              </div>
            </div>
            <div className="bg-[#101116] p-4">
              <HedgeSentimentCard risk={risk} />
            </div>
            <div className="bg-[#101116] p-4">
              <NewsBlock embedded />
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
  const rows = asArray<any>(data).slice(0, embedded ? 6 : 12)
  const sectionClass = embedded
    ? 'h-full overflow-hidden rounded-[20px] border border-white/[0.07] bg-white/[0.032]'
    : panelClass('overflow-hidden')
  const gridClass = embedded
    ? 'grid gap-px bg-white/[0.06]'
    : 'grid gap-px bg-white/[0.06] md:grid-cols-2 xl:grid-cols-3'

  return (
    <section className={sectionClass}>
      <SectionHeader icon={Newspaper} title="最新消息" action={<SourceBadge>每來源 3 則股票新聞</SourceBadge>} />
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

function ThemeFlowPanel() {
  const { data: themeData } = useQuery({
    queryKey: ['recommendations', 'sector-flow', 'theme', 'home'],
    queryFn: () => recommendationsApi.sectorFlow(undefined, 'theme').catch(() => ({ flows: [] })),
    staleTime: 30 * 60 * 1000,
    retry: 1,
  })
  const { data: industryData } = useQuery({
    queryKey: ['recommendations', 'sector-flow', 'industry', 'home'],
    queryFn: () => recommendationsApi.sectorFlow(undefined, 'industry').catch(() => ({ flows: [] })),
    staleTime: 30 * 60 * 1000,
    retry: 1,
  })
  const themeRows = asArray<any>(themeData?.flows).slice(0, 8)
  const industryRows = asArray<any>(industryData?.flows).slice(0, 8)

  return (
    <section className={panelClass('p-5')}>
      <div className="mb-5 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Radar className="h-4 w-4 text-cyan-300" />
          <h2 className="font-bold text-slate-100">法人資金流與題材輪動</h2>
        </div>
        <SourceBadge>{themeData?.date ?? industryData?.date ?? 'sector-flow'}</SourceBadge>
      </div>
      <div className="grid gap-6 xl:grid-cols-2">
        <FlowList title="題材資金流" rows={themeRows} />
        <FlowList title="產業資金流" rows={industryRows} />
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

function RecommendationPanel() {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['recommendations', 'daily', 'home'],
    queryFn: () => recommendationsApi.daily(undefined, { view: 'card' }).catch(() => ({ recommendations: [] })),
    staleTime: 30 * 60 * 1000,
    retry: 1,
  })
  const { tradable, researchOnly } = splitRecommendationLanes<any>(data)
  const allRows = recommendationRowsFromPayload(data)
  const heatValues = allRows
    .map((row: any) => asNumber(row?.market_heat_score ?? row?.strategy_router_components?.market_heat_score ?? row?.score_components?.market_heat_score))
    .filter((value): value is number => value != null)
  const avgHeat = heatValues.length ? heatValues.reduce((sum, item) => sum + item, 0) / heatValues.length : null

  return (
    <section className={panelClass('overflow-hidden')}>
      <SectionHeader
        icon={Sparkles}
        title="AI 推薦名單"
        action={<SourceBadge>{data?.date ?? 'latest'} · {allRows.length} 檔</SourceBadge>}
      />
      <div className="border-t border-white/[0.06] bg-[#101116] px-5 py-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2.5 py-1 text-[11px] font-bold text-emerald-300">
                可交易 {tradable.length}
              </span>
              <span className="rounded-full border border-sky-400/20 bg-sky-400/10 px-2.5 py-1 text-[11px] font-bold text-sky-300">
                研究 {researchOnly.length}
              </span>
              <span className="rounded-full border border-blue-400/20 bg-blue-400/10 px-2.5 py-1 text-[11px] font-bold text-blue-300">
                平均熱度 {avgHeat == null ? '待接資料' : avgHeat.toFixed(1)}
              </span>
            </div>
            <p className="mt-2 text-xs leading-5 text-slate-500">依最新交易日條件排序，點開牌卡查看個股籌碼、技術分數、模型判讀與交易計劃。</p>
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
      ) : allRows.length ? (
        <div className="grid gap-3 bg-[#101116] p-4 lg:grid-cols-2">
          {allRows.map((rec: any, index: number) => (
            <RecommendationCardClean key={rec.stock_id ?? rec.symbol ?? index} rec={rec} rank={index + 1} />
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
          <RecommendationPanel />
          <ThemeFlowPanel />
        </main>
      </div>
    </AppShell>
  )
}
