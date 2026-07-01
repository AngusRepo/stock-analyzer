import { Landmark } from 'lucide-react'

type Tone = 'cyan' | 'emerald' | 'amber' | 'rose' | 'violet' | 'slate'

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

function realOrPreview<T>(value: T | null | undefined, preview: T): { value: T; preview: boolean } {
  return value == null ? { value: preview, preview: true } : { value, preview: false }
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

function futuresBreakdownRows(regime: any, fallback: {
  labels: string[]
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
  return fallback.labels.map((label) => ({
    id: label,
    label,
    category: 'pending',
    netTradeLots: null,
    netOiLots: null,
    netOiAmountK: null,
  }))
}

function majorInstitutionRows(rows: FuturesInstitutionalRow[]) {
  const order = ['自營商', '投信', '外資']
  const selected = order
    .map((label) => rows.find((row) => participantLabel(row) === label))
    .filter((row): row is FuturesInstitutionalRow => Boolean(row))
  return selected.length ? selected : rows
}

function DetailPill({ children, tone = 'slate' }: { children: string; tone?: Tone }) {
  return (
    <span className={`inline-flex min-w-0 items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold ${TONE_BORDER[tone]} ${TONE_TEXT[tone]}`}>
      <span className="truncate">{children}</span>
    </span>
  )
}

function FuturesOpenInterestBar({ rows }: { rows: FuturesInstitutionalRow[] }) {
  const segments = rows.map((row) => {
    const value = Math.abs(asNumber(row.netOiLots) ?? 0)
    return {
      label: participantLabel(row),
      value,
      tone: participantTone(row.netOiLots),
    }
  })
  const total = segments.reduce((sum, segment) => sum + segment.value, 0)

  return (
    <div className="rounded-[14px] border border-white/[0.055] bg-black/20 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-[11px] font-semibold text-slate-500">未平倉分布</span>
        <span className="text-[11px] text-slate-600">三大法人</span>
      </div>
      <div className="flex h-2.5 overflow-hidden rounded-full bg-white/[0.07]">
        {segments.map((segment) => (
          <span
            key={segment.label}
            className={TONE_BAR[segment.tone]}
            style={{ width: `${total > 0 ? Math.max(8, (segment.value / total) * 100) : 100 / Math.max(1, segments.length)}%` }}
          />
        ))}
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2">
        {segments.map((segment) => (
          <div key={segment.label} className="min-w-0">
            <div className="truncate text-[10px] font-semibold text-slate-500">{segment.label}</div>
            <div className={`mt-0.5 text-xs font-bold tabular-nums ${TONE_TEXT[segment.tone]}`}>
              {segment.value ? `${Math.round(segment.value).toLocaleString('zh-TW')} 口` : '待接資料'}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function FuturesMetricCell({
  label,
  value,
  tone,
  intensity,
}: {
  label: string
  value: string
  tone: Tone
  intensity: number
}) {
  return (
    <div className="min-w-0 rounded-[12px] border border-white/[0.055] bg-black/20 px-3 py-2">
      <div className="text-[10px] font-semibold text-slate-500 sm:hidden">{label}</div>
      <div className={`mt-1 break-words text-sm font-bold leading-tight tabular-nums sm:mt-0 ${TONE_TEXT[tone]}`}>{value}</div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/35">
        <div className={`h-full rounded-full ${TONE_BAR[tone]}`} style={{ width: `${clamp(intensity, 6)}%` }} />
      </div>
    </div>
  )
}

function FuturesInstitutionRow({ row }: { row: FuturesInstitutionalRow }) {
  const label = participantLabel(row)
  const netOi = asNumber(row.netOiLots)
  const netTrade = asNumber(row.netTradeLots)
  const netAmountK = asNumber(row.netOiAmountK)
  const dominant = netOi ?? netTrade ?? netAmountK
  const tone = participantTone(dominant)
  return (
    <div className={`grid min-w-0 gap-2 rounded-[16px] border p-3 ${TONE_BORDER[tone]} sm:grid-cols-[minmax(72px,0.72fr)_repeat(3,minmax(0,1fr))]`}>
      <div className="flex min-w-0 items-center gap-2 sm:block">
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${TONE_BAR[tone]}`} />
        <div className="min-w-0">
          <div className="truncate text-sm font-bold text-slate-100">{label}</div>
          <div className="mt-0.5 text-[10px] font-semibold text-slate-500">台指期貨</div>
        </div>
      </div>
      <FuturesMetricCell
        label="未平倉"
        value={signed(netOi, ' 口', 0)}
        tone={participantTone(netOi)}
        intensity={Math.abs(netOi ?? 0) / 800}
      />
      <FuturesMetricCell
        label="交易淨口"
        value={signed(netTrade, ' 口', 0)}
        tone={participantTone(netTrade)}
        intensity={Math.abs(netTrade ?? 0) / 220}
      />
      <FuturesMetricCell
        label="未平倉淨額"
        value={compact(netAmountK == null ? null : netAmountK * 1000)}
        tone={participantTone(netAmountK)}
        intensity={Math.abs(netAmountK ?? 0) / 120_000}
      />
    </div>
  )
}

function buildFuturesView(risk: any) {
  const dataDepth = risk?.marketRiskDetail ?? risk?.finlabDataDepth ?? {}
  const regime = dataDepth.regime ?? {}

  const futuresNetOi = realOrPreview(asNumber(regime.futuresInstNetOiLots), null)
  const futuresNetTrade = realOrPreview(asNumber(regime.futuresInstNetTradeLots), null)
  const futuresNetAmount = realOrPreview(asNumber(regime.futuresInstNetOiAmountK), null)
  const rows = majorInstitutionRows(futuresBreakdownRows(regime, {
    labels: ['自營商', '投信', '外資'],
  }))

  const hasRowData = rows.some((row) =>
    asNumber(row.netOiLots) != null ||
    asNumber(row.netTradeLots) != null ||
    asNumber(row.netOiAmountK) != null,
  )
  const totalNetOi = hasRowData ? rows.reduce((sum, row) => sum + (asNumber(row.netOiLots) ?? 0), 0) : null
  const totalNetTrade = hasRowData ? rows.reduce((sum, row) => sum + (asNumber(row.netTradeLots) ?? 0), 0) : null
  const totalNetAmountK = hasRowData ? rows.reduce((sum, row) => sum + (asNumber(row.netOiAmountK) ?? 0), 0) : null
  const preview = futuresNetOi.preview || futuresNetTrade.preview || futuresNetAmount.preview

  return {
    rows,
    source: regime.source ?? 'canonical_regime_context_daily',
    status: totalNetOi == null ? '待接資料' : totalNetOi >= 0 ? '偏多' : '避險',
    tone: participantTone(totalNetOi),
    preview,
    totalNetOi,
    totalNetTrade,
    totalNetAmountK,
  }
}

export function MarketRiskDetailBreakdown({ risk }: { risk: any }) {
  const view = buildFuturesView(risk)
  const date = String(risk?.date ?? risk?.marketStats?.date ?? 'latest').slice(0, 10)

  return (
    <section className="min-w-0 rounded-[20px] border border-white/[0.08] bg-[linear-gradient(180deg,rgba(20,22,30,0.96),rgba(13,15,22,0.98))]">
      <div className="p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span className={`rounded-[12px] border p-2 ${TONE_BORDER[view.tone]}`}>
              <Landmark className={`h-4 w-4 ${TONE_TEXT[view.tone]}`} />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-bold text-slate-100">期貨與全球風險</h2>
                <DetailPill tone="slate">{date}</DetailPill>
                {view.preview && <DetailPill tone="amber">local preview</DetailPill>}
              </div>
              <p className="mt-1 text-xs leading-5 text-slate-500">
                三大法人期貨拆解；未平倉看隔日風險，交易淨口看當日方向。
              </p>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 sm:flex sm:flex-wrap sm:justify-end">
            <DetailPill tone={view.tone}>{view.status}</DetailPill>
            <DetailPill tone={participantTone(view.totalNetOi)}>{signed(view.totalNetOi, ' 口', 0)}</DetailPill>
            <DetailPill tone={participantTone(view.totalNetTrade)}>{signed(view.totalNetTrade, ' 口', 0)}</DetailPill>
          </div>
        </div>

        <div className="mt-4">
          <FuturesOpenInterestBar rows={view.rows} />
        </div>

        <div className="mt-4 hidden grid-cols-[minmax(72px,0.72fr)_repeat(3,minmax(0,1fr))] gap-2 px-3 text-[11px] font-semibold text-slate-500 sm:grid">
          <span>法人</span>
          <span>未平倉</span>
          <span>交易淨口</span>
          <span>未平倉淨額</span>
        </div>

        <div className="mt-2 grid min-w-0 gap-2">
          {view.rows.map((row) => (
            <FuturesInstitutionRow key={`${participantLabel(row)}-${row.id ?? row.category ?? 'row'}`} row={row} />
          ))}
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.06] pt-3">
          <span className="min-w-0 break-words text-[11px] text-slate-500">{view.source}</span>
          <span className={`text-[11px] font-semibold ${TONE_TEXT[view.tone]}`}>canonical signal</span>
        </div>
      </div>
    </section>
  )
}
