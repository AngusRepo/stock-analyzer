/**
 * 晨間概覽 — StockVision 主頁
 *
 * UX 改進：
 * 1. Hero 顯示完整報價（收盤、漲跌、成交量、52週高低）
 * 2. Tab 結構重組：圖表 / 籌碼技術 / 基本面 / AI分析 / 新聞
 * 3. 移除雙層 card 包裝，統一邊距與邊框
 * 4. 側邊欄加入漲跌顏色，看一眼知道持倉狀態
 * 5. 空白頁加入常用股票快速選擇
 */
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { stocksApi, marketApi, systemApi, watchlistApi, dashboardV4Api } from '@/lib/api'
import { useAuth } from '@/_core/hooks/useAuth'
import { usePWA } from '@/hooks/usePWA'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

import { toast } from 'sonner'
import { Toaster } from '@/components/ui/sonner'
import {
  Trash2, RefreshCw, BarChart2, Home,
  PieChart, Brain, LogIn, Sparkles,
  Newspaper, LogOut, ChevronRight, Search, Layers, ShieldAlert, Bell,
  Star, ShieldCheck, Users } from 'lucide-react'
import AppShell from '@/components/AppShell'
import StockSearchCombobox, { type StockSelection } from '@/components/StockSearchCombobox'
import TechnicalChart from '@/components/TechnicalChart'
import ChipChart from '@/components/ChipChart'
import MarginChart from '@/components/MarginChart'
import CandlestickChart from '@/components/CandlestickChart'
import FinancialSummary from '@/components/FinancialSummary'
import AlertManager from '@/components/AlertManager'
import FactorAnalysis from '@/components/FactorAnalysis'
import RiskMetricsPanel from '@/components/RiskMetricsPanel'
import StockAIReport from '@/components/StockAIReport'
import NewsPanel from '@/components/NewsPanel'
import DashboardV4LightweightChart from '@/components/charts/DashboardV4LightweightChart'
import MarketRiskPanel from '@/components/MarketRiskPanel'
import TradePerformancePanel from '@/components/TradePerformancePanel'
import SystemStatusBar from '@/components/SystemStatusBar'
import { ThemeFlowPanel } from '@/components/DailyRecommendationPanel'
import { DailyRecommendationPanelV2 } from '@/components/DailyRecommendationPanelV2'
import { AdminUsersPanel } from '@/components/AdminUsersPanel'
import { ThemeProvider } from '@/contexts/ThemeContext'
import { TooltipProvider } from '@/components/ui/tooltip'
import ErrorBoundary from '@/components/ErrorBoundary'
import {
  WorkstationPageTitle,
  WorkstationPanel,
  WorkstationPill,
} from '@/components/workstation/WorkstationChrome'

// ── 側邊欄股票列表項目 ─────────────────────────────────────────────────────────
function WatchlistItem({
  stock, active, onClick,
}: {
  stock: any; active: boolean; onClick: () => void
}) {
  const changePct = stock.change_pct ?? stock.changePct ?? 0
  const up = changePct >= 0

  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-left transition-all group ${
        active
          ? 'bg-primary/10 border border-primary/30 shadow-sm'
          : 'hover:bg-muted/40 border border-transparent'
      }`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-bold tracking-wide">{stock.symbol}</span>
          <Badge variant="outline" className="text-[9px] px-1 py-0 h-4">{stock.market}</Badge>
        </div>
        <p className="text-[11px] text-muted-foreground truncate mt-0.5">{stock.name}</p>
      </div>
      {stock.close ? (
        <div className="text-right shrink-0">
          <p className="text-xs font-mono font-semibold">{stock.close?.toFixed(2)}</p>
          <p className={`text-[10px] font-mono ${up ? 'text-red-400' : 'text-emerald-400'}`}>
            {up ? '▲' : '▼'} {Math.abs(changePct).toFixed(1)}%
          </p>
        </div>
      ) : (
        <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/40 group-hover:text-muted-foreground" />
      )}
    </button>
  )
}

// ── Hero：股票標題 + 完整報價 ─────────────────────────────────────────────────
function StockHero({
  stock, detail, onRefresh, onRemove, onBack, refreshing,
}: {
  stock: StockSelection
  detail: any
  onRefresh: () => void
  onRemove: () => void
  onBack: () => void
  refreshing: boolean
}) {
  const up = (detail?.change ?? 0) >= 0

  return (
    <div className="px-4 pt-4 pb-3 border-b border-border bg-card">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        {/* 左側：名稱 + 報價 */}
        <div className="flex items-end gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-2 mb-0.5">
              <button onClick={onBack} className="p-1 -ml-1 rounded hover:bg-accent/50 transition-colors" title="回首頁">
                <Home className="w-4 h-4 text-muted-foreground" />
              </button>
              <h1 className="text-xl font-black tracking-tight">{stock.symbol}</h1>
              <Badge variant="outline" className="text-xs">{stock.market}</Badge>
            </div>
            <p className="text-muted-foreground text-sm">{stock.name}</p>
          </div>

          {detail?.close && (
            <div className="flex items-baseline gap-3">
              <span className="text-3xl font-mono font-bold">
                {detail.close.toFixed(2)}
              </span>
              <div className={`text-sm font-mono ${up ? 'text-red-400' : 'text-emerald-400'}`}>
                <span>{up ? '▲' : '▼'} {Math.abs(detail.change ?? 0).toFixed(2)}</span>
                <span className="ml-1.5">({up ? '+' : ''}{detail.changePct?.toFixed(2) ?? '0.00'}%)</span>
              </div>
            </div>
          )}
        </div>

        {/* 右側：副指標 + 操作 */}
        <div className="flex items-center gap-2 ml-auto">
          {/* 成交量、52週高低 */}
          {detail && (
            <div className="hidden md:flex items-center gap-4 text-xs text-muted-foreground mr-2">
              {detail.volume && (
                <div className="text-center">
                  <p>成交量</p>
                  <p className="font-mono text-foreground">{(detail.volume / 1000).toFixed(0)}張</p>
                </div>
              )}
              {detail.high52w && (
                <div className="text-center">
                  <p>52W 高</p>
                  <p className="font-mono text-red-400">{detail.high52w?.toFixed(2)}</p>
                </div>
              )}
              {detail.low52w && (
                <div className="text-center">
                  <p>52W 低</p>
                  <p className="font-mono text-emerald-400">{detail.low52w?.toFixed(2)}</p>
                </div>
              )}
            </div>
          )}

          {/* 最新資料日期 */}
          {(detail?.latestPriceDate || detail?.latestChipDate) && (
            <div className="hidden lg:flex flex-col items-end text-[10px] text-muted-foreground mr-1">
              {detail.latestPriceDate && (
                <span>股價 {detail.latestPriceDate === new Date().toISOString().split('T')[0]
                  ? <span className="text-emerald-400">今日</span>
                  : <span className="text-yellow-400">{detail.latestPriceDate}</span>
                }</span>
              )}
              {detail.latestChipDate && (
                <span>籌碼 {detail.latestChipDate === new Date().toISOString().split('T')[0]
                  ? <span className="text-emerald-400">今日</span>
                  : <span className="text-yellow-400">{detail.latestChipDate}</span>
                }</span>
              )}
            </div>
          )}
          <Button
            size="sm" variant="ghost" className="h-8 gap-1.5 text-xs"
            onClick={onRefresh} disabled={refreshing}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline">更新</span>
          </Button>
          <Button
            size="sm" variant="ghost"
            className="h-8 gap-1.5 text-xs text-destructive/70 hover:text-destructive"
            onClick={onRemove}
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">移除</span>
          </Button>
        </div>
      </div>
    </div>
  )
}

// ── 空白頁（未選股票）─────────────────────────────────────────────────────────
const QUICK_STOCKS = [
  { symbol: '2330', name: '台積電', market: 'TW' },
  { symbol: '2317', name: '鴻海',   market: 'TW' },
  { symbol: '2603', name: '長榮',   market: 'TW' },
  { symbol: 'AAPL', name: 'Apple',  market: 'US' },
  { symbol: 'NVDA', name: 'NVIDIA', market: 'US' },
]

// ── Market Overview Row ──────────────────────────────────────────────────────
function ExDividendCard() {
  const { data } = useQuery({ queryKey: ['ex-dividend'], queryFn: marketApi.exDividend, staleTime: 3600_000 })
  if (!data?.length) return null
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
        近期除權除息
      </h3>
      <div className="space-y-1.5 max-h-48 overflow-y-auto">
        {data.slice(0, 15).map((item: any, i: number) => (
          <div key={i} className="flex items-center justify-between text-xs py-1 border-b border-border last:border-0">
            <div className="flex items-center gap-2">
              <span className="font-mono text-muted-foreground">{item.symbol || item.code}</span>
              <span className="truncate max-w-[80px]">{item.name}</span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-muted-foreground">{item.ex_date || item.date}</span>
              {item.cash_dividend && <Badge variant="outline" className="text-[10px] px-1 py-0 text-emerald-400 border-emerald-500/20">息 ${item.cash_dividend}</Badge>}
              {item.stock_dividend && <Badge variant="outline" className="text-[10px] px-1 py-0 text-amber-400 border-amber-500/20">權 {item.stock_dividend}</Badge>}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function AttentionStocksCard() {
  const { data } = useQuery({ queryKey: ['attention-stocks'], queryFn: marketApi.attentionStocks, staleTime: 3600_000 })
  if (!data?.length) return null
  return (
    <div className="rounded-xl border border-amber-500/15 bg-[linear-gradient(90deg,rgba(245,158,11,0.10),rgba(245,158,11,0.025)_45%,rgba(7,10,16,0.35))] p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-amber-300">
          <ShieldAlert className="h-3.5 w-3.5" />
          注意 / 處置股
        </h3>
        <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 font-mono text-[10px] text-amber-200/75">
          {data.length} 檔需先避開自動交易
        </span>
        <p className="ml-auto text-[11px] text-amber-100/55">先看交易限制，再看 AI 候選，避免清單漂亮但不能下單。</p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {data.slice(0, 12).map((item: any, i: number) => {
          const sym = typeof item === 'string' ? item : (item.symbol || item.code)
          const name = typeof item === 'string' ? '' : (item.name || '')
          return (
            <span key={i} className="inline-flex items-center gap-1 rounded-md border border-amber-500/15 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200">
              <span className="font-mono">{sym}</span>
              {name && <span className="text-amber-400/60">{name}</span>}
            </span>
          )
        })}
      </div>
      {data.length > 12 && <p className="mt-2 text-[10px] text-amber-300/55">另有 {data.length - 12} 檔未展開，詳情看資料品質 / 市場限制 drilldown。</p>}
    </div>
  )
}

function MarketPulsePanel() {
  const { data: indices } = useQuery({
    queryKey: ['market', 'indices'],
    queryFn: marketApi.indices,
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  })
  const { data: risk } = useQuery({
    queryKey: ['market', 'risk'],
    queryFn: marketApi.risk,
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  })

  const indexItems = Array.isArray(indices)
    ? indices
    : [indices?.twii, indices?.twoii, indices?.nasdaq, indices?.sp500].filter(Boolean)
  const twii = indexItems.find((idx: any) => String(idx.symbol ?? idx.name ?? '').toUpperCase().includes('TWII')) ?? indexItems[0]
  const otc = indexItems.find((idx: any) => {
    const key = String(idx.symbol ?? idx.name ?? '').toUpperCase()
    return key.includes('OTC') || key.includes('TWOII') || key.includes('櫃')
  }) ?? indexItems[1]
  const indexCards = [twii, otc].filter(Boolean)

  const vixLevel = risk?.vixLevel ?? risk?.vix_level ?? risk?.vix_level_label ?? 'normal'
  const riskTiles = [
    {
      label: 'VIX 恐慌指數',
      value: risk?.vix != null ? Number(risk.vix).toFixed(1) : '--',
      detail: `${vixLevel === 'normal' ? '正常' : vixLevel}，一般正常值約 < 20`,
      tone: ['high', 'extreme'].includes(String(vixLevel)) ? 'text-orange-300' : 'text-emerald-300',
    },
    {
      label: '台股 20 日波動率',
      value: risk?.twiiVol20 != null ? `${risk.twiiVol20}%` : '--',
      detail: '年化波動率；越高代表進出場要更保守',
      tone: Number(risk?.twiiVol20 ?? 0) > 24 ? 'text-orange-300' : 'text-slate-200',
    },
    {
      label: '大盤乖離率（20MA）',
      value: risk?.twiiBias != null ? `${risk.twiiBias > 0 ? '+' : ''}${Number(risk.twiiBias).toFixed(1)}%` : '--',
      detail: `MA20：${risk?.twiiMa20?.toLocaleString('zh-TW') ?? '--'}`,
      tone: Math.abs(Number(risk?.twiiBias ?? 0)) >= 6 ? 'text-orange-300' : 'text-amber-300',
    },
    {
      label: '外資動向',
      value: risk?.foreignConsecutiveSell < 0
        ? `連賣 ${Math.abs(risk.foreignConsecutiveSell)} 日`
        : risk?.foreignConsecutiveSell > 0
          ? `連買 ${risk.foreignConsecutiveSell} 日`
          : '中性',
      detail: risk?.foreignNet5d != null ? `近 5 日：${risk.foreignNet5d > 0 ? '+' : ''}${Number(risk.foreignNet5d).toFixed(0)} 億元` : '近 5 日：--',
      tone: risk?.foreignConsecutiveSell <= -3 ? 'text-rose-300' : 'text-emerald-300',
    },
  ]

  return (
    <div className="space-y-3">
      {indexCards.length > 0 && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {indexCards.map((idx: any, index) => {
            const change = idx.change ?? idx.change_value ?? 0
            const changePct = idx.changePct ?? idx.change_pct ?? 0
            const current = idx.current ?? idx.close ?? idx.price ?? 0
            const up = change >= 0
            return (
              <div key={idx.symbol ?? idx.name ?? index} className="rounded-xl border border-[#2b3a49] bg-[#111821]/70 p-3">
                <p className="truncate text-[10px] text-[#8b9bab]">{idx.name ?? idx.symbol}</p>
                <p className="font-mono text-xl font-bold text-[#e6edf3]">{Number(current).toLocaleString()}</p>
                <p className={`font-mono text-xs ${up ? 'text-red-400' : 'text-emerald-400'}`}>
                  {up ? '+' : ''}{Number(change).toFixed(2)} ({up ? '+' : ''}{Number(changePct).toFixed(2)}%)
                </p>
              </div>
            )
          })}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        {riskTiles.map((tile) => (
          <div key={tile.label} className="rounded-xl border border-[#2b3a49] bg-[#0f151d]/70 p-3">
            <p className="text-[10px] tracking-[0.14em] text-[#75879a]">{tile.label}</p>
            <p className={`mt-1 font-mono text-lg font-semibold ${tile.tone}`}>{tile.value}</p>
            <p className="mt-1 text-[11px] leading-4 text-[#8b9bab]">{tile.detail}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Watchlist Stock Cards（自選股牌卡）────────────────────────────────────────
function WatchlistCards({ onSelect }: { onSelect: (s: StockSelection) => void }) {
  const { user } = useAuth()
  const { data: stocks = [] } = useQuery({
    queryKey: ['watchlist'],
    queryFn: watchlistApi.list,
    enabled: !!user,
    staleTime: 60_000,
  })

  if (!user) return (
    <div className="rounded-xl border border-dashed border-border bg-card p-6 text-center">
      <Star className="w-6 h-6 text-muted-foreground/30 mx-auto mb-2" />
      <p className="text-sm text-muted-foreground">登入後加入自選股，追蹤你的投資組合</p>
    </div>
  )

  if (!stocks.length) return (
    <div className="rounded-xl border border-dashed border-border bg-card p-6 text-center">
      <Star className="w-6 h-6 text-muted-foreground/30 mx-auto mb-2" />
      <p className="text-sm text-muted-foreground">搜尋股票並加入自選清單</p>
    </div>
  )

  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
        <Star className="w-3.5 h-3.5" /> 我的自選股
      </h3>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {(stocks as any[]).map((s: any) => {
          const up = (s.change_pct ?? 0) >= 0
          const change = s.close && s.change_pct != null
            ? s.close - s.close / (1 + s.change_pct / 100)
            : 0
          return (
            <button
              key={s.stock_id ?? s.symbol}
              onClick={() => onSelect({ id: s.stock_id ?? 0, symbol: s.symbol, name: s.name, market: s.market })}
              className="rounded-xl border border-border bg-card hover:bg-white/[0.07] hover:border-primary/30 transition-all p-3 text-left group"
            >
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-sm font-bold group-hover:text-primary transition-colors">{s.symbol}</span>
                <Badge variant="outline" className="text-[9px] px-1 py-0 border-white/10 text-muted-foreground">
                  {s.market ?? 'TW'}
                </Badge>
              </div>
              <p className="text-[11px] text-muted-foreground truncate mb-1">{s.name}</p>
              {s.tags && (
                <div className="flex flex-wrap gap-0.5 mb-1.5">
                  {(s.tags as string).split(',').slice(0, 3).map((tag: string) => (
                    <span key={tag} className="text-[8px] px-1 py-0 rounded bg-primary/10 text-primary/70 leading-tight">{tag}</span>
                  ))}
                </div>
              )}
              <div className="flex items-end justify-between">
                <p className="text-base font-bold font-mono">
                  ${s.close?.toLocaleString('zh-TW', { minimumFractionDigits: s.close >= 100 ? 0 : 2, maximumFractionDigits: s.close >= 100 ? 0 : 2 }) ?? '—'}
                </p>
                <div className="text-right">
                  <p className={`text-xs font-mono font-bold ${up ? 'text-red-400' : 'text-emerald-400'}`}>
                    {up ? '▲' : '▼'} {up ? '+' : ''}{(s.change_pct ?? 0).toFixed(2)}%
                  </p>
                </div>
              </div>
              {s.volume != null && (
                <p className="text-[10px] text-muted-foreground/60 font-mono mt-1">
                  Vol {(s.volume / 1000).toFixed(0)}張
                </p>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function MorningBriefingCard() {
  const items = [
    { label: '市場情緒', value: '先觀察主題與資金流', tone: 'text-[#9cc7ef]', href: '/obs' },
    { label: '可觀測性', value: '確認 SLO / Trace / Freshness', tone: 'text-[#8fc8a9]', href: '/obs' },
    { label: '待處理事項', value: '查看模擬交易與提醒', tone: 'text-[#d4a44f]', href: '/bot' },
  ]

  return (
    <section className="overflow-hidden rounded-xl border border-[#2b3a49] bg-[linear-gradient(135deg,#171714,#111821_55%,#0d1722)] p-4 shadow-[0_18px_70px_rgba(0,0,0,0.22)]">
      <div className="grid gap-4 lg:grid-cols-[1.05fr_0.95fr] lg:items-end">
        <div>
          <p className="text-[11px] font-semibold tracking-[0.18em] text-[#d6a85f]">MORNING BRIEF</p>
          <h2 className="mt-1 font-['Space_Grotesk'] text-2xl font-semibold tracking-tight text-[#f2ead8]">先看市場，再看推薦，不急著按鈕</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[#a8b6c5]">
            Dashboard 是給一般朋友也看得懂的版本：先把市場風險、資料可信度、AI 候選與興櫃研究分流放在第一屏。
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          {items.map((item) => (
            <a key={item.label} href={item.href} className="rounded-xl border border-[#2b3a49] bg-[#070a10]/55 p-3 transition hover:border-[#f0b90b]/35 hover:bg-[#111821]/80">
              <p className="text-[11px] text-[#8b9bab]">{item.label}</p>
              <p className={`mt-1 text-sm font-semibold ${item.tone}`}>{item.value}</p>
            </a>
          ))}
        </div>
      </div>
    </section>
  )
}

function StockSearchWorkbench({ onSelect }: { onSelect: (s: StockSelection) => void }) {
  return (
    <WorkstationPanel title="標的入口" kicker="search, quick tickers, personal watch">
      <div className="space-y-3 p-3">
        <div>
          <h2 className="font-['Space_Grotesk'] text-lg font-semibold text-[#f2ead8]">想看哪檔？</h2>
          <p className="mt-1 text-xs leading-5 text-[#8b9bab]">搜尋標的進研究筆記；每日推薦與自選股則留在首頁工作台。</p>
        </div>
        <StockSearchCombobox onSelect={onSelect} />
        <div>
          <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.16em] text-[#7f8ba0]">quick launch</p>
          <div className="grid grid-cols-5 gap-1.5">
            {QUICK_STOCKS.map(s => (
              <button
                key={s.symbol}
                onClick={() => onSelect({ id: 0, ...s })}
                className="rounded-lg border border-[#2b3a49] bg-[#070a10] px-2 py-2 text-center transition-all hover:border-[#f0b90b]/45 hover:bg-[#171714]"
              >
                <p className="text-xs font-bold text-[#f2ead8]">{s.symbol}</p>
                <p className="truncate text-[10px] text-[#8b9bab]">{s.name}</p>
              </button>
            ))}
          </div>
        </div>
      </div>
    </WorkstationPanel>
  )
}

// ── EmptyState（主頁未選股票時的首頁）────────────────────────────────────────
function EmptyState({ onSelect, user }: { onSelect: (s: StockSelection) => void; user: any }) {
  return (
    <div className="min-h-full">
      <div className="w-full space-y-4 px-4 py-4">

        <MorningBriefingCard />

        <WorkstationPanel title="今日市場判讀" kicker="risk, flow, confidence">
          <div className="grid gap-3 p-3 xl:grid-cols-[minmax(360px,0.85fr)_minmax(0,1.15fr)]">
            <MarketRiskPanel />
            <MarketPulsePanel />
          </div>
        </WorkstationPanel>

        <AttentionStocksCard />

        <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1.28fr)_minmax(360px,0.72fr)]">
          <WorkstationPanel title="AI 候選清單" kicker="tradable lane + emerging research lane">
            <div className="p-3">
              <DailyRecommendationPanelV2 />
            </div>
          </WorkstationPanel>

          <ThemeFlowPanel />
        </div>

        <div className="grid grid-cols-1 gap-3 xl:grid-cols-[390px_minmax(0,1fr)]">
          <StockSearchWorkbench onSelect={onSelect} />

          <div className="grid gap-3 lg:grid-cols-2">
            <WorkstationPanel title="自選雷達" kicker="watchlist">
              <div className="p-3">
                <WatchlistCards onSelect={onSelect} />
              </div>
            </WorkstationPanel>
            <ExDividendCard />
          </div>
        </div>
      </div>
    </div>
  )
}

// ── 卡片包裝器（統一樣式）────────────────────────────────────────────────────
function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-border bg-card p-4 ${className}`}>
      {children}
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">{children}</h3>
}

// ── 晨間概覽主頁 ──────────────────────────────────────────────────────────────
export default function Dashboard() {
  const qc = useQueryClient()
  const { user, isAuthenticated, login, logout } = useAuth()
  const isAdmin = user?.role === 'admin'
  const { canInstall, install } = usePWA()
  const [activeStock, setActiveStock] = useState<StockSelection | null>(null)

  const { data: stocks = [], isLoading: stocksLoading } = useQuery({
    queryKey: ['watchlist'],
    queryFn: watchlistApi.list,
    enabled: !!user,
  })

  const { data: detail } = useQuery({
    queryKey: ['stocks', activeStock?.id],
    queryFn: () => stocksApi.get(activeStock!.id),
    enabled: !!activeStock?.id,
  })

  const {
    data: dashboardV4Chart,
    isLoading: dashboardV4ChartLoading,
    error: dashboardV4ChartError,
  } = useQuery({
    queryKey: ['dashboard-v4-chart', activeStock?.id],
    queryFn: () => dashboardV4Api.stockChart(activeStock!.id, { days: 365 }),
    enabled: !!activeStock?.id,
    staleTime: 5 * 60 * 1000,
  })

  const addMutation = useMutation({
    mutationFn: async (s: StockSelection) => {
      // 確保 stocks 表有此股票（search 會回傳 id），再加到 watchlist
      const searchRes = await stocksApi.add({ symbol: s.symbol, name: s.name, market: s.market })
      const stockId = searchRes?.id ?? s.id
      if (stockId) await watchlistApi.add(stockId)
      return searchRes
    },
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: ['watchlist'] })
      if (data?.id) setActiveStock(prev => prev ? { ...prev, id: data.id } : prev)
      toast.success('已加入觀察清單')
    },
    onError: (e: any) => toast.error(e.message),
  })

  const removeMutation = useMutation({
    mutationFn: (stockId: number) => watchlistApi.remove(stockId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['watchlist'] })
      setActiveStock(null)
      toast.success('已從觀察清單移除')
    },
  })

  const refreshMutation = useMutation({
    mutationFn: (id: number) => stocksApi.refresh(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['stocks', activeStock?.id] })
      qc.invalidateQueries({ queryKey: ['watchlist'] })
      toast.success('資料已更新')
    },
    onError: (e: any) => toast.error(e.message),
  })

  const handleSelect = (s: StockSelection) => {
    const existing = (stocks as any[]).find((st: any) => st.symbol === s.symbol)
    if (existing) {
      // watchlist API 回傳 stock_id，前端用 id
      setActiveStock({ ...existing, id: existing.stock_id ?? existing.id })
    } else {
      setActiveStock(s)
      if (isAuthenticated) addMutation.mutate(s)
    }
  }

  // ── 側邊欄內容 ───────────────────────────────────────────────────────────────
  const SidebarContent = () => (
    <div className="flex flex-col h-full">
      {/* 搜尋 */}
      <div className="p-3 border-b border-border/40">
        <StockSearchCombobox onSelect={handleSelect} />
      </div>

      {/* 觀察清單 */}
      <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
        {stocksLoading && (
          <div className="space-y-1 p-1">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-11 rounded-lg bg-muted/30 animate-pulse" />
            ))}
          </div>
        )}

        {!stocksLoading && !(stocks as any[]).length && (
          <div className="flex flex-col items-center justify-center py-10 text-center px-3">
            <Search className="w-7 h-7 text-muted-foreground/30 mb-2" />
            <p className="text-xs text-muted-foreground">搜尋股票以加入觀察清單</p>
          </div>
        )}

        {(stocks as any[]).map((s: any) => {
          const sid = s.stock_id ?? s.id
          return (
            <WatchlistItem
              key={sid}
              stock={s}
              active={activeStock?.id === sid}
              onClick={() => setActiveStock({ ...s, id: sid })}
            />
          )
        })}
      </div>

      {/* Admin: 使用者管理 */}
      {isAdmin && (
        <div className="px-2 pb-2">
          <details className="group">
            <summary className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground cursor-pointer rounded-md hover:bg-accent/50 transition-colors">
              <Users className="w-3.5 h-3.5" />
              <span>使用者管理</span>
            </summary>
            <div className="mt-1 max-h-60 overflow-y-auto">
              <AdminUsersPanel />
            </div>
          </details>
        </div>
      )}

      {/* 底部：用戶資訊 */}
      <div className="p-3 border-t border-border/40">
        {canInstall && (
          <Button variant="ghost" size="sm" className="w-full mb-2 text-xs gap-2 justify-start" onClick={install}>
            📲 安裝 App
          </Button>
        )}
        {isAuthenticated ? (
          <div className="flex items-center gap-2">
            {user?.avatar && <img src={user.avatar} className="w-7 h-7 rounded-full shrink-0" alt="" />}
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium truncate">{user?.name}</p>
              <p className="text-[10px] text-muted-foreground truncate">{user?.email}</p>
            </div>
            <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={logout}>
              <LogOut className="w-3.5 h-3.5" />
            </Button>
          </div>
        ) : (
          <Button variant="outline" size="sm" className="w-full gap-2 text-xs" onClick={login}>
            <LogIn className="w-3.5 h-3.5" /> Google 登入
          </Button>
        )}
      </div>

      {/* 資料更新狀態（hover 展開詳細） */}
      <div className="border-t border-border/40">
        <SystemStatusBar mode="compact" />
      </div>
    </div>
  )

  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <Toaster />
          <AppShell>
            <div className="p-4 pb-0 lg:p-5 lg:pb-0">
              <WorkstationPageTitle
                kicker="Morning overview"
                title={activeStock ? `${activeStock.symbol} 研究筆記` : '晨間概覽'}
                description="用比較輕的節奏整理市場、推薦與 Observability；需要細節時再進研究室或監控中心。"
                action={
                  <div className="flex flex-wrap gap-2">
                    <WorkstationPill tone="info">今日焦點</WorkstationPill>
                    {activeStock && <WorkstationPill tone="ok">{activeStock.market}</WorkstationPill>}
                  </div>
                }
              />
            </div>
            {!activeStock ? (
              <EmptyState onSelect={handleSelect} user={user} />
            ) : (
              <div className="flex h-full">
                {/* Inner watchlist sidebar (desktop only) */}
                <aside className="hidden lg:flex flex-col w-52 border-r border-border bg-card shrink-0">
                  <SidebarContent />
                </aside>

                {/* Stock detail content */}
                <div className="flex-1 flex flex-col overflow-hidden">
                  {/* Stock Hero */}
                  <StockHero
                    stock={activeStock}
                    detail={detail as any}
                    onRefresh={() => activeStock.id && refreshMutation.mutate(activeStock.id)}
                    onRemove={() => activeStock.id && removeMutation.mutate(activeStock.id)}
                    onBack={() => setActiveStock(null)}
                    refreshing={refreshMutation.isPending}
                  />

                  {/* Tabs */}
                  <div className="flex-1 overflow-y-auto">
                    <Tabs defaultValue="chart" className="h-full flex flex-col">
                      <div className="px-4 pt-3 border-b border-border bg-card shrink-0">
                        <TabsList className="h-9 bg-transparent p-0 gap-1">
                          {[
                            { value: 'chart',       icon: BarChart2,  label: '圖表' },
                            { value: 'chips',        icon: Layers,     label: '籌碼技術' },
                            { value: 'fundamental',  icon: PieChart,   label: '財報' },
                            { value: 'ai',           icon: Sparkles,   label: 'AI 分析' },
                            { value: 'news',         icon: Newspaper,  label: '新聞' },
                          ].map(tab => (
                            <TabsTrigger
                              key={tab.value}
                              value={tab.value}
                              className="h-8 px-3 text-xs gap-1.5 rounded-md data-[state=active]:bg-background data-[state=active]:border data-[state=active]:border-border/50 data-[state=active]:shadow-sm"
                            >
                              <tab.icon className="w-3 h-3" />
                              <span className="hidden sm:inline">{tab.label}</span>
                            </TabsTrigger>
                          ))}
                        </TabsList>
                      </div>

                      {/* ── 圖表 Tab ─────────────────────────────────────── */}
                      <TabsContent value="chart" className="flex-1 overflow-y-auto p-4">
                        <div className="mx-auto max-w-7xl">
                          <DashboardV4LightweightChart
                            packet={dashboardV4Chart}
                            loading={dashboardV4ChartLoading}
                            error={dashboardV4ChartError}
                          />
                        </div>
                      </TabsContent>

                      {/* ── 籌碼技術 Tab ──────────────────────────────────── */}
                      <TabsContent value="chips" className="flex-1 overflow-y-auto p-4">
                        <div className="max-w-4xl mx-auto space-y-4">
                          <Card>
                            <SectionTitle>K 線圖</SectionTitle>
                            <CandlestickChart stockId={activeStock.id} />
                          </Card>
                          <Card>
                            <SectionTitle>三大法人籌碼</SectionTitle>
                            <ChipChart stockId={activeStock.id} />
                          </Card>
                          <Card>
                            <SectionTitle>融資融券趨勢</SectionTitle>
                            <MarginChart stockId={activeStock.id} />
                          </Card>
                          <Card>
                            <SectionTitle>技術指標 RSI · MACD · 布林通道</SectionTitle>
                            <TechnicalChart stockId={activeStock.id} />
                          </Card>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <Card>
                              <SectionTitle>風險指標</SectionTitle>
                              <RiskMetricsPanel stockId={activeStock.id} />
                            </Card>
                            <Card>
                              <SectionTitle>多因子分析</SectionTitle>
                              <FactorAnalysis stockId={activeStock.id} />
                            </Card>
                          </div>
                        </div>
                      </TabsContent>

                      {/* ── 基本面 Tab ───────────────────────────────────── */}
                      <TabsContent value="fundamental" className="flex-1 overflow-y-auto p-4">
                        <div className="max-w-4xl mx-auto space-y-4">
                          <Card>
                            <SectionTitle>財報摘要</SectionTitle>
                            <FinancialSummary stockId={activeStock.id} />
                          </Card>
                          {isAuthenticated ? (
                            <Card>
                              <SectionTitle>🔔 價格警報</SectionTitle>
                              <AlertManager stockId={activeStock.id} />
                            </Card>
                          ) : (
                            <div className="rounded-xl border border-dashed border-border/50 p-6 text-center">
                              <Bell className="w-8 h-8 mx-auto mb-2 text-muted-foreground/30" />
                              <p className="text-sm text-muted-foreground mb-3">登入後可設定價格警報</p>
                              <Button variant="outline" size="sm" onClick={login} className="gap-2 text-xs">
                                <LogIn className="w-3.5 h-3.5" /> Google 登入
                              </Button>
                            </div>
                          )}
                        </div>
                      </TabsContent>

                      {/* ── AI 分析 Tab（整頁式報告）──────────────────────── */}
                      <TabsContent value="ai" className="flex-1 overflow-y-auto p-4">
                        <div className="max-w-4xl mx-auto">
                          <StockAIReport stockId={activeStock.id} />
                        </div>
                      </TabsContent>

                      {/* ── 新聞 Tab ─────────────────────────────────────── */}
                      <TabsContent value="news" className="flex-1 overflow-y-auto">
                        <div className="max-w-4xl mx-auto">
                          <NewsPanel stockId={activeStock.id} />
                        </div>
                      </TabsContent>
                    </Tabs>
                  </div>
                </div>
              </div>
            )}
          </AppShell>
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  )
}
