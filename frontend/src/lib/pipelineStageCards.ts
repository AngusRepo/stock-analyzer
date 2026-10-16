import type { SchedulerJob } from './api'

export const PIPELINE_STAGE_CARDS = [
  { id: 'pipeline-atomic', label: '輸入凍結與 Atomic', phases: ['node_load_inputs','node_load_market_env','node_capture_atomic_inputs'], end: 'node_capture_atomic_inputs' },
  { id: 'pipeline-features', label: '快照與特徵準備', phases: ['node_build_payloads','input_snapshot','input_prep','feature_preparation'], end: 'node_build_payloads' },
  { id: 'pipeline-l2', label: 'L2 特徵增強', phases: ['node_l2_timesfm_enrich','seal_l2_inputs','prepare_prediction_request'], end: 'prepare_prediction_request' },
  { id: 'pipeline-l3', label: 'L3 預測與封存', phases: ['dispatch_prediction','modal_prediction','modal_inference','node_l3_formal_predict','seal_l3_results'], end: 'seal_l3_results' },
] as const
export const expandPipelineStages = (id: string): string[] => id === 'pipeline'
  ? PIPELINE_STAGE_CARDS.map(c => c.id) : id === 'ml-predict' ? [] : [id]
const duration = (ms: number) => `${Math.floor(ms/60000)}分${Math.floor(ms/1000)%60}秒`
const names: Record<string,string> = {
  node_load_inputs:'載入候選股票',node_load_market_env:'載入市場環境',node_capture_atomic_inputs:'凍結 Atomic 輸入',
  node_build_payloads:'建立特徵與推論輸入',input_snapshot:'等待輸入快照',input_prep:'等待特徵批次',
  node_l2_timesfm_enrich:'TimesFM 特徵增強',seal_l2_inputs:'封存 L2 輸入',prepare_prediction_request:'準備預測請求',
  dispatch_prediction:'派送 L3',modal_prediction:'等待模型結果',node_l3_formal_predict:'驗證 L3 結果',seal_l3_results:'封存 L3 結果',
  modal_inference:'Modal 模型推論',
}

export function pipelineStageCards(parent?: SchedulerJob, now=Date.now()): SchedulerJob[] {
  if (!parent) return []
  const p=parent.pipelineProgress
  const progress=p?.run_id === parent.runId && p?.run_date === parent.statusRunDate ? p : null
  const history=progress ? Object.values(progress.executions ?? {legacy:progress.completed}).flat() : []
  const sealed=/\bawaiting_premarket\b/.test(parent.summary) && /\bl3_sealed=true\b/.test(parent.summary)
  return PIPELINE_STAGE_CARDS.map((card,index) => {
    const belongs=(phase:string)=>(card.phases as readonly string[]).includes(phase)
    const rows=history.filter(row=>belongs(row.phase))
    const latest=[...rows].sort((a,b)=>Date.parse(b.completed_at??'')-Date.parse(a.completed_at??''))[0]
    const active=Boolean(progress && belongs(progress.phase))
    const end=[...rows].reverse().find(row=>row.phase===card.end)
    const enrichment=[...rows].filter(row=>row.phase==='node_l2_timesfm_enrich')
      .sort((a,b)=>Date.parse(b.completed_at??'')-Date.parse(a.completed_at??''))[0]
    // Preparing a downstream request does not prove the optional sidecar ran.
    // Only a newer successful enrichment receipt clears its prior limitation.
    const enrichmentIssue=card.id==='pipeline-l2' && ['failed','blocked'].includes(enrichment?.status??'')
      && !(active && progress!.phase==='node_l2_timesfm_enrich' && progress!.status==='running')
    const newerAttempt=active && progress!.status==='running' && Boolean(end?.completed_at)
      && Date.parse(progress!.phase_started_at)>Date.parse(end!.completed_at!)
    const complete=(card.id==='pipeline-l3' && sealed) || (!newerAttempt && !enrichmentIssue && end?.status==='completed')
    const failed=!complete && (enrichmentIssue || (active ? ['failed','blocked'].includes(progress!.status) : ['failed','blocked'].includes(latest?.status??'')))
    const queued=active && (progress!.status==='waiting' || ['dispatch_prediction','modal_prediction'].includes(progress!.phase))
    const started=rows.map(r=>r.started_at).filter((v):v is string=>Boolean(v)).sort()[0]
      ?? (active ? progress!.phase_started_at : null)
    const batches=progress ? parent.pipelineBatches?.find(b=>belongs(b.phase)) : undefined
    const observed=Math.max(Date.parse(progress?.observed_at??'')||0,Date.parse(batches?.observed_at??'')||0)
    const stale=active && !complete && !failed && now-observed>15*60_000
    const missingEarlier=rows.length===0 && progress && PIPELINE_STAGE_CARDS.findIndex(c=>(c.phases as readonly string[]).includes(progress.phase))>index
    const visual: NonNullable<SchedulerJob['stageVisualStatus']>=complete?'completed':failed?'blocked':stale||missingEarlier?'stale'
      :queued?'waiting':active && progress!.status==='running'?'running':rows.length?'waiting':'not_started'
    const summary=(enrichmentIssue?`TimesFM ${enrichment.status==='blocked'?'條件未滿足':'執行失敗'}；流程已接續`:complete?'階段已完成':failed?'階段失敗／條件未滿足':missingEarlier?'缺少本輪階段紀錄':stale?'觀測超過 15 分鐘，待確認'
      :active?(names[progress!.phase]??progress!.phase):rows.length?'等待接續回報':'本輪尚未開始'
      )+(batches?` · 特徵批次 ${batches.completed}/${batches.total}`:'')
    const elapsed=rows.reduce((n,r)=>n+r.elapsed_ms,0) + (visual==='running' ? Math.max(0,now-Date.parse(progress!.phase_started_at)) : 0)
    const ended=complete || (enrichmentIssue && end?.status==='completed')?end?.completed_at:failed?latest?.completed_at:undefined
    const wall=started && (!complete || ended) ? duration(Math.max(0,(ended?Date.parse(ended):now)-Date.parse(started))) : undefined
    return {...parent,id:card.id,name:card.label,stageVisualStatus:visual,stageCard:true,
      stageElapsed:wall,
      lastStatus:visual==='completed'?'success':visual==='blocked'?'failed':visual==='running'?'running':'waiting',
      summary,details:[summary],displayNote:summary,lastError:failed?parent.lastError:undefined,
      lastRunAt:started,lastRun:started??'N/A',lastRunBasis:'started',lastAttemptAt:null,lastEffectiveRunAt:null,
      lastAttemptStatus:undefined,lastEffectiveStatus:undefined,recoveredFromStatus:null,
      lastDuration:rows.length||visual==='running'?`${duration(elapsed)}${visual==='running'?'（進行中）':complete?'':'（已記錄）'}`:'N/A',
      durationConcern:null,durationConcernReason:undefined,history7d:[],rate7d:'N/A',
      accounting:{...parent.accounting,task:card.id,physicalRoot:false,ticketRequired:false},
      ticket:{...parent.ticket,logicalTask:card.id,missing:!started},
    }
  })
}

export function pipelineRunSummary(parent?: SchedulerJob, now=Date.now()): string {
  if (!parent) return '本輪尚無紀錄'
  const p=parent.pipelineProgress
  if (!p || p.run_id!==parent.runId || p.run_date!==parent.statusRunDate) return '本輪階段紀錄尚未取得'
  const start=new Date(p.started_at).toLocaleTimeString('zh-TW',{timeZone:'Asia/Taipei',hour12:false})
  const sealed=/\bawaiting_premarket\b/.test(parent.summary) && /\bl3_sealed=true\b/.test(parent.summary)
  const end=Object.values(p.executions??{legacy:p.completed}).flat().reverse().find(r=>r.phase==='seal_l3_results'&&r.status==='completed')?.completed_at
  const elapsed=duration(Math.max(0,(sealed&&end?Date.parse(end):now)-Date.parse(p.started_at)))
  return `Pipeline · ${start} 開始 · 經過 ${elapsed} · ${sealed?'L3 已封存，等待盤前接續':names[p.phase]??p.phase}`
}
