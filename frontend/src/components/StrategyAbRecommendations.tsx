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
  const names = new Map(rows.map(row => [row.symbol, row.name]))
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
    <div className="grid gap-3 xl:grid-cols-2">
      {(['A', 'B'] as const).map(role => {
        const arm = data[role]
        return <div key={role} className="min-w-0 rounded-xl border border-muted/40 bg-background/40 p-4">
          <h3 className="font-semibold">{role === 'A' ? 'A 主方案' : 'B 挑戰方案'}</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{role === 'A' ? '價格 TimeXer＋L4 三頭' : '外生 TimeXer＋L4 三頭＋EV 殘差 MLP'}</p>
          {arm.status !== 'available' ? <p role="status" className="mt-4 text-sm text-amber-200">{arm.reason}</p> : <>
            <div className="mt-3 flex justify-between text-xs text-muted-foreground"><span>{arm.picks.length} 檔配置</span><span>現金 {(arm.cash_weight! * 100).toFixed(2)}%</span></div>
            {arm.picks.length === 0 ? <p className="mt-4 text-sm">已完成配置，本日持有現金。</p> :
              <table className="mt-3 w-full text-sm"><thead className="text-xs text-muted-foreground"><tr><th className="pb-2 text-left">股票</th><th className="pb-2 text-right">目標權重</th></tr></thead>
                <tbody>{arm.picks.map(pick => <tr key={pick.symbol} className={`border-t border-muted/30 ${selectedSymbol === pick.symbol ? 'bg-emerald-500/10' : ''}`}>
                  <td className="py-3"><button className="text-left hover:underline" onClick={() => onSelectSymbol?.(pick.symbol)}>{pick.symbol}{names.get(pick.symbol) ? ` ${names.get(pick.symbol)}` : ''}</button></td>
                  <td className="py-3 text-right tabular-nums">{(pick.weight * 100).toFixed(2)}%</td>
                </tr>)}</tbody></table>}
          </>}
        </div>
      })}
    </div>
  </section>
}
