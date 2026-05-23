import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Globe2,
  Landmark,
  ShieldCheck,
  TrendingDown,
  Waves,
} from 'lucide-react'
import { marketApi } from '@/lib/api'
import { formatTwDateTimeShort } from '@/lib/twTime'

type FactorStatus = 'ok' | 'info' | 'warn' | 'error' | 'missing'

interface MarketRiskFactor {
  id: string
  label: string
  value: string
  raw_value?: number | string | null
  score?: number
  status: FactorStatus
  source: string
  source_date?: string | null
  detail?: string
  missing_reason?: string
}

interface MarketRisk {
  date: string
  twiiClose: number | null
  riskScore: number
  riskLevel: 'green' | 'yellow' | 'orange' | 'red' | 'black'
  riskSummary: string
  calculatedAt: string
  contextFactors?: MarketRiskFactor[]
  factorPacket?: {
    schema_version: string
    score: number
    level: MarketRisk['riskLevel']
    generated_at: string
    missing_reasons?: Record<string, string>
  } | null
  regimeState?: {
    label: string
    family: string
    runDate: string | null
    computedAt: string
    source: string
  } | null
}

interface FactorGroup {
  id: string
  label: string
  value: string
  status: FactorStatus
  source: string
  sourceDate?: string | null
  detail: string
  missingReason?: string
  factors: MarketRiskFactor[]
  Icon: typeof Activity
}

const LEVEL_CONFIG = {
  green: { label: '貪婪', color: 'text-emerald-300', border: 'border-emerald-500/30', bg: 'bg-emerald-500/10' },
  yellow: { label: '中性', color: 'text-yellow-300', border: 'border-yellow-500/30', bg: 'bg-yellow-500/10' },
  orange: { label: '偏熱', color: 'text-orange-300', border: 'border-orange-500/30', bg: 'bg-orange-500/10' },
  red: { label: '恐慌', color: 'text-red-300', border: 'border-red-500/30', bg: 'bg-red-500/10' },
  black: { label: '極恐慌', color: 'text-zinc-100', border: 'border-zinc-400/40', bg: 'bg-zinc-700/40' },
}
const STATUS_STYLE: Record<FactorStatus, string> = {
  ok: 'border-emerald-400/25 bg-emerald-400/[0.07] text-emerald-100',
  info: 'border-sky-400/25 bg-sky-400/[0.07] text-sky-100',
  warn: 'border-amber-400/30 bg-amber-400/[0.08] text-amber-100',
  error: 'border-red-400/30 bg-red-400/[0.08] text-red-100',
  missing: 'border-slate-500/30 bg-slate-500/[0.06] text-slate-300',
}

const STATUS_LABEL: Record<FactorStatus, string> = {
  ok: '正常',
  info: '資訊',
  warn: '注意',
  error: '錯誤',
  missing: '缺資料',
}

const LIGHT_STYLE = [
  { name: '藍燈', className: 'bg-sky-400 shadow-sky-400/40' },
  { name: '黃藍燈', className: 'bg-cyan-300 shadow-cyan-300/40' },
  { name: '綠燈', className: 'bg-emerald-400 shadow-emerald-400/40' },
  { name: '黃紅燈', className: 'bg-amber-300 shadow-amber-300/40' },
  { name: '紅燈', className: 'bg-red-400 shadow-red-400/40' },
]

function lightClass(text: string) {
  return LIGHT_STYLE.find((item) => text.includes(item.name))?.className ?? 'bg-slate-400 shadow-slate-400/30'
}

function BusinessCycleLightValue({ value }: { value: string }) {
  const parts = value.split(/\s*(?:→|->)\s*/).filter(Boolean)
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 font-mono text-sm font-semibold leading-6 tabular-nums">
      {parts.map((part, index) => (
        <span key={`${part}-${index}`} className="inline-flex items-center gap-1.5">
          <span className={`h-2.5 w-2.5 rounded-full shadow ${lightClass(part)}`} />
          <span>{part}</span>
          {index < parts.length - 1 ? <span className="text-muted-foreground/80">→</span> : null}
        </span>
      ))}
    </div>
  )
}
const GROUPS = [
  {
    id: 'trend_volatility',
    label: '趨勢 / 波動',
    factorIds: ['price_trend', 'volatility'],
    sourceHint: '加權指數 20MA 與近 20 日波動',
    Icon: Waves,
  },
  {
    id: 'business_cycle',
    label: '景氣對策燈號',
    factorIds: ['breadth'],
    sourceHint: '景氣對策燈號資料',
    Icon: Landmark,
  },
  {
    id: 'chips',
    label: '三大法人',
    factorIds: ['chips'],
    sourceHint: '三大法人官方當日買賣超',
    Icon: TrendingDown,
  },
  {
    id: 'leverage',
    label: '融資融券',
    factorIds: ['leverage'],
    sourceHint: '融資融券最新餘額',
    Icon: Activity,
  },
  {
    id: 'macro_global',
    label: '總經 / 全球',
    factorIds: ['macro', 'global', 'global_risk'],
    sourceHint: '總經流動性與全球風險佐證',
    Icon: Globe2,
  },
  {
    id: 'event_pressure',
    label: '事件壓力',
    factorIds: ['event_monitors', 'lppls', 'hawkes'],
    sourceHint: '新聞事件、泡沫壓力與事件叢集',
    Icon: AlertTriangle,
  },
] as const
function cleanValue(value?: string | number | null) {
  const text = String(value ?? '').trim()
  if (!text || /^n\/a$/i.test(text) || /^context( missing)?$/i.test(text)) return '資料不足'
  const normalized = text.toLowerCase().replace(/[\s_-]+/g, '_')
  const valueMap: Record<string, string> = {
    bullish: '偏多',
    bull: '偏多',
    risk_on: '偏多',
    bearish: '偏空',
    bear: '偏空',
    risk_off: '偏空',
    neutral: '中性',
    sideways: '盤整',
    volatile: '高波動',
    high_volatility: '高波動',
    low_volatility: '低波動',
    greedy: '貪婪',
    fear: '恐慌',
    panic: '恐慌',
  }
  if (valueMap[normalized]) return valueMap[normalized]
  return text
}

function cleanDetail(value?: string | null) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  if (/^(source|run_date|generated)=/i.test(text)) return ''
  return text
    .replace(/\bTWII close\b/i, '加權指數收盤')
    .replace(/\bmarket_regime_state\b/ig, '市場狀態')
    .replace(/\bmacro_liquidity\b/ig, '總經流動性')
    .replace(/\bglobal_risk\b/ig, '全球風險')
    .replace(/\bevidence\b/ig, '佐證')
    .replace(/\bLPPLS\b/g, '泡沫壓力')
    .replace(/\bHawkes\b/g, '事件叢集')
}

function worstStatus(factors: MarketRiskFactor[]): FactorStatus {
  if (!factors.length) return 'missing'
  if (factors.some((factor) => factor.status === 'error')) return 'error'
  if (factors.some((factor) => factor.status === 'warn')) return 'warn'
  if (factors.every((factor) => factor.status === 'missing' || factor.missing_reason)) return 'missing'
  if (factors.some((factor) => factor.status === 'info')) return 'info'
  return 'ok'
}

function latestSourceDate(factors: MarketRiskFactor[]) {
  const dates = factors.map((factor) => factor.source_date).filter(Boolean).sort()
  return dates.length ? dates[dates.length - 1] ?? null : null
}

function uniqueText(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.map((value) => String(value ?? '').trim()).filter(Boolean)))
}

function buildGroupValue(groupId: string, factors: MarketRiskFactor[]) {
  const byId = new Map(factors.map((factor) => [factor.id, factor]))
  if (groupId === 'trend_volatility') {
    return `20MA ${cleanValue(byId.get('price_trend')?.value)} / 波動 ${cleanValue(byId.get('volatility')?.value)}`
  }
  if (groupId === 'macro_global') {
    const macro = cleanValue(byId.get('macro')?.value)
    const global = cleanValue((byId.get('global') ?? byId.get('global_risk'))?.value)
    return `總經 ${macro} / 全球 ${global}`
  }
  if (groupId === 'event_pressure') {
    return cleanValue(byId.get('event_monitors')?.value ?? byId.get('lppls')?.value ?? byId.get('hawkes')?.value)
  }
  return cleanValue(factors[0]?.value)
}
function buildFactorGroups(factors: MarketRiskFactor[]): FactorGroup[] {
  return GROUPS.map((group) => {
    const matched = factors.filter((factor) => group.factorIds.includes(factor.id as never))
    const status = worstStatus(matched)
    const sources = uniqueText(matched.map((factor) => factor.source))
    const details = uniqueText(matched.map((factor) => cleanDetail(factor.detail))).slice(0, 3)
    const missingReasons = uniqueText(matched.map((factor) => factor.missing_reason))

    return {
      id: group.id,
      label: group.label,
      value: buildGroupValue(group.id, matched),
      status,
      source: sources.length ? sources.join(' + ') : group.sourceHint,
      sourceDate: latestSourceDate(matched),
      detail: details.length ? details.join(' / ') : cleanDetail(group.sourceHint),
      missingReason: missingReasons.length ? missingReasons.join(' / ') : undefined,
      factors: matched,
      Icon: group.Icon,
    }
  })
}

function fallbackFactors(risk: MarketRisk): MarketRiskFactor[] {
  return [
    {
      id: 'price_trend',
      label: '趨勢 / 20MA',
      value: '資料不足',
      status: 'missing',
      source: 'market_risk.twii_bias',
      detail: `加權指數收盤 ${risk.twiiClose ?? '資料不足'}`,
      missing_reason: 'market_regime_factor_packet_missing',
    },
  ]
}

function MarketFearGauge({ score, level }: { score: number; level: keyof typeof LEVEL_CONFIG }) {
  const cfg = LEVEL_CONFIG[level] ?? LEVEL_CONFIG.yellow
  const safeScore = Math.max(0, Math.min(100, Number.isFinite(score) ? score : 0))
  const angle = Math.PI + (safeScore / 100) * Math.PI
  const centerX = 110
  const centerY = 100
  const needleX = centerX + Math.cos(angle) * 58
  const needleY = centerY + Math.sin(angle) * 58
  return (
    <div className="rounded-xl border border-white/10 bg-black/20 p-3 text-center">
      <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">市場綜合分數</div>
      <svg viewBox="0 0 220 116" className="mx-auto mt-1 h-24 w-full max-w-[220px] overflow-visible" aria-label={`Market Composite ${Math.round(safeScore)}`}>
        <defs>
          <linearGradient id="market-risk-gauge" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="#10b981" />
            <stop offset="44%" stopColor="#facc15" />
            <stop offset="70%" stopColor="#fb923c" />
            <stop offset="100%" stopColor="#fb3b6f" />
          </linearGradient>
          <filter id="market-risk-glow" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <path d="M30 100 A80 80 0 0 1 190 100" fill="none" stroke="rgba(148,163,184,.18)" strokeWidth="14" strokeLinecap="round" />
        <path d="M30 100 A80 80 0 0 1 190 100" fill="none" stroke="url(#market-risk-gauge)" strokeWidth="14" strokeLinecap="round" pathLength="100" strokeDasharray="100 100" filter="url(#market-risk-glow)" />
        <line x1={centerX} y1={centerY} x2={needleX} y2={needleY} stroke="#facc15" strokeWidth="3" strokeLinecap="round" />
        <circle cx={centerX} cy={centerY} r="6" fill="#facc15" stroke="#fff7ad" strokeWidth="2" />
      </svg>
      <div className={`mt-1 text-3xl font-bold leading-none tabular-nums ${cfg.color}`}>{Math.round(safeScore)}</div>
      <div className={`mt-0.5 text-xs font-semibold ${cfg.color}`}>{cfg.label}</div>
      <div className="mt-3 grid grid-cols-5 gap-1 text-[10px] text-muted-foreground">
        {['貪婪', '中性', '偏熱', '恐慌', '極恐慌'].map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
    </div>
  )
}

function FactorCard({ group }: { group: FactorGroup }) {
  const Icon = group.Icon
  return (
    <div className={`rounded-lg border p-3 ${STATUS_STYLE[group.status]}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className="h-4 w-4 shrink-0" />
          <span className="truncate text-sm font-semibold">{group.label}</span>
        </div>
        <span className="shrink-0 rounded-full border border-current/25 px-2 py-0.5 text-[10px]">
          {STATUS_LABEL[group.status]}
        </span>
      </div>
      {group.id === 'business_cycle' ? (
        <BusinessCycleLightValue value={group.value} />
      ) : (
        <div className="mt-3 break-words font-mono text-base font-semibold leading-6 tabular-nums">{group.value}</div>
      )}
      <div className="mt-2 text-[11px] leading-5 text-muted-foreground">
        {group.missingReason ? `缺資料：${group.missingReason}` : group.detail}
      </div>
      <div className="mt-2 flex items-center justify-end gap-2 font-mono text-[10px] text-muted-foreground/80">
        {group.sourceDate ? <span className="shrink-0">更新：{group.sourceDate}</span> : null}
      </div>
    </div>
  )
}
export default function MarketRiskPanel() {
  const [risk, setRisk] = useState<MarketRisk | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const load = async () => {
      try {
        const riskData = await marketApi.risk()
        setRisk(riskData)
      } catch (e: any) {
        setError(e.message ?? 'load_failed')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  const groups = useMemo(() => {
    if (!risk) return []
    const factors = risk.contextFactors?.length ? risk.contextFactors : fallbackFactors(risk)
    return buildFactorGroups(factors)
  }, [risk])

  if (loading) {
    return (
      <div className="flex h-36 items-center justify-center text-sm text-muted-foreground">
        <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
        載入市場風險...
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.04] p-5 text-sm">
        <p className="font-semibold text-amber-200">市場風險 API 載入失敗</p>
        <p className="mt-1 text-xs text-muted-foreground">請檢查資料品質與市場狀態資料是否已更新。</p>
      </div>
    )
  }
  if (!risk) return null

  const cfg = LEVEL_CONFIG[risk.riskLevel] ?? LEVEL_CONFIG.yellow
  const packetGeneratedAt = risk.factorPacket?.generated_at ?? risk.calculatedAt
  const missingCount = groups.filter((group) => group.status === 'missing').length
  const score = Number.isFinite(risk.riskScore) ? risk.riskScore : Number(risk.factorPacket?.score ?? 0)

  return (
    <div className={`rounded-xl border ${cfg.border} ${cfg.bg} p-5`}>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_220px]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <ShieldCheck className={`h-4 w-4 ${cfg.color}`} />
            <span className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">今日市場判讀</span>
            {missingCount > 0 && (
              <span className="rounded-full border border-slate-500/30 px-2 py-0.5 text-[10px] text-slate-300">
                缺資料 {missingCount}
              </span>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-end gap-3">
            <div className={`text-2xl font-bold ${cfg.color}`}>{cfg.label}</div>
            <div className="font-mono text-xs text-muted-foreground">資料日：{risk.regimeState?.runDate ?? risk.date}</div>
            <div className="font-mono text-xs text-muted-foreground">更新：{formatTwDateTimeShort(packetGeneratedAt)}</div>
          </div>
          <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {groups.map((group) => (
              <FactorCard key={group.id} group={group} />
            ))}
          </div>
        </div>
        <MarketFearGauge score={score} level={risk.riskLevel} />
      </div>
    </div>
  )
}
