import {
  Activity,
  Landmark,
  Layers3,
} from 'lucide-react'

type Tone = 'cyan' | 'emerald' | 'amber' | 'rose' | 'violet' | 'slate'

type Metric = {
  label: string
  value: string
  note: string
  tone: Tone
  intensity: number
}

type Segment = {
  label: string
  value: number
  tone: Tone
}

type BreakdownCard = {
  title: string
  subtitle: string
  source: string
  status: string
  score: number
  tone: Tone
  Icon: typeof Activity
  metrics: Metric[]
  segments: Segment[]
  preview: boolean
  layout?: 'standard' | 'wide'
}

type FuturesInstitutionalRow = {
  id?: string
  label?: string
  category?: string
  netTradeLots?: number | null
  netOiLots?: number | null
  netTradeAmountK?: number | null
  netOiAmountK?: number | null
}

const TONE_TEXT: Record<Tone, string> = {
  cyan: 'text-cyan-200',
  emerald: 'text-emerald-300',
  amber: 'text-amber-300',
  rose: 'text-rose-300',
  violet: 'text-violet-300',
  slate: 'text-slate-300',
}

const TONE_BAR: Record<Tone, string> = {
  cyan: 'bg-cyan-400',
  emerald: 'bg-emerald-400',
  amber: 'bg-amber-300',
  rose: 'bg-rose-400',
  violet: 'bg-violet-400',
  slate: 'bg-slate-500',
}

const TONE_BORDER: Record<Tone, string> = {
  cyan: 'border-cyan-300/20 bg-cyan-400/[0.055]',
  emerald: 'border-emerald-300/20 bg-emerald-400/[0.055]',
  amber: 'border-amber-300/20 bg-amber-400/[0.055]',
  rose: 'border-rose-300/20 bg-rose-400/[0.055]',
  violet: 'border-violet-300/20 bg-violet-400/[0.055]',
  slate: 'border-white/[0.07] bg-white/[0.035]',
}

function asNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function clamp(value: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value))
}

function compact(value: number | null, digits = 1) {
  if (value == null) return '待接資料'
  const abs = Math.abs(value)
  if (abs >= 1_000_000_000_000) return `${(value / 1_000_000_000_000).toFixed(digits)} 兆`
  if (abs >= 100_000_000) return `${(value / 100_000_000).toFixed(digits)} 億`
  if (abs >= 10_000) return `${(value / 10_000).toFixed(digits)} 萬`
  return value.toLocaleString('zh-TW', { maximumFractionDigits: digits })
}

function signed(value: number | null, suffix = '', digits = 1) {
  if (value == null) return '待接資料'
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}${suffix}`
}

function futuresBreakdownRows(regime: any, fallback: {
  netTradeLots: number
  netOiLots: number
  netOiAmountK: number
}): FuturesInstitutionalRow[] {
  const rows = Array.isArray(regime?.futuresInstitutionalBreakdown)
    ? regime.futuresInstitutionalBreakdown
    : []
  const normalized = rows
    .map((row: any) => ({
      id: String(row?.id ?? '').trim(),
      label: String(row?.label ?? row?.category ?? '').trim(),
      category: String(row?.category ?? '').trim(),
      netTradeLots: asNumber(row?.netTradeLots),
      netOiLots: asNumber(row?.netOiLots),
      netTradeAmountK: asNumber(row?.netTradeAmountK),
      netOiAmountK: asNumber(row?.netOiAmountK),
    }))
    .filter((row) => row.label)
  if (normalized.length) return normalized
  return [{
    id: 'total',
    label: '合計',
    category: 'legacy aggregate',
    netTradeLots: fallback.netTradeLots,
    netOiLots: fallback.netOiLots,
    netOiAmountK: fallback.netOiAmountK,
  }]
}

function participantTone(value: number | null | undefined): Tone {
  const n = asNumber(value)
  if (n == null) return 'slate'
  return n >= 0 ? 'emerald' : 'rose'
}

function participantLabel(row: FuturesInstitutionalRow) {
  const label = String(row.label ?? row.id ?? '').trim()
  if (label.includes('外資')) return '外資'
  if (label.includes('投信')) return '投信'
  if (label.includes('自營')) return '自營商'
  if (label.includes('合計') || row.id === 'total') return '合計'
  return label || '法人'
}

function majorInstitutionRows(rows: FuturesInstitutionalRow[]) {
  const order = ['自營商', '投信', '外資']
  const selected = order
    .map((label) => rows.find((row) => participantLabel(row) === label))
    .filter((row): row is FuturesInstitutionalRow => Boolean(row))
  return selected.length ? selected : rows
}

function realOrPreview<T>(value: T | null | undefined, preview: T): { value: T; preview: boolean } {
  return value == null ? { value: preview, preview: true } : { value, preview: false }
}

function DetailPill({ children, tone = 'slate' }: { children: string; tone?: Tone }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold ${TONE_BORDER[tone]} ${TONE_TEXT[tone]}`}>
      {children}
    </span>
  )
}

function SegmentBar({ segments }: { segments: Segment[] }) {
  const total = segments.reduce((sum, item) => sum + Math.max(0, item.value), 0) || 1
  return (
    <div>
      <div className="flex h-2 overflow-hidden rounded-full bg-white/[0.07]">
        {segments.map((segment) => (
          <span
            key={segment.label}
            className={TONE_BAR[segment.tone]}
            style={{ width: `${Math.max(5, (Math.max(0, segment.value) / total) * 100)}%` }}
          />
        ))}
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2">
        {segments.slice(0, 3).map((segment) => (
          <div key={segment.label} className="min-w-0">
            <div className="truncate text-[10px] font-semibold text-slate-500">{segment.label}</div>
            <div className={`mt-0.5 text-xs font-bold tabular-nums ${TONE_TEXT[segment.tone]}`}>{Math.round(segment.value)}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function MetricRow({ metric }: { metric: Metric }) {
  return (
    <div className={`rounded-[14px] border px-3 py-3 ${TONE_BORDER[metric.tone]}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[11px] font-semibold text-slate-500">{metric.label}</div>
          <div className={`mt-1 text-base font-bold leading-none tabular-nums ${TONE_TEXT[metric.tone]}`}>{metric.value}</div>
        </div>
        <div className="h-8 w-16 pt-1">
          <div className="h-1.5 overflow-hidden rounded-full bg-black/30">
            <div
              className={`h-full rounded-full ${TONE_BAR[metric.tone]}`}
              style={{ width: `${clamp(metric.intensity)}%` }}
            />
          </div>
        </div>
      </div>
      <div className="mt-2 text-[11px] leading-4 text-slate-500">{metric.note}</div>
    </div>
  )
}

function ScoreDial({ score, tone, status }: { score: number; tone: Tone; status: string }) {
  const marker = clamp(score)
  const color = tone === 'rose'
    ? '#fb7185'
    : tone === 'amber'
      ? '#fbbf24'
      : tone === 'emerald'
        ? '#34d399'
        : tone === 'violet'
          ? '#a78bfa'
          : '#22d3ee'
  return (
    <div className="grid h-[92px] w-[92px] place-items-center rounded-full border border-white/[0.08] bg-black/25">
      <div
        className="grid h-[76px] w-[76px] place-items-center rounded-full"
        style={{ background: `conic-gradient(${color} ${marker * 3.6}deg, rgba(255,255,255,.08) 0deg)` }}
      >
        <div className="grid h-[58px] w-[58px] place-items-center rounded-full bg-[#101116] text-center">
          <div className={`text-xl font-bold leading-none tabular-nums ${TONE_TEXT[tone]}`}>{Math.round(score)}</div>
          <div className="mt-0.5 text-[10px] font-semibold text-slate-500">{status}</div>
        </div>
      </div>
    </div>
  )
}

function BreakdownCardView({ card }: { card: BreakdownCard }) {
  const Icon = card.Icon
  const wide = card.layout === 'wide'
  return (
    <article className={`overflow-hidden rounded-[18px] border border-white/[0.08] bg-[linear-gradient(180deg,rgba(20,22,30,0.96),rgba(13,15,22,0.98))] ${wide ? 'xl:col-span-3' : ''}`}>
      <div className={`h-1.5 ${TONE_BAR[card.tone]}`} />
      <div className="p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <span className={`rounded-[12px] border p-2 ${TONE_BORDER[card.tone]}`}>
              <Icon className={`h-4 w-4 ${TONE_TEXT[card.tone]}`} />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="truncate text-sm font-bold text-slate-100">{card.title}</h3>
                {card.preview && <DetailPill tone="amber">預覽</DetailPill>}
              </div>
              <p className="mt-1 text-xs leading-5 text-slate-500">{card.subtitle}</p>
            </div>
          </div>
          <ScoreDial score={card.score} tone={card.tone} status={card.status} />
        </div>

        {wide ? (
          <div className="mt-4 grid gap-4 xl:grid-cols-[240px_minmax(0,1fr)]">
            <div className="rounded-[14px] border border-white/[0.07] bg-black/20 p-3">
              <SegmentBar segments={card.segments} />
              <p className="mt-3 text-xs leading-5 text-slate-500">
                三大法人分開看；交易淨口偏短線，未平倉偏隔日風險。
              </p>
            </div>
            <div className="grid gap-3 lg:grid-cols-3">
              {card.metrics.map((metric) => (
                <MetricRow key={metric.label} metric={metric} />
              ))}
            </div>
          </div>
        ) : (
          <>
            <div className="mt-4">
              <SegmentBar segments={card.segments} />
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {card.metrics.map((metric) => (
                <MetricRow key={metric.label} metric={metric} />
              ))}
            </div>
          </>
        )}

        <div className="mt-4 flex items-center justify-between gap-3 border-t border-white/[0.06] pt-3">
          <span className="truncate text-[11px] text-slate-500">{card.source}</span>
          <span className={`text-[11px] font-semibold ${TONE_TEXT[card.tone]}`}>canonical signal</span>
        </div>
      </div>
    </article>
  )
}

function buildCards(risk: any): BreakdownCard[] {
  const dataDepth = risk?.marketRiskDetail ?? risk?.finlabDataDepth ?? {}
  const regime = dataDepth.regime ?? {}

  const futuresNetOi = realOrPreview(asNumber(regime.futuresInstNetOiLots), -4_520)
  const futuresNetTrade = realOrPreview(asNumber(regime.futuresInstNetTradeLots), 1_860)
  const futuresNetAmount = realOrPreview(asNumber(regime.futuresInstNetOiAmountK), -12_800_000)
  const worldAdjMove = realOrPreview(asNumber(regime.worldAdjCloseChangePct), 0.42)
  const futuresRows = futuresBreakdownRows(regime, {
    netTradeLots: futuresNetTrade.value,
    netOiLots: futuresNetOi.value,
    netOiAmountK: futuresNetAmount.value,
  })
  const displayedFuturesRows = majorInstitutionRows(futuresRows)
  const futuresSegments = displayedFuturesRows.slice(0, 3).map((row) => {
    const netOi = asNumber(row.netOiLots) ?? 0
    return {
      label: participantLabel(row),
      value: Math.max(12, Math.abs(netOi) / 150),
      tone: participantTone(netOi),
    }
  })
  const futuresMetrics: Metric[] = displayedFuturesRows.flatMap((row) => {
    const label = participantLabel(row)
    const netOi = asNumber(row.netOiLots)
    const netTrade = asNumber(row.netTradeLots)
    const netAmountK = asNumber(row.netOiAmountK)
    return [
      {
        label: `${label}未平倉`,
        value: signed(netOi, ' 口', 0),
        note: '台指期貨淨未平倉口數。',
        tone: participantTone(netOi),
        intensity: clamp(Math.abs(netOi ?? 0) / 800),
      },
      {
        label: `${label}交易淨口`,
        value: signed(netTrade, ' 口', 0),
        note: '當日台指期貨交易淨口數。',
        tone: participantTone(netTrade),
        intensity: clamp(Math.abs(netTrade ?? 0) / 220),
      },
      {
        label: `${label}未平倉淨額`,
        value: compact((netAmountK ?? 0) * 1000),
        note: '台指期貨未平倉淨額。',
        tone: participantTone(netAmountK),
        intensity: clamp(Math.abs(netAmountK ?? 0) / 120_000),
      },
    ]
  })

  const regimePreview = futuresNetOi.preview || futuresNetTrade.preview || futuresNetAmount.preview || worldAdjMove.preview

  return [
    {
      title: '期貨與全球風險',
      subtitle: '保留三大法人拆解；未平倉看隔日風險，交易淨口看當日方向。',
      source: regime.source ?? 'canonical_regime_context_daily',
      status: futuresNetOi.value >= 0 ? '偏多' : '避險',
      score: clamp(50 - Math.min(22, Math.abs(futuresNetOi.value) / 420) + (worldAdjMove.value + 1) * 8),
      tone: futuresNetOi.value < 0 ? 'rose' : worldAdjMove.value >= 0 ? 'violet' : 'amber',
      Icon: Landmark,
      preview: regimePreview,
      layout: 'wide',
      segments: futuresSegments.length ? futuresSegments : [
        { label: '自營商', value: 12, tone: 'slate' },
        { label: '投信', value: 12, tone: 'slate' },
        { label: '外資', value: 12, tone: 'slate' },
      ],
      metrics: [
        ...futuresMetrics,
        {
          label: '海外均值變動',
          value: signed(worldAdjMove.value, '%'),
          note: '海外指數輔助情境，不是台股主訊號。',
          tone: worldAdjMove.value >= 0 ? 'cyan' : 'amber',
          intensity: clamp(Math.abs(worldAdjMove.value) * 55),
        },
      ],
    },
  ]
}

export function MarketRiskDetailBreakdown({ risk }: { risk: any }) {
  const cards = buildCards(risk)
  const date = String(risk?.date ?? risk?.marketStats?.date ?? 'latest').slice(0, 10)
  const hasPreview = cards.some((card) => card.preview)

  return (
    <section className="rounded-[20px] border border-white/[0.07] bg-[#0d1017] p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <Layers3 className="h-4 w-4 shrink-0 text-cyan-200" />
          <h2 className="truncate text-sm font-bold text-slate-100">細部風險分解</h2>
          <DetailPill tone="slate">{date}</DetailPill>
          {hasPreview && <DetailPill tone="amber">local preview</DetailPill>}
        </div>
        <div className="flex flex-wrap gap-2">
          <DetailPill tone="violet">期貨總覽</DetailPill>
          <DetailPill tone="emerald">法人拆解</DetailPill>
          <DetailPill tone="cyan">海外情境</DetailPill>
        </div>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        {cards.map((card) => (
          <BreakdownCardView key={card.title} card={card} />
        ))}
      </div>
    </section>
  )
}
