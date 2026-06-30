import {
  Activity,
  BarChart3,
  CircleDollarSign,
  Gauge,
  Landmark,
  Layers3,
  TrendingDown,
  TrendingUp,
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
  sparkline: number[]
  preview: boolean
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

function pct(value: number | null, digits = 1) {
  if (value == null) return '待接資料'
  return `${value.toFixed(digits)}%`
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

function MiniSparkline({ values, tone }: { values: number[]; tone: Tone }) {
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  let lastY = 20
  const points = values.map((value, index) => {
    const x = (index / Math.max(1, values.length - 1)) * 116
    const y = 36 - ((value - min) / span) * 28
    if (index === values.length - 1) lastY = y
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  const stroke = tone === 'rose'
    ? '#fb7185'
    : tone === 'amber'
      ? '#fbbf24'
      : tone === 'emerald'
        ? '#34d399'
        : tone === 'violet'
          ? '#a78bfa'
          : '#22d3ee'

  return (
    <svg viewBox="0 0 116 42" className="h-11 w-32 overflow-visible" aria-label="risk detail trend">
      <path d="M0 36H116" stroke="rgba(148,163,184,.18)" strokeWidth="1" strokeDasharray="3 5" />
      <polyline points={points} fill="none" stroke={stroke} strokeOpacity="0.95" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="116" cy={lastY} r="3" fill={stroke} />
    </svg>
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
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-black/20">
            <div
              className={`h-full rounded-full ${TONE_BAR[metric.tone]} opacity-55`}
              style={{ width: `${clamp(metric.intensity * 0.68 + 16)}%` }}
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
  return (
    <article className="overflow-hidden rounded-[18px] border border-white/[0.08] bg-[linear-gradient(180deg,rgba(20,22,30,0.96),rgba(13,15,22,0.98))]">
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

        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_132px]">
          <SegmentBar segments={card.segments} />
          <div className="rounded-[14px] border border-white/[0.06] bg-black/20 px-2 py-2">
            <MiniSparkline values={card.sparkline} tone={card.tone} />
          </div>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {card.metrics.map((metric) => (
            <MetricRow key={metric.label} metric={metric} />
          ))}
        </div>

        <div className="mt-4 flex items-center justify-between gap-3 border-t border-white/[0.06] pt-3">
          <span className="truncate text-[11px] text-slate-500">{card.source}</span>
          <span className={`text-[11px] font-semibold ${TONE_TEXT[card.tone]}`}>canonical signal</span>
        </div>
      </div>
    </article>
  )
}

function buildCards(risk: any): BreakdownCard[] {
  const marketStats = risk?.marketStats ?? {}
  const credit = risk?.creditTrading ?? {}
  const dataDepth = risk?.marketRiskDetail ?? risk?.finlabDataDepth ?? {}
  const liquidity = dataDepth.liquidity ?? {}
  const chip = dataDepth.chipPressure ?? {}
  const regime = dataDepth.regime ?? {}

  const amount = realOrPreview(asNumber(risk?.marketTurnoverAmount ?? marketStats.amount), 468_000_000_000)
  const marketValue = realOrPreview(asNumber(liquidity.marketValue), 72_400_000_000_000)
  const tradeCount = realOrPreview(asNumber(liquidity.tradeCount), 1_284_000)
  const bidAskSpreadBps = realOrPreview(asNumber(liquidity.bidAskSpreadBps), 8.6)
  const adjustedCoverage = realOrPreview(asNumber(liquidity.adjustedOhlcCoveragePct), 94)

  const marginUsage = realOrPreview(asNumber(chip.marginUsageRatio ?? credit.marginUsageRatio), 37.2)
  const shortUsage = realOrPreview(asNumber(chip.shortUsageRatio ?? credit.shortUsageRatio), 9.8)
  const lendingSellBalance = realOrPreview(asNumber(chip.securityLendingSellBalance), 2_880_000)
  const brokerBalanceIndex = realOrPreview(asNumber(chip.brokerBalanceIndex), 0.64)
  const brokerBuySellRatio = realOrPreview(asNumber(chip.brokerBuySellRatio), 1.18)

  const futuresNetOi = realOrPreview(asNumber(regime.futuresInstNetOiLots), -4_520)
  const futuresNetTrade = realOrPreview(asNumber(regime.futuresInstNetTradeLots), 1_860)
  const futuresNetAmount = realOrPreview(asNumber(regime.futuresInstNetOiAmountK), -12_800_000)
  const worldAdjMove = realOrPreview(asNumber(regime.worldAdjCloseChangePct), 0.42)

  const liquidityPreview = amount.preview || marketValue.preview || tradeCount.preview || bidAskSpreadBps.preview || adjustedCoverage.preview
  const chipPreview = marginUsage.preview || shortUsage.preview || lendingSellBalance.preview || brokerBalanceIndex.preview || brokerBuySellRatio.preview
  const regimePreview = futuresNetOi.preview || futuresNetTrade.preview || futuresNetAmount.preview || worldAdjMove.preview

  return [
    {
      title: '市場流動性',
      subtitle: '成交值、市值、筆數與買賣價差放在同一張流動性卡。',
      source: liquidity.source ?? 'canonical_market_daily',
      status: bidAskSpreadBps.value > 25 ? '偏緊' : '正常',
      score: clamp(72 - bidAskSpreadBps.value + adjustedCoverage.value * 0.18),
      tone: bidAskSpreadBps.value > 25 ? 'amber' : 'cyan',
      Icon: BarChart3,
      preview: liquidityPreview,
      segments: [
        { label: '成交值', value: 42, tone: 'cyan' },
        { label: '市值', value: 38, tone: 'violet' },
        { label: '筆數', value: 20, tone: 'emerald' },
      ],
      sparkline: [48, 51, 47, 56, 59, 63, 61, 66, 72, 69],
      metrics: [
        { label: '總成交值', value: compact(amount.value), note: '和市場成交量並列，判斷資金活躍度。', tone: 'cyan', intensity: 68 },
        { label: '總市值', value: compact(marketValue.value), note: 'market_value 補市場承載度。', tone: 'violet', intensity: 72 },
        { label: '成交筆數', value: compact(tradeCount.value, 0), note: 'trade_count 補交易密度。', tone: 'emerald', intensity: 64 },
        { label: '買賣價差', value: `${bidAskSpreadBps.value.toFixed(1)} bps`, note: '用 bid/ask 看 liquidity friction。', tone: bidAskSpreadBps.value > 25 ? 'amber' : 'cyan', intensity: clamp(100 - bidAskSpreadBps.value * 2) },
        { label: '還原價覆蓋', value: pct(adjustedCoverage.value, 0), note: 'adj OHLC 可讓圖表切還原價。', tone: 'emerald', intensity: adjustedCoverage.value },
      ],
    },
    {
      title: '信用與券商壓力',
      subtitle: '融資融券、借券與券商集中度合併成籌碼壓力線。',
      source: chip.source ?? 'canonical_chip_daily',
      status: brokerBalanceIndex.value >= 0 ? '偏多' : '壓力',
      score: clamp(52 + marginUsage.value * 0.35 + shortUsage.value * 0.4 - brokerBalanceIndex.value * 12),
      tone: shortUsage.value > 20 || brokerBalanceIndex.value < -0.2 ? 'rose' : marginUsage.value > 45 ? 'amber' : 'emerald',
      Icon: CircleDollarSign,
      preview: chipPreview,
      segments: [
        { label: '融資', value: marginUsage.value, tone: marginUsage.value > 45 ? 'amber' : 'emerald' },
        { label: '融券', value: shortUsage.value, tone: shortUsage.value > 20 ? 'rose' : 'cyan' },
        { label: '券商', value: Math.max(12, Math.abs(brokerBalanceIndex.value) * 50), tone: brokerBalanceIndex.value >= 0 ? 'emerald' : 'rose' },
      ],
      sparkline: [39, 41, 44, 43, 49, 54, 51, 58, 56, 62],
      metrics: [
        { label: '融資使用率', value: pct(marginUsage.value), note: 'margin_usage_ratio 看槓桿熱度。', tone: marginUsage.value > 45 ? 'amber' : 'emerald', intensity: marginUsage.value },
        { label: '融券使用率', value: pct(shortUsage.value), note: 'short_usage_ratio 看空方壓力。', tone: shortUsage.value > 20 ? 'rose' : 'cyan', intensity: shortUsage.value * 2.4 },
        { label: '借券賣出餘額', value: compact(lendingSellBalance.value, 0), note: 'security_lending_sell_balance 補避險賣壓。', tone: 'amber', intensity: 58 },
        { label: '券商集中度', value: brokerBalanceIndex.value.toFixed(2), note: 'broker_balance_index 可進推薦卡籌碼信心。', tone: brokerBalanceIndex.value >= 0 ? 'emerald' : 'rose', intensity: clamp(Math.abs(brokerBalanceIndex.value) * 80) },
        { label: '券商買賣比', value: brokerBuySellRatio.value.toFixed(2), note: 'broker_buy_sell_ratio 看主力承接。', tone: brokerBuySellRatio.value >= 1 ? 'emerald' : 'rose', intensity: clamp(brokerBuySellRatio.value * 52) },
      ],
    },
    {
      title: '期貨與全球風險',
      subtitle: '法人期貨淨部位與海外還原指數補上 regime 方向。',
      source: regime.source ?? 'canonical_regime_context_daily',
      status: futuresNetOi.value >= 0 ? '偏多' : '避險',
      score: clamp(50 - Math.min(22, Math.abs(futuresNetOi.value) / 420) + (worldAdjMove.value + 1) * 8),
      tone: futuresNetOi.value < 0 ? 'rose' : worldAdjMove.value >= 0 ? 'violet' : 'amber',
      Icon: Landmark,
      preview: regimePreview,
      segments: [
        { label: '未平倉', value: Math.max(18, Math.abs(futuresNetOi.value) / 150), tone: futuresNetOi.value >= 0 ? 'emerald' : 'rose' },
        { label: '交易淨口', value: Math.max(12, Math.abs(futuresNetTrade.value) / 110), tone: futuresNetTrade.value >= 0 ? 'emerald' : 'rose' },
        { label: '海外', value: Math.max(18, Math.abs(worldAdjMove.value) * 46), tone: worldAdjMove.value >= 0 ? 'cyan' : 'amber' },
      ],
      sparkline: [55, 52, 49, 46, 44, 47, 45, 43, 46, 48],
      metrics: [
        { label: '法人未平倉淨口數', value: signed(futuresNetOi.value, ' 口', 0), note: 'futures_inst_net_oi_lots。', tone: futuresNetOi.value >= 0 ? 'emerald' : 'rose', intensity: clamp(Math.abs(futuresNetOi.value) / 80) },
        { label: '法人交易淨口數', value: signed(futuresNetTrade.value, ' 口', 0), note: 'futures_inst_net_trade_lots。', tone: futuresNetTrade.value >= 0 ? 'emerald' : 'rose', intensity: clamp(Math.abs(futuresNetTrade.value) / 52) },
        { label: '未平倉淨額', value: compact(futuresNetAmount.value * 1000), note: 'futures_inst_net_oi_amount_k。', tone: futuresNetAmount.value >= 0 ? 'emerald' : 'rose', intensity: 56 },
        { label: '全球還原變動', value: signed(worldAdjMove.value, '%'), note: 'world_adj_close 讓海外市場可比較。', tone: worldAdjMove.value >= 0 ? 'cyan' : 'amber', intensity: clamp(Math.abs(worldAdjMove.value) * 55) },
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
          <DetailPill tone="cyan">流動性</DetailPill>
          <DetailPill tone="emerald">信用籌碼</DetailPill>
          <DetailPill tone="violet">期貨避險</DetailPill>
        </div>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        {cards.map((card) => (
          <BreakdownCardView key={card.title} card={card} />
        ))}
      </div>

      <div className="mt-4 grid gap-3 rounded-[16px] border border-white/[0.06] bg-black/15 p-3 text-xs text-slate-500 md:grid-cols-3">
        <div className="flex items-center gap-2">
          <Gauge className="h-4 w-4 text-cyan-200" />
          <span>分數呈現壓力或品質，不直接等同買賣訊號。</span>
        </div>
        <div className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-emerald-300" />
          <span>綠色偏支撐，黃/紅色偏壓力或流動性變差。</span>
        </div>
        <div className="flex items-center gap-2">
          <TrendingDown className="h-4 w-4 text-rose-300" />
          <span>資料接上後由 canonical tables 自動替換預覽值。</span>
        </div>
      </div>
    </section>
  )
}
