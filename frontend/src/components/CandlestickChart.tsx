/**
 * CandlestickChart — K 線圖（OHLC + Volume）
 * 使用 Recharts ComposedChart + custom shape
 */
import { useQuery } from '@tanstack/react-query'
import { stocksApi } from '@/lib/api'
import { ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Cell, Legend } from 'recharts'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { useState } from 'react'
import { format } from 'date-fns'

const RANGES = [
  { label: '1M', days: 30 },
  { label: '3M', days: 90 },
  { label: '6M', days: 180 },
  { label: '1Y', days: 365 },
]

// MA 計算（從 close 陣列算）
const MA_CONFIGS = [
  { period: 5,   color: '#f59e0b', label: 'MA5' },   // 週線 — 黃
  { period: 10,  color: '#ec4899', label: 'MA10' },   // 雙週 — 粉
  { period: 20,  color: '#3b82f6', label: 'MA20' },   // 月線 — 藍
  { period: 60,  color: '#8b5cf6', label: 'MA60' },   // 季線 — 紫
  { period: 120, color: '#14b8a6', label: 'MA120' },  // 半年 — 青
  { period: 240, color: '#f97316', label: 'MA240' },  // 年線 — 橙
]

function calcMA(closes: number[], period: number): (number | null)[] {
  return closes.map((_, i) => {
    if (i < period - 1) return null
    const slice = closes.slice(i - period + 1, i + 1)
    return Math.round(slice.reduce((a, b) => a + b, 0) / period * 100) / 100
  })
}

// Candlestick custom shape
function Candlestick(props: any) {
  const { x, y, width, height, payload } = props
  if (!payload || payload.open == null || payload.close == null) return null

  const { open, close, high, low } = payload
  const isUp = close >= open
  const color = isUp ? '#ef4444' : '#22c55e' // 台股：紅漲綠跌
  const bodyTop = Math.min(open, close)
  const bodyBottom = Math.max(open, close)

  // Scale: we need to convert price values to y-coordinates
  // The Bar component gives us y and height for the [open, close] range
  const yScale = props.yAxis
  if (!yScale) return null

  const yHigh = yScale.scale(high)
  const yLow = yScale.scale(low)
  const yOpen = yScale.scale(open)
  const yClose = yScale.scale(close)
  const yBodyTop = Math.min(yOpen, yClose)
  const yBodyHeight = Math.max(Math.abs(yOpen - yClose), 1)
  const cx = x + width / 2

  return (
    <g>
      {/* Wick (影線) */}
      <line x1={cx} y1={yHigh} x2={cx} y2={yLow} stroke={color} strokeWidth={1} />
      {/* Body (實體) */}
      <rect
        x={x + width * 0.15}
        y={yBodyTop}
        width={width * 0.7}
        height={yBodyHeight}
        fill={isUp ? color : color}
        fillOpacity={isUp ? 1 : 0.6}
        stroke={color}
        strokeWidth={0.5}
      />
    </g>
  )
}

export default function CandlestickChart({ stockId }: { stockId: number }) {
  const [days, setDays] = useState(90)

  const { data: prices = [], isLoading } = useQuery({
    queryKey: ['stocks', stockId, 'prices', days],
    queryFn: () => stocksApi.prices(stockId, days + 240),  // +240 for MA240 計算
    enabled: !!stockId,
  })

  if (isLoading) return <Skeleton className="h-72 w-full" />
  if (!(prices as any[]).length) return <p className="text-muted-foreground text-sm p-4">暫無資料</p>

  // 計算所有 MA（用完整 prices 陣列計算，但只顯示最後 days 筆）
  const allPricesArr = prices as any[]
  const allCloses = allPricesArr.map((p: any) => p.close as number)
  const maData: Record<string, (number | null)[]> = {}
  for (const ma of MA_CONFIGS) {
    maData[ma.label] = calcMA(allCloses, ma.period)
  }

  // 只顯示最後 days 筆（前面的只是為了算 MA）
  const displayStart = Math.max(0, allPricesArr.length - days)
  const displayPrices = allPricesArr.slice(displayStart)

  const chartData = displayPrices.map((p: any, displayIdx: number) => {
    const i = displayStart + displayIdx
    const row: any = {
      date: format(new Date(p.date), 'MM/dd'),
      open: p.open,
      high: p.high,
      low: p.low,
      close: p.close,
      volume: p.volume,
      range: [Math.min(p.open, p.close), Math.max(p.open, p.close)],
    }
    for (const ma of MA_CONFIGS) {
      row[ma.label] = maData[ma.label][i]
    }
    return row
  })

  const allPrices = chartData.flatMap((d: any) => [d.high, d.low, ...MA_CONFIGS.map(ma => d[ma.label])].filter(Boolean))
  const minPrice = Math.min(...allPrices) * 0.98
  const maxPrice = Math.max(...allPrices) * 1.02
  const maxVol = Math.max(...chartData.map((d: any) => d.volume ?? 0))

  return (
    <div className="space-y-1">
      <div className="flex gap-1">
        {RANGES.map(r => (
          <Button key={r.label} size="sm" variant={days === r.days ? 'default' : 'ghost'}
            className="h-7 px-2.5 text-xs" onClick={() => setDays(r.days)}>
            {r.label}
          </Button>
        ))}
      </div>

      {/* K 線主圖 + 均線 */}
      <ResponsiveContainer width="100%" height={300}>
        <ComposedChart data={chartData} margin={{ top: 5, right: 5, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#333" opacity={0.3} />
          <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#888' }} tickLine={false}
            interval={Math.max(Math.floor(chartData.length / 8), 1)} />
          <YAxis domain={[minPrice, maxPrice]} tick={{ fontSize: 9, fill: '#888' }}
            tickLine={false} tickFormatter={(v: number) => v.toFixed(0)} />
          <Tooltip
            contentStyle={{ background: '#1a1a2e', border: '1px solid #333', borderRadius: '8px', fontSize: 11, color: '#eee' }}
            formatter={(v: any, name: string) => {
              if (name === 'range') return [null, null]
              if (typeof v === 'number') return [v.toLocaleString(), name]
              return [v, name]
            }}
            labelFormatter={(label: string, items: any[]) => {
              const d = items?.[0]?.payload
              if (!d) return label
              return `${label}  O:${d.open} H:${d.high} L:${d.low} C:${d.close}`
            }}
          />
          <Legend
            verticalAlign="top" height={24}
            formatter={(value: string) => <span style={{ fontSize: 10, color: '#aaa' }}>{value}</span>}
          />
          {/* Candlestick body + wick */}
          <Bar dataKey="range" barSize={Math.min(8, Math.max(2, 500 / chartData.length))}
            legendType="none"
            shape={(props: any) => {
              const { x, width, payload } = props
              if (!payload?.open || !payload?.close) return null
              const { open, close, high, low } = payload
              const isUp = close >= open
              const color = isUp ? '#ef4444' : '#22c55e'

              const yAxisHeight = 290
              const priceRange = maxPrice - minPrice
              const toY = (price: number) => 5 + (1 - (price - minPrice) / priceRange) * yAxisHeight

              const yHigh = toY(high)
              const yLow = toY(low)
              const yOpen = toY(open)
              const yClose = toY(close)
              const yBodyTop = Math.min(yOpen, yClose)
              const yBodyHeight = Math.max(Math.abs(yOpen - yClose), 1)
              const cx = x + width / 2

              return (
                <g>
                  <line x1={cx} y1={yHigh} x2={cx} y2={yLow} stroke={color} strokeWidth={1} />
                  <rect x={x} y={yBodyTop} width={width} height={yBodyHeight}
                    fill={color} fillOpacity={isUp ? 1 : 0.5} stroke={color} strokeWidth={0.5} />
                </g>
              )
            }}
          />
          {/* 均線 — 只顯示期間內有足夠資料的 MA */}
          {MA_CONFIGS.filter(ma => ma.period <= days).map(ma => (
            <Line key={ma.label} type="monotone" dataKey={ma.label} name={ma.label}
              stroke={ma.color} strokeWidth={1.2} dot={false}
              connectNulls={false} strokeOpacity={0.85} />
          ))}
        </ComposedChart>
      </ResponsiveContainer>

      {/* 成交量 */}
      <ResponsiveContainer width="100%" height={60}>
        <ComposedChart data={chartData} margin={{ top: 0, right: 5, bottom: 0, left: 0 }}>
          <XAxis dataKey="date" hide />
          <YAxis domain={[0, maxVol * 1.2]} hide />
          <Bar dataKey="volume" barSize={Math.min(6, Math.max(1, 400 / chartData.length))}>
            {chartData.map((entry, i) => (
              <Cell key={i} fill={entry.close >= entry.open ? '#ef444480' : '#22c55e80'} />
            ))}
          </Bar>
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}
