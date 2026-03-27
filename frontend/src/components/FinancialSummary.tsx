import { useQuery } from '@tanstack/react-query'
import { stocksApi } from '@/lib/api'
import { Skeleton } from '@/components/ui/skeleton'

function Row({ label, value }: { label: string; value: any }) {
  return (
    <div className="flex justify-between py-2 border-b border-border/30 last:border-0 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono font-medium">{value ?? '—'}</span>
    </div>
  )
}

export default function FinancialSummary({ stockId }: { stockId: number }) {
  const { data: financials = [], isLoading } = useQuery({
    queryKey: ['stocks', stockId, 'financials'],
    queryFn: () => stocksApi.financials(stockId, 4),
    enabled: !!stockId,
  })

  if (isLoading) return <div className="space-y-2">{[...Array(6)].map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}</div>

  const latest = financials[0] as any
  if (!latest) return <div className="text-sm text-muted-foreground text-center py-8">暫無財報資料</div>

  const pct = (v: number | null) => v != null ? `${v.toFixed(2)}%` : null

  return (
    <div>
      <p className="text-xs text-muted-foreground mb-3">最新期別：{latest.period}</p>
      <Row label="EPS" value={latest.eps?.toFixed(2)} />
      <Row label="本益比 (P/E)" value={latest.pe?.toFixed(2)} />
      <Row label="股價淨值比 (P/B)" value={latest.pb?.toFixed(2)} />
      <Row label="殖利率" value={pct(latest.dividend_yield)} />
      <Row label="每股股息" value={latest.dividend_per_share?.toFixed(2)} />
      <Row label="ROE" value={pct(latest.roe)} />
      <Row label="營收成長 (YoY)" value={latest.revenue_growth_yoy != null ? `${latest.revenue_growth_yoy.toFixed(1)}%` : null} />
    </div>
  )
}
