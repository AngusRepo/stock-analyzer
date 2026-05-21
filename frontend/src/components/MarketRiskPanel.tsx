import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Globe2,
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
  score?: number
  weight?: number
  contribution?: number
  status: FactorStatus
  source: string
  source_date?: string | null
  detail?: string
  missing_reason?: string
  evidence_title?: string | null
  evidence_url?: string | null
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
  riskScore: number
  appetiteScore: number
  contribution: number
  source: string
  sourceDate?: string | null
  detail: string
  missingReason?: string
  evidenceTitle?: string | null
  evidenceUrl?: string | null
  factors: MarketRiskFactor[]
  Icon: typeof Activity
}

const STATUS_STYLE: Record<FactorStatus, string> = {
  ok: 'border-emerald-400/35 bg-emerald-500/[0.09] text-emerald-100 shadow-[0_0_24px_rgba(16,185,129,0.08)]',
  info: 'border-cyan-400/30 bg-cyan-500/[0.08] text-cyan-100 shadow-[0_0_24px_rgba(34,211,238,0.07)]',
  warn: 'border-amber-400/35 bg-amber-500/[0.09] text-amber-100 shadow-[0_0_24px_rgba(245,158,11,0.08)]',
  error: 'border-rose-400/35 bg-rose-500/[0.09] text-rose-100 shadow-[0_0_24px_rgba(244,63,94,0.08)]',
  missing: 'border-slate-500/35 bg-slate-500/[0.08] text-slate-200',
}

const BAR_STYLE: Record<FactorStatus, string> = {
  ok: 'from-emerald-300 to-cyan-300',
  info: 'from-cyan-300 to-sky-300',
  warn: 'from-amber-300 to-orange-400',
  error: 'from-rose-400 to-pink-500',
  missing: 'from-slate-500 to-slate-400',
}

const GROUPS = [
  {
    id: 'chips',
    label: '外資',
    factorIds: ['chips'],
    sourceHint: 'FinLab canonical_chip_daily 5日法人金額',
    Icon: TrendingDown,
  },
  {
    id: 'trend',
    label: '大盤動能',
    factorIds: ['price_trend'],
    sourceHint: 'TWII 20MA 乖離與價格趨勢',
    Icon: Activity,
  },
  {
    id: 'volatility',
    label: '波動率',
    factorIds: ['volatility'],
    sourceHint: 'VIX 或台股 20 日波動',
    Icon: Waves,
  },
  {
    id: 'economy_light',
    label: '景氣燈號',
    factorIds: ['economy_light'],
    sourceHint: 'FinLab tw_business_indicators 景氣對策信號',
    Icon: BarChart3,
  },
  {
    id: 'leverage',
    label: '融資',
    factorIds: ['leverage'],
    sourceHint: 'FinLab 融資融券 / 借券壓力',
    Icon: ShieldCheck,
  },
  {
    id: 'global_events',
    label: '全球事件',
    factorIds: ['macro', 'global', 'global_risk', 'event_monitors', 'lppls', 'hawkes'],
    sourceHint: 'FinLab 全球/總經 + 鉅亨/GDELT 事件證據',
    Icon: Globe2,
  },
] as const

const MOOD_MARKS = [
  { label: '極度恐慌', color: 'bg-pink-500' },
  { label: '恐慌', color: 'bg-orange-500' },
  { label: '中性', color: 'bg-yellow-300' },
  { label: '貪婪', color: 'bg-emerald-400' },
  { label: '極度貪婪', color: 'bg-cyan-400' },
]

function clamp(value: number, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, value))
}

function finiteNumber(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function riskToAppetite(score: unknown) {
  const riskScore = finiteNumber(score)
  return riskScore == null ? 50 : Math.round(clamp(100 - riskScore))
}

function cleanValue(value?: string | null) {
  const text = String(value ?? '').trim()
  if (!text || /^n\/a$/i.test(text) || /^context( missing)?$/i.test(text)) return '缺資料'
  return text
}

function readableStatus(status: FactorStatus) {
  if (status === 'ok') return 'OK'
  if (status === 'info') return 'INFO'
  if (status === 'warn') return 'WARN'
  if (status === 'error') return 'RISK'
  return 'MISSING'
}

function moodLabel(score: number) {
  if (score <= 20) return '極度恐慌'
  if (score <= 40) return '恐慌'
  if (score <= 60) return '中性'
  if (score <= 80) return '貪婪'
  return '極度貪婪'
}

function moodColor(score: number) {
  if (score <= 20) return 'text-pink-400'
  if (score <= 40) return 'text-orange-300'
  if (score <= 60) return 'text-yellow-300'
  if (score <= 80) return 'text-emerald-300'
  return 'text-cyan-300'
}

function factorRiskScore(factor: MarketRiskFactor) {
  const score = finiteNumber(factor.score)
  return score == null ? 45 : clamp(score)
}

function factorContribution(factor: MarketRiskFactor) {
  const contribution = finiteNumber(factor.contribution)
  return contribution == null ? factorRiskScore(factor) * Number(factor.weight ?? 0) : contribution
}

function latestSourceDate(factors: MarketRiskFactor[]) {
  const sourceDates = factors.map((factor) => factor.source_date).filter(Boolean).sort()
  return sourceDates.length ? sourceDates[sourceDates.length - 1] ?? null : null
}

function worstStatus(factors: MarketRiskFactor[]): FactorStatus {
  if (!factors.length) return 'missing'
  if (factors.some((factor) => factor.status === 'error')) return 'error'
  if (factors.some((factor) => factor.status === 'warn')) return 'warn'
  if (factors.every((factor) => factor.status === 'missing' || factor.missing_reason)) return 'missing'
  if (factors.some((factor) => factor.status === 'info')) return 'info'
  return 'ok'
}

function buildGroupValue(groupId: string, factors: MarketRiskFactor[]) {
  const byId = new Map(factors.map((factor) => [factor.id, factor]))
  if (groupId === 'global_events') {
    const event = byId.get('event_monitors')
    const global = byId.get('global') ?? byId.get('global_risk')
    const macro = byId.get('macro')
    const values = [event?.value, global?.value, macro?.value].map(cleanValue).filter((value) => value !== '缺資料')
    return values.length ? values.slice(0, 2).join(' / ') : '缺資料'
  }
  return cleanValue(factors[0]?.value)
}

function buildFactorGroups(factors: MarketRiskFactor[]): FactorGroup[] {
  return GROUPS.map((group) => {
    const matched = factors.filter((factor) => group.factorIds.includes(factor.id as never))
    const status = worstStatus(matched)
    const missingReasons = matched
      .map((factor) => factor.missing_reason)
      .filter((reason): reason is string => Boolean(reason))
    const riskScore = matched.length
      ? matched.reduce((sum, factor) => sum + factorRiskScore(factor), 0) / matched.length
      : 45
    const contribution = matched.reduce((sum, factor) => sum + factorContribution(factor), 0)
    const sources = matched.map((factor) => factor.source).filter(Boolean)
    const details = matched.map((factor) => factor.detail).filter(Boolean).slice(0, 2)
    const evidence = matched.find((factor) => factor.evidence_title || factor.evidence_url)

    return {
      id: group.id,
      label: group.label,
      value: buildGroupValue(group.id, matched),
      status,
      riskScore: Math.round(riskScore),
      appetiteScore: status === 'missing' ? 0 : riskToAppetite(riskScore),
      contribution: Math.round(contribution * 10) / 10,
      source: sources.length ? Array.from(new Set(sources)).join(' + ') : group.sourceHint,
      sourceDate: latestSourceDate(matched),
      detail: details.length ? details.join('；') : group.sourceHint,
      missingReason: missingReasons.length ? Array.from(new Set(missingReasons)).join(' / ') : undefined,
      evidenceTitle: evidence?.evidence_title ?? null,
      evidenceUrl: evidence?.evidence_url ?? null,
      factors: matched,
      Icon: group.Icon,
    }
  })
}

function fallbackFactors(risk: MarketRisk): MarketRiskFactor[] {
  return [
    {
      id: 'price_trend',
      label: '價格趨勢',
      value: '缺資料',
      status: 'missing',
      score: 45,
      source: 'market_risk.twii_bias',
      detail: `TWII close ${risk.twiiClose ?? 'n/a'}`,
      missing_reason: 'market_regime_factor_packet_missing',
    },
  ]
}

function marketSummary(risk: MarketRisk, groups: FactorGroup[]) {
  const missing = groups.filter((group) => group.status === 'missing').map((group) => group.label)
  const pressure = [...groups].filter((group) => group.status !== 'missing').sort((a, b) => b.riskScore - a.riskScore)[0]
  const regime = risk.regimeState?.label ?? 'regime missing'
  const pressureText = pressure ? `主要壓力：${pressure.label} ${pressure.riskScore}/100。` : '主要壓力：缺資料。'
  return missing.length
    ? `${regime}，${pressureText} 缺資料：${missing.join('、')}。`
    : `${regime}，${pressureText}`
}

function MarketGauge({ score }: { score: number }) {
  const angle = -90 + clamp(score) * 1.8
  return (
    <div className="relative mx-auto aspect-[1.55/1] w-full max-w-[420px]">
      <svg viewBox="0 0 240 150" className="h-full w-full overflow-visible" role="img" aria-label={`市場恐慌貪婪指數 ${score}`}>
        <defs>
          <linearGradient id="market-gauge-gradient" x1="16" x2="224" y1="128" y2="128" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#ff1768" />
            <stop offset="24%" stopColor="#ff6a1a" />
            <stop offset="50%" stopColor="#ffd60a" />
            <stop offset="74%" stopColor="#19d37b" />
            <stop offset="100%" stopColor="#0aa6a6" />
          </linearGradient>
          <filter id="market-gauge-glow" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <path d="M 24 122 A 96 96 0 0 1 216 122" fill="none" stroke="#1e293b" strokeWidth="18" strokeLinecap="round" />
        <path d="M 24 122 A 96 96 0 0 1 216 122" fill="none" stroke="url(#market-gauge-gradient)" strokeWidth="18" strokeLinecap="round" filter="url(#market-gauge-glow)" />
        <g style={{ transformOrigin: '120px 122px', transform: `rotate(${angle}deg)` }}>
          <line x1="120" y1="122" x2="120" y2="39" stroke="#ffd60a" strokeWidth="3.5" strokeLinecap="round" />
          <circle cx="120" cy="122" r="8" fill="#ffd60a" stroke="#fff3a3" strokeWidth="3" />
        </g>
      </svg>
      <div className="absolute inset-x-0 bottom-[2%] text-center">
        <div className={`font-['Space_Grotesk'] text-6xl font-bold leading-none tabular-nums drop-shadow-[0_0_20px_rgba(250,204,21,0.45)] ${moodColor(score)}`}>
          {score}
        </div>
        <div className={`mt-2 text-lg font-bold ${moodColor(score)}`}>{moodLabel(score)}</div>
      </div>
    </div>
  )
}

function FactorTile({ group }: { group: FactorGroup }) {
  const Icon = group.Icon
  const hasData = group.status !== 'missing'
  const barWidth = hasData ? Math.max(4, Math.min(100, group.appetiteScore)) : 7
  const headline = group.missingReason ? `缺資料：${group.missingReason}` : group.detail

  return (
    <div className={`rounded-2xl border p-4 ${STATUS_STYLE[group.status]}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className="h-4 w-4 shrink-0 opacity-85" />
          <span className="truncate text-sm font-medium text-slate-300">{group.label}</span>
        </div>
        <span className="rounded-full border border-current/20 px-2 py-0.5 font-mono text-[10px] opacity-80">
          {readableStatus(group.status)}
        </span>
      </div>
      <div className="mt-3 flex items-end gap-2">
        <div className={`font-['Space_Grotesk'] text-4xl font-bold leading-none tabular-nums ${hasData ? moodColor(group.appetiteScore) : 'text-slate-400'}`}>
          {hasData ? group.appetiteScore : '--'}
        </div>
        <div className="mb-1 min-w-0 truncate text-xs text-slate-500" title={group.value}>
          {group.value}
        </div>
      </div>
      <div className="mt-4 h-2 overflow-hidden rounded-full bg-black/30">
        <div className={`h-full rounded-full bg-gradient-to-r ${BAR_STYLE[group.status]}`} style={{ width: `${barWidth}%` }} />
      </div>
      <div className="mt-3 text-xs leading-5 text-slate-400" title={headline}>
        {headline}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 font-mono text-[10px] text-slate-500">
        <span className="truncate" title={group.source}>{group.source}</span>
        <span className="shrink-0">risk {group.riskScore}</span>
      </div>
      {group.evidenceTitle && group.evidenceUrl ? (
        <a
          href={group.evidenceUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-3 block truncate rounded-lg border border-current/15 bg-black/15 px-2 py-1 text-xs text-cyan-100 underline-offset-2 hover:underline"
          title={group.evidenceTitle}
        >
          {group.evidenceTitle}
        </a>
      ) : null}
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
      <div className="flex h-72 items-center justify-center rounded-3xl border border-border bg-card text-sm text-muted-foreground">
        <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
        載入市場恐慌貪婪指數...
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-3xl border border-amber-500/25 bg-amber-500/[0.05] p-5 text-sm">
        <p className="font-semibold text-amber-200">市場判讀 API 載入失敗</p>
        <p className="mt-1 text-xs text-muted-foreground">請到 OBS/Data Quality 檢查 market_risk 與 market_regime_state。</p>
        <p className="mt-2 font-mono text-[10px] text-muted-foreground/70">source=market/risk status=degraded</p>
      </div>
    )
  }

  if (!risk) return null

  const rawRiskScore = finiteNumber(risk.factorPacket?.score ?? risk.riskScore) ?? 50
  const appetiteScore = riskToAppetite(rawRiskScore)
  const packetGeneratedAt = risk.factorPacket?.generated_at ?? risk.calculatedAt
  const sourceDate = risk.regimeState?.runDate ?? risk.date
  const missingCount = groups.filter((group) => group.status === 'missing').length

  return (
    <section className="overflow-hidden rounded-[2rem] border border-slate-700/60 bg-[radial-gradient(circle_at_16%_18%,rgba(255,23,104,0.14),transparent_27%),radial-gradient(circle_at_86%_22%,rgba(20,184,166,0.14),transparent_30%),linear-gradient(145deg,#10151d,#090d14_62%,#070a10)] p-5 shadow-[0_24px_80px_rgba(0,0,0,0.35)]">
      <div className="grid gap-6 xl:grid-cols-[minmax(340px,0.9fr)_minmax(0,1.1fr)] xl:items-center">
        <div className="rounded-[1.6rem] border border-white/8 bg-black/20 p-5 shadow-inner shadow-black/30">
          <div className="text-center">
            <p className="text-[11px] font-semibold tracking-[0.24em] text-slate-500">MARKET COMPOSITE</p>
            <h2 className="mt-2 text-2xl font-bold tracking-wide text-slate-100">台灣市場恐慌貪婪指數</h2>
            <p className="mt-2 text-xs text-slate-500">
              每日 22:00 chain 後更新 · 整合 6 大市場指標
            </p>
          </div>
          <MarketGauge score={appetiteScore} />
          <div className="mt-2 text-center text-xs text-slate-500">
            {sourceDate} · risk {Math.round(rawRiskScore)}/100 · generated {formatTwDateTimeShort(packetGeneratedAt)}
          </div>
          <div className="mt-5 border-t border-white/8 pt-4">
            <div className="grid grid-cols-5 gap-2">
              {MOOD_MARKS.map((mark) => (
                <div key={mark.label} className="text-center">
                  <div className={`mx-auto h-2 w-2 rounded-full ${mark.color}`} />
                  <div className="mt-2 text-[11px] text-slate-500">{mark.label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold tracking-[0.22em] text-cyan-300/80">指標細項</p>
              <p className="mt-1 text-sm text-slate-400">{marketSummary(risk, groups)}</p>
            </div>
            <div className="flex flex-wrap gap-2 font-mono text-[10px] text-slate-500">
              <span className="rounded-full border border-slate-600/70 px-2 py-1">policy={risk.factorPacket?.schema_version ?? 'legacy-market-risk'}</span>
              {missingCount > 0 ? <span className="rounded-full border border-amber-500/40 px-2 py-1 text-amber-200">missing {missingCount}</span> : null}
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {groups.map((group) => <FactorTile key={group.id} group={group} />)}
          </div>
          <div className="mt-4 rounded-2xl border border-slate-700/60 bg-black/20 p-3 text-xs leading-5 text-slate-400">
            <AlertTriangle className="mr-2 inline h-3.5 w-3.5 text-amber-300" />
            分數方向：後端仍保存 risk score；本圖轉成 fear/greed score = 100 - risk score，避免把高風險誤讀成高貪婪。
          </div>
        </div>
      </div>
    </section>
  )
}
