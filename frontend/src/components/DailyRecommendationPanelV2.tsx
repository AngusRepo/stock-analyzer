import { useQuery } from '@tanstack/react-query'
import { RefreshCw, Star } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { AI_TOP_PICK_EXPLANATION, RecommendationCardClean } from '@/components/RecommendationCardClean'
import { RecommendationLaneExplainer } from '@/components/workstation/DecisionArchitecture'
import { recommendationsApi } from '@/lib/api'
import { queryTtl, recommendationDailyKey, selectRecommendationLanes, twToday } from '@/lib/queryPolicy'
import { cn } from '@/lib/utils'

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
  const emerging = data?.emerging ?? []

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Star className="h-4 w-4 text-amber-400" />
            每日選股推薦
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {payload?.date ?? today} · ML + 籌碼 + 技術 + Alpha / Risk 綜合評分
          </p>
          <p className="mt-1 max-w-2xl text-[11px] leading-relaxed text-muted-foreground/80">
            {AI_TOP_PICK_EXPLANATION}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => refetch()}
          className="gap-1.5 text-xs"
          disabled={isLoading}
        >
          <RefreshCw className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
          更新
        </Button>
      </div>

      <RecommendationLaneExplainer />

      {isLoading ? (
        <div className="grid gap-3 xl:grid-cols-2">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-24 animate-pulse rounded-xl bg-muted/40" />
          ))}
        </div>
      ) : tradable.length === 0 && emerging.length === 0 ? (
        <div className="rounded-2xl border border-[#263247] bg-[#070a10]/80 py-10 text-center text-muted-foreground">
          <Star className="mx-auto mb-2 h-8 w-8 opacity-20" />
          <p className="text-sm">尚未產出今日推薦</p>
          <p className="mt-1 text-xs">請確認 evening-chain / pipeline / recommendation 已完成，或查看 OBS 根因。</p>
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2 xl:items-start">
          <section className="space-y-3">
            <div className="flex items-center justify-between px-1">
              <div>
                <p className="text-xs font-semibold text-emerald-300">上市上櫃交易流</p>
                <p className="text-[11px] text-muted-foreground">
                  會進入 morning setup / debate / pending buys，這一區才可能影響自動交易。
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
                今天沒有上市櫃交易候選；興櫃不會回填到此區，避免研究股擠掉交易股。
              </div>
            )}
          </section>

          <section className="space-y-3 rounded-2xl border border-amber-500/20 bg-amber-500/[0.04] p-3">
            <div className="flex items-center justify-between px-1">
              <div>
                <p className="text-xs font-semibold text-amber-300">興櫃觀察 · 研究流</p>
                <p className="text-[11px] text-muted-foreground">
                  可跑 ML / IC / calibration evidence，但硬 gate 不進 morning setup、不產生 pending buys。
                </p>
              </div>
              <Badge variant="outline" className="border-amber-500/30 text-[10px] text-amber-300">
                {emerging.length} 檔
              </Badge>
            </div>
            {emerging.length > 0 ? (
              emerging.slice(0, 24).map((rec: any, i: number) => (
                <RecommendationCardClean key={rec.stock_id ?? rec.symbol ?? i} rec={rec} rank={i + 1} />
              ))
            ) : (
              <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.03] p-4 text-xs text-muted-foreground">
                今天沒有興櫃研究候選；此區只做研究觀察，不會擠掉上市櫃交易流。
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
