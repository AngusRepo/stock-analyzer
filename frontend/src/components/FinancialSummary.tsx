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

const fmt = (n: number) => n >= 1e8 ? `${(n / 1e8).toFixed(1)}億` : n >= 1e4 ? `${(n / 1e4).toFixed(0)}萬` : `${n}`
const pctClass = (v: number | null) => !v ? '' : v > 0 ? 'text-red-400' : 'text-green-400'

export default function FinancialSummary({ stockId }: { stockId: number }) {
  const { data: financials = [], isLoading } = useQuery({
    queryKey: ['stocks', stockId, 'financials'],
    queryFn: () => stocksApi.financials(stockId, 4),
    enabled: !!stockId,
  })

  const { data: monthlyRevenue = [] } = useQuery({
    queryKey: ['stocks', stockId, 'monthly-revenue'],
    queryFn: () => stocksApi.monthlyRevenue(stockId, 12),
    enabled: !!stockId,
  })

  if (isLoading) return <div className="space-y-2">{[...Array(6)].map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}</div>

  const latest = financials[0] as any
  const pct = (v: number | null) => v != null ? `${v.toFixed(2)}%` : null

  return (
    <div className="space-y-6">
      {/* 季度財報 */}
      {latest ? (
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
      ) : (
        <div className="text-sm text-muted-foreground text-center py-4">
          暫無季度財報
          <a href="https://mops.twse.com.tw/mops/web/t146sb05" target="_blank" rel="noopener noreferrer"
             className="block mt-1 text-xs text-blue-400 hover:underline">
            前往公開資訊觀測站查詢
          </a>
        </div>
      )}

      {/* 逐月營收 */}
      {(monthlyRevenue as any[]).length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">近 12 月營收</h4>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground border-b border-border/30">
                  <th className="text-left py-1.5 pr-2">月份</th>
                  <th className="text-right py-1.5 px-2">營收</th>
                  <th className="text-right py-1.5 px-2">MoM</th>
                  <th className="text-right py-1.5 pl-2">YoY</th>
                </tr>
              </thead>
              <tbody>
                {(monthlyRevenue as any[]).map((r: any, i: number) => (
                  <tr key={i} className="border-b border-border/20 last:border-0">
                    <td className="py-1.5 pr-2 text-muted-foreground">{r.date?.slice(0, 7) ?? r.period}</td>
                    <td className="py-1.5 px-2 text-right font-mono">{r.revenue ? fmt(r.revenue) : '—'}</td>
                    <td className={`py-1.5 px-2 text-right font-mono ${pctClass(r.revenue_mom)}`}>
                      {r.revenue_mom != null ? `${r.revenue_mom > 0 ? '+' : ''}${r.revenue_mom.toFixed(1)}%` : '—'}
                    </td>
                    <td className={`py-1.5 pl-2 text-right font-mono ${pctClass(r.revenue_yoy)}`}>
                      {r.revenue_yoy != null ? `${r.revenue_yoy > 0 ? '+' : ''}${r.revenue_yoy.toFixed(1)}%` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
