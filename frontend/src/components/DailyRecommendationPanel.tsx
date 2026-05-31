import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { BarChart3, Network, ShieldCheck } from 'lucide-react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  Treemap,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts'
import { Badge } from '@/components/ui/badge'
import { paperApi, recommendationsApi } from '@/lib/api'
import { cn } from '@/lib/utils'
import { formatTwDateTimeShort } from '@/lib/twTime'

type FlowRow = {
  sector?: string
  name?: string
  total_net?: number
  stock_count?: number
  quadrant?: string
  rs_ratio?: number
  rs_momentum?: number
  created_at?: string
}

type StockFlowRow = {
  symbol?: string
  name?: string
  net_amount?: number
}

const FLOW_REFRESH_MS = 30 * 60 * 1000
const MIN_NET = 0.1

function twToday(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
}

function flowName(row: FlowRow): string {
  return row.sector ?? row.name ?? 'unknown'
}

function fmtNet(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  const abs = Math.abs(value)
  const prefix = value > 0 ? '+' : ''
  if (abs < 0.01 && abs > 0) return `${prefix}${Math.round(value * 10000)} wan`
  return `${prefix}${value.toFixed(abs >= 10 ? 0 : 2)} B`
}

function flowTone(value: number): string {
  if (value > 0) return 'text-rose-300'
  if (value < 0) return 'text-emerald-300'
  return 'text-slate-300'
}

function flowFill(value: number): string {
  if (value > 0) return '#fb7185'
  if (value < 0) return '#34d399'
  return '#94a3b8'
}

function staleDate(payload: any): string | undefined {
  return payload?.stale ? payload?.stale_date : payload?.date
}

function ThemeFlowStaleNotice({ data, label }: { data: any; label: string }) {
  if (!data) return null
  const actualDate = staleDate(data)
  const requestedDate = data.requested_date ?? data.date
  const updatedAt = data.flows?.[0]?.created_at ?? data.stocks?.[0]?.created_at
  return (
    <div className={cn(
      'rounded-xl border px-3 py-2 text-[11px] leading-5',
      data.stale
        ? 'border-[#d6a85f]/30 bg-[#d6a85f]/10 text-[#f1c16f]'
        : 'border-emerald-500/20 bg-emerald-500/5 text-emerald-200',
    )}>
      <span className="font-medium">{label}</span>
      <span className="ml-2 text-[#a8b6c5]">
        data {actualDate ?? '-'} / requested {requestedDate ?? '-'}
        {updatedAt ? ` / updated ${formatTwDateTimeShort(updatedAt)}` : ''}
      </span>
    </div>
  )
}

function FlowTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: any }> }) {
  const row = payload?.[0]?.payload
  if (!active || !row) return null
  return (
    <div className="border border-[#263247] bg-[#070a10] px-3 py-2 text-xs text-[#d7e0ea] shadow-xl">
      <div className="font-semibold">{row.name}</div>
      <div className="mt-1 font-mono text-[#9badbf]">net {fmtNet(row.net)}</div>
      {row.quadrant && <div className="font-mono text-[#9badbf]">RRG {row.quadrant}</div>}
      {row.stockCount != null && <div className="font-mono text-[#9badbf]">pool {row.stockCount}</div>}
    </div>
  )
}

function FlowBarList({ rows, title }: { rows: FlowRow[]; title: string }) {
  const maxAbs = Math.max(...rows.map((row) => Math.abs(row.total_net ?? 0)), 1)
  return (
    <div className="space-y-2">
      <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-[#70809b]">{title}</div>
      {rows.length ? rows.map((row) => {
        const net = row.total_net ?? 0
        const pct = Math.max(4, Math.min(100, Math.abs(net) / maxAbs * 100))
        return (
          <div key={`${title}-${flowName(row)}`} className="grid gap-2 rounded-xl border border-[#263247] bg-[#05070c] p-3 sm:grid-cols-[132px_minmax(0,1fr)_74px] sm:items-center">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-[#f2ead8]">{flowName(row)}</div>
              <div className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-[#70809b]">{row.quadrant ?? 'flow'}</div>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-[#172033]">
              <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: flowFill(net) }} />
            </div>
            <div className={cn('font-mono text-xs tabular-nums', flowTone(net))}>{fmtNet(net)}</div>
          </div>
        )
      }) : (
        <div className="rounded-xl border border-[#263247] bg-[#05070c] p-4 text-xs text-[#70809b]">No matching flow.</div>
      )}
    </div>
  )
}

function TreemapContent(props: any) {
  const { x, y, width, height, name, net } = props
  if (width < 46 || height < 24) return null
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx={4}
        fill={net >= 0 ? 'rgba(251,113,133,0.62)' : 'rgba(52,211,153,0.58)'}
        stroke="rgba(255,255,255,0.12)"
      />
      <text x={x + width / 2} y={y + height / 2 - 3} textAnchor="middle" fill="white" fontSize={width < 70 ? 9 : 11} fontWeight={700}>
        {name}
      </text>
      <text x={x + width / 2} y={y + height / 2 + 11} textAnchor="middle" fill="rgba(255,255,255,0.72)" fontSize={9}>
        {fmtNet(net)}
      </text>
    </g>
  )
}

function FlowTreemap({ flows }: { flows: FlowRow[] }) {
  const data = flows
    .slice()
    .sort((a, b) => Math.abs(b.total_net ?? 0) - Math.abs(a.total_net ?? 0))
    .slice(0, 16)
    .map((row) => ({ name: flowName(row), size: Math.max(0.01, Math.abs(row.total_net ?? 0)), net: row.total_net ?? 0 }))
  if (!data.length) return null
  return (
    <div className="h-48 rounded-xl border border-[#263247] bg-[#05070c] p-2">
      <ResponsiveContainer width="100%" height="100%">
        <Treemap data={data} dataKey="size" aspectRatio={4 / 3} content={<TreemapContent />} />
      </ResponsiveContainer>
    </div>
  )
}

function StockCloud({ stocks }: { stocks: StockFlowRow[] }) {
  const unique = useMemo(() => {
    const seen = new Set<string>()
    return stocks
      .slice()
      .sort((a, b) => Math.abs(b.net_amount ?? 0) - Math.abs(a.net_amount ?? 0))
      .filter((row) => {
        const key = row.symbol ?? row.name ?? ''
        if (!key || seen.has(key)) return false
        seen.add(key)
        return true
      })
      .slice(0, 24)
  }, [stocks])
  if (!unique.length) return null
  const maxAbs = Math.max(...unique.map((row) => Math.abs(row.net_amount ?? 0)), 1)
  return (
    <div className="flex flex-wrap gap-2">
      {unique.map((row) => {
        const net = row.net_amount ?? 0
        const ratio = Math.abs(net) / maxAbs
        return (
          <Badge
            key={`${row.symbol ?? row.name}-${net}`}
            variant="outline"
            className={cn(
              'rounded-full border-[#263247] bg-[#05070c] px-2.5 py-1 font-mono text-[10px]',
              net >= 0 ? 'text-rose-200' : 'text-emerald-200',
            )}
            style={{ opacity: 0.55 + ratio * 0.45 }}
          >
            {row.name ?? row.symbol ?? 'stock'} {fmtNet(net)}
          </Badge>
        )
      })}
    </div>
  )
}

function RrgScatterChart({ flows }: { flows: FlowRow[] }) {
  const data = flows
    .filter((row) => row.rs_ratio != null && row.rs_momentum != null)
    .map((row) => ({
      name: flowName(row),
      x: row.rs_ratio,
      y: row.rs_momentum,
      z: Math.max(1, Math.abs(row.total_net ?? 1)),
      quadrant: row.quadrant ?? 'unknown',
      net: row.total_net ?? 0,
    }))
  if (!data.length) {
    return <div className="rounded-xl border border-[#263247] bg-[#05070c] p-4 text-xs text-[#70809b]">RRG data is not available yet.</div>
  }
  return (
    <div className="h-80 rounded-xl border border-[#263247] bg-[#05070c] p-3">
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart margin={{ top: 16, right: 18, bottom: 22, left: 4 }}>
          <CartesianGrid stroke="rgba(148,163,184,0.12)" />
          <XAxis type="number" dataKey="x" name="RS" tick={{ fill: '#70809b', fontSize: 11 }} tickLine={false} axisLine={{ stroke: '#263247' }} />
          <YAxis type="number" dataKey="y" name="Momentum" tick={{ fill: '#70809b', fontSize: 11 }} tickLine={false} axisLine={{ stroke: '#263247' }} />
          <ZAxis type="number" dataKey="z" range={[46, 280]} />
          <ReferenceLine x={100} stroke="rgba(255,255,255,0.25)" strokeDasharray="4 4" />
          <ReferenceLine y={0} stroke="rgba(255,255,255,0.25)" strokeDasharray="4 4" />
          <Tooltip cursor={{ strokeDasharray: '3 3' }} content={<FlowTooltip />} />
          <Scatter data={data}>
            {data.map((row) => <Cell key={row.name} fill={flowFill(row.net)} fillOpacity={0.82} />)}
          </Scatter>
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  )
}

function QuadrantFilterLog() {
  const today = twToday()
  const { data } = useQuery({
    queryKey: ['paper', 'quadrant-filter', today],
    queryFn: () => paperApi.quadrantFilter(today),
    staleTime: FLOW_REFRESH_MS,
  })
  const log = Array.isArray(data?.log) ? data.log.slice(0, 8) : []
  if (!log.length) return null
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-[#70809b]">
        <ShieldCheck className="h-3.5 w-3.5 text-[#ffd87f]" />
        T2 quadrant filter
      </div>
      {log.map((entry: any, index: number) => (
        <div key={`${entry.symbol ?? index}-${entry.action ?? 'action'}`} className="flex items-center gap-2 rounded-xl border border-[#263247] bg-[#05070c] px-3 py-2 text-xs">
          <span className="w-14 font-mono text-[#f2ead8]">{entry.symbol ?? '-'}</span>
          <span className="min-w-0 flex-1 truncate text-[#a8b6c5]">{entry.name ?? entry.reason ?? '-'}</span>
          <Badge variant="outline" className="border-[#263247] text-[10px] text-[#d7e0ea]">{entry.quadrant ?? '-'}</Badge>
          <span className={cn('w-18 text-right font-mono text-[10px]', entry.action === 'PASS' ? 'text-emerald-300' : entry.action === 'REJECT' ? 'text-rose-300' : 'text-amber-300')}>
            {entry.action ?? '-'}
          </span>
        </div>
      ))}
    </div>
  )
}

function useThemeFlowData() {
  const today = twToday()
  const theme = useQuery({
    queryKey: ['recommendations', 'sector-flow', 'theme', today],
    queryFn: () => recommendationsApi.sectorFlow(undefined, 'theme'),
    staleTime: FLOW_REFRESH_MS,
  })
  const stocks = useQuery({
    queryKey: ['recommendations', 'sector-flow-stocks', 'top', today],
    queryFn: () => recommendationsApi.sectorFlowStocks(undefined, 'top'),
    staleTime: FLOW_REFRESH_MS,
  })
  const flows = Array.isArray(theme.data?.flows) ? theme.data.flows as FlowRow[] : []
  const stockRows = Array.isArray(stocks.data?.stocks) ? stocks.data.stocks as StockFlowRow[] : []
  return { today, theme, stocks, flows, stockRows }
}

export function ThemeFlowPanel() {
  const { theme, flows, stockRows } = useThemeFlowData()
  const buyRows = flows.filter((row) => (row.total_net ?? 0) > MIN_NET).slice(0, 10)
  const sellRows = flows.filter((row) => (row.total_net ?? 0) < -MIN_NET).sort((a, b) => (a.total_net ?? 0) - (b.total_net ?? 0)).slice(0, 10)
  const chartRows = flows.slice(0, 12).map((row) => ({
    name: flowName(row),
    net: row.total_net ?? 0,
    quadrant: row.quadrant,
    stockCount: row.stock_count,
  }))

  return (
    <div className="rounded-2xl border border-[#3a3125] bg-[#171714]/80 p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-medium text-[#fff7e8]">
            <BarChart3 className="h-4 w-4 text-[#d6a85f]" />
            Theme Flow Visual Map
          </h3>
          <p className="mt-1 text-xs text-[#8b9bab]">Aggregate theme flow only; no Bot target subset is exposed here.</p>
        </div>
        <Badge variant="outline" className="border-[#d6a85f]/30 text-[10px] text-[#f1c16f]">visual</Badge>
      </div>
      <div className="space-y-4">
        <ThemeFlowStaleNotice data={theme.data} label="theme flow" />
        {theme.isLoading ? (
          <div className="space-y-2">{[1, 2, 3, 4].map((i) => <div key={i} className="h-6 animate-pulse rounded bg-muted/40" />)}</div>
        ) : flows.length === 0 ? (
          <div className="rounded-xl border border-[#263247] bg-[#05070c] p-4 text-xs text-[#70809b]">No theme flow data for this session.</div>
        ) : (
          <>
            <div className="h-72 rounded-xl border border-[#263247] bg-[#05070c] p-3">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartRows} layout="vertical" margin={{ top: 8, right: 20, bottom: 8, left: 8 }}>
                  <CartesianGrid stroke="rgba(148,163,184,0.12)" horizontal={false} />
                  <XAxis type="number" tick={{ fill: '#70809b', fontSize: 11 }} tickLine={false} axisLine={{ stroke: '#263247' }} />
                  <YAxis dataKey="name" type="category" width={96} tick={{ fill: '#a8b6c5', fontSize: 11 }} tickLine={false} axisLine={false} />
                  <Tooltip cursor={{ fill: 'rgba(148,163,184,0.06)' }} content={<FlowTooltip />} />
                  <Bar dataKey="net" radius={[4, 4, 4, 4]} barSize={14}>
                    {chartRows.map((row) => <Cell key={row.name} fill={flowFill(row.net)} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <FlowTreemap flows={flows} />
            <StockCloud stocks={stockRows} />
            <div className="grid gap-3 lg:grid-cols-2">
              <FlowBarList rows={buyRows} title="Top positive themes" />
              <FlowBarList rows={sellRows} title="Top negative themes" />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export function BotThemeFlowPanel() {
  const { theme, flows } = useThemeFlowData()
  return (
    <div className="rounded-2xl border border-[#3a3125] bg-[#171714]/80 p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-medium text-[#fff7e8]">
            <Network className="h-4 w-4 text-[#d6a85f]" />
            Bot Theme Flow Context
          </h3>
          <p className="mt-1 text-xs text-[#8b9bab]">Private context panel for execution review; not a fallback recommendation list.</p>
        </div>
        <Badge variant="outline" className="border-fuchsia-400/30 text-[10px] text-fuchsia-100">bot context</Badge>
      </div>
      <div className="space-y-4">
        <ThemeFlowStaleNotice data={theme.data} label="bot theme flow" />
        {theme.isLoading ? (
          <div className="space-y-2">{[1, 2, 3, 4].map((i) => <div key={i} className="h-6 animate-pulse rounded bg-muted/40" />)}</div>
        ) : flows.length === 0 ? (
          <div className="rounded-xl border border-[#263247] bg-[#05070c] p-4 text-xs text-[#70809b]">No theme flow data for Bot context.</div>
        ) : (
          <>
            <RrgScatterChart flows={flows} />
            <QuadrantFilterLog />
          </>
        )}
      </div>
    </div>
  )
}
