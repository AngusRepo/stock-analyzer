import { RecommendationCardClean } from '@/components/RecommendationCardClean'
import { useQuery } from '@tanstack/react-query'
import { apiGet } from '@/lib/apiClient'
import { recommendationsApi } from '@/lib/api'
import { recommendationDailyKey, queryTtl } from '@/lib/queryPolicy'
import type { StrategyAbRecommendations as Comparison } from '../../../worker/src/lib/strategyAbRecommendationContract'

export default function StrategyAbRecommendations({ date, selectedSymbol, onSelectSymbol }: {
  date?: string; selectedSymbol?: string | null; onSelectSymbol?: (symbol: string) => void
}) {
  const daily = useQuery({ queryKey: recommendationDailyKey(date),
    queryFn: ({ signal }) => recommendationsApi.daily(date, { view: 'card', signal, timeoutMs: 15_000 }),
    staleTime: queryTtl.dailyDecision })
  const signalDate = date || daily.data?.date
  const comparison = useQuery({ queryKey: ['strategy-ab-recommendations', signalDate], enabled: !!signalDate,
    queryFn: ({ signal }) => apiGet<Comparison>(`/dashboard/v4/strategy-ab/recommendations?date=${signalDate}`, { signal, timeoutMs: 15_000 }), staleTime: 30_000 })
  const raw = daily.data as any
  const rows: any[] = Array.isArray(raw?.all_recommendations) ? raw.all_recommendations : Array.isArray(raw?.recommendations) ? raw.recommendations : Array.isArray(raw?.data) ? raw.data : []
  // A dated comparison must never borrow cards from a different signal day.
  const cards = new Map(rows.filter(row => (row.date || raw?.date) === signalDate).map(row => [String(row.symbol), row]))
  if (comparison.isError || daily.isError) return <div role="alert" className="rounded-xl border border-amber-500/30 p-4 text-sm text-amber-200">
    A/B 配置讀取失敗。<button className="ml-3 underline" onClick={() => { void comparison.refetch(); void daily.refetch() }}>重新讀取</button>
  </div>
  if (!comparison.data) return <p role="status" className="p-4 text-sm text-muted-foreground">讀取 A/B 同日配置…</p>
  const data = comparison.data
  return <section className="space-y-3" aria-label="A B 選股與配置權重">
    <div className="text-sm font-semibold">{data.date} · A／B 選股與配置權重</div>
    <p className="text-xs leading-5 text-muted-foreground">{data.scope === 'retrospective_research'
      ? '事後補算比較：僅供觀察，不計入原生 NAV 績效，也不會產生委託。'
      : '下列為各方案的配置目標；是否成交仍以待買檢查、辯論及成交紀錄為準。'}</p>
    <p className="text-xs leading-5 text-muted-foreground">卡片編號為配置清單順序。ML_EDGE 是校準機率換算分，可能因校準曲線平臺而同分；個股配置仍依 L4 預測與 sparse＋OPB 決定。待買清單可先顯示「等待辯論」，通過辯論及交易檢查後才可執行。</p>
    <div className="grid gap-3 xl:grid-cols-2">
      {(['A', 'B'] as const).map(role => {
        const arm = data[role]
        return <div key={role} className="min-w-0 rounded-xl border border-muted/40 bg-background/40 p-4">
          <h3 className="font-semibold">{role === 'A' ? 'A 主方案' : 'B 挑戰方案'}</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{role === 'A' ? '價格 TimeXer＋L4 三頭' : '外生 TimeXer＋L4 三頭＋EV 殘差 MLP'}</p>
          {arm.status !== 'available' ? <p role="status" className="mt-4 text-sm text-amber-200">{arm.reason}</p> : <>
            <div className="mt-3 flex justify-between text-xs text-muted-foreground"><span>{arm.picks.length} 檔配置</span><span>現金 {(arm.cash_weight! * 100).toFixed(2)}%</span></div>
            {arm.picks.length === 0 ? <p className="mt-4 text-sm">已完成配置，本日持有現金。</p> :
              <div className="mt-3 space-y-4">{arm.picks.map((pick, index) => {
                const rec = cards.get(pick.symbol)
                return <article key={pick.symbol} aria-label={`${role} ${pick.symbol} 配置`} className={`rounded-xl border p-2 ${selectedSymbol === pick.symbol ? 'border-emerald-500/60 bg-emerald-500/5' : 'border-muted/30'}`}>
                  <div className="mb-2 flex items-center justify-between gap-3 px-2 py-1 text-sm">
                    <button className="text-left font-medium hover:underline" onClick={() => onSelectSymbol?.(pick.symbol)}>{pick.symbol}{rec?.name ? ` ${rec.name}` : ''}</button>
                    <span className="shrink-0 tabular-nums">{role} 目標 {(pick.weight * 100).toFixed(2)}%</span>
                  </div>
                  {role === 'B' && <p className="mb-2 px-2 text-xs leading-5 text-amber-200">下方為同日正式 A 個股資訊，供行情與模型對照；B 的模型分數與交易價位尚未提供。B 配置以本卡上方權重為準。</p>}
                  {rec ? <RecommendationCardClean rec={rec} rank={index + 1} context="home" />
                    : <p role="status" className="p-3 text-xs text-muted-foreground">尚無 {data.date} 的首頁個股資訊；保留已核實的配置權重。</p>}
                </article>
              })}</div>}
          </>}
        </div>
      })}
    </div>
  </section>
}
