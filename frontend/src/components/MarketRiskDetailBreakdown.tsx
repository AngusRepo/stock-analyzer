import { Landmark } from 'lucide-react'
import { StatusBadge } from '@/components/ui/status'
import { priceArrow } from '@/lib/colorTokens'
import { formatNumber, formatTwdCompact } from '@/lib/format'
import { humanSource } from '@/lib/humanLabels'

// up/down: signed lots and amounts (Taiwan convention, net long red). cyan/amber/violet: participant identity only.
type Tone = 'cyan' | 'up' | 'down' | 'amber' | 'violet' | 'slate'

type FuturesInstitutionalRow = {
  id?: string
  label?: string
  category?: string
  netTradeLots?: number | null
  netOiLots?: number | null
  previousNetOiLots?: number | null
  netOiDeltaLots?: number | null
  netTradeAmountK?: number | null
  netOiAmountK?: number | null
  previousDate?: string | null
}

const NBSP = '\u00a0'

const TONE_TEXT: Record<Tone, string> = {
  cyan: 'text-cyan-200',
  up: 'text-up',
  down: 'text-down',
  amber: 'text-amber-300',
  violet: 'text-violet-300',
  slate: 'text-slate-300',
}

const TONE_BAR: Record<Tone, string> = {
  cyan: 'bg-cyan-400',
  up: 'bg-up',
  down: 'bg-down',
  amber: 'bg-amber-300',
  violet: 'bg-violet-400',
  slate: 'bg-slate-500',
}

const PARTICIPANT_TONE: Record<string, Tone> = {
  自營商: 'amber',
  投信: 'cyan',
  外資: 'violet',
  合計: 'slate',
}

function asNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function clamp(value: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value))
}

function signedAmount(value: number | null) {
  if (value == null) return '—'
  return `${priceArrow(value)}${priceArrow(value) ? ' ' : ''}${value > 0 ? '+' : ''}${formatTwdCompact(value)}`
}

function signedLots(value: number | null) {
  if (value == null) return '—'
  return `${priceArrow(value)}${priceArrow(value) ? ' ' : ''}${value > 0 ? '+' : ''}${formatNumber(value, 0)}${NBSP}口`
}

function realOrPreview<T>(value: T | null | undefined, preview: T): { value: T; preview: boolean } {
  return value == null ? { value: preview, preview: true } : { value, preview: false }
}

// Net positions follow the index tiles' Taiwan convention: net long red, net short green.
function participantTone(value: number | null | undefined): Tone {
  const n = asNumber(value)
  if (n == null || n === 0) return 'slate'
  return n > 0 ? 'up' : 'down'
}

function participantLabel(row: FuturesInstitutionalRow) {
  const label = String(row.label ?? row.id ?? '').trim()
  if (label.includes('外資')) return '外資'
  if (label.includes('投信')) return '投信'
  if (label.includes('自營')) return '自營商'
  if (label.includes('合計') || row.id === 'total') return '合計'
  return label || '法人'
}

function participantIdentityTone(row: FuturesInstitutionalRow): Tone {
  return PARTICIPANT_TONE[participantLabel(row)] ?? 'slate'
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
      previousNetOiLots: asNumber(row?.previousNetOiLots),
      netOiDeltaLots: asNumber(row?.netOiDeltaLots),
      netTradeAmountK: asNumber(row?.netTradeAmountK),
      netOiAmountK: asNumber(row?.netOiAmountK),
      previousDate: row?.previousDate == null ? null : String(row.previousDate).slice(0, 10),
    }))
    .filter((row) => row.label)
  if (normalized.length) return normalized
  return fallback.labels.map((label) => ({
    id: label,
    label,
    category: 'pending',
    netTradeLots: null,
    netOiLots: null,
    previousNetOiLots: null,
    netOiDeltaLots: null,
    netOiAmountK: null,
    previousDate: null,
  }))
}

function majorInstitutionRows(rows: FuturesInstitutionalRow[]) {
  const order = ['自營商', '投信', '外資']
  const selected = order
    .map((label) => rows.find((row) => participantLabel(row) === label))
    .filter((row): row is FuturesInstitutionalRow => Boolean(row))
  return selected.length ? selected : rows
}

function FuturesOpenInterestBar({ rows }: { rows: FuturesInstitutionalRow[] }) {
  const segments = rows.map((row) => {
    const value = Math.abs(asNumber(row.netOiLots) ?? 0)
    return {
      label: participantLabel(row),
      value,
      tone: participantIdentityTone(row),
    }
  })
  const total = segments.reduce((sum, segment) => sum + segment.value, 0)

  return (
    <div>
      <div className="mb-1.5 text-[11px] font-semibold text-muted-foreground" title="三大法人未平倉口數絕對值占比">未平倉分布</div>
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
            <div className="truncate text-[10px] font-semibold text-muted-foreground">{segment.label}</div>
            <div className={`mt-0.5 whitespace-nowrap text-xs font-bold tabular-nums ${TONE_TEXT[segment.tone]}`}>
              {segment.value ? `${formatNumber(segment.value, 0)}${NBSP}口` : '—'}
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
    <div className="min-w-0">
      <div className="text-[10px] font-semibold text-muted-foreground sm:hidden">{label}</div>
      <div className={`mt-1 whitespace-nowrap text-sm font-bold leading-tight tabular-nums sm:mt-0 ${TONE_TEXT[tone]}`}>{value}</div>
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/[0.07]">
        <div className={`h-full rounded-full ${TONE_BAR[tone]}`} style={{ width: `${clamp(intensity, 6)}%` }} />
      </div>
    </div>
  )
}

function FuturesInstitutionRow({ row }: { row: FuturesInstitutionalRow }) {
  const label = participantLabel(row)
  const identityTone = participantIdentityTone(row)
  const netOi = asNumber(row.netOiLots)
  const netOiDelta = asNumber(row.netOiDeltaLots)
  const netTrade = asNumber(row.netTradeLots)
  const netAmountK = asNumber(row.netOiAmountK)
  const dominant = netOi ?? netTrade ?? netAmountK
  return (
    <div className="grid min-w-0 gap-2 border-b border-white/[0.06] px-1 py-2.5 last:border-b-0 sm:grid-cols-[minmax(64px,0.6fr)_repeat(4,minmax(0,1fr))] sm:items-center" data-net-direction={participantTone(dominant)}>
      <div className="flex min-w-0 items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${TONE_BAR[identityTone]}`} />
        <div className="truncate text-sm font-bold text-slate-100">{label}</div>
      </div>
      <FuturesMetricCell
        label="未平倉"
        value={signedLots(netOi)}
        tone={participantTone(netOi)}
        intensity={Math.abs(netOi ?? 0) / 800}
      />
      <FuturesMetricCell
        label="未平倉差"
        value={signedLots(netOiDelta)}
        tone={participantTone(netOiDelta)}
        intensity={Math.abs(netOiDelta ?? 0) / 80}
      />
      <FuturesMetricCell
        label="交易淨口"
        value={signedLots(netTrade)}
        tone={participantTone(netTrade)}
        intensity={Math.abs(netTrade ?? 0) / 220}
      />
      <FuturesMetricCell
        label="未平倉淨額"
        value={signedAmount(netAmountK == null ? null : netAmountK * 1000)}
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
    asNumber(row.netOiDeltaLots) != null ||
    asNumber(row.netTradeLots) != null ||
    asNumber(row.netOiAmountK) != null,
  )
  const totalNetOi = hasRowData ? rows.reduce((sum, row) => sum + (asNumber(row.netOiLots) ?? 0), 0) : null
  const totalNetOiDelta = hasRowData ? rows.reduce((sum, row) => sum + (asNumber(row.netOiDeltaLots) ?? 0), 0) : null
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
    totalNetOiDelta,
    totalNetTrade,
    totalNetAmountK,
  }
}

// The data date sits once in the market overview title; the raw source key only reaches the tooltip.
export function MarketRiskDetailBreakdown({ risk }: { risk: any }) {
  const view = buildFuturesView(risk)

  return (
    <section className="min-w-0 border-t border-border">
      <div className="pt-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2" title="三大法人台指期貨拆解；未平倉看隔日風險，交易淨口看當日方向。">
            <Landmark className={`h-4 w-4 shrink-0 ${TONE_TEXT[view.tone]}`} />
            <h2 className="truncate text-sm font-bold text-slate-100">期貨三大法人</h2>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {view.preview && <StatusBadge tone="warn" title="部分欄位尚未入庫">資料不全</StatusBadge>}
            <span className="text-[11px] text-muted-foreground" title="資料來源">{humanSource(view.source, '期交所')}</span>
          </div>
        </div>

        <div className="mt-3">
          <FuturesOpenInterestBar rows={view.rows} />
        </div>

        <div className="mt-3 hidden grid-cols-[minmax(64px,0.6fr)_repeat(4,minmax(0,1fr))] gap-2 px-1 text-[11px] font-semibold text-muted-foreground sm:grid">
          <span>法人</span>
          <span>未平倉</span>
          <span>未平倉差</span>
          <span>交易淨口</span>
          <span>未平倉淨額</span>
        </div>

        <div className="mt-1 grid min-w-0">
          {view.rows.map((row) => (
            <FuturesInstitutionRow key={`${participantLabel(row)}-${row.id ?? row.category ?? 'row'}`} row={row} />
          ))}
        </div>
      </div>
    </section>
  )
}
