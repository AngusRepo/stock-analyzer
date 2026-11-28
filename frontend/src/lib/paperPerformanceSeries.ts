import { paperPnlSnapshotsFromPayload } from './paperPayload'

export type BenchmarkKey = '0050' | 'TWII' | '00981A' | '00631L' | '00403A'
export const BENCHMARK_KEYS: BenchmarkKey[] = ['0050', 'TWII', '00981A', '00631L', '00403A']

export type PerformancePoint = {
  time: string
  /** 缺值或 ≤0 的總值是斷點（null），不畫成 0% 或 -100%。 */
  bot: number | null
  benchmarks: Partial<Record<BenchmarkKey, number>>
  /** 期間回撤（%）：所選期間內 bot 總值相對期間內最高點；總值缺值日為 null。 */
  drawdown: number | null
  totalValue: number | null
}

/** 每條基準的起算點：與 bot 同起點（aligned），或序列較晚才有值、從自己的第一個值起算。 */
export type BenchmarkBase = { base: number; startDate: string; aligned: boolean }

export const PERIOD_DAYS: Record<string, number> = { '1W': 7, '1M': 30, '3M': 90, ALL: 9999 }

export function dateOnly(value: unknown): string | null {
  if (!value) return null
  const raw = String(value)
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10)
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10)
}

export function numberOrNull(value: unknown): number | null {
  // Number(null) and Number('') are 0; a missing snapshot value must stay missing, not plot as -100%.
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function pct(value: number, base: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(base) || base <= 0) return 0
  return ((value / base) - 1) * 100
}

function positiveOrNull(raw: unknown): number | null {
  // A benchmark price is never zero or negative; treat one as a gap in the series.
  const value = numberOrNull(raw)
  return value != null && value > 0 ? value : null
}

function etfMap(row: any): Record<string, unknown> {
  return row?.etf_benchmarks && typeof row.etf_benchmarks === 'object' ? row.etf_benchmarks as Record<string, unknown> : {}
}

/**
 * 0050 的價格基礎：新版 Worker（batch2 paperEtfBenchmarks）在 etf_benchmarks['0050'] 給 adj_close（含息）；
 * 舊版只有 benchmark_value（收盤價）。同一條線只用一種基礎——只要任一列有 adj，就整條用 adj，
 * 缺值留空，不回補收盤價（兩種尺度混在一條線會造成除息跳點）。
 */
export function uses0050Adjusted(rows: any[]): boolean {
  return rows.some((row) => positiveOrNull(etfMap(row)['0050']) != null)
}

export function benchmarkRawValue(row: any, key: BenchmarkKey, adjusted0050 = false): number | null {
  const map = etfMap(row)
  const raw = key === '0050' ? (adjusted0050 ? map['0050'] : row?.benchmark_value)
    : key === 'TWII' ? row?.twii_value
      : map[key] ?? row?.[`${key}_value`] ?? row?.[key]
  return positiveOrNull(raw)
}

function rowDate(row: any): string {
  return String(dateOnly(row?.date ?? row?.snapshot_date ?? row?.ts))
}

export function firstPositiveValue(rows: any[], getter: (row: any) => unknown, fallback: number) {
  for (const row of rows) {
    const value = numberOrNull(getter(row))
    if (value != null && value > 0) return value
  }
  return fallback
}

/**
 * 共同起點：bot 在期間第一個 snapshot 日。該日有值的基準用該日當 base（aligned）；
 * 該日沒值（例如 00403A 05-12 才上市、TWII 缺值）的基準用自己的第一個值，並回傳起算日，
 * 圖例要標「自 MM-DD 起算」，不能暗示與 bot 同區間。
 */
function totalOf(row: any): number | null {
  return positiveOrNull(row?.total_value ?? row?.portfolio_value)
}

/** bot 的起點＝期間內第一筆有正值總值的列（首列總值缺值時，共同起點一起往後移）。 */
export function botStartIndex(rows: any[]): number {
  const index = rows.findIndex((row) => totalOf(row) != null)
  return index < 0 ? 0 : index
}

export function benchmarkBases(rows: any[], adjusted0050 = uses0050Adjusted(rows)): Partial<Record<BenchmarkKey, BenchmarkBase>> {
  const out: Partial<Record<BenchmarkKey, BenchmarkBase>> = {}
  if (!rows.length) return out
  const startRow = rows[botStartIndex(rows)]
  const botStart = rowDate(startRow)
  const fromStart = rows.slice(botStartIndex(rows))
  for (const key of BENCHMARK_KEYS) {
    const startValue = benchmarkRawValue(startRow, key, adjusted0050)
    if (startValue != null) {
      out[key] = { base: startValue, startDate: botStart, aligned: true }
      continue
    }
    const first = fromStart.find((row) => benchmarkRawValue(row, key, adjusted0050) != null)
    if (first) out[key] = { base: benchmarkRawValue(first, key, adjusted0050)!, startDate: rowDate(first), aligned: false }
  }
  return out
}

export function sortedSnapshots(pnl: any): any[] {
  return [...paperPnlSnapshotsFromPayload<any>(pnl)]
    .filter((row) => dateOnly(row?.date ?? row?.snapshot_date ?? row?.ts))
    .sort((a, b) => rowDate(a).localeCompare(rowDate(b)))
}

export function periodRows(allSnapshots: any[], period: string, nowMs = Date.now()): any[] {
  if (!allSnapshots.length) return []
  const periodDays = PERIOD_DAYS[period] ?? 9999
  const cutoffDate = new Date(nowMs - periodDays * 86_400_000).toISOString().slice(0, 10)
  const snapshots = period === 'ALL' ? allSnapshots : allSnapshots.filter((row) => rowDate(row) >= cutoffDate)
  return snapshots.length ? snapshots : allSnapshots
}

export function buildPaperTradePerformancePoints(pnl: any, period: string, nowMs = Date.now()): PerformancePoint[] {
  const periodSlice = periodRows(sortedSnapshots(pnl), period, nowMs)
  // 期間開頭 bot 總值缺值的列不畫：共同起點移到 bot 第一筆有值的日子（基準也從那天起算）。
  const rows = periodSlice.slice(botStartIndex(periodSlice))
  if (!rows.length) return []
  const baseValue = firstPositiveValue(rows, (row) => row?.total_value ?? row?.portfolio_value, 1_000_000)
  const adjusted0050 = uses0050Adjusted(rows)
  const bases = benchmarkBases(rows, adjusted0050)
  let peak = 0

  return rows.map((row) => {
    const totalValue = totalOf(row)
    // 期間回撤用期間內的總值自己算；max_drawdown_to_date 是成立以來累計，切到 1W／1M 會帶進期間外的回撤。
    if (totalValue != null) peak = Math.max(peak, totalValue)
    const drawdown = totalValue != null && peak > 0 ? (totalValue / peak - 1) * 100 : null
    const benchmarks: Partial<Record<BenchmarkKey, number>> = {}
    for (const key of BENCHMARK_KEYS) {
      const raw = benchmarkRawValue(row, key, adjusted0050)
      const base = bases[key]
      if (raw != null && base) benchmarks[key] = pct(raw, base.base)
    }
    return { time: rowDate(row), bot: totalValue == null ? null : pct(totalValue, baseValue), benchmarks, drawdown, totalValue }
  })
}

/** lightweight-charts 的資料點：沒有 value 的是 whitespace，畫成斷線（不補 0、不把前後兩點直接連起來）。 */
export type LineDatum = { time: string; value?: number }

/**
 * batch2 起 /pnl 基準只取當日 adj_close，缺就 null、不沿用前一日（例：0050 缺 07-10；00631L 停牌 03-25～03-30、
 * 05-22～06-26 整段缺；00403A 05-12 前未上市）。每個日期都要出一個點：有值給 value，缺值給 whitespace。
 * 若只是把缺值濾掉，lightweight-charts 會把缺口兩端直線連過去，看起來像那段有報價。
 */
export function benchmarkLineData(points: PerformancePoint[], key: BenchmarkKey): LineDatum[] {
  return points.map((point) => {
    const value = point.benchmarks[key]
    return value == null ? { time: point.time } : { time: point.time, value }
  })
}

export function botLineData(points: PerformancePoint[]): LineDatum[] {
  return points.map((point) => point.bot == null ? { time: point.time } : { time: point.time, value: point.bot })
}

/** 帶狀圖的資料點：per-point 顏色（領先／落後）讓同一條 area 分段上色。 */
export type BandDatum = { time: string; value?: number; topColor?: string; bottomColor?: string }

/**
 * bot 與基準之間的差距帶：upper＝兩者較高者，依領先／落後上色；lower＝兩者較低者，用背景色蓋掉下方，
 * 疊起來只剩兩線之間的帶。任一邊缺值的日期是 whitespace，帶子斷開，不補值。
 */
export function gapBandData(points: PerformancePoint[], key: BenchmarkKey, colors: { lead: string; lag: string; background: string }): { upper: BandDatum[]; lower: BandDatum[] } {
  const upper: BandDatum[] = []
  const lower: BandDatum[] = []
  for (const point of points) {
    const bench = point.benchmarks[key]
    if (point.bot == null || bench == null) {
      upper.push({ time: point.time })
      lower.push({ time: point.time })
      continue
    }
    const color = point.bot >= bench ? colors.lead : colors.lag
    upper.push({ time: point.time, value: Math.max(point.bot, bench), topColor: color, bottomColor: color })
    lower.push({ time: point.time, value: Math.min(point.bot, bench), topColor: colors.background, bottomColor: colors.background })
  }
  return { upper, lower }
}

/** 期間最大回撤（%，≤0）：只看所選期間內的點；全部缺值時為 null。 */
export function periodMaxDrawdown(points: PerformancePoint[]): number | null {
  const values = points.map((point) => point.drawdown).filter((value): value is number => value != null)
  return values.length ? Math.min(...values) : null
}

/**
 * 摘要列「vs 0050」用的基準報酬：和資產曲線同一個價格基礎（0050 優先 etf_benchmarks adj_close，舊 Worker 才用 benchmark_value），
 * 起點列的選法和 bot 的近期報酬一致（cutoff 之後第一列）。兩端任一缺值就是 null，不回補收盤價。
 */
export function benchmarkReturnSince(snapshots: any[], key: BenchmarkKey, daysAgo: number, nowMs = Date.now()): number | null {
  const rows = [...snapshots].filter((row) => dateOnly(row?.date ?? row?.snapshot_date ?? row?.ts)).sort((a, b) => rowDate(a).localeCompare(rowDate(b)))
  if (rows.length < 2) return null
  const adjusted = key === '0050' && uses0050Adjusted(rows)
  const cutoff = new Date(nowMs - daysAgo * 86_400_000).toISOString().slice(0, 10)
  const ref = rows.find((row) => rowDate(row) >= cutoff) ?? rows[0]
  const start = benchmarkRawValue(ref, key, adjusted)
  const end = benchmarkRawValue(rows[rows.length - 1], key, adjusted)
  return start != null && end != null ? end / start - 1 : null
}
