/**
 * AIAnalystPanel — 統一 AI 分析面板
 * 整合：ML 10模型集成預測 + LLM技術分析 + LLM交易建議 + LLM摘要 + AI問答
 * 設計：暗色系，統一 CSS variables，無 bg-white / border-slate-*
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { llmApi, mlApi, chatApi } from '@/lib/api'
import { useAuth } from '@/_core/hooks/useAuth'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Sparkles, RefreshCw, Brain, TrendingUp, BarChart2,
  Bot, User, Send, ChevronDown, ChevronUp, Zap,
} from 'lucide-react'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

// ─── 型別 ──────────────────────────────────────────────────────────────────────
interface Message { role: 'user' | 'assistant'; content: string }

// ─── 信號設定 ──────────────────────────────────────────────────────────────────
const SIGNAL_CFG: Record<string, { label: string; accent: string; bg: string }> = {
  STRONG_BUY:  { label: '強力買進', accent: 'text-red-400',     bg: 'border-red-500/30 bg-red-500/5' },
  BUY:         { label: '買進',     accent: 'text-orange-400',  bg: 'border-orange-500/30 bg-orange-500/5' },
  HOLD:        { label: '持有觀望', accent: 'text-yellow-400',  bg: 'border-yellow-500/30 bg-yellow-500/5' },
  SELL:        { label: '賣出',     accent: 'text-emerald-400', bg: 'border-emerald-500/30 bg-emerald-500/5' },
  STRONG_SELL: { label: '強力賣出', accent: 'text-emerald-300', bg: 'border-emerald-400/30 bg-emerald-400/5' },
  NO_SIGNAL:   { label: '訊號不明', accent: 'text-muted-foreground', bg: 'border-border bg-muted/20' },
}

const MODEL_COLORS: Record<string, string> = {
  ARIMA: '#818cf8', XGBoost: '#fb923c', LightGBM: '#34d399',
  Prophet: '#60a5fa', LSTM: '#f472b6',
}

// ─── 子元件：AI 文字面板（技術分析 / 交易建議 / 摘要）────────────────────────
function LLMPane({
  label, icon: Icon, result, onRun, isPending,
}: {
  label: string
  icon: any
  result: string | null
  onRun: () => void
  isPending: boolean
}) {
  return (
    <div className="space-y-3">
      <Button
        onClick={onRun}
        disabled={isPending}
        variant="outline"
        size="sm"
        className="gap-2 h-8"
      >
        {isPending
          ? <RefreshCw className="w-3.5 h-3.5 animate-spin" />
          : <Icon className="w-3.5 h-3.5" />}
        {isPending ? 'AI 分析中…' : label}
      </Button>

      {result && (
        <div className="rounded-lg border border-border/50 bg-muted/20 p-4 text-sm leading-relaxed whitespace-pre-wrap text-foreground/90">
          {result}
        </div>
      )}

      {!result && !isPending && (
        <div className="rounded-lg border border-dashed border-border/40 p-6 text-center">
          <Icon className="w-7 h-7 mx-auto mb-2 text-muted-foreground/30" />
          <p className="text-xs text-muted-foreground">點擊按鈕生成 AI {label}</p>
        </div>
      )}

      <p className="text-[10px] text-muted-foreground/40 text-center">⚠ AI 分析僅供參考，非投資建議</p>
    </div>
  )
}

// ─── 子元件：ML 集成預測 ───────────────────────────────────────────────────────
function MLPane({ stockId }: { stockId: number }) {
  const qc = useQueryClient()
  const [showModels, setShowModels] = useState(false)

  const { data: mlData } = useQuery({
    queryKey: ['ml', 'predict', stockId],
    queryFn: () => mlApi.getPredict(stockId),
    enabled: !!stockId,
    retry: false,
  })

  const runMutation = useMutation({
    mutationFn: () => mlApi.runPredict(stockId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ml', 'predict', stockId] }),
  })

  const d = mlData as any
  const signal = d?.signal ?? 'NO_SIGNAL'
  const cfg = SIGNAL_CFG[signal] ?? SIGNAL_CFG.NO_SIGNAL

  if (!d && !runMutation.isPending) {
    return (
      <div className="flex flex-col items-center justify-center py-10 gap-3">
        <Zap className="w-8 h-8 text-muted-foreground/30" />
        <p className="text-sm text-muted-foreground">尚無預測資料</p>
        <Button size="sm" onClick={() => runMutation.mutate()}>執行 AI 集成預測</Button>
      </div>
    )
  }

  if (runMutation.isPending) {
    return (
      <div className="flex flex-col items-center justify-center py-10 gap-2">
        <RefreshCw className="w-6 h-6 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground animate-pulse">10 模型集成預測中，請稍候…</p>
        <p className="text-xs text-muted-foreground/50">ARIMA → XGBoost → LightGBM → Prophet → LSTM</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* 信號卡 */}
      <div className={`rounded-xl border-2 p-4 ${cfg.bg}`}>
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">集成模型投票結果</p>
            <p className={`text-2xl font-bold ${cfg.accent}`}>{cfg.label}</p>
            <div className="flex flex-wrap gap-3 text-sm mt-2">
              <span className="text-muted-foreground">
                信心 <span className="text-foreground font-semibold">{((d?.confidence ?? 0) * 100).toFixed(0)}%</span>
              </span>
              <span className="text-muted-foreground">
                共識 <span className="text-foreground font-semibold">{((d?.consensus ?? 0) * 100).toFixed(0)}%</span>
              </span>
              <span className="text-muted-foreground">
                5日預測{' '}
                <span className={`font-semibold ${(d?.forecast_pct ?? 0) >= 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                  {((d?.forecast_pct ?? 0) * 100).toFixed(1)}%
                </span>
              </span>
            </div>
          </div>
          <Button
            size="sm" variant="ghost" className="shrink-0 h-8 text-xs"
            onClick={() => runMutation.mutate()} disabled={runMutation.isPending}
          >
            <RefreshCw className="w-3 h-3 mr-1" /> 重新預測
          </Button>
        </div>
        {d?.reasoning && (
          <p className="mt-3 text-xs text-muted-foreground leading-relaxed border-t border-border/30 pt-3">
            {d.reasoning}
          </p>
        )}
      </div>

      {/* 停損 / 目標 */}
      {signal !== 'NO_SIGNAL' && (
        <div className="grid grid-cols-4 gap-2">
          {[
            { label: '進場參考', value: d?.entry_price, className: 'text-foreground' },
            { label: '停損',     value: d?.stop_loss,   className: 'text-emerald-400' },
            { label: '目標 1',   value: d?.target1,     className: 'text-red-400' },
            { label: '目標 2',   value: d?.target2,     className: 'text-red-300' },
          ].map(item => (
            <div key={item.label} className="rounded-lg border border-border/50 bg-muted/20 p-2.5 text-center">
              <p className="text-[10px] text-muted-foreground mb-1">{item.label}</p>
              <p className={`text-sm font-bold font-mono ${item.className}`}>
                {typeof item.value === 'number' ? item.value.toFixed(2) : '—'}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* 各模型投票 */}
      {d?.models?.length > 0 && (
        <div className="rounded-lg border border-border/50">
          <button
            className="flex items-center justify-between w-full px-4 py-2.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setShowModels(v => !v)}
          >
            <span>各模型投票明細（{d.models.length} 個）</span>
            {showModels ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>

          {showModels && (
            <div className="px-4 pb-3 space-y-2.5 border-t border-border/30">
              {d.models.map((m: any) => (
                <div key={m.name} className="flex items-center gap-2 text-xs mt-2.5">
                  <span
                    className="w-18 text-[10px] font-medium px-2 py-0.5 rounded-full text-black text-center shrink-0"
                    style={{ backgroundColor: MODEL_COLORS[m.name] ?? '#888', minWidth: '5rem' }}
                  >
                    {m.name}
                  </span>
                  <span className={`w-10 text-center ${m.direction === 'up' ? 'text-red-400' : 'text-emerald-400'}`}>
                    {m.direction === 'up' ? '↑ 漲' : '↓ 跌'}
                  </span>
                  <div className="flex-1 bg-muted rounded-full h-1.5 overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{ width: `${(m.confidence * 100).toFixed(0)}%`, backgroundColor: MODEL_COLORS[m.name] ?? '#888' }}
                    />
                  </div>
                  <span className="text-muted-foreground w-8 text-right">{(m.confidence * 100).toFixed(0)}%</span>
                  <span className="text-muted-foreground/60 w-14 text-right">
                    準確 {(m.direction_accuracy * 100).toFixed(0)}%
                  </span>
                  <span className="text-muted-foreground/60 w-12 text-right">
                    權重 {(m.weight * 100).toFixed(0)}%
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── 主元件 ────────────────────────────────────────────────────────────────────
export function ManusAnalystPanel({ stockId }: { stockId: number }) {
  const [technical, setTechnical] = useState<string | null>(null)
  const [trading,   setTrading]   = useState<string | null>(null)
  const [summary,   setSummary]   = useState<string | null>(null)
  const [messages,    setMessages]    = useState<Message[]>([])
  const [input,       setInput]       = useState('')
  const [sessionId,   setSessionId]   = useState<number | null>(null)
  const { user } = useAuth()

  const techMutation    = useMutation({ mutationFn: () => llmApi.technicalAnalysis(stockId), onSuccess: (d: any) => setTechnical(d.analysis) })
  const tradeMutation   = useMutation({ mutationFn: () => llmApi.tradingAdvice(stockId),     onSuccess: (d: any) => setTrading(d.advice) })
  const summaryMutation = useMutation({ mutationFn: () => llmApi.analystSummary(stockId),   onSuccess: (d: any) => setSummary(d.summary) })

  // ── 換股票時重設對話並載入歷史 ────────────────────────────────────────────
  const { data: sessions } = useQuery({
    queryKey: ['chat', 'sessions', stockId],
    queryFn: () => chatApi.getSessions(stockId),
    enabled: !!user,
  })

  // 有現有 session 時載入訊息
  useQuery({
    queryKey: ['chat', 'messages', sessionId],
    queryFn: async () => {
      if (!sessionId) return []
      const msgs = await chatApi.getMessages(sessionId)
      setMessages(msgs.map((m: any) => ({ role: m.role, content: m.content })))
      return msgs
    },
    enabled: !!sessionId,
    staleTime: Infinity,
  })

  // 找到或建立此股票的 session
  useState(() => {
    const existingSession = sessions?.[0]
    if (existingSession) {
      setSessionId(existingSession.id)
    }
  })

  // 換股票時重設本地狀態
  const prevStockId = useState(stockId)[0]
  if (prevStockId !== stockId) {
    setMessages([])
    setSessionId(null)
  }

  const chatMutation = useMutation({
    mutationFn: async (q: string) => {
      // 確保有 session（第一次發訊息時建立）
      let sid = sessionId
      if (!sid) {
        const session = await chatApi.createSession(stockId, q.slice(0, 30))
        sid = session.id
        setSessionId(sid)
      }
      // 同步 user 訊息到 D1
      await chatApi.addMessage(sid, 'user', q)
      const data = await llmApi.ask(stockId, q, messages)
      // 同步 assistant 回覆到 D1
      await chatApi.addMessage(sid, 'assistant', data.answer)
      return data
    },
    onSuccess: (data: any) => setMessages(p => [...p, { role: 'assistant', content: data.answer }]),
    onError:   () => setMessages(p => [...p, { role: 'assistant', content: '抱歉，發生錯誤，請稍後再試。' }]),
  })

  const sendChat = () => {
    if (!input.trim() || chatMutation.isPending) return
    const q = input.trim()
    setMessages(p => [...p, { role: 'user', content: q }])
    setInput('')
    chatMutation.mutate(q)
  }

  return (
    <Tabs defaultValue="ml">
      <TabsList className="w-full grid grid-cols-5 h-9">
        <TabsTrigger value="ml"        className="text-xs gap-1"><Zap        className="w-3 h-3 hidden sm:block" />ML預測</TabsTrigger>
        <TabsTrigger value="summary"   className="text-xs gap-1"><Brain      className="w-3 h-3 hidden sm:block" />摘要</TabsTrigger>
        <TabsTrigger value="technical" className="text-xs gap-1"><BarChart2  className="w-3 h-3 hidden sm:block" />技術</TabsTrigger>
        <TabsTrigger value="trading"   className="text-xs gap-1"><TrendingUp className="w-3 h-3 hidden sm:block" />交易</TabsTrigger>
        <TabsTrigger value="chat"      className="text-xs gap-1"><Bot        className="w-3 h-3 hidden sm:block" />問答</TabsTrigger>
      </TabsList>

      <TabsContent value="ml"        className="mt-4"><MLPane stockId={stockId} /></TabsContent>
      <TabsContent value="summary"   className="mt-4"><LLMPane label="分析師摘要" icon={Brain}      result={summary}   onRun={() => summaryMutation.mutate()} isPending={summaryMutation.isPending} /></TabsContent>
      <TabsContent value="technical" className="mt-4"><LLMPane label="技術分析"   icon={BarChart2}  result={technical} onRun={() => techMutation.mutate()}    isPending={techMutation.isPending}    /></TabsContent>
      <TabsContent value="trading"   className="mt-4"><LLMPane label="交易建議"   icon={TrendingUp} result={trading}   onRun={() => tradeMutation.mutate()}   isPending={tradeMutation.isPending}   /></TabsContent>

      <TabsContent value="chat" className="mt-4">
        <div className="flex flex-col h-[400px]">
          <ScrollArea className="flex-1 pr-1">
            <div className="space-y-3 p-1">
              {messages.length === 0 && (
                <div className="flex flex-col items-center justify-center h-32 text-muted-foreground">
                  <Bot className="w-7 h-7 mb-2 opacity-30" />
                  <p className="text-sm">詢問任何關於這檔股票的問題</p>
                  <p className="text-xs mt-1 opacity-60">例如：目前適合進場嗎？風險如何？</p>
                </div>
              )}
              {messages.map((msg, i) => (
                <div key={i} className={cn('flex gap-2', msg.role === 'user' ? 'justify-end' : 'justify-start')}>
                  {msg.role === 'assistant' && <Bot className="w-4 h-4 shrink-0 mt-1 text-primary" />}
                  <div className={cn(
                    'max-w-[85%] rounded-xl px-3 py-2 text-sm leading-relaxed',
                    msg.role === 'user'
                      ? 'bg-primary text-primary-foreground rounded-tr-none'
                      : 'bg-muted rounded-tl-none'
                  )}>
                    {msg.content}
                  </div>
                  {msg.role === 'user' && <User className="w-4 h-4 shrink-0 mt-1 text-muted-foreground" />}
                </div>
              ))}
              {chatMutation.isPending && (
                <div className="flex gap-2">
                  <Bot className="w-4 h-4 text-primary mt-1" />
                  <div className="bg-muted rounded-xl rounded-tl-none px-3 py-2 text-sm text-muted-foreground">
                    <span className="inline-flex gap-0.5">
                      <span className="animate-bounce" style={{ animationDelay: '0ms' }}>·</span>
                      <span className="animate-bounce" style={{ animationDelay: '150ms' }}>·</span>
                      <span className="animate-bounce" style={{ animationDelay: '300ms' }}>·</span>
                    </span>
                  </div>
                </div>
              )}
            </div>
          </ScrollArea>
          <div className="flex gap-2 pt-3 border-t border-border/50 mt-2">
            <Input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendChat()}
              placeholder="輸入問題…"
              disabled={chatMutation.isPending}
              className="text-sm h-9"
            />
            <Button size="sm" onClick={sendChat} disabled={!input.trim() || chatMutation.isPending} className="h-9 px-3">
              <Send className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      </TabsContent>
    </Tabs>
  )
}
