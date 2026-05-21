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
  score: number
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

const LEVEL_CONFIG = {
  green: { label: '低風險', color: 'text-emerald-300', bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', bar: 'bg-emerald-400' },
  yellow: { label: '觀察', color: 'text-yellow-300', bg: 'bg-yellow-500/10', border: 'border-yellow-500/30', bar: 'bg-yellow-400' },
  orange: { label: '偏高', color: 'text-orange-300', bg: 'bg-orange-500/10', border: 'border-orange-500/30', bar: 'bg-orange-400' },
  red: { label: '高風險', color: 'text-red-300', bg: 'bg-red-500/10', border: 'border-red-500/30', bar: 'bg-red-400' },
  black: { label: '極端風險', color: 'text-zinc-200', bg: 'bg-zinc-700/50', border: 'border-zinc-400/40', bar: 'bg-zinc-300' },
}

const STATUS_STYLE: Record<FactorStatus, string> = {
  ok: 'border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-200',
  info: 'border-sky-400/25 bg-sky-400/[0.08] text-sky-200',
  warn: 'border-amber-400/30 bg-amber-400/[0.08] text-amber-200',
  error: 'border-red-400/30 bg-red-400/[0.08] text-red-200',
  missing: 'border-slate-500/30 bg-slate-500/[0.08] text-slate-300',
}

const GROUPS = [
  {
    id: 'trend_volatility',
    label: '趨勢 / 波動',
    factorIds: ['price_trend', 'volatility'],
    sourceHint: '20MA 乖離 + VIX/20日波動',
    Icon: Waves,
  },
  {
    id: 'breadth',
    label: '景氣燈號',
    factorIds: ['economy_light'],
    sourceHint: 'FinLab tw_business_indicators 景氣對策信號',
    Icon: BarChart3,
  },
  {
    id: 'chips',
    label: '籌碼',
    factorIds: ['chips'],
    sourceHint: 'canonical_chip_daily 5日法人金額',
    Icon: TrendingDown,
  },
  {
    id: 'leverage',
    label: '槓桿',
    factorIds: ['leverage'],
    sourceHint: '融資融券 / 借券壓力',
    Icon: Activity,
  },
  {
    id: 'macro_global',
    label: '總經 / 全球',
    factorIds: ['macro', 'global'],
    sourceHint: 'FinLab 景氣燈號、PMI/NMI、世界指數',
    Icon: Globe2,
  },
  {
    id: 'event_pressure',
    label: '事件鏈',
    factorIds: ['event_monitors', 'lppls', 'hawkes'],
    sourceHint: 'GDELT / 鉅亨 / 官方事件與 LPPLS/Hawkes 監控',
    Icon: AlertTriangle,
  },
] as const

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function cleanValue(value?: string | null) {
  const text = String(value ?? '').trim()
  if (!text || /^n\/a$/i.test(text) || /^context( missing)?$/i.test(text)) return '缺資料'
  return text
}

function readableStatus(status: FactorStatus) {
  if (status === 'ok') return '正常'
  if (status === 'info') return '中性'
  if (status === 'warn') return '注意'
  if (status === 'error') return '風險'
  return '缺資料'
}

function worstStatus(factors: MarketRiskFactor[]): FactorStatus {
  if (!factors.length) return 'missing'
  if (factors.some((factor) => factor.status === 'error')) return 'error'
  if (factors.some((factor) => factor.status === 'warn')) return 'warn'
  if (factors.every((factor) => factor.status === 'missing' || factor.missing_reason)) return 'missing'
  if (factors.some((factor) => factor.status === 'info')) return 'info'
  return 'ok'
}

function factorScore(factor: MarketRiskFactor) {
  const score = Number(factor.score)
  return Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 45
}

function factorContribution(factor: MarketRiskFactor) {
  const contribution = Number(factor.contribution)
  return Number.isFinite(contribution) ? contribution : factorScore(factor) * Number(factor.weight ?? 0)
}

function latestSourceDate(factors: MarketRiskFactor[]) {
  const sourceDates = factors.map((factor) => factor.source_date).filter(Boolean).sort()
  return sourceDates.length ? sourceDates[sourceDates.length - 1] ?? null : null
}

function buildGroupValue(groupId: string, factors: MarketRiskFactor[]) {
  const byId = new Map(factors.map((factor) => [factor.id, factor]))
  if (groupId === 'trend_volatility') {
    return `${cleanValue(byId.get('price_trend')?.value)} / ${cleanValue(byId.get('volatility')?.value)}`
  }
  if (groupId === 'macro_global') {
    const values = [byId.get('macro')?.value, byId.get('global')?.value, byId.get('global_risk')?.value]
      .map(cleanValue)
      .filter((value) => value !== '缺資料')
    return values.length ? values.join(' / ') : '缺資料'
  }
  if (groupId === 'event_pressure') {
    const value = cleanValue(byId.get('event_monitors')?.value ?? byId.get('lppls')?.value ?? byId.get('hawkes')?.value)
    return value
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
    const avgScore = matched.length
      ? matched.reduce((sum, factor) => sum + factorScore(factor), 0) / matched.length
      : 45
    const contribution = matched.reduce((sum, factor) => sum + factorContribution(factor), 0)
    const sources = matched.map((factor) => factor.source).filter(Boolean)
    const details = matched
      .map((factor) => factor.detail)
      .filter(Boolean)
      .slice(0, 2)
    const evidence = matched.find((factor) => factor.evidence_title || factor.evidence_url)

    return {
      id: group.id,
      label: group.label,
      value: buildGroupValue(group.id, matched),
      status,
      score: Math.round(avgScore),
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
      source: 'market_risk.twii_bias',
      detail: `TWII close ${risk.twiiClose ?? 'n/a'}`,
      missing_reason: 'market_regime_factor_packet_missing',
    },
  ]
}

function marketSummary(risk: MarketRisk, groups: FactorGroup[]) {
  const missing = groups.filter((group) => group.status === 'missing').map((group) => group.label)
  const pressure = [...groups].sort((a, b) => b.contribution - a.contribution)[0]
  const regime = risk.regimeState?.label ?? 'regime missing'
  const base = `${regime}，主要風險來源：${pressure?.label ?? '缺資料'}。`
  return missing.length ? `${base} 缺資料：${missing.join('、')}。` : base
}

function MiniBars({ factors }: { factors: MarketRiskFactor[] }) {
  const safe = factors.length ? factors : [{ id: 'missing', score: 0, status: 'missing' as FactorStatus }] as MarketRiskFactor[]
  return (
    <div className="mt-3 flex h-7 items-end gap-1" aria-label="factor mini bars">
      {safe.map((factor, index) => {
        const score = factorScore(factor)
        return (
          <div
            key={`${factor.id}:${index}`}
            className="flex-1 rounded-sm bg-current opacity-70"
            style={{ height: `${Math.max(4, (score / 100) * 28)}px` }}
            title={`${factor.label ?? factor.id}: ${score}`}
          />
        )
      })}
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
        載入市場判讀...
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.04] p-5 text-sm">
        <p className="font-semibold text-amber-200">市場判讀 API 載入失敗</p>
        <p className="mt-1 text-xs text-muted-foreground">請到 OBS/Data Quality 檢查 market_risk 與 market_regime_state。</p>
        <p className="mt-2 font-mono text-[10px] text-muted-foreground/70">source=market/risk status=degraded</p>
      </div>
    )
  }

  if (!risk) return null

  const cfg = LEVEL_CONFIG[risk.riskLevel] ?? LEVEL_CONFIG.green
  const packetGeneratedAt = risk.factorPacket?.generated_at ?? risk.calculatedAt
  const missingCount = groups.filter((group) => group.status === 'missing').length
  const score = isFiniteNumber(risk.riskScore) ? risk.riskScore : Number(risk.factorPacket?.score ?? 0)

  return (
    <div className="space-y-3">
      <div className={`rounded-lg border ${cfg.border} ${cfg.bg} p-5`}>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_220px]">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <ShieldCheck className={`h-4 w-4 ${cfg.color}`} />
              <span className="text-xs font-semibold text-muted-foreground">FinLab-style market regime packet</span>
              {missingCount > 0 && (
                <span className="rounded-full border border-slate-500/30 px-2 py-0.5 text-[10px] text-slate-300">
                  missing {missingCount}
                </span>
              )}
            </div>
            <div className={`mt-2 text-2xl font-bold ${cfg.color}`}>{cfg.label}</div>
            <p className="mt-2 text-sm leading-6 text-foreground/80">{marketSummary(risk, groups)}</p>
            <div className="mt-3 flex flex-wrap gap-2 font-mono text-[10px] text-muted-foreground">
              <span>run_date={risk.regimeState?.runDate ?? risk.date}</span>
              <span>policy={risk.factorPacket?.schema_version ?? 'legacy-market-risk'}</span>
              <span>generated={formatTwDateTimeShort(packetGeneratedAt)}</span>
            </div>
          </div>
          <div className="rounded-lg border border-black/20 bg-black/15 p-3 text-right">
            <div className="text-xs text-muted-foreground">大盤風險分數</div>
            <div className={`mt-1 text-4xl font-bold tabular-nums ${cfg.color}`}>
              {score}<span className="text-sm font-normal text-muted-foreground">/100</span>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted/30">
              <div className={`h-full rounded-full transition-all duration-700 ${cfg.bar}`} style={{ width: `${Math.max(0, Math.min(100, score))}%` }} />
            </div>
          </div>
        </div>

        <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {groups.map((group) => {
            const Icon = group.Icon
            return (
              <div key={group.id} className={`rounded-md border p-3 ${STATUS_STYLE[group.status]}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="truncate text-sm font-semibold">{group.label}</span>
                  </div>
                  <span className="shrink-0 rounded-full border border-current/25 px-2 py-0.5 text-[10px]">{readableStatus(group.status)}</span>
                </div>
                <div className="mt-3 font-mono text-lg font-semibold tabular-nums">{group.value}</div>
                <MiniBars factors={group.factors} />
                <div className="mt-3 flex items-center justify-between gap-2 font-mono text-[10px] text-muted-foreground">
                  <span className="truncate">{group.source}</span>
                  <span className="shrink-0">risk {group.score} / c{group.contribution.toFixed(1)}</span>
                </div>
                <div className="mt-1 text-[11px] leading-5 text-muted-foreground">
                  {group.missingReason ? `缺資料：${group.missingReason}` : group.detail}
                </div>
                {group.evidenceTitle && group.evidenceUrl ? (
                  <a
                    href={group.evidenceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 block truncate rounded border border-current/20 px-2 py-1 text-[11px] underline-offset-2 hover:underline"
                  >
                    {group.evidenceTitle}
                  </a>
                ) : null}
                {group.sourceDate ? <div className="mt-1 font-mono text-[10px] text-muted-foreground/70">source_date={group.sourceDate}</div> : null}
              </div>
            )
          })}
        </div>
      </div>

    </div>
  )
}
