import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Activity,
  BarChart3,
  Bot,
  EyeOff,
  Gauge,
  Network,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  TrendingDown,
  TrendingUp,
} from 'lucide-react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import AppShell from '@/components/AppShell'
import { Button } from '@/components/ui/button'
import {
  WorkstationFlow,
  WorkstationMetricTile,
  WorkstationPageTitle,
  WorkstationPanel,
  WorkstationPill,
} from '@/components/workstation/WorkstationChrome'
import { StatusPill } from '@/components/workstation/VisualPrimitives'
import { marketApi, recommendationsApi } from '@/lib/api'
import { buildPublicDailyFocusPacket, type PublicDailyFlow } from '@/lib/dailyFocusVisibility'
import { cn } from '@/lib/utils'

const CHART_HEIGHT = 310

function twToday(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
}

function fmtNet(value: number): string {
  if (!Number.isFinite(value)) return '-'
  const prefix = value > 0 ? '+' : ''
  return `${prefix}${value.toFixed(Math.abs(value) >= 10 ? 0 : 2)} 億`
}

function fmtInt(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toLocaleString('zh-TW') : '-'
}

function riskTone(score: number): 'ok' | 'warn' | 'error' | 'info' {
  if (score >= 75) return 'error'
  if (score >= 55) return 'warn'
  if (score <= 30) return 'ok'
  return 'info'
}

function flowColor(flow: PublicDailyFlow): string {
  if (flow.net > 0) return '#fb7185'
  if (flow.net < 0) return '#34d399'
  return '#94a3b8'
}

function RiskGauge({ score, label }: { score: number; label: string }) {
  const safe = Math.max(0, Math.min(100, Number.isFinite(score) ? score : 50))
  const radius = 48
  const circumference = 2 * Math.PI * radius
  const dash = (safe / 100) * circumference
  return (
    <div className="sv-content-card grid min-h-[220px] place-items-center rounded-xl p-4">
      <div className="relative h-40 w-40">
        <svg viewBox="0 0 128 128" className="h-40 w-40 -rotate-90">
          <circle cx="64" cy="64" r={radius} fill="none" stroke="var(--sv-panel-raised)" strokeWidth="12" />
          <circle
            cx="64"
            cy="64"
            r={radius}
            fill="none"
            stroke={safe >= 75 ? '#fb7185' : safe >= 55 ? '#fbbf24' : safe <= 30 ? '#34d399' : '#38bdf8'}
            strokeLinecap="round"
            strokeWidth="12"
            strokeDasharray={`${dash} ${circumference - dash}`}
          />
        </svg>
        <div className="absolute inset-0 grid place-items-center text-center">
          <div>
            <div className="sv-title-text font-['Space_Grotesk'] text-4xl font-semibold">{Math.round(safe)}</div>
            <div className="sv-muted-text mt-1 font-mono text-[10px] uppercase tracking-[0.14em]">{label}</div>
          </div>
        </div>
      </div>
    </div>
  )
}

function FlowTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: PublicDailyFlow }> }) {
  const row = payload?.[0]?.payload
  if (!active || !row) return null
  return (
    <div className="sv-content-card rounded-lg px-3 py-2 text-xs text-[color:var(--sv-text-soft)] shadow-xl">
      <div className="font-semibold">{row.name}</div>
      <div className="mt-1 font-mono text-[#9badbf]">net {fmtNet(row.net)}</div>
      <div className="font-mono text-[#9badbf]">pool {fmtInt(row.stockCount)}</div>
      <div className="font-mono text-[#9badbf]">RRG {row.quadrant}</div>
    </div>
  )
}

function ThemeFlowChart({ flows }: { flows: PublicDailyFlow[] }) {
  const rows = flows.slice(0, 12)
  if (!rows.length) {
    return (
      <div className="sv-content-card sv-muted-text grid h-[310px] place-items-center rounded-xl text-sm">
        今日公開主題流尚未產生
      </div>
    )
  }

  return (
    <div className="sv-content-card h-[310px] rounded-xl p-3">
      <ResponsiveContainer width="100%" height={CHART_HEIGHT - 24}>
        <BarChart data={rows} layout="vertical" margin={{ top: 8, right: 20, bottom: 8, left: 8 }}>
          <CartesianGrid stroke="rgba(148,163,184,0.12)" horizontal={false} />
          <XAxis
            type="number"
            tick={{ fill: 'var(--sv-text-muted)', fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: 'var(--sv-panel-border-soft)' }}
          />
          <YAxis
            dataKey="name"
            type="category"
            width={96}
            tick={{ fill: 'var(--sv-text-soft)', fontSize: 11 }}
            tickLine={false}
            axisLine={false}
          />
          <Tooltip cursor={{ fill: 'rgba(148,163,184,0.06)' }} content={<FlowTooltip />} />
          <Bar dataKey="net" radius={[4, 4, 4, 4]} barSize={14}>
            {rows.map((row) => (
              <Cell key={row.name} fill={flowColor(row)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

function PublicCandidateArc({ buy, hold, sell }: { buy: number; hold: number; sell: number }) {
  const total = Math.max(1, buy + hold + sell)
  const lanes = [
    { label: 'BUY pool', value: buy, color: 'bg-rose-300', text: 'text-rose-200' },
    { label: 'HOLD', value: hold, color: 'bg-sky-300', text: 'text-sky-200' },
    { label: 'SELL risk', value: sell, color: 'bg-emerald-300', text: 'text-emerald-200' },
  ]
  return (
    <div className="space-y-3">
      {lanes.map((lane) => (
        <div key={lane.label}>
          <div className="sv-muted-text mb-1 flex justify-between font-mono text-[10px] uppercase tracking-[0.12em]">
            <span>{lane.label}</span>
            <span className={lane.text}>{fmtInt(lane.value)}</span>
          </div>
          <div className="h-3 overflow-hidden rounded-full bg-[color:var(--sv-panel-raised)]">
            <div className={cn('h-full rounded-full', lane.color)} style={{ width: `${Math.max(4, (lane.value / total) * 100)}%` }} />
          </div>
        </div>
      ))}
    </div>
  )
}

function FlowCloud({ flows }: { flows: PublicDailyFlow[] }) {
  const top = flows.slice(0, 16)
  if (!top.length) return null
  const max = Math.max(...top.map((row) => Math.abs(row.net)), 1)
  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
      {top.map((row) => {
        const intensity = Math.max(0.18, Math.min(1, Math.abs(row.net) / max))
        return (
          <div
            key={row.name}
            className="sv-content-card min-h-[92px] rounded-xl p-3"
            style={{ boxShadow: `inset 0 0 0 999px rgba(${row.net >= 0 ? '251,113,133' : '52,211,153'},${0.04 + intensity * 0.11})` }}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="sv-title-text truncate text-sm font-semibold">{row.name}</div>
                <div className="sv-muted-text mt-1 font-mono text-[10px] uppercase tracking-[0.12em]">{row.quadrant}</div>
              </div>
              <span className={cn('font-mono text-xs', row.net >= 0 ? 'text-rose-200' : 'text-emerald-200')}>
                {fmtNet(row.net)}
              </span>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-[color:var(--sv-panel-raised)]">
              <div
                className={cn('h-full rounded-full', row.net >= 0 ? 'bg-rose-300' : 'bg-emerald-300')}
                style={{ width: `${Math.max(8, intensity * 100)}%` }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

export default function DailyFocusHomePage() {
  const today = twToday()
  const riskQuery = useQuery({
    queryKey: ['market', 'risk', 'public-home'],
    queryFn: marketApi.risk,
    staleTime: 5 * 60_000,
  })
  const themeFlowQuery = useQuery({
    queryKey: ['recommendations', 'sector-flow', 'theme', 'public-home', today],
    queryFn: () => recommendationsApi.sectorFlow(undefined, 'theme'),
    staleTime: 30 * 60_000,
  })
  const reportQuery = useQuery({
    queryKey: ['recommendations', 'daily-report', 'public-home', today],
    queryFn: () => recommendationsApi.dailyReport(),
    staleTime: 30 * 60_000,
  })

  const packet = useMemo(
    () => buildPublicDailyFocusPacket({
      risk: riskQuery.data,
      sectorFlow: themeFlowQuery.data,
      dailyReport: reportQuery.data,
      nowDate: today,
    }),
    [reportQuery.data, riskQuery.data, themeFlowQuery.data, today],
  )

  const isLoading = riskQuery.isLoading || themeFlowQuery.isLoading || reportQuery.isLoading
  const hasError = Boolean(riskQuery.error || themeFlowQuery.error || reportQuery.error)
  const refreshAll = () => {
    riskQuery.refetch()
    themeFlowQuery.refetch()
    reportQuery.refetch()
  }

  return (
    <AppShell>
      <div className="min-h-[100dvh] space-y-4 p-4 lg:p-5">
        <WorkstationPageTitle
          kicker="Public daily focus"
          title="StockVision Home"
          description="朋友可看的公開市場情報：大盤風險、主題熱區、候選池規模與資料新鮮度。真正交易目標與執行脈絡只留在 Bot。"
          action={
            <div className="flex flex-wrap items-center gap-2">
              <WorkstationPill tone={packet.isStale ? 'warn' : 'ok'}>{packet.isStale ? 'stale public data' : 'fresh public data'}</WorkstationPill>
              <Button
                size="sm"
                variant="outline"
                className="rounded-full border-[color:var(--sv-accent-border)] bg-[color:var(--sv-accent-soft)] text-[color:var(--sv-accent)] hover:bg-[color:var(--sv-accent-soft)]"
                onClick={refreshAll}
              >
                <RefreshCw className={cn('mr-1 h-3.5 w-3.5', isLoading && 'animate-spin')} />
                重新整理
              </Button>
            </div>
          }
        />

        {hasError && (
          <div className="rounded-xl border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-100">
            部分公開資料讀取失敗，頁面會保留可用的聚合訊號。
          </div>
        )}

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <WorkstationMetricTile
            label="public candidates"
            value={fmtInt(packet.publicCandidateCount)}
            detail="公開候選池規模；不顯示真實交易目標。"
            tone="info"
          />
          <WorkstationMetricTile
            label="risk score"
            value={Math.round(packet.riskScore)}
            detail={`${packet.riskLevel} / ${packet.date}`}
            tone={riskTone(packet.riskScore)}
          />
          <WorkstationMetricTile
            label="positive themes"
            value={packet.positiveFlows.length}
            detail={packet.breadthLabel}
            tone={packet.positiveFlows.length ? 'ok' : 'neutral'}
          />
          <WorkstationMetricTile
            label="negative themes"
            value={packet.negativeFlows.length}
            detail={packet.dataDate}
            tone={packet.negativeFlows.length > packet.positiveFlows.length ? 'warn' : 'neutral'}
          />
        </div>

        <div className="grid gap-3 xl:grid-cols-[360px_minmax(0,1fr)]">
          <WorkstationPanel
            title="Market Risk Gauge"
            kicker="public aggregate"
            action={<StatusPill tone={riskTone(packet.riskScore)}>{packet.riskLevel}</StatusPill>}
          >
            <div className="grid gap-3 p-3">
              <RiskGauge score={packet.riskScore} label={packet.riskLevel} />
              <div className="sv-content-card rounded-xl p-3 text-xs leading-5 text-[color:var(--sv-text-soft)]">
                {packet.riskSummary}
              </div>
            </div>
          </WorkstationPanel>

          <WorkstationPanel
            title="Theme Money Flow"
            kicker="visualized sector-flow / no stock-level target"
            action={<StatusPill tone={packet.isStale ? 'warn' : 'ok'}>{packet.dataDate}</StatusPill>}
          >
            <div className="p-3">
              <ThemeFlowChart flows={packet.themeFlows} />
            </div>
          </WorkstationPanel>
        </div>

        <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_360px]">
          <WorkstationPanel title="Public Heat Map" kicker="top public themes by absolute flow">
            <div className="p-3">
              <FlowCloud flows={packet.themeFlows} />
            </div>
          </WorkstationPanel>

          <WorkstationPanel
            title="Signal Distribution"
            kicker="aggregate only"
            action={<EyeOff className="sv-accent-text h-4 w-4" />}
          >
            <div className="space-y-4 p-3">
              <PublicCandidateArc buy={packet.buyCount} hold={packet.holdCount} sell={packet.sellCount} />
              <div className="sv-content-card rounded-xl p-3 text-xs leading-5 text-[color:var(--sv-text-soft)]">
                {packet.informationBoundary}
              </div>
            </div>
          </WorkstationPanel>
        </div>

        <WorkstationPanel
          title="Information Boundary"
          kicker="friend-visible Home vs private Bot"
          action={<ShieldCheck className="h-4 w-4 text-emerald-300" />}
        >
          <div className="grid gap-3 p-3 xl:grid-cols-[1fr_1.4fr]">
            <div className="sv-content-card rounded-xl p-4">
              <div className="sv-title-text flex items-center gap-2 text-sm font-semibold">
                <Sparkles className="sv-accent-text h-4 w-4" />
                今日公開摘要
              </div>
              <p className="mt-3 text-sm leading-6 text-[color:var(--sv-text-soft)]">{packet.dailyDigest}</p>
            </div>
            <WorkstationFlow
              steps={[
                { label: 'Home', detail: '市場風險、主題熱區、候選池規模、資料新鮮度。', tone: 'info' },
                { label: 'Bot', detail: 'pending context、debate、quote sanity、真正交易目標。', tone: 'warn' },
                { label: 'Obs', detail: 'pipeline、data quality、release gate 與事件 root cause。', tone: 'neutral' },
                { label: 'ModelPool', detail: '模型治理、promotion gate 與 raw artifact inspector。', tone: 'ok' },
              ]}
            />
          </div>
        </WorkstationPanel>

        <div className="grid gap-3 md:grid-cols-4">
          {[
            { icon: Gauge, label: 'risk', detail: '大盤風險視覺化' },
            { icon: Network, label: 'themes', detail: '主題流向圖像化' },
            { icon: BarChart3, label: 'pool', detail: '候選池只顯示聚合' },
            { icon: Bot, label: 'private', detail: '核心交易留在 Bot' },
          ].map(({ icon: Icon, label, detail }) => (
            <div key={label} className="sv-content-card flex min-h-[76px] items-center gap-3 rounded-xl p-3">
              <Icon className="sv-accent-text h-5 w-5" />
              <div>
                <div className="sv-muted-text font-mono text-[10px] uppercase tracking-[0.14em]">{label}</div>
                <div className="sv-title-text mt-1 text-sm">{detail}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <div className="sv-content-card sv-muted-text rounded-xl p-3 text-xs leading-5">
            <Activity className="mb-2 h-4 w-4 text-[#7aa2c7]" />
            Home 現在是正式入口，但資料面保留資訊落差：公開頁只看宏觀聚合，不讀核心推薦卡。
          </div>
          <div className="sv-content-card sv-muted-text rounded-xl p-3 text-xs leading-5">
            <TrendingUp className="mb-2 inline h-4 w-4 text-rose-300" />
            <TrendingDown className="mb-2 ml-2 inline h-4 w-4 text-emerald-300" />
            紅綠只代表市場資金流方向；不代表首頁可以直接推導進出場。
          </div>
        </div>
      </div>
    </AppShell>
  )
}
