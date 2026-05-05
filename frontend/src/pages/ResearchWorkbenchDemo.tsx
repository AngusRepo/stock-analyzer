import {
  Activity,
  ArrowUpRight,
  BellRing,
  BookOpenText,
  Building2,
  CalendarClock,
  ChartCandlestick,
  ChevronRight,
  CircleDollarSign,
  Gauge,
  Layers3,
  LineChart,
  Newspaper,
  Radar,
  Route,
  Search,
  ShieldCheck,
  Sparkles,
  Target,
  TrendingUp,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

const topics = [
  { id: 'asic-ip-design', name: 'IP 授權與 ASIC 設計', group: '半導體設計', heat: 91, delta: '+8.4%', tone: 'hot' },
  { id: 'advanced-packaging', name: 'AI 先進封裝', group: '半導體製程', heat: 86, delta: '+5.1%', tone: 'hot' },
  { id: 'power-ic', name: '類比與功率 IC', group: 'IC 元件', heat: 72, delta: '+2.7%', tone: 'warm' },
  { id: 'edge-ai', name: '邊緣 AI 模組', group: 'AI 硬體', heat: 68, delta: '-1.2%', tone: 'cool' },
]

const focusQueue = [
  { tag: '新聞', title: 'ASIC IP 題材新聞量升至 30 日高位', source: 'Anue / MOPS / internal topic map', impact: '高' },
  { tag: '資金', title: '法人連 3 日加碼 IC 設計族群', source: 'TWSE / TPEX', impact: '中高' },
  { tag: '籌碼', title: '大戶持股同步升溫，融資增幅仍可控', source: 'chip_data / margin_balance', impact: '中' },
  { tag: '公告', title: 'MOPS 重大訊息集中於先進製程與伺服器供應鏈', source: 'MOPS normalized events', impact: '中' },
]

const constituents = [
  { symbol: '3443', name: '創意', role: 'ASIC / NRE', ml: 82, chip: '+12.4%', news: 9, risk: '中' },
  { symbol: '3034', name: '聯詠', role: 'HPC / display IC', ml: 76, chip: '+5.8%', news: 5, risk: '低' },
  { symbol: '3661', name: '世芯-KY', role: 'ASIC design service', ml: 74, chip: '-2.1%', news: 7, risk: '中高' },
  { symbol: '5274', name: '信驊', role: 'BMC / server IC', ml: 69, chip: '+3.6%', news: 3, risk: '低' },
]

const sourceCoverage = ['TWSE', 'TPEX', 'TAIFEX', 'Anue', 'MOPS', 'FinMind sidecar', 'Internal ML']

function ToneDot({ tone }: { tone: string }) {
  const color = tone === 'hot' ? 'bg-[#f25f5c]' : tone === 'warm' ? 'bg-[#f6bd60]' : 'bg-[#5aa9e6]'
  return <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${color}`} />
}

function MetricTile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="border border-[#273142] bg-[#0d1118] p-3">
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#8a94a8]">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-white">{value}</p>
      <p className="mt-1 text-xs text-[#9aa6b8]">{sub}</p>
    </div>
  )
}

function SectionTitle({
  icon: Icon,
  title,
  eyebrow,
}: {
  icon: React.ElementType
  title: string
  eyebrow: string
}) {
  return (
    <div className="mb-4 flex items-center justify-between gap-4">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center border border-[#334155] bg-[#111827] text-[#65d6ad]">
          <Icon className="h-4 w-4" />
        </div>
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#8a94a8]">{eyebrow}</p>
          <h2 className="text-lg font-semibold text-white">{title}</h2>
        </div>
      </div>
      <Button size="sm" variant="outline" className="h-8 gap-1.5 border-[#334155] bg-[#0d1118] text-xs text-[#cbd5e1]">
        <ArrowUpRight className="h-3.5 w-3.5" />
        Inspect
      </Button>
    </div>
  )
}

function TopicWorkspace() {
  return (
    <div className="space-y-5">
      <SectionTitle icon={Layers3} eyebrow="Topic workspace" title="IP 授權與 ASIC 設計" />
      <div className="grid gap-3 md:grid-cols-4">
        <MetricTile label="Topic heat" value="91" sub="題材強度 PR 94" />
        <MetricTile label="News pulse" value="+42%" sub="7 日新聞增速" />
        <MetricTile label="Chip pressure" value="+12.4%" sub="法人與大戶同步" />
        <MetricTile label="ML alignment" value="82%" sub="recommendation overlap" />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.3fr_0.7fr]">
        <div className="border border-[#273142] bg-[#0b0f16]">
          <div className="grid grid-cols-[88px_1fr_130px_80px_80px_72px] border-b border-[#273142] px-4 py-2 font-mono text-[10px] uppercase tracking-[0.12em] text-[#8a94a8]">
            <span>Symbol</span>
            <span>Name / role</span>
            <span>Chip</span>
            <span>News</span>
            <span>ML</span>
            <span>Risk</span>
          </div>
          {constituents.map((stock) => (
            <div key={stock.symbol} className="grid grid-cols-[88px_1fr_130px_80px_80px_72px] items-center border-b border-[#1f2937] px-4 py-3 last:border-0">
              <span className="font-mono text-sm font-semibold text-white">{stock.symbol}</span>
              <div>
                <p className="text-sm font-medium text-[#e5e7eb]">{stock.name}</p>
                <p className="text-xs text-[#8a94a8]">{stock.role}</p>
              </div>
              <span className="font-mono text-sm text-[#65d6ad]">{stock.chip}</span>
              <span className="font-mono text-sm text-[#f6bd60]">{stock.news}</span>
              <span className="font-mono text-sm text-[#8ecae6]">{stock.ml}</span>
              <Badge variant="outline" className="w-fit rounded-sm border-[#334155] text-[#cbd5e1]">{stock.risk}</Badge>
            </div>
          ))}
        </div>

        <div className="space-y-3">
          {['AI ASIC 投片需求延續', '先進封裝產能議題擴散', 'NRE 訂單能見度改善'].map((item, index) => (
            <div key={item} className="border border-[#273142] bg-[#10151f] p-4">
              <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#8a94a8]">Catalyst 0{index + 1}</p>
              <p className="mt-2 text-sm font-medium text-white">{item}</p>
              <p className="mt-2 text-xs leading-5 text-[#9aa6b8]">新聞、籌碼與 ML 同向時提高觀察優先級，單一來源不直接升級成買進訊號。</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function DailyFocus() {
  return (
    <div className="space-y-5">
      <SectionTitle icon={BellRing} eyebrow="Daily focus" title="今日焦點隊列" />
      <div className="grid gap-3 lg:grid-cols-2">
        {focusQueue.map((item) => (
          <div key={item.title} className="border border-[#273142] bg-[#0b0f16] p-4">
            <div className="mb-3 flex items-center justify-between">
              <Badge className="rounded-sm bg-[#1b4332] text-[#b7efc5] hover:bg-[#1b4332]">{item.tag}</Badge>
              <span className="font-mono text-xs text-[#f6bd60]">Impact {item.impact}</span>
            </div>
            <h3 className="text-base font-semibold text-white">{item.title}</h3>
            <p className="mt-3 text-xs text-[#8a94a8]">{item.source}</p>
          </div>
        ))}
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <MetricTile label="Strength list" value="38" sub="本週強勢股" />
        <MetricTile label="Large holder" value="14" sub="大戶加碼樣本" />
        <MetricTile label="Event tracker" value="9" sub="公告與事件異動" />
      </div>
    </div>
  )
}

function StockResearch() {
  const lanes = [
    { icon: LineChart, title: 'Technical', text: '突破 20 日整理區，量能維持高於 20 日均量。' },
    { icon: CircleDollarSign, title: 'Chip', text: '法人三日買超，大戶持股率同步上修。' },
    { icon: Newspaper, title: 'News', text: '題材新聞集中於 ASIC、AI server 與先進製程。' },
    { icon: ShieldCheck, title: 'Risk', text: '波動升高，停損需綁定 intraday liquidity。' },
  ]

  return (
    <div className="space-y-5">
      <SectionTitle icon={Building2} eyebrow="Stock research" title="3443 創意：題材、ML 與風險合併視圖" />
      <div className="grid gap-3 md:grid-cols-[1.1fr_0.9fr]">
        <div className="border border-[#273142] bg-[#0b0f16] p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-[#8a94a8]">Signal provenance</p>
              <h3 className="mt-2 text-2xl font-semibold text-white">BUY / confidence 0.82</h3>
              <p className="mt-2 text-sm text-[#9aa6b8]">來源：ensemble_v2 + topic momentum + chip confirmation</p>
            </div>
            <div className="grid grid-cols-2 gap-2 text-right">
              <MetricTile label="ML score" value="82" sub="rank PR 88" />
              <MetricTile label="Stop gap" value="5.2%" sub="ATR adjusted" />
            </div>
          </div>
        </div>
        <div className="border border-[#273142] bg-[#10151f] p-5">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#8a94a8]">Related map</p>
          <div className="mt-4 flex flex-wrap gap-2">
            {['IP 授權', 'ASIC 設計', 'AI 伺服器', '先進封裝', '供應鏈映射'].map((tag) => (
              <Badge key={tag} variant="outline" className="rounded-sm border-[#3b4a5f] bg-[#0b0f16] text-[#d8dee9]">{tag}</Badge>
            ))}
          </div>
          <p className="mt-4 text-sm leading-6 text-[#9aa6b8]">個股頁不再只是圖表集合，而是把題材、籌碼、新聞、公告、ML 與供應鏈關係放在同一個固定研究容器。</p>
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-4">
        {lanes.map(({ icon: Icon, title, text }) => (
          <div key={title} className="border border-[#273142] bg-[#0d1118] p-4">
            <Icon className="mb-3 h-4 w-4 text-[#65d6ad]" />
            <h3 className="text-sm font-semibold text-white">{title}</h3>
            <p className="mt-2 text-xs leading-5 text-[#9aa6b8]">{text}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

function LeftRail() {
  return (
    <aside className="hidden border-r border-[#273142] bg-[#080c12] p-4 lg:block">
      <div className="mb-5 flex items-center gap-2">
        <div className="flex h-9 w-9 items-center justify-center border border-[#65d6ad]/40 bg-[#0f1d1a] font-mono text-xs font-black text-[#b7efc5]">SV</div>
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-white">Research</p>
          <p className="text-[11px] text-[#8a94a8]">topic-first layer</p>
        </div>
      </div>

      <div className="space-y-2">
        {topics.map((topic) => (
          <button key={topic.id} className="grid w-full grid-cols-[12px_1fr_auto] items-center gap-2 border border-transparent px-2 py-2.5 text-left hover:border-[#334155] hover:bg-[#0d1118]">
            <ToneDot tone={topic.tone} />
            <span className="min-w-0">
              <span className="block truncate text-xs font-medium text-[#e5e7eb]">{topic.name}</span>
              <span className="block truncate text-[10px] text-[#8a94a8]">{topic.group}</span>
            </span>
            <span className="font-mono text-[11px] text-[#65d6ad]">{topic.heat}</span>
          </button>
        ))}
      </div>

      <div className="mt-6 border-t border-[#273142] pt-4">
        <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.16em] text-[#8a94a8]">Market lenses</p>
        {['題材熱力', '資金動向', '法人加碼', '供應鏈映射'].map((lens) => (
          <button key={lens} className="flex w-full items-center justify-between px-2 py-2 text-left text-xs text-[#cbd5e1] hover:bg-[#0d1118]">
            <span>{lens}</span>
            <ChevronRight className="h-3.5 w-3.5 text-[#64748b]" />
          </button>
        ))}
      </div>
    </aside>
  )
}

function RightRail() {
  return (
    <aside className="hidden border-l border-[#273142] bg-[#080c12] p-4 xl:block">
      <div className="mb-5">
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#8a94a8]">Today brief</p>
        <h3 className="mt-2 text-base font-semibold text-white">研究摘要</h3>
      </div>

      <div className="space-y-3">
        {focusQueue.slice(0, 3).map((item) => (
          <div key={item.title} className="border border-[#273142] bg-[#0d1118] p-3">
            <div className="mb-2 flex items-center justify-between">
              <Badge variant="outline" className="rounded-sm border-[#334155] text-[10px] text-[#cbd5e1]">{item.tag}</Badge>
              <span className="font-mono text-[10px] text-[#f6bd60]">{item.impact}</span>
            </div>
            <p className="text-xs leading-5 text-[#d8dee9]">{item.title}</p>
          </div>
        ))}
      </div>

      <div className="mt-6 border-t border-[#273142] pt-4">
        <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.16em] text-[#8a94a8]">Source coverage</p>
        <div className="flex flex-wrap gap-1.5">
          {sourceCoverage.map((source) => (
            <span key={source} className="border border-[#273142] bg-[#10151f] px-2 py-1 font-mono text-[10px] text-[#9aa6b8]">{source}</span>
          ))}
        </div>
      </div>
    </aside>
  )
}

export default function ResearchWorkbenchDemo() {
  return (
    <div className="min-h-screen bg-[#05080d] text-[#e5e7eb]">
      <div className="grid min-h-screen grid-cols-1 lg:grid-cols-[260px_1fr] xl:grid-cols-[260px_1fr_300px]">
        <LeftRail />

        <main className="min-w-0">
          <header className="border-b border-[#273142] bg-[#080c12] px-4 py-4 md:px-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <Badge className="rounded-sm bg-[#1b4332] text-[#b7efc5] hover:bg-[#1b4332]">Demo route</Badge>
                  <span className="font-mono text-[11px] text-[#8a94a8]">/demo/research-workbench</span>
                </div>
                <h1 className="text-2xl font-semibold tracking-normal text-white md:text-3xl">StockVision Research Workbench</h1>
                <p className="mt-2 max-w-3xl text-sm leading-6 text-[#9aa6b8]">題材、每日焦點與個股研究合併成單一研究層。這頁只使用靜態 demo data，不觸碰 production API。</p>
              </div>
              <div className="flex items-center gap-2">
                <div className="hidden border border-[#273142] bg-[#0d1118] px-3 py-2 font-mono text-xs text-[#9aa6b8] md:flex">
                  <CalendarClock className="mr-2 h-4 w-4 text-[#65d6ad]" />
                  2026-05-05 08:30 TW
                </div>
                <Button className="h-9 gap-2 rounded-sm bg-[#d8f3dc] text-[#06130f] hover:bg-[#b7efc5]">
                  <Search className="h-4 w-4" />
                  Search
                </Button>
              </div>
            </div>
          </header>

          <section className="border-b border-[#273142] bg-[#0a0f16] px-4 py-4 md:px-6">
            <div className="grid gap-3 md:grid-cols-4">
              <MetricTile label="Active topics" value="128" sub="taxonomy nodes" />
              <MetricTile label="News mapped" value="412" sub="24h topic events" />
              <MetricTile label="Chip alerts" value="37" sub="institution / large holder" />
              <MetricTile label="ML coverage" value="91%" sub="recommendation universe" />
            </div>
          </section>

          <section className="px-4 py-5 md:px-6">
            <Tabs defaultValue="topics" className="gap-5">
              <TabsList className="grid h-auto w-full grid-cols-1 rounded-none border border-[#273142] bg-[#0d1118] p-1 sm:grid-cols-3">
                <TabsTrigger value="topics" className="rounded-sm data-[state=active]:bg-[#d8f3dc] data-[state=active]:text-[#06130f]">
                  <Route className="h-4 w-4" />
                  題材
                </TabsTrigger>
                <TabsTrigger value="focus" className="rounded-sm data-[state=active]:bg-[#d8f3dc] data-[state=active]:text-[#06130f]">
                  <Radar className="h-4 w-4" />
                  焦點
                </TabsTrigger>
                <TabsTrigger value="stock" className="rounded-sm data-[state=active]:bg-[#d8f3dc] data-[state=active]:text-[#06130f]">
                  <ChartCandlestick className="h-4 w-4" />
                  個股
                </TabsTrigger>
              </TabsList>

              <TabsContent value="topics">
                <TopicWorkspace />
              </TabsContent>
              <TabsContent value="focus">
                <DailyFocus />
              </TabsContent>
              <TabsContent value="stock">
                <StockResearch />
              </TabsContent>
            </Tabs>
          </section>
        </main>

        <RightRail />
      </div>

      <div className="fixed bottom-4 left-4 z-20 hidden items-center gap-2 border border-[#273142] bg-[#080c12]/95 px-3 py-2 font-mono text-[11px] text-[#9aa6b8] shadow-2xl backdrop-blur md:flex">
        <Activity className="h-3.5 w-3.5 text-[#65d6ad]" />
        Static UX demo. No production calls.
        <Sparkles className="h-3.5 w-3.5 text-[#f6bd60]" />
        Hybrid mode.
        <Gauge className="h-3.5 w-3.5 text-[#8ecae6]" />
        Research layer only.
        <Target className="h-3.5 w-3.5 text-[#f25f5c]" />
        Review candidate.
        <BookOpenText className="h-3.5 w-3.5 text-[#b7efc5]" />
        IA preview.
        <TrendingUp className="h-3.5 w-3.5 text-[#f6bd60]" />
        Topic-first.
      </div>
    </div>
  )
}
