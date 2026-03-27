import { useQuery } from '@tanstack/react-query'
import { stocksApi } from '@/lib/api'
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { useState } from 'react'
import { format } from 'date-fns'

const RANGES = [{ label: '1M', days: 30 }, { label: '3M', days: 90 }, { label: '6M', days: 180 }, { label: '1Y', days: 365 }, { label: '2Y', days: 730 }]

export default function StockPriceChart({ stockId }: { stockId: number }) {
  const [days, setDays] = useState(180)

  const { data: prices = [], isLoading } = useQuery({
    queryKey: ['stocks', stockId, 'prices', days],
    queryFn: () => stocksApi.prices(stockId, days),
    enabled: !!stockId,
  })

  const { data: indicators = [] } = useQuery({
    queryKey: ['stocks', stockId, 'indicators', days],
    queryFn: () => stocksApi.indicators(stockId, days),
    enabled: !!stockId,
  })

  if (isLoading) return <Skeleton className="h-64 w-full" />

  const indMap = new Map((indicators as any[]).map(i => [i.date?.split('T')[0], i]))

  const chartData = (prices as any[]).map(p => {
    const dateKey = p.date?.split('T')[0]
    const ind = indMap.get(dateKey)
    return {
      date: format(new Date(p.date), 'MM/dd'),
      close: p.close ? Math.round(p.close * 100) / 100 : null,
      ma20: ind?.ma20 ? Math.round(ind.ma20 * 100) / 100 : null,
      ma60: ind?.ma60 ? Math.round(ind.ma60 * 100) / 100 : null,
    }
  })

  const minVal = Math.min(...chartData.map(d => d.close ?? Infinity)) * 0.98
  const maxVal = Math.max(...chartData.map(d => d.close ?? 0)) * 1.02

  return (
    <div className="space-y-3">
      <div className="flex gap-1">
        {RANGES.map(r => (
          <Button key={r.label} size="sm" variant={days === r.days ? 'default' : 'ghost'}
            className="h-7 px-2.5 text-xs" onClick={() => setDays(r.days)}>
            {r.label}
          </Button>
        ))}
      </div>
      <ResponsiveContainer width="100%" height={260}>
        <AreaChart data={chartData}>
          <defs>
            <linearGradient id="colorClose" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#22c55e" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#333" opacity={0.3} />
          <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#888' }} tickLine={false} interval={Math.floor(chartData.length / 6)} />
          <YAxis domain={[minVal, maxVal]} tick={{ fontSize: 10, fill: '#888' }} tickLine={false} tickFormatter={v => v.toFixed(0)} />
          <Tooltip contentStyle={{ background: '#1a1a2e', border: '1px solid #333', borderRadius: '8px', fontSize: 12, color: '#eee' }} />
          <Area type="monotone" dataKey="close" stroke="#22c55e" strokeWidth={2} fill="url(#colorClose)" dot={false} name="收盤價" />
          <Area type="monotone" dataKey="ma20" stroke="#3b82f6" strokeWidth={1.5} fill="none" dot={false} name="MA20" />
          <Area type="monotone" dataKey="ma60" stroke="#f59e0b" strokeWidth={1.5} fill="none" dot={false} name="MA60" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
