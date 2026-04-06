import { useQuery } from '@tanstack/react-query'
import { stocksApi } from '@/lib/api'
import {
  ResponsiveContainer, ComposedChart, Area, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'
import { Skeleton } from '@/components/ui/skeleton'
import { format } from 'date-fns'

export default function MarginChart({ stockId }: { stockId: number }) {
  const { data: raw = [], isLoading } = useQuery({
    queryKey: ['stocks', stockId, 'margin'],
    queryFn: () => stocksApi.margin(stockId, 60),
    enabled: !!stockId,
  })

  if (isLoading) return <Skeleton className="h-[250px] w-full" />
  if (!raw.length) return (
    <div className="h-[250px] flex items-center justify-center text-sm text-muted-foreground">
      暫無融資融券資料
    </div>
  )

  // API returns DESC order — reverse to chronological
  const chartData = [...raw].reverse().map((d: any) => ({
    date: format(new Date(d.date), 'MM/dd'),
    marginBalance: d.margin_balance,
    shortBalance: d.short_balance,
    marginUsagePct: d.margin_usage_pct,
  }))

  const latest = raw[0] as any

  return (
    <div className="space-y-3">
      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-3 text-sm">
        <div className="rounded-lg border border-border/50 p-3">
          <p className="text-xs text-muted-foreground">融資餘額</p>
          <p className="text-lg font-mono font-bold text-blue-400">
            {latest.margin_balance?.toLocaleString() ?? '—'}
          </p>
          <p className="text-xs text-muted-foreground">張</p>
        </div>
        <div className="rounded-lg border border-border/50 p-3">
          <p className="text-xs text-muted-foreground">融券餘額</p>
          <p className="text-lg font-mono font-bold text-orange-400">
            {latest.short_balance?.toLocaleString() ?? '—'}
          </p>
          <p className="text-xs text-muted-foreground">張</p>
        </div>
        <div className="rounded-lg border border-border/50 p-3">
          <p className="text-xs text-muted-foreground">融資使用率</p>
          <p className="text-lg font-mono font-bold text-purple-400">
            {latest.margin_usage_pct != null ? `${latest.margin_usage_pct.toFixed(1)}%` : '—'}
          </p>
          <p className="text-xs text-muted-foreground">
            券資比 {latest.short_ratio != null ? `${(latest.short_ratio * 100).toFixed(1)}%` : '—'}
          </p>
        </div>
      </div>

      {/* Composed chart: margin balance (area, left Y) + short balance (area, right Y) + usage % (line) */}
      <ResponsiveContainer width="100%" height={200}>
        <ComposedChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="#333" opacity={0.3} />
          <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#888' }} tickLine={false} interval={Math.max(0, Math.floor(chartData.length / 8) - 1)} />
          <YAxis
            yAxisId="left"
            tick={{ fontSize: 10, fill: '#888' }}
            tickLine={false}
            tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)}
          />
          <YAxis
            yAxisId="right"
            orientation="right"
            tick={{ fontSize: 10, fill: '#888' }}
            tickLine={false}
            tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)}
          />
          <Tooltip
            contentStyle={{ background: '#1a1a2e', border: '1px solid #333', fontSize: 12 }}
            formatter={(value: number, name: string) => {
              if (name === '融資使用率') return [`${value?.toFixed(1)}%`, name]
              return [value?.toLocaleString(), name]
            }}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Area
            yAxisId="left"
            type="monotone"
            dataKey="marginBalance"
            name="融資餘額"
            stroke="#60a5fa"
            fill="#60a5fa"
            fillOpacity={0.15}
            strokeWidth={1.5}
          />
          <Area
            yAxisId="right"
            type="monotone"
            dataKey="shortBalance"
            name="融券餘額"
            stroke="#fb923c"
            fill="#fb923c"
            fillOpacity={0.15}
            strokeWidth={1.5}
          />
          <Line
            yAxisId="left"
            type="monotone"
            dataKey="marginUsagePct"
            name="融資使用率"
            stroke="#a78bfa"
            strokeWidth={1.5}
            dot={false}
            strokeDasharray="4 2"
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}
