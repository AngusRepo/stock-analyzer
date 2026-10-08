import { Check, X } from 'lucide-react'
import type { PendingBuyExecutionPreview } from '@/lib/pendingBuyTradePreview'
import { lastEntryBlocker, checklistEvidence, checklistNumbers, checklistUnknownReason, evidenceTime } from '@/lib/pendingEntryChecklist'

const groups = [
  {title:'當日基準',note:'跨日重置；計畫修訂或資料更正時更新',rows:[
    ['plan','盤前計畫封存且標的允許買入'],['ma60','0050 昨收高於 60 日均線'],['opening_limit','開盤 ORH 未達漲停'],['atr_once','首次訊號動能 > 1.5 × ATR5（SMA）；不通過當日不買']]},
  {title:'完整 5 分 K 訊號',note:'保留最近確認值；下一根完整 K 棒後更新',rows:[
    ['bars','一分鐘 K 棒完整'],['or_touch','訊號根最高價觸及 ORH'],['vwap','訊號根收盤 ≥ 累積 VWAP'],['relative_strength','同時刻漲幅 ≥ 0050']]},
  {title:'送單前檢查',note:'每次送單重查，歷史通過不代表目前可下單',rows:[
    ['window','下一根 5 分 K 首分鐘送單期限'],['quote','訊號後的有效新報價'],['buy_limit','該次價格未達漲停'],
    ['chase','該次價格未超過追價上限'],['position','尚未持有、今日未買入'],
    ['allocation','配置、可用資金與持倉席位'],['l5','五檔報價、價差與深度'],['final','成交前風控與委託複核']]},
]
interface Props {
  preview?:PendingBuyExecutionPreview|null
  plannedAllocation?:{target_weight:number;target_value:number;locked:boolean;finalized_at:string}|null
  todayFills?:{shares:number}|null
  liveQuote?:{price:number;as_of:string}|null
  nowMs?:number
}
export function PendingEntryChecklist({preview,plannedAllocation,todayFills,liveQuote,nowMs=Date.now()}:Props) {
  const evidence=checklistEvidence(preview,nowMs)
  const blocker=lastEntryBlocker(preview)
  const signal=evidence.signal
  const daily=preview?.daily_assessment??signal
  const conditions:Record<string,boolean|null>={...evidence.conditions}
  for(const key of ['ma60','opening_limit','atr_once']) if(typeof conditions[key]!=='boolean' && typeof daily?.conditions?.[key]==='boolean') conditions[key]=daily.conditions[key]
  conditions.plan=plannedAllocation ? plannedAllocation.target_weight>0 && !plannedAllocation.locked : null
  if(todayFills?.shares && todayFills.shares>0) conditions.position=false
  // Allocator and L5 audit details remain evidence, never an enduring execution authorization.
  conditions.allocation=null;conditions.l5=null;conditions.final=null
  const quoteAge=liveQuote?.as_of?(nowMs-Date.parse(liveQuote.as_of))/1000:null
  const freshLive=liveQuote && quoteAge!=null && quoteAge>=0 && quoteAge<=90
  return <section className="mt-3 rounded-lg border border-border bg-background/45 p-3 text-sm">
    <div className="font-semibold text-base text-foreground">進場條件與實際數值</div>
    {blocker&&<p className="mt-2 text-sm text-amber-400">{blocker}</p>}
    {groups.map(group=><div key={group.title} className="mt-3 border-t border-border pt-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1"><h4 className="text-base font-semibold text-foreground">{group.title}</h4><span className="text-sm text-muted-foreground">{group.note}</span></div>
      <div className="mt-2 grid gap-x-5 gap-y-3 sm:grid-cols-2">{group.rows.map(([key,label])=>{
        const value=conditions[key]??null
        const source=['ma60','opening_limit','atr_once'].includes(key) && typeof evidence.conditions[key]!=='boolean'?daily:signal
        let detail=checklistNumbers(key,key==='atr_once' && preview?.or15?.atr_once?preview.or15:source)
        if(key==='plan' && plannedAllocation) detail=`權重 ${(plannedAllocation.target_weight*100).toFixed(2)}% · 目標 $${Math.round(plannedAllocation.target_value).toLocaleString('zh-TW')} · 封存 ${evidenceTime(plannedAllocation.finalized_at)}`
        if(key==='position' && todayFills?.shares) detail=`今日已有 ${todayFills.shares.toLocaleString('zh-TW')} 股成交`
        if(key==='allocation' && preview?.allocator) detail=`最近檢查 ${evidenceTime(preview.allocator.checked_at)} · 上限 $${preview.allocator.budget_cap?.toLocaleString('zh-TW')??'未記錄'}（送單時重查）`
        if(key==='l5' && preview?.allocator) detail=`最近檢查 ${evidenceTime(preview.allocator.checked_at)} · ${preview.allocator.l5_status??'未記錄'}（送單時重查）`
        return <div key={key} className="min-w-0">
          <div className="flex items-start justify-between gap-3"><span className="text-foreground">{label}</span><span className={`shrink-0 ${value===true?'text-emerald-400':value===false?'text-amber-400':'text-muted-foreground'}`}>
            {value===true?<Check className="h-4 w-4" aria-label="通過"/>:value===false?<X className="h-4 w-4" aria-label="未通過"/>:<span>{checklistUnknownReason(key,!!signal)}</span>}
          </span></div>
          {detail&&<p className="mt-1 text-sm text-muted-foreground">{detail}</p>}
        </div>
      })}</div>
    </div>)}
    <p className="mt-3 text-sm text-muted-foreground">最近訊號檢查：{evidenceTime(evidence.checkedAt)}；當日基準取自已封存計畫或標示時間的驗證結果，綠勾不等於目前送單授權。</p>
    <p className="mt-1 text-sm text-muted-foreground">當日行情基準檢查：{evidenceTime(daily?.checked_at)}</p>
    <p className="mt-1 text-sm text-muted-foreground">{freshLive?`畫面最新報價 $${liveQuote.price.toFixed(2)} · ${evidenceTime(liveQuote.as_of)} · 距今 ${quoteAge!.toFixed(1)} 秒（僅供展示，送單另取價）`:'等待 90 秒內展示報價；不沿用過期價格。'}</p>
  </section>
}
