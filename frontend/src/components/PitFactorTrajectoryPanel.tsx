import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Radar, RotateCcw } from 'lucide-react'
import {
  paperApi,
  recommendationsApi,
  type FactorFlowMapResponse,
  type FactorTrajectoryPoint,
  type FactorTrajectorySeries,
} from '@/lib/api'
import { paperPendingBuysFromPayload, paperPositionsFromPayload } from '@/lib/paperPayload'

const WIDTH = 760
const HEIGHT = 410
const PAD = { left: 60, right: 70, top: 42, bottom: 58 }
const COLORS = ['#67e8f9', '#fbbf24', '#fb7185', '#a78bfa', '#34d399', '#60a5fa', '#f97316', '#e879f9', '#a3e635', '#fda4af', '#22d3ee', '#c4b5fd']
const WINDOW_OPTIONS = [3, 5, 10, 20, 60] as const

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ')
}

function coordinate(point: FactorTrajectoryPoint) {
  const x = PAD.left + (Math.max(0, Math.min(100, Number(point.x))) / 100) * (WIDTH - PAD.left - PAD.right)
  const yValue = Math.max(0, Math.min(100, Number(point.y)))
  const y = HEIGHT - PAD.bottom - (yValue / 100) * (HEIGHT - PAD.top - PAD.bottom)
  return { x, y }
}

function smoothPath(points: FactorTrajectoryPoint[]): string {
  const nodes = points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y)).map(coordinate)
  if (!nodes.length) return ''
  if (nodes.length === 1) return `M ${nodes[0].x} ${nodes[0].y}`
  let path = `M ${nodes[0].x} ${nodes[0].y}`
  for (let index = 0; index < nodes.length - 1; index += 1) {
    const previous = nodes[Math.max(0, index - 1)]
    const current = nodes[index]
    const next = nodes[index + 1]
    const after = nodes[Math.min(nodes.length - 1, index + 2)]
    const control1 = { x: current.x + (next.x - previous.x) / 6, y: current.y + (next.y - previous.y) / 6 }
    const control2 = { x: next.x - (after.x - current.x) / 6, y: next.y - (after.y - current.y) / 6 }
    path += ` C ${control1.x} ${control1.y}, ${control2.x} ${control2.y}, ${next.x} ${next.y}`
  }
  return path
}

function formatPoint(point: FactorTrajectoryPoint, scope: 'group' | 'stock') {
  const delta = scope === 'group' ? point.mean_rank_delta : point.rank_delta
  return [
    point.date,
    `Residual ${point.x.toFixed(1)}`,
    `確認 ${Number(point.y).toFixed(1)}`,
    point.flow == null ? null : `資金擴散 ${point.flow.toFixed(1)}`,
    delta == null ? null : `Δrank ${delta >= 0 ? '+' : ''}${delta.toFixed(2)}`,
  ].filter(Boolean).join(' · ')
}

function pointRadius(point: FactorTrajectoryPoint, latest = false) {
  const residualStrength = Math.min(1, Math.abs(Number(point.x) - 50) / 50)
  const confirmationStrength = Math.min(1, Math.abs(Number(point.y) - 50) / 50)
  return 2.8 + Math.max(residualStrength, confirmationStrength) * 4.2 + (latest ? 1.8 : 0)
}

function pointOpacity(point: FactorTrajectoryPoint) {
  const flow = point.flow == null ? 0.35 : Math.max(0, Math.min(1, Number(point.flow) / 100))
  return 0.18 + flow * 0.68
}

function TrajectoryChart({ series, scope }: { series: FactorTrajectorySeries[]; scope: 'group' | 'stock' }) {
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const [replayKey, setReplayKey] = useState(0)
  const [hovered, setHovered] = useState<{ label: string; point: FactorTrajectoryPoint } | null>(null)
  const visible = focusKey ? series.filter((item) => item.key === focusKey) : series

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setFocusKey(null)}
          aria-pressed={focusKey == null}
          className={cx(
            'rounded-full border px-2.5 py-1 text-[11px] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70',
            focusKey == null ? 'border-cyan-300/35 bg-cyan-300/10 text-cyan-100' : 'border-white/10 text-slate-400 hover:text-slate-200',
          )}
        >
          全部
        </button>
        {series.map((item, index) => (
          <button
            type="button"
            key={item.key}
            onClick={() => setFocusKey((current) => current === item.key ? null : item.key)}
            aria-pressed={focusKey === item.key}
            className={cx(
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70',
              focusKey === item.key ? 'border-white/25 bg-white/10 text-white' : 'border-white/[0.07] text-slate-400 hover:border-white/15 hover:text-slate-200',
            )}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: COLORS[index % COLORS.length] }} />
            {item.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setReplayKey((value) => value + 1)}
          className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-white/10 px-2.5 py-1 text-[11px] font-semibold text-slate-300 transition hover:border-cyan-300/30 hover:text-cyan-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70"
        >
          <RotateCcw className="h-3 w-3" />重播路徑
        </button>
      </div>

      <div className="relative overflow-hidden rounded-2xl border border-white/[0.07] bg-[#090d14]">
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="block h-auto min-h-[330px] w-full" role="img" aria-label="PIT residual 與族群廣度資金擴散的近期軌跡圖">
          <style>{`
            @keyframes sv-factor-trace { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
            @media (prefers-reduced-motion: reduce) { .sv-factor-path { animation: none !important; stroke-dashoffset: 0 !important; } .sv-factor-head { display: none; } }
          `}</style>
          <rect x={PAD.left} y={PAD.top} width={(WIDTH - PAD.left - PAD.right) / 2} height={(HEIGHT - PAD.top - PAD.bottom) / 2} fill="#0f172a" opacity="0.42" />
          <rect x={WIDTH / 2 - 5} y={PAD.top} width={(WIDTH - PAD.left - PAD.right) / 2} height={(HEIGHT - PAD.top - PAD.bottom) / 2} fill="#0b2a2b" opacity="0.40" />
          <rect x={PAD.left} y={HEIGHT / 2 - 8} width={(WIDTH - PAD.left - PAD.right) / 2} height={(HEIGHT - PAD.top - PAD.bottom) / 2} fill="#241721" opacity="0.34" />
          <rect x={WIDTH / 2 - 5} y={HEIGHT / 2 - 8} width={(WIDTH - PAD.left - PAD.right) / 2} height={(HEIGHT - PAD.top - PAD.bottom) / 2} fill="#2a220d" opacity="0.31" />

          {[0, 25, 50, 75, 100].map((tick) => {
            const x = PAD.left + (tick / 100) * (WIDTH - PAD.left - PAD.right)
            const y = HEIGHT - PAD.bottom - (tick / 100) * (HEIGHT - PAD.top - PAD.bottom)
            return (
              <g key={tick}>
                <line x1={x} x2={x} y1={PAD.top} y2={HEIGHT - PAD.bottom} stroke={tick === 50 ? '#64748b' : '#334155'} strokeOpacity={tick === 50 ? 0.62 : 0.32} strokeDasharray={tick === 50 ? '5 5' : '2 7'} />
                <line x1={PAD.left} x2={WIDTH - PAD.right} y1={y} y2={y} stroke={tick === 50 ? '#64748b' : '#334155'} strokeOpacity={tick === 50 ? 0.62 : 0.32} strokeDasharray={tick === 50 ? '5 5' : '2 7'} />
                <text x={x} y={HEIGHT - PAD.bottom + 22} textAnchor="middle" fontSize="11" fill="#7f8da3">{tick}</text>
                <text x={PAD.left - 13} y={y + 4} textAnchor="end" fontSize="11" fill="#7f8da3">{tick}</text>
              </g>
            )
          })}
          <text x={WIDTH / 2} y={HEIGHT - 14} textAnchor="middle" fontSize="12" fontWeight="600" fill="#a5b4c7">
            {scope === 'group' ? '10% residual 對候選排序的族群傾斜' : '個股 PIT residual momentum rank'}
          </text>
          <text x="16" y={HEIGHT / 2} textAnchor="middle" fontSize="12" fontWeight="600" fill="#a5b4c7" transform={`rotate(-90 16 ${HEIGHT / 2})`}>
            廣度／資金擴散確認
          </text>
          <text x={PAD.left + 8} y={PAD.top + 18} textAnchor="start" fontSize="10" fill="#94a3b8">殘差弱、擴散確認</text>
          <text x={WIDTH - PAD.right - 8} y={PAD.top + 18} textAnchor="end" fontSize="10" fill="#6ee7b7">殘差強、擴散確認</text>
          <text x={PAD.left + 8} y={HEIGHT - PAD.bottom - 10} textAnchor="start" fontSize="10" fill="#fb7185">殘差弱、族群未確認</text>
          <text x={WIDTH - PAD.right - 8} y={HEIGHT - PAD.bottom - 10} textAnchor="end" fontSize="10" fill="#fbbf24">殘差強、族群未確認</text>

          {visible.map((item) => {
            const sourceIndex = series.findIndex((candidate) => candidate.key === item.key)
            const color = COLORS[Math.max(0, sourceIndex) % COLORS.length]
            const validPoints = item.points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
            const path = smoothPath(validPoints)
            const latest = validPoints[validPoints.length - 1]
            if (!path || !latest) return null
            const latestPosition = coordinate(latest)
            return (
              <g key={`${item.key}-${replayKey}`}>
                <path
                  d={path}
                  pathLength={1}
                  fill="none"
                  stroke={color}
                  strokeWidth={focusKey ? 3.4 : 2.2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeDasharray={1}
                  strokeDashoffset={1}
                  className="sv-factor-path"
                  style={{ animation: 'sv-factor-trace 1300ms cubic-bezier(.22,.75,.2,1) forwards' }}
                />
                {validPoints.map((point) => {
                  const position = coordinate(point)
                  return (
                    <circle
                      key={`${item.key}-${point.date}`}
                      cx={position.x}
                      cy={position.y}
                      r={pointRadius(point)}
                      fill={color}
                      fillOpacity={pointOpacity(point)}
                      stroke={color}
                      strokeWidth={1.5}
                      tabIndex={0}
                      onMouseEnter={() => setHovered({ label: item.label, point })}
                      onMouseLeave={() => setHovered(null)}
                      onFocus={() => setHovered({ label: item.label, point })}
                      onBlur={() => setHovered(null)}
                    >
                      <title>{item.label} · {formatPoint(point, scope)}</title>
                    </circle>
                  )
                })}
                {validPoints.length > 1 ? (
                  <circle r="4" fill={color} className="sv-factor-head">
                    <animateMotion dur="1300ms" path={path} fill="freeze" repeatCount="1" />
                  </circle>
                ) : null}
                <circle
                  cx={latestPosition.x}
                  cy={latestPosition.y}
                  r={pointRadius(latest, true)}
                  fill={color}
                  fillOpacity={pointOpacity(latest)}
                  stroke="#f8fafc"
                  strokeWidth="1.4"
                />
                <text x={latestPosition.x + 8} y={latestPosition.y - 9} fontSize="11" fontWeight="700" fill={color}>{item.label}</text>
              </g>
            )
          })}
        </svg>
        {hovered ? (
          <div className="pointer-events-none absolute left-4 top-4 max-w-[min(90%,360px)] rounded-xl border border-white/10 bg-[#10151f]/95 px-3 py-2 text-xs shadow-2xl">
            <p className="font-bold text-slate-100">{hovered.label}</p>
            <p className="mt-1 leading-5 text-slate-400">{formatPoint(hovered.point, scope)}</p>
          </div>
        ) : null}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-slate-500">
        <span>圓點大小＝殘差／確認強度</span>
        <span>填色深淺＝相對資金擴散 rank（非絕對資金流入）</span>
      </div>
    </div>
  )
}

function PanelShell({ data, isLoading, error, scope, days, onDaysChange }: {
  data?: FactorFlowMapResponse
  isLoading: boolean
  error: Error | null
  scope: 'group' | 'stock'
  days: number
  onDaysChange: (days: number) => void
}) {
  const series = scope === 'group' ? data?.group_series ?? [] : data?.stock_series ?? []
  const title = scope === 'group' ? '族群殘差動能 × 擴散確認' : '持倉／待買個股殘差動能軌跡'
  return (
    <section className="h-full overflow-hidden rounded-2xl border border-[#2a3446] bg-[#111722]/90 p-4 shadow-[0_18px_60px_rgba(0,0,0,0.18)] sm:p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Radar className="h-4 w-4 text-cyan-300" />
            <h2 className="font-bold text-slate-100">{title}</h2>
          </div>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-slate-500">
            {scope === 'group'
              ? '每條線是一個族群；X 軸取自 residual challenger 對實際候選排序的反事實影響，Y 軸以廣度與法人資金擴散做診斷確認。'
              : '只顯示實際持倉與 active pending buys；每個節點都是實際交易日資料，曲線只做視覺平滑。'}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex flex-wrap justify-end gap-1" aria-label="軌跡交易日視窗">
            {WINDOW_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => onDaysChange(option)}
                aria-pressed={days === option}
                className={cx(
                  'rounded-full border px-2.5 py-1 text-[10px] font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70',
                  days === option
                    ? 'border-cyan-300/35 bg-cyan-300/10 text-cyan-100'
                    : 'border-white/10 text-slate-500 hover:text-slate-300',
                )}
              >
                {option}日
              </button>
            ))}
          </div>
          <div className="flex flex-wrap justify-end gap-2 text-[10px] font-bold">
            <span className="rounded-full border border-white/10 px-2.5 py-1 text-slate-400">{data?.date ?? '等待資料'}</span>
            <span className="rounded-full border border-cyan-300/20 bg-cyan-400/[0.07] px-2.5 py-1 text-cyan-200">10% shadow · 決策權 0%</span>
          </div>
        </div>
      </div>
      {isLoading ? (
        <div className="h-[410px] animate-pulse rounded-2xl border border-white/[0.06] bg-white/[0.025]" />
      ) : error ? (
        <div className="rounded-xl border border-amber-300/15 bg-amber-400/[0.055] p-4 text-sm text-amber-100">PIT factor map 暫時無法讀取：{error.message}</div>
      ) : series.length === 0 ? (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.025] p-5 text-sm text-slate-500">尚無 prospective PIT residual 軌跡；正式選股、倉位與下單維持原狀。</div>
      ) : (
        <>
          <TrajectoryChart series={series} scope={scope} />
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
            <span>已累積 {data?.session_count ?? 0}/{data?.requested_sessions ?? 10} 個實際 session</span>
            {scope === 'group' ? (
              <span>正式圖層：{data?.governance.taxonomy_layer ?? 'industry'} · {series.length} 類；系統 taxonomy 共 {data?.governance.available_taxonomy_layers?.length ?? 4} 層</span>
            ) : null}
            <span>Residual 是唯一 challenger；廣度／資金擴散不加分</span>
          </div>
        </>
      )}
    </section>
  )
}

export function GroupFactorTrajectoryPanel() {
  const [days, setDays] = useState<number>(10)
  const query = useQuery({
    queryKey: ['recommendations', 'factor-flow-map', 'groups', days],
    queryFn: () => recommendationsApi.factorFlowMap({ days, includeMovers: 0 }),
    staleTime: 30 * 60_000,
    retry: 1,
  })
  return <PanelShell data={query.data} isLoading={query.isLoading} error={query.error as Error | null} scope="group" days={days} onDaysChange={setDays} />
}

export function StockFactorTrajectoryPanel() {
  const pending = useQuery({ queryKey: ['paper', 'pending-buys'], queryFn: () => paperApi.pendingBuys(), staleTime: 60_000 })
  const positions = useQuery({ queryKey: ['paper', 'positions'], queryFn: paperApi.positions, staleTime: 60_000 })
  const [days, setDays] = useState<number>(10)
  const symbols = useMemo(() => {
    const pendingSymbols = paperPendingBuysFromPayload<any>(pending.data).map((row) => String(row.symbol ?? row.stock_symbol ?? '')).filter(Boolean)
    const positionSymbols = paperPositionsFromPayload<any>(positions.data).map((row) => String(row.symbol ?? row.stock_symbol ?? '')).filter(Boolean)
    return [...new Set([...pendingSymbols, ...positionSymbols])]
  }, [pending.data, positions.data])
  const query = useQuery({
    queryKey: ['recommendations', 'factor-flow-map', 'stocks', days, symbols.join(',')],
    queryFn: () => recommendationsApi.factorFlowMap({
      days,
      symbols,
      includeMovers: 0,
    }),
    staleTime: 5 * 60_000,
    retry: 1,
  })
  return <PanelShell data={query.data} isLoading={query.isLoading || pending.isLoading || positions.isLoading} error={query.error as Error | null} scope="stock" days={days} onDaysChange={setDays} />
}
