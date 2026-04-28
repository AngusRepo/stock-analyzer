import { useState, type ElementType } from 'react'
import {
  AlertCircle,
  BarChart3,
  ChevronDown,
  ChevronUp,
  Minus,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
  Users,
  Zap,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

type AlphaContext = {
  bucket?: string
  regime?: string
  sizing?: number | null
  scoreAdjustment?: number | null
  boost?: number | null
  volatility?: string
  liquidity?: string
  skip?: boolean
  poc?: string | number | null
  fairValueLow?: string | number | null
  fairValueHigh?: string | number | null
  location?: string
}

function fmtNumber(value: number | string | null | undefined, decimals = 1): string {
  if (value == null || value === '') return '-'
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return String(value)
  return numeric.toFixed(decimals)
}

function fmtChipAmount(billion: number | null | undefined): string {
  if (billion == null) return '-'
  const abs = Math.abs(billion)
  if (abs < 0.01 && abs > 0) {
    const wan = Math.round(billion * 10000)
    return `${wan > 0 ? '+' : ''}${wan} 萬`
  }
  return `${billion > 0 ? '+' : ''}${billion.toFixed(2)} 億`
}

const SIGNAL_CONFIG: Record<string, { label: string; color: string; icon: ElementType }> = {
  STRONG_BUY: { label: '強買', color: 'bg-red-500 text-white', icon: Zap },
  BUY: { label: '買進', color: 'bg-orange-500 text-white', icon: TrendingUp },
  HOLD: { label: '觀望', color: 'bg-yellow-500 text-white', icon: Minus },
  SELL: { label: '賣出', color: 'bg-blue-500 text-white', icon: TrendingDown },
  STRONG_SELL: { label: '強賣', color: 'bg-purple-600 text-white', icon: TrendingDown },
}

const ALPHA_BUCKET_TEXT: Record<string, { label: string; help: string }> = {
  trend_following: {
    label: '順勢追蹤',
    help: '代表系統認為主要優勢來自「趨勢延續」。重點是價格已經有方向，進場不是撿便宜，而是順著強勢走。',
  },
  mean_reversion: {
    label: '均值回歸',
    help: '代表系統認為價格短線偏離合理區，可能有修復空間。重點是避免接刀，要看支撐、量能與大盤是否穩住。',
  },
  breakout_vol_expansion: {
    label: '突破 / 波動擴張',
    help: '代表系統偵測到突破或波動放大。這種機會可能跑很快，但也最容易追高，所以 sizing 和停損要更嚴格。',
  },
  defensive_accumulation: {
    label: '防守型累積',
    help: '代表訊號不是強攻型，而是偏防守、慢慢累積。適合小部位或觀察，不應解讀成無腦追價。',
  },
}

const REGIME_TEXT: Record<string, string> = {
  bull: '多頭環境：系統會較願意給順勢與突破策略權重，但仍需注意是否過熱。',
  bear: '空頭環境：系統會提高防守與風險控管權重，買進訊號要更保守。',
  sideways: '盤整環境：追突破容易假突破，均值回歸與區間交易通常更重要。',
  volatile: '高波動環境：價格容易大幅跳動，重點是降倉、避開滑價與避免追高。',
}

const VOL_TEXT: Record<string, string> = {
  normal: '波動正常：價格變動沒有明顯失控，風控可用標準參數。',
  high: '波動偏高：容易震盪掃停損，進場價、部位大小與停損距離都要更保守。',
  extreme: '波動極端：容易出現跳空與急殺，通常不適合自動追價。',
  unknown: '波動資料不足：不要過度解讀，需要等更多價格資料。',
}

const LIQUIDITY_TEXT: Record<string, string> = {
  normal: '流動性正常：成交量足夠，理論上較不容易因買賣造成明顯滑價。',
  thin: '流動性偏薄：掛單可能比較難成交，或成交價偏離預期。',
  low: '流動性低：滑價與流動性風險高，通常應跳過或大幅降倉。',
  unknown: '流動性資料不足：無法可靠估計成交與滑價風險。',
}

const LOCATION_TEXT: Record<string, string> = {
  below_fair_value: '低於公平價區：看起來偏便宜，但要確認不是弱勢破位。',
  in_fair_value: '位於公平價區：價格相對合理，不算明顯追高或折價。',
  above_fair_value: '高於公平價區：偏追高，若同時高波動或量薄就要特別小心。',
  unknown: '公平價位置不足：資料不夠完整，不能過度解讀。',
}

function labelFor(value: unknown, table?: Record<string, string>): string {
  if (typeof value !== 'string' || !value) return 'unknown'
  return ALPHA_BUCKET_TEXT[value]?.label ?? table?.[value] ?? value.replace(/_/g, ' ')
}

function normalizeWatchPoints(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  if (typeof raw !== 'string' || !raw.trim()) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : []
  } catch {
    return [raw]
  }
}

function extractValue(text: string, key: string): string | null {
  const match = text.match(new RegExp(`${key}=([^,]+)`))
  return match?.[1]?.trim() ?? null
}

function contextFromWatchPoints(points: string[]): AlphaContext | null {
  const alphaPoint = points.find((point) => point.startsWith('Alpha bucket:'))
  const structurePoint = points.find((point) => point.startsWith('Market structure:'))
  if (!alphaPoint && !structurePoint) return null

  const risk = extractValue(alphaPoint ?? '', 'risk')
  const [volatility, liquidity] = risk ? risk.split('/') : []
  const fairValue = extractValue(structurePoint ?? '', 'fair_value')
  const [fairValueLow, fairValueHigh] = fairValue ? fairValue.split('~') : []

  return {
    bucket: alphaPoint?.match(/^Alpha bucket:\s*([^,]+)/)?.[1]?.trim(),
    regime: extractValue(alphaPoint ?? '', 'regime') ?? undefined,
    sizing: Number(extractValue(alphaPoint ?? '', 'sizing x') ?? NaN),
    volatility,
    liquidity,
    poc: extractValue(structurePoint ?? '', 'POC'),
    fairValueLow,
    fairValueHigh,
    location: extractValue(structurePoint ?? '', 'location') ?? undefined,
  }
}

function alphaContextFromRec(rec: any, points: string[]): AlphaContext | null {
  const alpha = rec.alpha_context
  if (!alpha) return contextFromWatchPoints(points)

  const risk = alpha.risk_overlay ?? {}
  const structure = risk.structure_detail ?? {}
  return {
    bucket: alpha.edge_bucket,
    regime: alpha.regime,
    sizing: alpha.sizing_multiplier,
    scoreAdjustment: alpha.score_adjustment,
    boost: rec.alpha_allocation?.score_boost,
    volatility: risk.volatility_level,
    liquidity: risk.liquidity_level,
    skip: risk.skip,
    poc: structure.poc_price,
    fairValueLow: structure.fair_value_low,
    fairValueHigh: structure.fair_value_high,
    location: structure.price_location,
  }
}

function ScoreBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const safeValue = Number.isFinite(value) ? value : 0
  const pct = Math.max(0, Math.min(100, Math.round((safeValue / max) * 100)))
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-12 shrink-0 text-muted-foreground">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div className={cn('h-full rounded-full transition-all', color)} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-12 text-right font-mono text-muted-foreground">
        {fmtNumber(safeValue, 1)}/{max}
      </span>
    </div>
  )
}

function ScoreBreakdown({ rec }: { rec: any }) {
  const chip = Number(rec.chip_score ?? 0)
  const tech = Number(rec.tech_score ?? 0)
  const ml = Number(rec.ml_score ?? 0)
  const base = Math.round((chip + tech + ml) * 10) / 10
  const alphaAdj = Number(rec.alpha_context?.score_adjustment ?? 0)
  const allocationBoost = Number(rec.alpha_allocation?.score_boost ?? 0)
  const finalScore = Number(rec.score ?? base + alphaAdj + allocationBoost)
  const residual = Math.round((finalScore - base - alphaAdj - allocationBoost) * 10) / 10

  return (
    <div className="rounded-lg border border-border/50 bg-background/50 p-3 text-xs">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="font-medium text-muted-foreground">分數公式</span>
        <span className="font-mono text-foreground">
          {fmtNumber(finalScore, 1)} = {fmtNumber(base, 1)}
          {alphaAdj >= 0 ? ' + ' : ' - '}{fmtNumber(Math.abs(alphaAdj), 1)}
          {allocationBoost >= 0 ? ' + ' : ' - '}{fmtNumber(Math.abs(allocationBoost), 1)}
          {Math.abs(residual) >= 0.1 && `${residual >= 0 ? ' + ' : ' - '}${fmtNumber(Math.abs(residual), 1)}`}
        </span>
      </div>
      <div className="grid gap-1.5 text-muted-foreground sm:grid-cols-2">
        <span>基礎分：籌碼 + 技術 + ML = {fmtNumber(base, 1)}</span>
        <span>Alpha 調整：{alphaAdj >= 0 ? '+' : ''}{fmtNumber(alphaAdj, 1)}</span>
        <span>Slate 排序 boost：+{fmtNumber(allocationBoost, 1)}</span>
        <span>最終分數：{fmtNumber(finalScore, 1)}</span>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground/80">
        Alpha 調整代表風控與市場狀態對分數的加減；Slate boost 是為了讓不同交易 edge 在清單中保持分散，不是原始 ML 預測報酬。
      </p>
    </div>
  )
}

function AlphaContextBlock({ context }: { context: AlphaContext | null }) {
  if (!context) return null
  const bucket = context.bucket ?? 'unknown'
  const regime = context.regime ?? 'unknown'
  const volatility = context.volatility ?? 'unknown'
  const liquidity = context.liquidity ?? 'unknown'
  const location = context.location ?? 'unknown'
  const fairValue = context.fairValueLow || context.fairValueHigh
    ? `${fmtNumber(context.fairValueLow, 2)} ~ ${fmtNumber(context.fairValueHigh, 2)}`
    : '-'

  return (
    <div className="rounded-lg border border-sky-500/20 bg-sky-500/[0.06] p-3">
      <p className="mb-2 flex items-center gap-1 text-xs font-medium text-sky-700 dark:text-sky-300">
        <ShieldCheck className="h-3 w-3" />
        Alpha / Market Context
      </p>
      <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
        <span>Alpha bucket：{labelFor(bucket)}</span>
        <span>Regime：{labelFor(regime)}</span>
        <span>Sizing：x{fmtNumber(context.sizing, 2)}</span>
        <span>Score adj：{context.scoreAdjustment == null ? '-' : `${Number(context.scoreAdjustment) >= 0 ? '+' : ''}${fmtNumber(context.scoreAdjustment, 1)}`}</span>
        <span>波動：{labelFor(volatility)}</span>
        <span>流動性：{labelFor(liquidity)}</span>
        <span>POC：{fmtNumber(context.poc, 2)}</span>
        <span>Fair value：{fairValue}</span>
        <span className="sm:col-span-2">價格位置：{labelFor(location)}</span>
      </div>
      <div className="mt-3 space-y-1.5 text-xs leading-relaxed text-muted-foreground/85">
        <p>{ALPHA_BUCKET_TEXT[bucket]?.help ?? 'Alpha bucket 是系統判斷這檔股票目前主要 edge 來源的分類。'}</p>
        <p>{REGIME_TEXT[regime] ?? 'Regime 是目前大盤狀態，用來調整不同策略類型的權重。'}</p>
        <p>{VOL_TEXT[volatility] ?? VOL_TEXT.unknown} {LIQUIDITY_TEXT[liquidity] ?? LIQUIDITY_TEXT.unknown}</p>
        <p>
          Market structure：POC 是近期成交量最集中的價格，fair value 是系統估計的合理價格帶；
          {LOCATION_TEXT[location] ?? LOCATION_TEXT.unknown}
        </p>
      </div>
      {context.skip && (
        <p className="mt-2 text-xs font-medium text-amber-600">
          Risk overlay 已標記 skip：代表風險層不建議自動進場。
        </p>
      )}
    </div>
  )
}

function normalizeWatchPoint(point: string): string {
  if (point.startsWith('Alpha bucket:')) {
    return `${point}。白話：這是在說目前適合哪一種交易邏輯，會影響 allocation、sizing 與風控。`
  }
  if (point.startsWith('Market structure:')) {
    return `${point}。白話：POC 是近期量能重心，fair value 是合理價格帶，location 用來判斷追高或折價。`
  }
  return point
}

export function RecommendationCardClean({ rec, rank }: { rec: any; rank: number }) {
  const [expanded, setExpanded] = useState(false)
  const sig = SIGNAL_CONFIG[rec.signal] ?? SIGNAL_CONFIG.HOLD
  const SigIcon = sig.icon
  const watchPoints = normalizeWatchPoints(rec.watch_points)
  const alphaContext = alphaContextFromRec(rec, watchPoints)
  const chip5dRaw = (rec.foreign_net_5d ?? 0) + (rec.trust_net_5d ?? 0)
  const chipPositive = chip5dRaw > 0

  return (
    <div className={cn(
      'rounded-xl border transition-all',
      rank === 1
        ? 'border-amber-500/40 bg-amber-500/[0.06] shadow-sm'
        : 'border-border/50 bg-card hover:border-border',
    )}>
      <div
        className="flex cursor-pointer select-none items-center gap-3 p-3 sm:p-4"
        onClick={() => setExpanded((value) => !value)}
      >
        <div className={cn(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-bold',
          rank === 1 ? 'bg-amber-400 text-white' :
          rank === 2 ? 'bg-gray-400 text-white' :
          rank === 3 ? 'bg-orange-400 text-white' :
          'bg-muted text-muted-foreground',
        )}>
          {rank}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">{rec.symbol}</span>
            <span className="truncate text-sm text-muted-foreground">{rec.name}</span>
            {rec.sector && (
              <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px]">{rec.sector}</Badge>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <Badge className={cn('px-1.5 py-0 text-[10px]', sig.color)}>
              <SigIcon className="mr-1 h-2.5 w-2.5" />
              {sig.label}
            </Badge>
            <span className={cn('flex items-center gap-1 text-xs', chipPositive ? 'text-red-500' : 'text-emerald-500')}>
              <Users className="h-3 w-3" />
              籌碼 {fmtChipAmount(chip5dRaw)}
            </span>
            {rec.rsi14 != null && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <BarChart3 className="h-3 w-3" />
                RSI {fmtNumber(rec.rsi14, 1)}
              </span>
            )}
            {alphaContext?.bucket && (
              <Badge variant="outline" className="gap-1 border-sky-500/40 bg-sky-500/10 px-1.5 py-0 text-[10px] text-sky-700 dark:text-sky-300">
                <ShieldCheck className="h-2.5 w-2.5" />
                {labelFor(alphaContext.bucket)}
              </Badge>
            )}
          </div>
        </div>

        <div className="shrink-0 text-right">
          <div className="text-lg font-bold text-primary">{Math.round(Number(rec.score ?? 0))}</div>
          <div className="text-[10px] text-muted-foreground">最終分</div>
        </div>

        {expanded ? (
          <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
      </div>

      {expanded && (
        <div className="space-y-4 border-t border-border/40 px-4 pb-4 pt-3">
          <div className="space-y-1.5">
            <p className="mb-2 text-xs font-medium text-muted-foreground">基礎分數</p>
            <ScoreBar label="籌碼" value={Number(rec.chip_score ?? 0)} max={40} color="bg-blue-500" />
            <ScoreBar label="技術" value={Number(rec.tech_score ?? 0)} max={30} color="bg-purple-500" />
            <ScoreBar label="ML" value={Number(rec.ml_score ?? 0)} max={30} color="bg-emerald-500" />
          </div>

          <ScoreBreakdown rec={rec} />

          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">推薦理由</p>
            <p className="whitespace-pre-line text-sm leading-relaxed text-foreground/90">{rec.reason}</p>
          </div>

          <AlphaContextBlock context={alphaContext} />

          {watchPoints.length > 0 && (
            <div>
              <p className="mb-1.5 flex items-center gap-1 text-xs font-medium text-muted-foreground">
                <AlertCircle className="h-3 w-3" />
                注意事項
              </p>
              <ul className="space-y-1">
                {watchPoints.map((point, index) => (
                  <li key={`${point}-${index}`} className="flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
                    <span className="mt-0.5 shrink-0 text-amber-500">!</span>
                    {normalizeWatchPoint(point)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {rec.confidence != null && (
            <p className="text-[11px] text-muted-foreground">
              ML 信心度 {(Number(rec.confidence) * 100).toFixed(0)}%
              {rec.current_price != null && (
                <span className="ml-3">參考價 ${fmtNumber(rec.current_price, 2)}</span>
              )}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
