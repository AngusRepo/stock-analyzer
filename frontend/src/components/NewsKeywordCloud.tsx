import { useQuery } from '@tanstack/react-query'
import { newsApi } from '@/lib/api'
import { Skeleton } from '@/components/ui/skeleton'

const SENTIMENT_COLOR = {
  positive: '#f87171',   // 紅（台股漲）
  negative: '#34d399',   // 綠（台股跌）
  neutral:  '#94a3b8',   // 灰
}

const SIZE_CLASS = [
  '',
  'text-xs px-1.5 py-0.5',
  'text-sm px-2 py-0.5',
  'text-base px-2.5 py-1',
  'text-lg px-3 py-1 font-medium',
  'text-xl px-3 py-1.5 font-bold',
]

export default function NewsKeywordCloud({ stockId, days = 30 }: { stockId: number; days?: number }) {
  const { data: keywords = [], isLoading } = useQuery({
    queryKey: ['news', stockId, 'keywords', days],
    queryFn: () => newsApi.keywords(stockId, days),
    enabled: !!stockId,
    staleTime: 10 * 60 * 1000,
  })

  if (isLoading) return <Skeleton className="h-32 w-full" />

  if (!keywords.length) return (
    <div className="h-24 flex items-center justify-center text-xs text-muted-foreground">
      暫無關鍵字資料（新聞數量不足）
    </div>
  )

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        近 {days} 日新聞關鍵字
        <span className="ml-2 gap-3 inline-flex">
          <span className="text-[#f87171]">■ 正面</span>
          <span className="text-[#34d399]">■ 負面</span>
          <span className="text-[#94a3b8]">■ 中性</span>
        </span>
      </p>
      <div className="flex flex-wrap gap-2 p-3 rounded-lg bg-muted/20 border border-border/30 min-h-[80px]">
        {(keywords as any[]).map((kw: any) => (
          <span
            key={kw.word}
            className={`rounded-full border inline-flex items-center gap-1 cursor-default select-none transition-opacity hover:opacity-80 ${SIZE_CLASS[kw.size] ?? SIZE_CLASS[2]}`}
            style={{
              borderColor: SENTIMENT_COLOR[kw.sentiment as keyof typeof SENTIMENT_COLOR],
              color: SENTIMENT_COLOR[kw.sentiment as keyof typeof SENTIMENT_COLOR],
              backgroundColor: SENTIMENT_COLOR[kw.sentiment as keyof typeof SENTIMENT_COLOR] + '18',
            }}
            title={`出現 ${kw.count} 次`}
          >
            {kw.word}
            <span className="opacity-60 text-[10px]">{kw.count}</span>
          </span>
        ))}
      </div>
    </div>
  )
}
