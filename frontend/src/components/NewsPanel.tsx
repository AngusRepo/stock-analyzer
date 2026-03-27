import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { stocksApi, newsApi } from '@/lib/api'
import { formatDistanceToNow } from 'date-fns'
import { zhTW } from 'date-fns/locale'
import { Newspaper, ExternalLink, RefreshCw, TrendingUp, TrendingDown, Minus } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts'
import NewsKeywordCloud from './NewsKeywordCloud'
import { toast } from 'sonner'
import { useAuth } from '@/_core/hooks/useAuth'

const SENTIMENT_STYLE = {
  positive: { className: 'border-red-400/50 text-red-400 bg-red-400/10',   label: '正面', icon: TrendingUp },
  neutral:  { className: 'border-muted text-muted-foreground bg-muted/30', label: '中性', icon: Minus },
  negative: { className: 'border-emerald-400/50 text-emerald-400 bg-emerald-400/10', label: '負面', icon: TrendingDown },
}

function SentimentSummaryBar({ stockId }: { stockId: number }) {
  const { data } = useQuery({
    queryKey: ['news', stockId, 'sentiment'],
    queryFn: () => newsApi.sentiment(stockId, 30),
    enabled: !!stockId,
  })
  if (!data || !data.total) return null
  const pos = Math.round((data.positive / data.total) * 100)
  const neg = Math.round((data.negative / data.total) * 100)
  const neu = 100 - pos - neg
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-muted-foreground">近30日情感：</span>
      <span className="text-red-400">正面 {pos}%</span>
      <span className="text-muted-foreground">中性 {neu}%</span>
      <span className="text-emerald-400">負面 {neg}%</span>
      <span className="text-muted-foreground ml-1">({data.total}篇)</span>
    </div>
  )
}

function SentimentTrendMini({ stockId }: { stockId: number }) {
  const { data: trend = [] } = useQuery({
    queryKey: ['news', stockId, 'trend'],
    queryFn: () => newsApi.trend(stockId, 30),
    enabled: !!stockId,
  })
  if (!trend.length) return null
  return (
    <div>
      <p className="text-xs text-muted-foreground mb-1.5">情感趨勢（近30日）</p>
      <ResponsiveContainer width="100%" height={90}>
        <LineChart data={trend as any[]}>
          <CartesianGrid strokeDasharray="3 3" stroke="#333" opacity={0.3} />
          <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#888' }} tickLine={false} interval={4} />
          <YAxis tick={{ fontSize: 9, fill: '#888' }} tickLine={false} />
          <Tooltip contentStyle={{ background: '#1a1a2e', border: '1px solid #333', fontSize: 11 }} />
          <Line type="monotone" dataKey="positive" stroke="#f87171" strokeWidth={1.5} dot={false} name="正面" />
          <Line type="monotone" dataKey="negative" stroke="#34d399" strokeWidth={1.5} dot={false} name="負面" />
          <Line type="monotone" dataKey="neutral"  stroke="#94a3b8" strokeWidth={1}   dot={false} name="中性" strokeDasharray="3 3" />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

export default function NewsPanel({ stockId }: { stockId: number }) {
  const qc = useQueryClient()
  const { isAuthenticated } = useAuth()

  const { data: news = [], isLoading } = useQuery({
    queryKey: ['stocks', stockId, 'news'],
    queryFn: () => stocksApi.news(stockId, 30),
    enabled: !!stockId,
    staleTime: 5 * 60 * 1000,
  })

  const crawlMutation = useMutation({
    mutationFn: () => newsApi.crawl(stockId),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['stocks', stockId, 'news'] })
      qc.invalidateQueries({ queryKey: ['news', stockId] })
      toast.success(`爬取完成，新增 ${data.count} 篇新聞`)
    },
    onError: () => toast.error('爬取失敗，請稍後再試'),
  })

  return (
    <div className="space-y-4 p-4 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <SentimentSummaryBar stockId={stockId} />
        {isAuthenticated && (
          <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs"
            onClick={() => crawlMutation.mutate()} disabled={crawlMutation.isPending}>
            <RefreshCw className={`w-3 h-3 ${crawlMutation.isPending ? 'animate-spin' : ''}`} />
            {crawlMutation.isPending ? '爬取中…' : '更新新聞'}
          </Button>
        )}
      </div>

      {/* Sentiment trend mini chart */}
      <SentimentTrendMini stockId={stockId} />

      {/* Keyword cloud */}
      <NewsKeywordCloud stockId={stockId} days={30} />

      {/* News list */}
      {isLoading ? (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
        </div>
      ) : !(news as any[]).length ? (
        <div className="flex flex-col items-center justify-center h-32 text-muted-foreground">
          <Newspaper className="w-8 h-8 mb-2 opacity-30" />
          <p className="text-sm">暫無新聞</p>
          {isAuthenticated && <p className="text-xs mt-1">點擊「更新新聞」手動爬取</p>}
        </div>
      ) : (
        <ScrollArea className="h-[360px]">
          <div className="space-y-1.5">
            {(news as any[]).map((item: any) => {
              const style = SENTIMENT_STYLE[item.sentiment as keyof typeof SENTIMENT_STYLE] ?? SENTIMENT_STYLE.neutral
              const Icon  = style.icon
              return (
                <a key={item.id} href={item.url ?? '#'} target="_blank" rel="noopener noreferrer"
                  className="flex gap-3 p-3 rounded-lg border border-border/40 hover:border-border hover:bg-muted/30 transition-colors group">
                  <Icon className={`w-4 h-4 shrink-0 mt-0.5 ${item.sentiment === 'positive' ? 'text-red-400' : item.sentiment === 'negative' ? 'text-emerald-400' : 'text-muted-foreground'}`} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm leading-snug group-hover:text-primary transition-colors line-clamp-2">
                      {item.title}
                    </p>
                    <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                      <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${style.className}`}>
                        {style.label}
                      </Badge>
                      <span className="text-[11px] text-muted-foreground">{item.source}</span>
                      <span className="text-[11px] text-muted-foreground ml-auto">
                        {item.published_at
                          ? formatDistanceToNow(new Date(item.published_at), { addSuffix: true, locale: zhTW })
                          : ''}
                      </span>
                    </div>
                  </div>
                  <ExternalLink className="w-3.5 h-3.5 text-muted-foreground shrink-0 opacity-0 group-hover:opacity-100" />
                </a>
              )
            })}
          </div>
        </ScrollArea>
      )}
    </div>
  )
}
