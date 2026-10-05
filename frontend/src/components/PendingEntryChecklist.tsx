import { Check, Minus, X } from 'lucide-react'
import { describeOr15Reason, type PendingBuyExecutionPreview } from '@/lib/pendingBuyTradePreview'
import { formatTwDateTimeShort } from '@/lib/twTime'

const labels: Record<string,string> = {
  plan:'盤前計畫封存且標的允許買入', position:'尚未持有、今日未買入', window:'下一根 5 分 K 首分鐘送單期限',
  ma60:'0050 昨收高於 60 日均線', bars:'完整的一分鐘 K 棒', or_touch:'訊號根最高價觸及 ORH',
  vwap:'訊號根收盤 ≥ 累積 VWAP', relative_strength:'同時刻漲幅 ≥ 0050', opening_limit:'ORH 未達漲停',
  quote:'訊號後的有效新報價', buy_limit:'該次價格未達漲停', chase:'該次價格未超過追價上限',
}
export function PendingEntryChecklist({preview}: {preview?:PendingBuyExecutionPreview|null}) {
  const signal=preview?.or15
  const window=preview?.submission_window
  const price=(value:number|null|undefined)=>value==null?'—':`$${value.toFixed(2)}`
  const details:Record<string,string|null>={
    or_touch:signal?.signal_high!=null||signal?.or_high!=null?`高點 ${price(signal?.signal_high)} / ORH ${price(signal?.or_high)}`:null,
    vwap:signal?.signal_close!=null||signal?.vwap!=null?`收盤 ${price(signal?.signal_close)} / VWAP ${price(signal?.vwap)}`:null,
    relative_strength:signal?.relative_return!=null?`相對 0050 ${(signal.relative_return*100).toFixed(2)}% / 門檻 0%`:null,
    chase:signal?.quote_price!=null||signal?.max_buy_price!=null?`報價 ${price(signal?.quote_price)} / 上限 ${price(signal?.max_buy_price)}`:null,
  }
  const rows=Object.entries(labels).map(([key,label])=>({
    key,label,
    value:key==='window'?window?.open??null:signal?.conditions?.[key]??null,
    detail:details[key]??null,
  }))
  const allocator=preview?.allocator
  rows.push({key:'allocation',label:'L4 配置、可用資金與持倉席位',value:allocator?['buy','add'].includes(allocator.action)&&Number(allocator.budget_cap)>0:null,detail:null},
    {key:'l5',label:'五檔報價、價差與深度',value:allocator?.l5_status?allocator.l5_status==='pass':null,detail:null},
    {key:'final',label:'成交前風控、委託價格與送單時限複核',value:null,detail:null})
  return <section className="mt-3 rounded-lg border border-border bg-background/45 p-3 text-sm">
    <div className="font-semibold text-foreground">進場條件 · 最近完整 5 分 K {signal?.checked_at?formatTwDateTimeShort(signal.checked_at):'待檢查'}</div>
    {window?.open===false&&<p className="mt-1 text-xs text-muted-foreground">本輪送單首分鐘已過；等待下一根完整 5 分 K。下方價格門檻保留上次完整判斷。</p>}
    {window?.reason && !['swing_next_bar_submission_missed',signal?.reason].includes(window.reason)
      && <p className="mt-1 text-xs text-amber-300">本輪狀態：{describeOr15Reason(window.reason)}</p>}
    <div className="mt-2 grid gap-x-5 gap-y-2 sm:grid-cols-2">{rows.map(({key,label,value,detail})=><div key={key} className="flex items-center justify-between gap-2">
      <span className="text-foreground">{label}{detail&&<span className="block text-xs text-muted-foreground">{detail}</span>}</span>
      <span className={value===true?'text-emerald-400':value===false?'text-amber-400':'text-muted-foreground'}>
        {value===true?<Check className="h-4 w-4" aria-label="通過"/>:value===false?<X className="h-4 w-4" aria-label="未通過"/>:<Minus className="h-4 w-4" aria-label="尚未評估"/>}
      </span>
    </div>)}</div>
    <p className="mt-2 text-sm text-muted-foreground">綠勾＝該次檢查通過；—＝尚未評估／缺資料。價格條件取自上次完整 5 分 K，送單時窗顯示本輪狀態；全數通過仍須成交確認。</p>
  </section>
}
