import { Check, Minus, X } from 'lucide-react'
import type { PendingBuyExecutionPreview } from '@/lib/pendingBuyTradePreview'

const labels: Record<string,string> = {
  plan:'盤前計畫封存且標的允許買入', position:'尚未持有、今日未買入', window:'下一根 5 分 K 首分鐘送單期限',
  ma60:'0050 昨收高於 60 日均線', bars:'完整的一分鐘 K 棒', or_touch:'訊號根最高價觸及 ORH',
  vwap:'訊號根收盤 ≥ 累積 VWAP', relative_strength:'同時刻漲幅 ≥ 0050', opening_limit:'ORH 未達漲停',
  quote:'訊號後的有效新報價', buy_limit:'該次價格未達漲停', chase:'該次價格未超過追價上限',
}
export function PendingEntryChecklist({preview}: {preview?:PendingBuyExecutionPreview|null}) {
  const signal=preview?.or15
  const rows=Object.entries(labels).map(([key,label])=>({key,label,value:signal?.conditions?.[key]??null}))
  const allocator=preview?.allocator
  rows.push({key:'allocation',label:'L4 配置、可用資金與持倉席位',value:allocator?['buy','add'].includes(allocator.action)&&Number(allocator.budget_cap)>0:null},
    {key:'l5',label:'五檔報價、價差與深度',value:allocator?.l5_status?allocator.l5_status==='pass':null},
    {key:'final',label:'成交前風控、委託價格與送單時限複核',value:null})
  return <section className="mt-3 rounded-lg border border-border bg-background/45 p-3 text-sm">
    <div className="font-semibold text-foreground">進場條件</div>
    <div className="mt-2 grid gap-x-5 gap-y-2 sm:grid-cols-2">{rows.map(({key,label,value})=><div key={key} className="flex items-center justify-between gap-2">
      <span className="text-foreground">{label}</span>
      <span className={value===true?'text-emerald-400':value===false?'text-amber-400':'text-muted-foreground'}>
        {value===true?<Check className="h-4 w-4" aria-label="通過"/>:value===false?<X className="h-4 w-4" aria-label="未通過"/>:<Minus className="h-4 w-4" aria-label="尚未評估"/>}
      </span>
    </div>)}</div>
    <p className="mt-2 text-sm text-muted-foreground">綠勾＝該次檢查通過；—＝尚未評估／缺資料。行情更新不會改寫訊號結果；全數通過仍須成交確認。</p>
    {signal?.max_buy_price!=null&&<p className="mt-1 text-sm text-muted-foreground">該次追價上限 ${signal.max_buy_price} · 訊號收盤 ${signal.signal_close??'—'}</p>}
  </section>
}
