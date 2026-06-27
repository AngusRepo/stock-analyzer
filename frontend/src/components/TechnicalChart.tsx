import { useQuery } from '@tanstack/react-query'
import { stocksApi } from '@/lib/api'
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, Legend } from 'recharts'
import { Skeleton } from '@/components/ui/skeleton'
import { format } from 'date-fns'

export default function TechnicalChart({ stockId }: { stockId: number }) {
  const { data: indicators = [], isLoading } = useQuery({
    queryKey: ['stocks', stockId, 'indicators'],
    queryFn: () => stocksApi.indicators(stockId, 180),
    enabled: !!stockId,
  })

  if (isLoading) return <Skeleton className="h-64 w-full" />
  if (!indicators.length) return <div className="h-64 flex items-center justify-center text-muted-foreground text-sm">暫無技術指標資料</div>

  const latest = indicators[indicators.length - 1] as any

  const rsiData = indicators.map((d: any) => ({
    date: format(new Date(d.date), 'MM/dd'),
    RSI: d.rsi14 ? parseFloat(d.rsi14.toFixed(1)) : null,
  }))

  const macdData = indicators.map((d: any) => ({
    date: format(new Date(d.date), 'MM/dd'),
    MACD: d.macd ? parseFloat(d.macd.toFixed(3)) : null,
    Signal: d.macd_signal ? parseFloat(d.macd_signal.toFixed(3)) : null,
    Hist: d.macd_hist ? parseFloat(d.macd_hist.toFixed(3)) : null,
  }))

  return (
    <div className="space-y-4">
      {/* Latest values */}
      <div className="grid grid-cols-3 gap-3 text-sm">
        <div className="rounded-lg border border-border/50 p-3">
          <p className="text-xs text-muted-foreground mb-1">RSI (14)</p>
          <p className={`text-lg sv-num font-bold ${latest.rsi14 > 70 ? 'text-red-400' : latest.rsi14 < 30 ? 'text-emerald-400' : 'text-foreground'}`}>
            {latest.rsi14?.toFixed(1) ?? '—'}
          </p>
          <p className="text-xs text-muted-foreground">{latest.rsi14 > 70 ? '超買' : latest.rsi14 < 30 ? '超賣' : '中性'}</p>
        </div>
        <div className="rounded-lg border border-border/50 p-3">
          <p className="text-xs text-muted-foreground mb-1">MACD</p>
          <p className={`text-lg sv-num font-bold ${latest.macd_hist > 0 ? 'text-red-400' : 'text-emerald-400'}`}>
            {latest.macd?.toFixed(3) ?? '—'}
          </p>
          <p className="text-xs text-muted-foreground">Signal: {latest.macd_signal?.toFixed(3) ?? '—'}</p>
        </div>
        <div className="rounded-lg border border-border/50 p-3">
          <p className="text-xs text-muted-foreground mb-1">布林通道</p>
          <p className="text-sm sv-num">{latest.bb_upper?.toFixed(2) ?? '—'}</p>
          <p className="text-xs text-muted-foreground">Mid: {latest.bb_mid?.toFixed(2) ?? '—'}</p>
        </div>
      </div>

      {/* RSI Chart */}
      <div>
        <p className="text-xs font-medium text-muted-foreground mb-2">RSI (14)</p>
        <ResponsiveContainer width="100%" height={120}>
          <LineChart data={rsiData.slice(-60)}>
            <CartesianGrid strokeDasharray="3 3" stroke="#333" opacity={0.3} />
            <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#888' }} tickLine={false} interval={9} />
            <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: '#888' }} tickLine={false} />
            <Tooltip contentStyle={{ background: '#1a1a2e', border: '1px solid #333' }} />
            <ReferenceLine y={70} stroke="#ef4444" strokeDasharray="4 4" opacity={0.6} label={{ value: '70', fontSize: 9, fill: '#ef4444' }} />
            <ReferenceLine y={30} stroke="#3b82f6" strokeDasharray="4 4" opacity={0.6} label={{ value: '30', fontSize: 9, fill: '#3b82f6' }} />
            <Line type="monotone" dataKey="RSI" stroke="#22c55e" strokeWidth={1.5} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* MACD Chart */}
      <div>
        <p className="text-xs font-medium text-muted-foreground mb-2">MACD</p>
        <ResponsiveContainer width="100%" height={120}>
          <LineChart data={macdData.slice(-60)}>
            <CartesianGrid strokeDasharray="3 3" stroke="#333" opacity={0.3} />
            <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#888' }} tickLine={false} interval={9} />
            <YAxis tick={{ fontSize: 10, fill: '#888' }} tickLine={false} />
            <Tooltip contentStyle={{ background: '#1a1a2e', border: '1px solid #333' }} />
            <ReferenceLine y={0} stroke="#333" />
            <Line type="monotone" dataKey="MACD" stroke="#22c55e" strokeWidth={1.5} dot={false} />
            <Line type="monotone" dataKey="Signal" stroke="#ef4444" strokeWidth={1.5} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
