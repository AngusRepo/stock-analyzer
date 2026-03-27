import { useQuery } from '@tanstack/react-query'
import { stocksApi } from '@/lib/api'
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell } from 'recharts'
import { Skeleton } from '@/components/ui/skeleton'
import { format } from 'date-fns'

export default function ChipChart({ stockId }: { stockId: number }) {
  const { data: chips = [], isLoading } = useQuery({
    queryKey: ['stocks', stockId, 'chips'],
    queryFn: () => stocksApi.chips(stockId, 30),
    enabled: !!stockId,
  })

  if (isLoading) return <Skeleton className="h-48 w-full" />
  if (!chips.length) return <div className="h-48 flex items-center justify-center text-sm text-muted-foreground">暫無籌碼資料（僅台股）</div>

  const latest = chips[chips.length - 1] as any
  // D1 存的是股數，顯示轉換為張（1 張 = 1000 股）
  const toLots = (v: number | null) => v != null ? Math.round(v / 1000) : null
  const chartData = (chips as any[]).slice(-20).map(c => ({
    date: format(new Date(c.date), 'MM/dd'),
    foreign: toLots(c.foreign_net) ?? 0,
    trust: toLots(c.trust_net) ?? 0,
    dealer: toLots(c.dealer_net) ?? 0,
  }))

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3 text-sm">
        {[
          { label: '外資買賣超', value: toLots(latest.foreign_net) },
          { label: '投信買賣超', value: toLots(latest.trust_net) },
          { label: '自營商買賣超', value: toLots(latest.dealer_net) },
        ].map(item => (
          <div key={item.label} className="rounded-lg border border-border/50 p-3">
            <p className="text-xs text-muted-foreground">{item.label}</p>
            <p className={`text-lg font-mono font-bold ${(item.value ?? 0) >= 0 ? 'text-red-400' : 'text-emerald-400'}`}>
              {item.value != null ? `${item.value > 0 ? '+' : ''}${item.value.toLocaleString()}` : '—'}
            </p>
            <p className="text-xs text-muted-foreground">張</p>
          </div>
        ))}
      </div>
      <ResponsiveContainer width="100%" height={160}>
        <BarChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="#333" opacity={0.3} />
          <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#888' }} tickLine={false} interval={3} />
          <YAxis tick={{ fontSize: 10, fill: '#888' }} tickLine={false} />
          <Tooltip contentStyle={{ background: '#1a1a2e', border: '1px solid #333', fontSize: 12 }} />
          <Bar dataKey="foreign" name="外資" radius={[2, 2, 0, 0]}>
            {chartData.map((d, i) => <Cell key={i} fill={d.foreign >= 0 ? '#f87171' : '#34d399'} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
