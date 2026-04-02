import { useQuery } from '@tanstack/react-query'
import { stocksApi } from '@/lib/api'
import { Skeleton } from '@/components/ui/skeleton'

function Metric({ label, value, hint }: { label: string; value: any; hint?: string }) {
  return (
    <div className="rounded-lg border border-border/50 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-mono font-bold mt-1">{value ?? '—'}</p>
      {hint && <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>}
    </div>
  )
}

export default function RiskMetricsPanel({ stockId }: { stockId: number }) {
  const { data: risk, isLoading } = useQuery({
    queryKey: ['stocks', stockId, 'risk'],
    queryFn: () => stocksApi.risk(stockId, '1y'),
    enabled: !!stockId,
  })

  if (isLoading) return <div className="grid grid-cols-2 gap-3">{[...Array(6)].map((_, i) => <Skeleton key={i} className="h-20" />)}</div>
  if (!risk || (risk as any).empty) return (
    <div className="text-sm text-muted-foreground text-center py-8">
      {(risk as any)?.reason ?? '暫無風險指標'}
    </div>
  )

  const r = risk as any
  return (
    <div className="grid grid-cols-2 gap-3">
      <Metric label="Sharpe Ratio" value={r.sharpe_ratio?.toFixed(3)} hint="越高越好 (>1佳)" />
      <Metric label="Sortino Ratio" value={r.sortino_ratio?.toFixed(3)} />
      <Metric label="Beta" value={r.beta?.toFixed(3)} hint="相對大盤波動" />
      <Metric label="最大回撤" value={r.max_drawdown != null ? `${(r.max_drawdown * 100).toFixed(2)}%` : null} />
      <Metric label="VaR (95%)" value={r.var95 != null ? `${(r.var95 * 100).toFixed(2)}%` : null} hint="1日最大損失" />
      <Metric label="年化波動率" value={r.annual_volatility != null ? `${(r.annual_volatility * 100).toFixed(2)}%` : null} />
    </div>
  )
}
