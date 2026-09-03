import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Pause, Play, Radar, RotateCcw } from 'lucide-react'
import { useReducedMotion } from 'framer-motion'
import {
  paperApi,
  recommendationsApi,
  type FactorFlowMapResponse,
  type FactorTrajectoryPoint,
  type FactorTrajectorySeries,
} from '@/lib/api'
import { paperPendingBuysFromPayload, paperPositionsFromPayload } from '@/lib/paperPayload'
import { buildFactorTrajectoryTimeline, factorTrajectoryPlaybackInterval } from '@/lib/pitFactorTrajectoryPlayback'

const WIDTH = 1040
const HEIGHT = 560
const PAD = { left: 68, right: 34, top: 28, bottom: 46 }
const PLOT_WIDTH = WIDTH - PAD.left - PAD.right
const PLOT_HEIGHT = HEIGHT - PAD.top - PAD.bottom
const PLOT_MID_X = PAD.left + PLOT_WIDTH / 2
const PLOT_MID_Y = PAD.top + PLOT_HEIGHT / 2
const COLORS = ['#67e8f9', '#fbbf24', '#fb7185', '#a78bfa', '#34d399', '#60a5fa', '#f97316', '#e879f9', '#a3e635', '#fda4af', '#22d3ee', '#c4b5fd']
const WINDOW_OPTIONS = [3, 5, 10, 20, 60] as const
const MAX_DEFAULT_LABELS = 12
const DEFAULT_GROUP_LIMIT = 12

const QUADRANT_GUIDES = [
  { corner: '左上', title: '資金先卡位', detail: '表現仍偏弱，但參與開始增加', className: 'border-slate-400/25 bg-slate-500/[0.07] text-slate-200' },
  { corner: '右上', title: '強勢擴散', detail: '表現優於預期，且股票與資金同步', className: 'border-emerald-300/25 bg-emerald-400/[0.07] text-emerald-100' },
  { corner: '左下', title: '弱勢退潮', detail: '表現偏弱，資金參與也較少', className: 'border-rose-300/25 bg-rose-400/[0.07] text-rose-100' },
  { corner: '右下', title: '強但未擴散', detail: '表現偏強，但支持面仍偏窄', className: 'border-amber-300/25 bg-amber-400/[0.07] text-amber-100' },
] as const

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ')
}

function coordinate(point: FactorTrajectoryPoint) {
  const x = PAD.left + (Math.max(0, Math.min(100, Number(point.x))) / 100) * PLOT_WIDTH
  const yValue = Math.max(0, Math.min(100, Number(point.y)))
  const y = HEIGHT - PAD.bottom - (yValue / 100) * PLOT_HEIGHT
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
    scope === 'group' ? `比預期強弱位置 ${point.x.toFixed(1)}` : `個股比預期強弱 ${point.x.toFixed(1)}`,
    `股票／資金支持度 ${Number(point.y).toFixed(1)}`,
    point.flow == null ? null : `相對資金參與度 ${point.flow.toFixed(1)}`,
    delta == null ? null : `實際名次變動 ${delta >= 0 ? '+' : ''}${delta.toFixed(2)}`,
  ].filter(Boolean).join(' · ')
}

function pointRadius(point: FactorTrajectoryPoint, latest = false) {
  const residualStrength = Math.min(1, Math.abs(Number(point.x) - 50) / 50)
  const confirmationStrength = Math.min(1, Math.abs(Number(point.y) - 50) / 50)
  return 2.8 + Math.max(residualStrength, confirmationStrength) * 4.2 + (latest ? 1.8 : 0)
}

function flowRingRadius(point: FactorTrajectoryPoint) {
  const flow = point.flow == null ? 0.35 : Math.max(0, Math.min(1, Number(point.flow) / 100))
  return pointRadius(point) + 2.5 + flow * 5.5
}

function flowRingWidth(point: FactorTrajectoryPoint) {
  const flow = point.flow == null ? 0.35 : Math.max(0, Math.min(1, Number(point.flow) / 100))
  return 0.8 + flow * 1.8
}

function revealedTrajectoryPoints(points: FactorTrajectoryPoint[], currentDate: string | null) {
  if (!currentDate) return []
  return points.filter((point) => point.date <= currentDate && Number.isFinite(point.x) && Number.isFinite(point.y))
}

function defaultLabeledSeriesKeys(series: FactorTrajectorySeries[], currentDate: string | null) {
  const candidates = series
    .map((item) => {
      const revealed = revealedTrajectoryPoints(item.points, currentDate)
      const current = revealed[revealed.length - 1]
      const salience = current == null ? -1 : Math.hypot(Number(current.x) - 50, Number(current.y) - 50)
      if (!current) return null
      const position = coordinate(current)
      const width = Math.max(42, [...item.label].length * 12.5)
      const height = 18
      const left = position.x > PLOT_MID_X ? position.x - 10 - width : position.x + 10
      const top = position.y < PAD.top + 34 ? position.y + 7 : position.y - 26
      return { key: item.key, salience, box: { left, right: left + width, top, bottom: top + height } }
    })
    .filter((item): item is NonNullable<typeof item> => item != null)
    .sort((left, right) => right.salience - left.salience)

  const accepted: typeof candidates = []
  for (const candidate of candidates) {
    const overlaps = accepted.some((existing) => (
      candidate.box.left < existing.box.right + 6
      && candidate.box.right + 6 > existing.box.left
      && candidate.box.top < existing.box.bottom + 6
      && candidate.box.bottom + 6 > existing.box.top
    ))
    if (overlaps) continue
    accepted.push(candidate)
    if (accepted.length >= MAX_DEFAULT_LABELS) break
  }
  return new Set(accepted.map((item) => item.key))
}

function TrajectoryChart({
  series,
  scope,
  onSeriesSelect,
}: {
  series: FactorTrajectorySeries[]
  scope: 'group' | 'stock'
  onSeriesSelect?: (key: string) => void
}) {
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const [replayKey, setReplayKey] = useState(0)
  const [playbackIndex, setPlaybackIndex] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [hovered, setHovered] = useState<{ label: string; point: FactorTrajectoryPoint } | null>(null)
  const prefersReducedMotion = useReducedMotion()
  const visible = useMemo(
    () => focusKey ? series.filter((item) => item.key === focusKey) : series,
    [focusKey, series],
  )
  const timeline = useMemo(() => buildFactorTrajectoryTimeline(visible), [visible])
  const timelineKey = timeline.join('|')
  const lastPlaybackIndex = Math.max(0, timeline.length - 1)
  const currentDate = timeline[Math.min(playbackIndex, lastPlaybackIndex)] ?? null
  const labeledSeriesKeys = defaultLabeledSeriesKeys(visible, currentDate)

  useEffect(() => {
    if (focusKey && !series.some((item) => item.key === focusKey)) setFocusKey(null)
  }, [focusKey, series])

  useEffect(() => {
    if (prefersReducedMotion || timeline.length <= 1) {
      setPlaybackIndex(lastPlaybackIndex)
      setIsPlaying(false)
      return
    }
    setPlaybackIndex(0)
    setIsPlaying(true)
  }, [focusKey, lastPlaybackIndex, prefersReducedMotion, replayKey, timeline.length, timelineKey])

  useEffect(() => {
    if (!isPlaying) return
    if (playbackIndex >= lastPlaybackIndex) {
      setIsPlaying(false)
      return
    }
    const timer = window.setTimeout(
      () => setPlaybackIndex((current) => Math.min(lastPlaybackIndex, current + 1)),
      factorTrajectoryPlaybackInterval(timeline.length),
    )
    return () => window.clearTimeout(timer)
  }, [isPlaying, lastPlaybackIndex, playbackIndex, timeline.length])

  function togglePlayback() {
    if (timeline.length <= 1) return
    if (playbackIndex >= lastPlaybackIndex) setPlaybackIndex(0)
    setIsPlaying((current) => !current)
  }

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
            onClick={() => {
              if (onSeriesSelect) onSeriesSelect(item.key)
              else setFocusKey((current) => current === item.key ? null : item.key)
            }}
            aria-pressed={focusKey === item.key}
            aria-label={onSeriesSelect ? `查看 ${item.label} 的產業主題` : undefined}
            className={cx(
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70',
              focusKey === item.key ? 'border-white/25 bg-white/10 text-white' : 'border-white/[0.07] text-slate-400 hover:border-white/15 hover:text-slate-200',
            )}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: COLORS[index % COLORS.length] }} />
            {item.label}
          </button>
        ))}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <span data-playback-date className="rounded-full border border-cyan-300/20 bg-cyan-400/[0.07] px-2.5 py-1 text-[11px] font-semibold tabular-nums text-cyan-100">
            {currentDate ? `播放至 ${currentDate}` : '等待交易日'}
          </span>
          <button
            type="button"
            onClick={togglePlayback}
            disabled={timeline.length <= 1}
            className="inline-flex items-center gap-1.5 rounded-full border border-white/10 px-2.5 py-1 text-[11px] font-semibold text-slate-300 transition hover:border-cyan-300/30 hover:text-cyan-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isPlaying ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
            {isPlaying ? '暫停' : playbackIndex >= lastPlaybackIndex ? '從頭播放' : '繼續播放'}
          </button>
          <button
            type="button"
            onClick={() => setReplayKey((value) => value + 1)}
            disabled={timeline.length <= 1 || Boolean(prefersReducedMotion)}
            className="inline-flex items-center gap-1.5 rounded-full border border-white/10 px-2.5 py-1 text-[11px] font-semibold text-slate-300 transition hover:border-cyan-300/30 hover:text-cyan-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <RotateCcw className="h-3 w-3" />重播
          </button>
        </div>
      </div>

      <div className="mb-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4" aria-label="四象限判讀說明">
        {QUADRANT_GUIDES.map((guide) => (
          <div key={guide.corner} data-quadrant-guide className={cx('rounded-xl border px-3 py-2', guide.className)}>
            <div className="flex items-baseline gap-2">
              <span className="text-[10px] font-bold tracking-[0.16em] opacity-60">{guide.corner}</span>
              <strong className="text-xs">{guide.title}</strong>
            </div>
            <p className="mt-1 text-[11px] leading-4 opacity-70">{guide.detail}</p>
          </div>
        ))}
      </div>

      <div className="relative rounded-2xl border border-white/[0.07] bg-[#090d14] pl-9 sm:pl-12">
        <div data-y-axis-guide className="absolute inset-y-0 left-1.5 flex items-center gap-1 text-[11px] font-semibold text-slate-400 sm:left-3" aria-hidden="true">
          <span className="text-cyan-300">↑</span>
          <span style={{ writingMode: 'vertical-rl', textOrientation: 'upright' }} className="tracking-[0.18em]">越上方，股票與資金支持越廣</span>
        </div>
        <div className="overflow-hidden rounded-r-2xl">
        <svg data-trajectory-plot viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className={cx('block w-full', scope === 'group' ? 'min-h-[480px]' : 'min-h-[390px]')} role="img" aria-label="PIT residual 與族群廣度資金擴散的近期軌跡圖">
          <rect x={PAD.left} y={PAD.top} width={PLOT_WIDTH / 2} height={PLOT_HEIGHT / 2} fill="#0f172a" opacity="0.42" />
          <rect x={PLOT_MID_X} y={PAD.top} width={PLOT_WIDTH / 2} height={PLOT_HEIGHT / 2} fill="#0b2a2b" opacity="0.40" />
          <rect x={PAD.left} y={PLOT_MID_Y} width={PLOT_WIDTH / 2} height={PLOT_HEIGHT / 2} fill="#241721" opacity="0.34" />
          <rect x={PLOT_MID_X} y={PLOT_MID_Y} width={PLOT_WIDTH / 2} height={PLOT_HEIGHT / 2} fill="#2a220d" opacity="0.31" />

          {[0, 25, 50, 75, 100].map((tick) => {
            const x = PAD.left + (tick / 100) * PLOT_WIDTH
            const y = HEIGHT - PAD.bottom - (tick / 100) * PLOT_HEIGHT
            return (
              <g key={tick}>
                <line x1={x} x2={x} y1={PAD.top} y2={HEIGHT - PAD.bottom} stroke={tick === 50 ? '#64748b' : '#334155'} strokeOpacity={tick === 50 ? 0.62 : 0.32} strokeDasharray={tick === 50 ? '5 5' : '2 7'} />
                <line x1={PAD.left} x2={WIDTH - PAD.right} y1={y} y2={y} stroke={tick === 50 ? '#64748b' : '#334155'} strokeOpacity={tick === 50 ? 0.62 : 0.32} strokeDasharray={tick === 50 ? '5 5' : '2 7'} />
                <text x={x} y={HEIGHT - PAD.bottom + 25} textAnchor="middle" fontSize="13" fontWeight="600" fill="#94a3b8">{tick}</text>
                <text x={PAD.left - 14} y={y + 5} textAnchor="end" fontSize="13" fontWeight="600" fill="#94a3b8">{tick}</text>
              </g>
            )
          })}
          {visible.map((item) => {
            const sourceIndex = series.findIndex((candidate) => candidate.key === item.key)
            const color = COLORS[Math.max(0, sourceIndex) % COLORS.length]
            const revealedPoints = revealedTrajectoryPoints(item.points, currentDate)
            const path = smoothPath(revealedPoints)
            const latest = revealedPoints[revealedPoints.length - 1]
            if (!path || !latest) return null
            const latestPosition = coordinate(latest)
            const labelOnLeft = latestPosition.x > PLOT_MID_X
            const labelBelow = latestPosition.y < PAD.top + 34
            const showLabel = focusKey != null || labeledSeriesKeys.has(item.key)
            return (
              <g key={item.key}>
                <path
                  data-trajectory-path={item.key}
                  d={path}
                  fill="none"
                  stroke={color}
                  strokeWidth={focusKey ? 3.4 : 2.2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeOpacity={focusKey ? 0.95 : 0.78}
                />
                {revealedPoints.map((point) => {
                  const position = coordinate(point)
                  return (
                    <g key={`${item.key}-${point.date}`} data-trajectory-point={`${item.key}:${point.date}`}>
                      <circle cx={position.x} cy={position.y} r={flowRingRadius(point)} fill="none" stroke={color} strokeOpacity="0.38" strokeWidth={flowRingWidth(point)} />
                      <circle
                        cx={position.x}
                        cy={position.y}
                        r={pointRadius(point)}
                        fill={color}
                        fillOpacity="0.56"
                        stroke="#e2e8f0"
                        strokeOpacity="0.55"
                        strokeWidth={1.1}
                        tabIndex={0}
                        onMouseEnter={() => setHovered({ label: item.label, point })}
                        onMouseLeave={() => setHovered(null)}
                        onFocus={() => setHovered({ label: item.label, point })}
                        onBlur={() => setHovered(null)}
                      >
                        <title>{item.label} · {formatPoint(point, scope)}</title>
                      </circle>
                    </g>
                  )
                })}
                <g
                  style={{
                    transform: `translate(${latestPosition.x}px, ${latestPosition.y}px)`,
                    transition: prefersReducedMotion ? undefined : `transform ${Math.min(520, factorTrajectoryPlaybackInterval(timeline.length))}ms cubic-bezier(.22,.75,.2,1)`,
                  }}
                >
                  {isPlaying ? <circle r={pointRadius(latest, true) + 6} fill="none" stroke={color} strokeOpacity="0.28" strokeWidth="2" /> : null}
                  <circle
                    r={pointRadius(latest, true)}
                    fill={color}
                    fillOpacity="0.96"
                    stroke="#f8fafc"
                    strokeWidth="1.6"
                  />
                  {showLabel ? (
                    <text
                      data-trajectory-label={item.key}
                      x={labelOnLeft ? -10 : 10}
                      y={labelBelow ? 20 : -11}
                      textAnchor={labelOnLeft ? 'end' : 'start'}
                      fontSize="12"
                      fontWeight="700"
                      paintOrder="stroke"
                      stroke="#090d14"
                      strokeWidth="3"
                      fill={color}
                    >
                      {item.label}
                    </text>
                  ) : null}
                </g>
              </g>
            )
          })}
        </svg>
        </div>
        {hovered ? (
          <div className="pointer-events-none absolute left-14 top-4 max-w-[min(82%,360px)] rounded-xl border border-white/10 bg-[#10151f]/95 px-3 py-2 text-xs shadow-2xl sm:left-20">
            <p className="font-bold text-slate-100">{hovered.label}</p>
            <p className="mt-1 leading-5 text-slate-400">{formatPoint(hovered.point, scope)}</p>
          </div>
        ) : null}
        <div data-x-axis-guide className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 border-t border-white/[0.06] px-4 py-2.5 text-[11px] font-semibold text-slate-400">
          <span className="text-left">← 比原本預期弱</span>
          <span className="text-center text-slate-300">{scope === 'group' ? '族群表現' : '個股表現'}</span>
          <span className="text-right">比原本預期強 →</span>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-slate-500">
        <span>圓點越大＝當天的強弱或支持訊號越明顯</span>
        <span>外圈越大、越粗＝相對更多資金參與（只比較當天族群，不是實際金額）</span>
        {focusKey == null && series.length > 1 ? <span>為避免文字打架，預設最多標示離中心最遠且互不重疊的 {MAX_DEFAULT_LABELS} 類；點上方族群可單獨查看</span> : null}
      </div>
    </div>
  )
}

function PanelShell({
  data,
  isLoading,
  error,
  scope,
  days,
  onDaysChange,
  groupLayer,
  selectedTheme,
  onThemeSelect,
  onThemeClear,
  totalGroupCount,
  showAllGroups,
  onShowAllGroupsChange,
}: {
  data?: FactorFlowMapResponse
  isLoading: boolean
  error: Error | null
  scope: 'group' | 'stock'
  days: number
  onDaysChange: (days: number) => void
  groupLayer?: 'industry_theme' | 'subindustry'
  selectedTheme?: string | null
  onThemeSelect?: (theme: string) => void
  onThemeClear?: () => void
  totalGroupCount?: number
  showAllGroups?: boolean
  onShowAllGroupsChange?: (showAll: boolean) => void
}) {
  const series = scope === 'group' ? data?.group_series ?? [] : data?.stock_series ?? []
  const title = scope === 'group'
    ? groupLayer === 'subindustry' && selectedTheme
      ? `${selectedTheme} · 次產業動向 × 資金確認`
      : '產業題材動向 × 資金確認'
    : '持倉／待買個股強弱軌跡'
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
              ? groupLayer === 'subindustry'
                ? `目前展開「${selectedTheme ?? ''}」底下由 FinLab 定義的次產業。往右代表表現比原本預期強，往上代表成分股與資金支持較廣。`
                : '以清理後的 FinLab 產業題材呈現市場主線；同一股票屬於多個題材時會等權分攤，點擊題材可展開其 FinLab 次產業。這是 StockVision 的殘差動向圖，不是 RRG。'
              : '只顯示實際持倉與 active pending buys；每個節點都是實際交易日資料，曲線只做視覺平滑。'}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          {scope === 'group' && groupLayer === 'subindustry' && selectedTheme && onThemeClear ? (
            <button
              type="button"
              onClick={onThemeClear}
              className="rounded-full border border-cyan-300/25 bg-cyan-300/[0.07] px-3 py-1 text-[11px] font-bold text-cyan-100 transition hover:border-cyan-300/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70"
            >
              ← 回到全部產業題材
            </button>
          ) : null}
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
            {scope === 'group' && onShowAllGroupsChange && Number(totalGroupCount ?? 0) > DEFAULT_GROUP_LIMIT ? (
              <button
                type="button"
                onClick={() => onShowAllGroupsChange(!showAllGroups)}
                aria-pressed={Boolean(showAllGroups)}
                className="rounded-full border border-white/10 px-2.5 py-1 text-slate-400 transition hover:border-cyan-300/30 hover:text-cyan-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70"
              >
                {showAllGroups ? `精簡顯示前 ${DEFAULT_GROUP_LIMIT} 類` : `顯示全部 ${totalGroupCount} 類`}
              </button>
            ) : null}
            <span className="rounded-full border border-white/10 px-2.5 py-1 text-slate-400">{data?.date ?? '等待資料'}</span>
            <span className="rounded-full border border-cyan-300/20 bg-cyan-400/[0.07] px-2.5 py-1 text-cyan-200">10% 觀察層 · 不影響交易</span>
          </div>
        </div>
      </div>
      {isLoading ? (
        <div className={cx('animate-pulse rounded-2xl border border-white/[0.06] bg-white/[0.025]', scope === 'group' ? 'h-[620px]' : 'h-[480px]')} />
      ) : error ? (
        <div className="rounded-xl border border-amber-300/15 bg-amber-400/[0.055] p-4 text-sm text-amber-100">PIT factor map 暫時無法讀取：{error.message}</div>
      ) : series.length === 0 ? (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.025] p-5 text-sm text-slate-500">尚無 prospective PIT residual 軌跡；正式選股、倉位與下單維持原狀。</div>
      ) : (
        <>
          <TrajectoryChart
            series={series}
            scope={scope}
            onSeriesSelect={scope === 'group' && groupLayer === 'industry_theme' ? onThemeSelect : undefined}
          />
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
            <span>已累積 {data?.session_count ?? 0}/{data?.requested_sessions ?? 10} 個實際 session</span>
            {scope === 'group' ? (
              <span>
                圖層：{data?.governance.taxonomy_layer === 'subindustry' ? '次產業' : '產業題材'} · 顯示 {series.length}/{totalGroupCount ?? series.length} 類 · 分類 owner：FinLab
              </span>
            ) : null}
            <span>這是觀察圖；股票與資金支持度只用來確認，不會直接改變選股、持倉或下單</span>
          </div>
        </>
      )}
    </section>
  )
}

export function GroupFactorTrajectoryPanel() {
  const [days, setDays] = useState<number>(10)
  const [selectedTheme, setSelectedTheme] = useState<string | null>(null)
  const groupLayer: 'industry_theme' | 'subindustry' = selectedTheme ? 'subindustry' : 'industry_theme'
  const [showAllGroups, setShowAllGroups] = useState(false)
  const query = useQuery({
    queryKey: ['recommendations', 'factor-flow-map', 'groups', days, groupLayer, selectedTheme],
    queryFn: () => recommendationsApi.factorFlowMap({
      days,
      includeMovers: 0,
      layer: groupLayer,
      parentLayer: selectedTheme ? 'industry_theme' : undefined,
      parent: selectedTheme ?? undefined,
    }),
    staleTime: 30 * 60_000,
    retry: 1,
  })
  const totalGroupCount = query.data?.group_series.length ?? 0
  const displayData = useMemo<FactorFlowMapResponse | undefined>(() => {
    if (!query.data || showAllGroups) return query.data
    return {
      ...query.data,
      group_series: query.data.group_series.slice(0, DEFAULT_GROUP_LIMIT),
    }
  }, [query.data, showAllGroups])
  return (
    <PanelShell
      data={displayData}
      isLoading={query.isLoading}
      error={query.error as Error | null}
      scope="group"
      days={days}
      onDaysChange={setDays}
      groupLayer={groupLayer}
      selectedTheme={selectedTheme}
      onThemeSelect={(theme) => {
        setSelectedTheme(theme)
        setShowAllGroups(false)
      }}
      onThemeClear={() => {
        setSelectedTheme(null)
        setShowAllGroups(false)
      }}
      totalGroupCount={totalGroupCount}
      showAllGroups={showAllGroups}
      onShowAllGroupsChange={setShowAllGroups}
    />
  )
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
