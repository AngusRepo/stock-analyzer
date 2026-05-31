import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Activity,
  BarChart3,
  Bot,
  Boxes,
  CheckCircle2,
  ChevronRight,
  Eye,
  Gauge,
  GitBranch,
  Home,
  Layers3,
  LineChart,
  Lock,
  ShieldCheck,
  Sparkles,
  Target,
  TrendingUp,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

type Tone = 'ok' | 'warn' | 'info' | 'neutral' | 'private'

type RoadmapStep = {
  phase: 'P0' | 'P1' | 'P2' | 'P3'
  title: string
  outcome: string
  surfaces: string
}

const toneClass: Record<Tone, string> = {
  ok: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200',
  warn: 'border-amber-400/35 bg-amber-400/10 text-amber-100',
  info: 'border-sky-400/30 bg-sky-400/10 text-sky-100',
  neutral: 'border-slate-500/25 bg-slate-500/10 text-slate-200',
  private: 'border-fuchsia-400/30 bg-fuchsia-400/10 text-fuchsia-100',
}

const publicTopics = [
  { label: 'AI server', value: 91, candidates: 18, flow: '+32.4B' },
  { label: 'Power & cooling', value: 78, candidates: 14, flow: '+24.1B' },
  { label: 'Advanced packaging', value: 66, candidates: 16, flow: '+15.2B' },
  { label: 'Defense tech', value: 54, candidates: 9, flow: '+8.8B' },
]

const executionFunnel = [
  { label: 'Public candidates', count: 40, tone: 'info' as Tone },
  { label: 'Tradable pool', count: 17, tone: 'neutral' as Tone },
  { label: 'Debate passed', count: 8, tone: 'warn' as Tone },
  { label: 'Bot targets', count: 5, tone: 'private' as Tone },
  { label: 'Pending buys', count: 3, tone: 'ok' as Tone },
]

const modelHealth = [
  { model: 'TabM', ic: 'ok', pbo: 'ok', dsr: 'warn', live: 'ok', champion: 'shadow' },
  { model: 'PatchTST', ic: 'ok', pbo: 'warn', dsr: 'warn', live: 'neutral', champion: 'candidate' },
  { model: 'DLinear', ic: 'neutral', pbo: 'ok', dsr: 'ok', live: 'ok', champion: 'production' },
  { model: 'GNN', ic: 'warn', pbo: 'neutral', dsr: 'neutral', live: 'warn', champion: 'research' },
]

const roadmap: RoadmapStep[] = [
  {
    phase: 'P0',
    title: 'Visibility boundary',
    outcome: 'Home 只拿 public projection；Bot 才拿 private trade execution packet。',
    surfaces: 'Home, Bot, queryPolicy',
  },
  {
    phase: 'P0',
    title: 'Daily Focus becomes Home',
    outcome: '/preview/daily-focus 的模式升級成正式首頁，舊 Dashboard 併入或降級。',
    surfaces: 'App routes, DailyFocus',
  },
  {
    phase: 'P1',
    title: 'Visualize recommendations',
    outcome: '用 decision map、score waterfall、gate strip 取代長卡片與重複說明。',
    surfaces: 'RecommendationCardClean split',
  },
  {
    phase: 'P1',
    title: 'Bot execution cockpit',
    outcome: 'Bot 變成交易核心：funnel、pending buys、gate blockers、positions、P&L。',
    surfaces: 'BotDashboard',
  },
  {
    phase: 'P2',
    title: 'Model governance split',
    outcome: '/model-pool 顯示 health matrix；raw artifacts 移到 /model-pool/inspector。',
    surfaces: 'ModelPool, Inspector',
  },
  {
    phase: 'P3',
    title: 'Delete duplicate surfaces',
    outcome: '移除 legacy recommendation panel、重複 fallback UI；prototype URL 改導正式 Home。',
    surfaces: 'Shared primitives',
  },
]

const boundaryItems: Array<{ title: string; detail: string; tone: Tone }> = [
  { title: 'Public payload', detail: '市場風險、題材熱度、候選數、公開摘要', tone: 'info' },
  { title: 'Hidden in Home', detail: 'Bot target subset、pending buys、debate details', tone: 'private' },
  { title: 'Allowed CTA', detail: '登入後進 Bot 查看執行池', tone: 'ok' },
]

const visualizationItems: Array<{ title: string; detail: string; tone: Tone }> = [
  { title: 'Score waterfall', detail: 'base → alpha → risk → final', tone: 'ok' },
  { title: 'Gate strip', detail: 'ML / chip / technical / liquidity / risk', tone: 'warn' },
  { title: 'Long reason', detail: '只在 drilldown 顯示全文', tone: 'neutral' },
]

const demoTabs: Array<{ id: string; icon: LucideIcon; label: string }> = [
  { id: 'home', icon: Home, label: 'Home' },
  { id: 'bot', icon: Bot, label: 'Bot' },
  { id: 'map', icon: BarChart3, label: 'Visuals' },
  { id: 'model', icon: Boxes, label: 'ModelPool' },
]

const summaryTiles: Array<{ title: string; detail: string; icon: LucideIcon; tone: Tone }> = [
  { title: 'Public Home', detail: '市場/題材/候選池', icon: Eye, tone: 'info' },
  { title: 'Private Bot', detail: '真正交易核心', icon: Lock, tone: 'private' },
  { title: 'Visual First', detail: '圖表取代長文', icon: LineChart, tone: 'ok' },
  { title: 'Raw Inspector', detail: '獨立查核頁', icon: Gauge, tone: 'warn' },
]

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ')
}

function Pill({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={cx('inline-flex items-center border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em]', toneClass[tone])}>
      {children}
    </span>
  )
}

function Panel({
  title,
  label,
  icon: Icon,
  children,
  className,
}: {
  title: string
  label: string
  icon: typeof Activity
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cx('overflow-hidden rounded-lg border border-[#263247] bg-[#0d141d]', className)}>
      <header className="flex min-h-12 items-center justify-between gap-3 border-b border-[#263247] bg-[#111923] px-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid h-8 w-8 shrink-0 place-items-center border border-[#3a4658] bg-[#070a10] text-[#ffd87f]">
            <Icon aria-hidden="true" className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-[#f2ead8]">{title}</h2>
            <p className="truncate text-[11px] text-[#8b9bab]">{label}</p>
          </div>
        </div>
      </header>
      {children}
    </section>
  )
}

function PublicHomePreview() {
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
      <Panel title="Public Daily Focus" label="朋友可看的市場情報層" icon={Home}>
        <div className="space-y-4 p-4">
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              ['候選池', '40', '公開候選，不揭露 Bot 目標'],
              ['題材群', '6', '熱度、資金、新聞事件'],
              ['風險分', '68', '偏多但需控倉'],
            ].map(([label, value, detail]) => (
              <div key={label} className="border border-[#263247] bg-[#070a10]/70 p-3">
                <p className="text-[11px] text-[#8b9bab]">{label}</p>
                <p className="mt-1 font-mono text-3xl font-semibold tabular-nums text-[#f2ead8]">{value}</p>
                <p className="mt-2 text-[11px] leading-4 text-[#75879a]">{detail}</p>
              </div>
            ))}
          </div>

          <div className="space-y-3">
            {publicTopics.map((topic) => (
              <div key={topic.label} className="grid gap-3 border border-[#263247] bg-[#070a10]/70 p-3 sm:grid-cols-[128px_minmax(0,1fr)_96px] sm:items-center">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-[#f2ead8]">{topic.label}</p>
                  <p className="mt-1 text-[11px] text-[#75879a]">{topic.candidates} candidates</p>
                </div>
                <div className="h-2 overflow-hidden bg-[#172033]" aria-label={`${topic.label} strength ${topic.value}`}>
                  <div className="h-full bg-[linear-gradient(90deg,#00d2ff,#f0b90b)]" style={{ width: `${topic.value}%` }} />
                </div>
                <p className="font-mono text-sm text-red-300">{topic.flow}</p>
              </div>
            ))}
          </div>
        </div>
      </Panel>

      <Panel title="Public/Private Boundary" label="首頁展示價值，但不暴露核心交易標的" icon={ShieldCheck}>
        <div className="space-y-3 p-4">
          {boundaryItems.map(({ title, detail, tone }) => (
            <div key={title} className="flex gap-3 border border-[#263247] bg-[#070a10]/70 p-3">
              <Pill tone={tone}>{title}</Pill>
              <p className="min-w-0 text-xs leading-5 text-[#a8b6c5]">{detail}</p>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  )
}

function ExecutionCockpitPreview() {
  const total = executionFunnel[0]?.count ?? 1

  return (
    <Panel title="Private Bot Execution Cockpit" label="真正交易核心只在 Bot" icon={Bot}>
      <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-3">
          {executionFunnel.map((step, index) => (
            <div key={step.label} className="grid gap-3 border border-[#263247] bg-[#070a10]/72 p-3 md:grid-cols-[32px_minmax(0,1fr)_minmax(160px,0.7fr)_80px] md:items-center">
              <span className="grid h-8 w-8 place-items-center border border-[#3a3125] bg-[#171714] font-mono text-[11px] text-[#ffd87f]">
                {index + 1}
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-[#f2ead8]">{step.label}</p>
                <p className="mt-1 text-[11px] text-[#75879a]">{index === 3 ? 'private execution subset' : 'visible only at the right layer'}</p>
              </div>
              <div className="h-2 overflow-hidden bg-[#172033]">
                <div className="h-full bg-[#ffd87f]" style={{ width: `${Math.max(8, (step.count / total) * 100)}%` }} />
              </div>
              <Pill tone={step.tone}>{step.count}</Pill>
            </div>
          ))}
        </div>

        <div className="space-y-3 border border-fuchsia-400/25 bg-fuchsia-400/[0.04] p-4">
          <div className="flex items-center gap-2 text-fuchsia-100">
            <Lock aria-hidden="true" className="h-4 w-4" />
            <h3 className="text-sm font-semibold">Bot-only trading packet</h3>
          </div>
          <div className="grid gap-2">
            {['true target subset', 'pending buy states', 'debate evidence', 'quote sanity', 'position sizing'].map((item) => (
              <div key={item} className="flex items-center justify-between border border-fuchsia-400/20 bg-[#070a10]/60 px-3 py-2 text-xs">
                <span className="text-[#d8c5ff]">{item}</span>
                <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5 text-fuchsia-200" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </Panel>
  )
}

function RecommendationMapPreview() {
  const points = useMemo(
    () => [
      { x: 72, y: 70, tone: 'info' as Tone, label: 'public candidate' },
      { x: 84, y: 62, tone: 'warn' as Tone, label: 'watch' },
      { x: 90, y: 82, tone: 'private' as Tone, label: 'bot target' },
      { x: 66, y: 44, tone: 'neutral' as Tone, label: 'research' },
      { x: 78, y: 88, tone: 'ok' as Tone, label: 'pending buy' },
    ],
    [],
  )

  return (
    <Panel title="Recommendation Visualization" label="少文字，多判斷座標" icon={Target}>
      <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="relative min-h-[340px] border border-[#263247] bg-[#070a10] p-4">
          <div className="absolute inset-4 bg-[linear-gradient(rgba(255,255,255,0.035)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.03)_1px,transparent_1px)] bg-[size:48px_48px]" />
          <div className="absolute bottom-4 left-4 right-4 h-px bg-[#263247]" />
          <div className="absolute bottom-4 left-4 top-4 w-px bg-[#263247]" />
          <span className="absolute bottom-1 right-4 font-mono text-[10px] text-[#75879a]">score</span>
          <span className="absolute left-1 top-4 font-mono text-[10px] text-[#75879a] [writing-mode:vertical-rl]">execution confidence</span>
          {points.map((point) => (
            <div
              key={point.label}
              className={cx(
                'absolute h-8 w-8 -translate-x-1/2 -translate-y-1/2 border shadow-[0_0_24px_rgba(240,185,11,0.08)]',
                toneClass[point.tone],
              )}
              style={{ left: `${point.x}%`, top: `${100 - point.y}%` }}
              title={point.label}
            />
          ))}
        </div>

        <div className="space-y-3">
          {visualizationItems.map(({ title, detail, tone }) => (
            <div key={title} className="border border-[#263247] bg-[#070a10]/72 p-3">
              <Pill tone={tone}>{title}</Pill>
              <p className="mt-3 text-xs leading-5 text-[#a8b6c5]">{detail}</p>
            </div>
          ))}
        </div>
      </div>
    </Panel>
  )
}

function ModelPoolPreview() {
  const statusTone = (value: string): Tone => {
    if (value === 'ok' || value === 'production') return 'ok'
    if (value === 'warn' || value === 'shadow' || value === 'candidate') return 'warn'
    if (value === 'research') return 'info'
    return 'neutral'
  }

  return (
    <Panel title="ModelPool Split" label="/model-pool 看治理，/model-pool/inspector 查 raw" icon={Boxes}>
      <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="overflow-x-auto">
          <div className="min-w-[640px] border border-[#263247]">
            <div className="grid grid-cols-[132px_repeat(5,1fr)] bg-[#111923] text-[11px] text-[#8b9bab]">
              {['model', 'IC', 'PBO', 'DSR', 'Live', 'Champion'].map((cell) => (
                <div key={cell} className="border-r border-[#263247] px-3 py-2 last:border-r-0">{cell}</div>
              ))}
            </div>
            {modelHealth.map((row) => (
              <div key={row.model} className="grid grid-cols-[132px_repeat(5,1fr)] border-t border-[#263247] text-xs">
                <div className="border-r border-[#263247] px-3 py-3 font-semibold text-[#f2ead8]">{row.model}</div>
                {[row.ic, row.pbo, row.dsr, row.live, row.champion].map((value, index) => (
                  <div key={`${row.model}-${index}`} className="border-r border-[#263247] px-3 py-2 last:border-r-0">
                    <Pill tone={statusTone(value)}>{value}</Pill>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-3 border border-[#263247] bg-[#070a10]/72 p-4">
          <div className="flex items-center gap-2">
            <GitBranch aria-hidden="true" className="h-4 w-4 text-[#ffd87f]" />
            <h3 className="text-sm font-semibold text-[#f2ead8]">Inspector route</h3>
          </div>
          <p className="text-xs leading-5 text-[#a8b6c5]">
            Raw artifact ID、candidate validation packet、blocker code、超寬表格移到獨立頁，避免治理首頁被 audit 細節淹沒。
          </p>
          <Pill tone="info">/model-pool/inspector</Pill>
        </div>
      </div>
    </Panel>
  )
}

function RoadmapPreview() {
  return (
    <Panel title="Implementation Roadmap" label="從資訊邊界到刪除重複 surface" icon={Layers3}>
      <div className="divide-y divide-[#263247]">
        {roadmap.map((item) => (
          <div key={`${item.phase}-${item.title}`} className="grid gap-3 p-4 md:grid-cols-[64px_minmax(0,0.8fr)_minmax(0,1.2fr)_220px] md:items-center">
            <Pill tone={item.phase === 'P0' ? 'warn' : item.phase === 'P1' ? 'ok' : item.phase === 'P2' ? 'info' : 'neutral'}>
              {item.phase}
            </Pill>
            <p className="text-sm font-semibold text-[#f2ead8]">{item.title}</p>
            <p className="text-xs leading-5 text-[#a8b6c5]">{item.outcome}</p>
            <p className="font-mono text-[11px] text-[#75879a]">{item.surfaces}</p>
          </div>
        ))}
      </div>
    </Panel>
  )
}

export default function UiuxRoadmapDemoPage() {
  const [activeView, setActiveView] = useState('home')

  return (
    <main className="min-h-[100dvh] overflow-x-hidden bg-[#070a10] text-[#e6edf3]">
      <div className="pointer-events-none fixed inset-0 opacity-50 bg-[linear-gradient(rgba(255,255,255,0.022)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.016)_1px,transparent_1px)] bg-[size:22px_22px]" />
      <div className="relative mx-auto flex w-full max-w-[1480px] flex-col gap-4 px-4 py-4 lg:px-6">
        <header className="grid gap-4 rounded-lg border border-[#2b3a49] bg-[linear-gradient(120deg,#171714,#111821_54%,#0b1118)] p-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Pill tone="warn">UIUX refactor demo</Pill>
              <Pill tone="private">visibility boundary</Pill>
            </div>
            <h1 className="mt-3 text-balance font-['Space_Grotesk'] text-2xl font-semibold text-[#f2ead8] md:text-4xl">
              StockVision Daily Focus Home + Private Bot Cockpit
            </h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-[#a8b6c5]">
              Demo 先展示重構後的資訊分層：首頁公開展示市場脈絡與候選池，Bot 保留真正交易目標，ModelPool 拆出 raw inspector。
            </p>
          </div>
          <nav aria-label="Demo sections" className="flex flex-wrap gap-2">
            {demoTabs.map(({ id, icon: Icon, label }) => (
              <button
                key={id}
                type="button"
                aria-label={`Show ${label} demo`}
                onClick={() => setActiveView(id)}
                className={cx(
                  'inline-flex h-9 items-center gap-2 border px-3 text-xs font-medium text-[#c8d3df] transition-[background-color,border-color,color]',
                  activeView === id
                    ? 'border-[#ffd87f]/60 bg-[#f0b90b]/12 text-[#ffd87f]'
                    : 'border-[#263247] bg-[#070a10]/70 hover:border-[#3a4658] hover:text-[#f2ead8] focus-visible:ring-2 focus-visible:ring-[#ffd87f]/40',
                )}
              >
                <Icon aria-hidden="true" className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </nav>
        </header>

        <div className="grid gap-3 md:grid-cols-4">
            {summaryTiles.map(({ title, detail, icon: Icon, tone }) => (
              <div key={title} className="border border-[#263247] bg-[#0d141d] p-3">
                <div className="flex items-center justify-between gap-3">
                  <Icon aria-hidden="true" className="h-4 w-4 text-[#ffd87f]" />
                  <Pill tone={tone}>target</Pill>
              </div>
              <p className="mt-3 text-sm font-semibold text-[#f2ead8]">{title}</p>
              <p className="mt-1 text-xs leading-5 text-[#8b9bab]">{detail}</p>
            </div>
          ))}
        </div>

        {activeView === 'home' && <PublicHomePreview />}
        {activeView === 'bot' && <ExecutionCockpitPreview />}
        {activeView === 'map' && <RecommendationMapPreview />}
        {activeView === 'model' && <ModelPoolPreview />}

        <RoadmapPreview />

        <footer className="flex flex-col gap-2 border border-[#263247] bg-[#0d141d] p-4 text-xs leading-5 text-[#8b9bab] md:flex-row md:items-center md:justify-between">
          <span>Demo only: static sample data, no production API, no trading action.</span>
          <span className="inline-flex items-center gap-1 font-mono text-[#ffd87f]">
            next
            <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
            retire duplicate preview surfaces
          </span>
        </footer>
      </div>
    </main>
  )
}
