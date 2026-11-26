import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Globe2,
  Landmark,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
  Waves,
} from 'lucide-react'
import { marketApi } from '@/lib/api'
import { formatTwDateTimeShort } from '@/lib/twTime'
import { safeExternalUrl } from '@/lib/safeUrl'
import { DataState } from '@/components/ui/data-state'
import { StatusIcon } from '@/components/ui/status'
import { STATUS_CHIP, TW_COLORS, type StatusTone } from '@/lib/colorTokens'
import { formatDate, formatNumber } from '@/lib/format'
import { humanSource, humanStatus, looksInternal } from '@/lib/humanLabels'
import { marketRiskLevelStyle, normalizeMarketRiskLevel, tradingMarketRisk, type MarketRiskLevel } from '@/lib/marketRiskLevel'

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
  riskScore: number | null
  riskLevel: MarketRiskLevel | null
  riskSummary: string
  calculatedAt: string
  marketOutlook?: {
    schema_version: string
    index: string
    horizon_trading_days: number
    base_price: number | null
    ma20: number | null
    optimistic_target: number | null
    upside_pct: number | null
    confidence: 'low' | 'medium' | 'high'
    target_basis: string
    summary: string
    missing_reasons?: string[]
  } | null
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

const STATUS_TONE: Record<FactorStatus, StatusTone> = {
  ok: 'ok',
  info: 'ok',
  warn: 'warn',
  error: 'fail',
  missing: 'na',
}

const STATUS_LABEL: Record<FactorStatus, string> = {
  ok: '正常',
  info: '參考',
  warn: '注意',
  error: '風險',
  missing: '缺資料',
}

const GROUPS = [
  {
    id: 'trend_volatility',
    label: '趨勢 / 波動',
    factorIds: ['price_trend', 'volatility'],
    sourceHint: '加權指數 20MA 乖離、VIX、20 日波動',
    Icon: Waves,
  },
  {
    id: 'business_cycle',
    label: '景氣對策燈號',
    // Packets written before 2026-11 keyed this factor as 'breadth'.
    factorIds: ['business_cycle', 'breadth'],
    sourceHint: '國發會景氣指標（FinLab）',
    Icon: Landmark,
  },
  {
    id: 'chips',
    label: '三大法人',
    factorIds: ['chips'],
    sourceHint: '外資、投信、自營商 5 日金額',
    Icon: TrendingDown,
  },
  {
    id: 'leverage',
    label: '融資融券',
    factorIds: ['leverage'],
    sourceHint: '融資餘額與融券餘額',
    Icon: Activity,
  },
  {
    id: 'macro_global',
    label: '總經 / 全球',
    factorIds: ['macro', 'global', 'global_risk'],
    sourceHint: '總經流動性與全球風險',
    Icon: Globe2,
  },
  {
    id: 'event_pressure',
    label: '全球事件',
    factorIds: ['event_monitors', 'lppls', 'hawkes'],
    sourceHint: 'LPPLS／Hawkes 泡沫與連鎖事件監控',
    Icon: AlertTriangle,
  },
] as const

function cleanValue(value?: string | number | null) {
  const text = String(value ?? '').trim()
  if (!text || /^n\/a$/i.test(text) || /^context( missing)?$/i.test(text)) return 'n/a'
  return text
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
  return dates.length ? dates[dates.length - 1] : null
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
    const details = uniqueText(matched.map((factor) => factor.detail)).slice(0, 3)
    const missingReasons = uniqueText(matched.map((factor) => factor.missing_reason))

    return {
      id: group.id,
      label: group.label,
      value: buildGroupValue(group.id, matched),
      status,
      source: sources.length ? sources.join(' + ') : group.sourceHint,
      sourceDate: latestSourceDate(matched),
      detail: details.filter((detail) => !looksInternal(detail)).join(' / ') || group.sourceHint,
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
      value: 'n/a',
      status: 'missing',
      source: 'market_risk.twii_bias',
      detail: `TWII close ${risk.twiiClose ?? 'n/a'}`,
      missing_reason: 'market_regime_factor_packet_missing',
    },
  ]
}

// Single-colour arc in the level's status tone; the five level names sit under it as text.
function MarketFearGauge({ score, cfg }: { score: number | null; cfg: { label: string; color: string; tone: StatusTone } }) {
  const safeScore = score == null ? null : Math.max(0, Math.min(100, score))
  const angle = Math.PI + ((safeScore ?? 0) / 100) * Math.PI
  const needleX = 120 + Math.cos(angle) * 76
  const needleY = 120 + Math.sin(angle) * 76
  const stroke = cfg.tone === 'na' ? TW_COLORS.neutral : TW_COLORS[cfg.tone]
  return (
    <div className="rounded-xl border border-white/10 bg-black/20 p-4 text-center">
      <div className="text-[10px] font-semibold text-muted-foreground">市場風險綜合分數</div>
      <svg viewBox="0 0 240 150" className="mx-auto mt-2 h-32 w-full max-w-[260px] overflow-visible">
        <path d="M30 120 A90 90 0 0 1 210 120" fill="none" stroke="rgba(148,163,184,.18)" strokeWidth="18" strokeLinecap="round" />
        {safeScore != null && (
          <path d="M30 120 A90 90 0 0 1 210 120" fill="none" stroke={stroke} strokeWidth="18" strokeLinecap="round" pathLength="100" strokeDasharray={`${safeScore} 100`} />
        )}
        {safeScore != null && <line x1="120" y1="120" x2={needleX} y2={needleY} stroke="#e2e8f0" strokeWidth="3" strokeLinecap="round" />}
        <circle cx="120" cy="120" r="7" fill="#e2e8f0" />
      </svg>
      <div className={`-mt-8 text-4xl font-bold tabular-nums ${cfg.color}`}>{safeScore == null ? '—' : Math.round(safeScore)}</div>
      <div className={`mt-1 inline-flex items-center gap-1 text-sm font-semibold ${cfg.color}`}><StatusIcon tone={cfg.tone} size={12} />{cfg.label}</div>
      <div className="mt-4 grid grid-cols-5 gap-1 text-[10px] text-muted-foreground">
        {['貪婪', '中性', '偏熱', '恐慌', '極恐慌'].map((label) => (
          <span key={label} className={label === cfg.label || (label === '極恐慌' && cfg.label === '極度恐慌') ? cfg.color : undefined}>{label}</span>
        ))}
      </div>
    </div>
  )
}

function FactorCard({ group }: { group: FactorGroup }) {
  const Icon = group.Icon
  const sourceUrl = safeExternalUrl(group.source)
  const tone = STATUS_TONE[group.status]
  return (
    <div className="rounded-lg border border-white/[0.08] bg-white/[0.03] p-3 text-slate-100">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-semibold">{group.label}</span>
        </div>
        <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] ${STATUS_CHIP[tone]}`}>
          <StatusIcon tone={tone} size={10} />
          {STATUS_LABEL[group.status]}
        </span>
      </div>
      <div className="mt-3 break-words sv-num text-base font-semibold leading-6 tabular-nums">{group.value}</div>
      <div className="mt-2 text-[11px] leading-5 text-muted-foreground" title={group.missingReason}>
        {group.missingReason ? '缺資料' : group.detail}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 sv-num text-[10px] text-muted-foreground">
        {sourceUrl ? (
          <a className="truncate text-sky-300 hover:text-sky-200" href={sourceUrl} target="_blank" rel="noopener noreferrer">
            來源連結
          </a>
        ) : (
          <span className="truncate" title={group.source}>{humanSource(group.source, '系統資料')}</span>
        )}
        {group.sourceDate ? <span className="shrink-0">{formatDate(group.sourceDate)}</span> : null}
      </div>
    </div>
  )
}

function fmtIndex(value: number | null | undefined) {
  return value == null || !Number.isFinite(Number(value))
    ? 'n/a'
    : formatNumber(Number(value), 2)
}

function MarketOutlookCard({ outlook }: { outlook: NonNullable<MarketRisk['marketOutlook']> }) {
  const target = fmtIndex(outlook.optimistic_target)
  const base = fmtIndex(outlook.base_price)
  const upside = outlook.upside_pct == null ? 'n/a' : `▲ +${formatNumber(Number(outlook.upside_pct), 2)}%`
  const missing = outlook.missing_reasons?.length ? outlook.missing_reasons.join(' / ') : null
  return (
    <div className="mt-4 rounded-lg border border-sky-400/25 bg-sky-400/[0.07] p-3 text-sky-100">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4" />
          <span className="text-sm font-semibold">TWII Optimistic Target</span>
        </div>
        <span className="rounded-full border border-current/25 px-2 py-0.5 text-[10px] normal-case">
          {outlook.confidence}
        </span>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <div>
          <div className="text-[10px] normal-case text-muted-foreground">Base</div>
          <div className="sv-num text-base font-semibold tabular-nums">{base}</div>
        </div>
        <div>
          <div className="text-[10px] normal-case text-muted-foreground">Optimistic</div>
          <div className="sv-num text-base font-semibold tabular-nums">{target}</div>
        </div>
        <div>
          <div className="text-[10px] normal-case text-muted-foreground">{outlook.horizon_trading_days}D Upside</div>
          <div className="sv-num text-base font-semibold tabular-nums text-up">{upside}</div>
        </div>
      </div>
      <div className="mt-2 text-[11px] leading-5 text-muted-foreground" title={missing ?? outlook.target_basis}>
        {missing ? '部分資料缺漏' : looksInternal(outlook.target_basis) ? '依 20MA 與近期波動推估' : outlook.target_basis}
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
    return <DataState kind="loading" title="載入市場判讀" minHeight={144} />
  }

  if (error) {
    return <DataState kind="error" title="市場判讀暫時讀不到" code={error} />
  }

  if (!risk) return null

  // Header and gauge show the level Paper trades on; the factor packet level is shown as a labelled reference.
  const trading = tradingMarketRisk(risk)
  const cfg = trading.style
  const packetLevel = normalizeMarketRiskLevel(risk.factorPacket?.level ?? risk.riskLevel)
  const packetCfg = marketRiskLevelStyle(packetLevel)
  const rawPacketScore = risk.factorPacket?.score ?? risk.riskScore
  const packetScore = packetLevel && rawPacketScore != null ? Number(rawPacketScore) : NaN
  const packetGeneratedAt = risk.factorPacket?.generated_at ?? risk.calculatedAt
  const missingCount = groups.filter((group) => group.status === 'missing').length

  return (
    <div className={`rounded-xl border ${cfg.border} ${cfg.bg} p-5`}>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,7fr)_minmax(260px,3fr)]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <ShieldCheck className={`h-4 w-4 ${cfg.color}`} />
            <span className="text-xs font-semibold normal-case text-muted-foreground">今日市場判讀</span>
            {missingCount > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full border border-slate-500/30 px-2 py-0.5 text-[10px] text-slate-300">
                <StatusIcon tone="na" size={10} />
                缺 {missingCount} 項
              </span>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-end gap-3">
            <div
              className={`inline-flex items-center gap-1.5 text-2xl font-bold ${cfg.color}`}
              title={trading.blockers.length ? `交易狀態 ${humanStatus(trading.status)}；阻擋原因 ${trading.blockers.slice(0, 4).join(', ')}` : `交易狀態 ${humanStatus(trading.status)}`}
            >
              <StatusIcon tone={cfg.tone} size={16} />
              {trading.label}
            </div>
            <div className="sv-num text-xs text-muted-foreground">資料日 {formatDate(risk.regimeState?.runDate ?? risk.date)}</div>
            <div className="sv-num text-xs text-muted-foreground">產生 {formatTwDateTimeShort(packetGeneratedAt)}</div>
            <div className={`sv-num text-xs ${packetCfg.color}`}>因子封包 {packetCfg.label}{Number.isFinite(packetScore) ? ` ${Math.round(packetScore)}` : ''}</div>
          </div>
          {risk.marketOutlook && <MarketOutlookCard outlook={risk.marketOutlook} />}
          <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {groups.map((group) => (
              <FactorCard key={group.id} group={group} />
            ))}
          </div>
        </div>
        <MarketFearGauge score={trading.score} cfg={{ label: trading.label, color: cfg.color, tone: cfg.tone }} />
      </div>
    </div>
  )
}
