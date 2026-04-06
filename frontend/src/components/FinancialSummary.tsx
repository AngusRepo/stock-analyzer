import { useQuery } from '@tanstack/react-query'
import { stocksApi } from '@/lib/api'
import { Skeleton } from '@/components/ui/skeleton'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  AreaChart, Area, CartesianGrid, ReferenceLine,
} from 'recharts'

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

// ── PE River helpers ──────────────────────────────────────────────────────────
const PE_ZONES = [
  { key: 'zone0_10', from: 0,  to: 10, color: '#166534', label: 'PE < 10 偏低' },
  { key: 'zone10_15', from: 10, to: 15, color: '#4ade80', label: 'PE 10-15' },
  { key: 'zone15_20', from: 15, to: 20, color: '#facc15', label: 'PE 15-20 合理' },
  { key: 'zone20_25', from: 20, to: 25, color: '#fb923c', label: 'PE 20-25' },
  { key: 'zone25_30', from: 25, to: 30, color: '#f87171', label: 'PE > 25 偏高' },
]

function buildPeRiverData(financials: any[]) {
  // financials is DESC order — reverse for chart
  const sorted = [...financials].reverse()
  return sorted
    .filter((f: any) => f.pe != null && f.period && /Q\d$/.test(f.period))
    .map((f: any) => {
      const pe = f.pe as number
      const row: any = { period: f.period, pe }
      // Build stacked zones: each zone's height is how much of PE falls within that band
      PE_ZONES.forEach(z => {
        if (pe <= z.from) {
          row[z.key] = 0
        } else if (pe >= z.to) {
          row[z.key] = z.to - z.from
        } else {
          row[z.key] = pe - z.from
        }
      })
      return row
    })
}

// ── Revenue chart helpers ─────────────────────────────────────────────────────
function buildRevenueChartData(monthlyRevenue: any[]) {
  // monthlyRevenue is DESC — reverse for chronological
  const sorted = [...monthlyRevenue].reverse()
  return sorted.map((r: any) => {
    const dateStr = r.date?.slice(0, 7) ?? r.period ?? ''
    const month = dateStr ? parseInt(dateStr.split('-')[1], 10) : 0
    return {
      month: month ? `${month}月` : dateStr,
      revenue: r.revenue ? +(r.revenue / 1e8).toFixed(2) : 0,
      rawRevenue: r.revenue,
      yoy: r.revenue_yoy,
      mom: r.revenue_mom,
    }
  })
}

// ── Custom Tooltip components ─────────────────────────────────────────────────
function RevenueTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload
  return (
    <div className="bg-card border border-border rounded-md px-3 py-2 text-xs shadow-lg">
      <p className="font-medium mb-1">{d.month}</p>
      <p>營收：<span className="font-mono">{d.rawRevenue ? fmt(d.rawRevenue) : '—'}</span></p>
      <p>MoM：<span className={`font-mono ${pctClass(d.mom)}`}>
        {d.mom != null ? `${d.mom > 0 ? '+' : ''}${d.mom.toFixed(1)}%` : '—'}
      </span></p>
      <p>YoY：<span className={`font-mono ${pctClass(d.yoy)}`}>
        {d.yoy != null ? `${d.yoy > 0 ? '+' : ''}${d.yoy.toFixed(1)}%` : '—'}
      </span></p>
    </div>
  )
}

function PeTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload
  if (!d) return null
  return (
    <div className="bg-card border border-border rounded-md px-3 py-2 text-xs shadow-lg">
      <p className="font-medium mb-1">{d.period}</p>
      <p>P/E：<span className="font-mono">{d.pe?.toFixed(2)}</span></p>
    </div>
  )
}

// ── Custom bar label ──────────────────────────────────────────────────────────
function YoYLabel(props: any) {
  const { x, y, width, value } = props
  const d = props.payload
  if (d?.yoy == null) return null
  const yoy = d.yoy
  return (
    <text
      x={x + width / 2}
      y={y - 4}
      textAnchor="middle"
      fontSize={9}
      fill={yoy > 0 ? '#f87171' : '#4ade80'}
      className="font-mono"
    >
      {yoy > 0 ? '+' : ''}{yoy.toFixed(1)}%
    </text>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
export default function FinancialSummary({ stockId }: { stockId: number }) {
  const { data: financials = [], isLoading } = useQuery({
    queryKey: ['stocks', stockId, 'financials'],
    queryFn: () => stocksApi.financials(stockId, 20),
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

  // Chart data
  const revenueChartData = buildRevenueChartData(monthlyRevenue as any[])
  const peRiverData = buildPeRiverData(financials as any[])

  // Latest revenue for subtitle
  const latestRev = (monthlyRevenue as any[])[0]
  const latestRevStr = latestRev?.revenue ? fmt(latestRev.revenue) : null
  const latestYoY = latestRev?.revenue_yoy

  return (
    <div className="space-y-6">
      {/* ─── 1. 季度財報 ─── */}
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

      {/* ─── 2. 本益比河流圖 ─── */}
      {peRiverData.length > 2 && (
        <div>
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">本益比河流圖</h4>
          <p className="text-[10px] text-muted-foreground mb-2">
            近 {peRiverData.length} 季 P/E 估值區間
            {latest?.pe != null && (
              <span className="ml-2 font-mono">
                目前 P/E：<span className={latest.pe > 25 ? 'text-red-400' : latest.pe < 10 ? 'text-green-400' : 'text-foreground'}>{latest.pe.toFixed(1)}</span>
              </span>
            )}
          </p>
          <div className="rounded-md border border-border/30 bg-card p-2">
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={peRiverData} margin={{ top: 8, right: 8, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border)/0.3)" />
                <XAxis
                  dataKey="period"
                  tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))' }}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))' }}
                  domain={[0, 'auto']}
                />
                <Tooltip content={<PeTooltip />} />
                {PE_ZONES.map(z => (
                  <Area
                    key={z.key}
                    type="monotone"
                    dataKey={z.key}
                    stackId="1"
                    stroke="none"
                    fill={z.color}
                    fillOpacity={0.6}
                  />
                ))}
                {/* Actual PE line overlay */}
                <Area
                  type="monotone"
                  dataKey="pe"
                  stroke="#fff"
                  strokeWidth={2}
                  fill="none"
                  dot={{ r: 2.5, fill: '#fff', stroke: '#fff' }}
                />
                {latest?.pe != null && (
                  <ReferenceLine y={latest.pe} stroke="#fbbf24" strokeDasharray="4 4" strokeWidth={1} />
                )}
              </AreaChart>
            </ResponsiveContainer>
            {/* Legend */}
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1.5 px-1">
              {PE_ZONES.map(z => (
                <div key={z.key} className="flex items-center gap-1 text-[9px] text-muted-foreground">
                  <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: z.color, opacity: 0.7 }} />
                  {z.label}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ─── 3. 月營收趨勢 Bar Chart ─── */}
      {revenueChartData.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">月營收趨勢</h4>
          <p className="text-[10px] text-muted-foreground mb-2">
            {latestRevStr && <>最新月營收：<span className="font-mono">{latestRevStr}</span></>}
            {latestYoY != null && (
              <span className={`ml-2 font-mono ${pctClass(latestYoY)}`}>
                YoY {latestYoY > 0 ? '+' : ''}{latestYoY.toFixed(1)}%
              </span>
            )}
          </p>
          <div className="rounded-md border border-border/30 bg-card p-2">
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={revenueChartData} margin={{ top: 16, right: 8, left: -10, bottom: 0 }}>
                <XAxis
                  dataKey="month"
                  tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                />
                <YAxis
                  tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))' }}
                  tickFormatter={(v: number) => `${v}億`}
                />
                <Tooltip content={<RevenueTooltip />} cursor={{ fill: 'hsl(var(--muted-foreground)/0.08)' }} />
                <Bar dataKey="revenue" radius={[3, 3, 0, 0]} label={<YoYLabel />}>
                  {revenueChartData.map((d, i) => (
                    <Cell key={i} fill={d.yoy != null && d.yoy > 0 ? '#f87171' : '#4ade80'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* ─── 4. 近12月營收 Table (existing) ─── */}
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
