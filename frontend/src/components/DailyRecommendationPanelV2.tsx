import { useQuery } from '@tanstack/react-query'
import { Activity, BarChart3, RefreshCw, Star } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { AI_TOP_PICK_EXPLANATION, RecommendationCardClean } from '@/components/RecommendationCardClean'
import { RecommendationLaneExplainer } from '@/components/workstation/DecisionArchitecture'
import { recommendationsApi } from '@/lib/api'
import { queryTtl, recommendationDailyKey, selectRecommendationLanes, twToday } from '@/lib/queryPolicy'
import { cn } from '@/lib/utils'

function ObservabilityChip({ icon: Icon, label, value, tone = 'info' }: {
  icon: typeof Activity
  label: string
  value: string
  tone?: 'ok' | 'warn' | 'info'
}) {
  return (
    <div className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.12em] ${
      tone === 'ok' ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300'
        : tone === 'warn' ? 'border-amber-500/25 bg-amber-500/10 text-amber-300'
          : 'border-sky-500/25 bg-sky-500/10 text-sky-300'
    }`}>
      <Icon className="h-3.5 w-3.5" />
      <span>{label}</span>
      <span className="text-foreground">{value}</span>
    </div>
  )
}

export function DailyRecommendationPanelV2() {
  const today = twToday()
  const { data, isLoading, refetch } = useQuery({
    queryKey: recommendationDailyKey(today),
    queryFn: () => recommendationsApi.daily(undefined, { view: 'card' }),
    staleTime: queryTtl.dailyDecision,
    select: selectRecommendationLanes,
  })
  const payload = data?.payload
  const tradable = data?.tradable ?? []
  const explanation = AI_TOP_PICK_EXPLANATION.replace(/^名詞解釋：/, '')

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <Star className="h-4 w-4 text-amber-400" />
              每日選股推薦
            </h2>
            <ObservabilityChip icon={BarChart3} label="tradable" value={`${tradable.length}`} tone="ok" />
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {payload?.date ?? today} · ML + 籌碼 + 技術 + Alpha / Risk 綜合評分
          </p>
          <div className="mt-2 flex w-full flex-wrap items-center gap-2 rounded-xl border border-[#263247] bg-[#070a10]/70 px-3 py-2 text-[11px] leading-5 text-muted-foreground/85">
            <Badge variant="outline" className="shrink-0 border-sky-500/30 bg-sky-500/10 px-1.5 py-0 text-[10px] text-sky-300">
              名詞解釋
            </Badge>
            <span className="min-w-0 flex-1">{explanation}</span>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => refetch()}
          className="gap-1.5 text-xs xl:mt-1"
          disabled={isLoading}
        >
          <RefreshCw className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
          更新
        </Button>
      </div>

      <RecommendationLaneExplainer />

      {isLoading ? (
        <div className="grid gap-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-24 animate-pulse rounded-xl bg-muted/40" />
          ))}
        </div>
      ) : tradable.length === 0 ? (
        <div className="rounded-2xl border border-[#263247] bg-[#070a10]/80 py-10 text-center text-muted-foreground">
          <Star className="mx-auto mb-2 h-8 w-8 opacity-20" />
          <p className="text-sm">尚未產出今日推薦</p>
          <p className="mt-1 text-xs">請檢查 evening-chain / pipeline / recommendation，或到 OBS 看 root cause。</p>
        </div>
      ) : (
        <div className="grid gap-4">
          <section className="space-y-3 rounded-2xl border border-emerald-500/15 bg-emerald-500/[0.025] p-3">
            <div className="flex items-center justify-between px-1">
              <div>
                <p className="text-xs font-semibold text-emerald-300">上市櫃交易流</p>
                <p className="text-[11px] text-muted-foreground">
                  會進 morning setup / debate / pending buys，自動交易只看這一區。
                </p>
              </div>
              <Badge variant="outline" className="border-emerald-500/30 text-[10px] text-emerald-300">
                {tradable.length} 檔
              </Badge>
            </div>
            {tradable.length > 0 ? (
              tradable.map((rec: any, i: number) => (
                <RecommendationCardClean key={rec.stock_id ?? rec.symbol ?? i} rec={rec} rank={i + 1} />
              ))
            ) : (
              <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.03] p-4 text-xs text-muted-foreground">
                今日沒有通過上市櫃交易流的候選。
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
