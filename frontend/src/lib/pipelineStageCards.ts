import type { SchedulerJob } from './api'

export const PIPELINE_STAGE_CARDS = [
  // legacyEnd: runs from controllers before node_prepare_l2_inputs existed end at market env.
  { id: 'pipeline-inputs', label: '輸入凍結', phases: ['node_load_inputs','node_load_market_env','node_attach_serving_context','node_prepare_l2_inputs'],
    end: 'node_prepare_l2_inputs', legacyEnd: 'node_load_market_env' },
  // Detached sub-jobs: the controller execution that consumes one records it as a receipt
  // (registration -> consumption). A run that dispatches none leaves these cards empty.
  { id: 'pipeline-snapshot', label: '輸入快照匯出', phases: ['input_snapshot'], end: 'input_snapshot', subJob: true },
  { id: 'pipeline-feature-batches', label: '特徵批次', phases: ['input_prep','feature_preparation'], end: 'input_prep', subJob: true },
  // node_resume_l2_inputs re-verifies frozen inputs after a sub-job; it never reopens the first card.
  { id: 'pipeline-features', label: '特徵與推論輸入組裝', phases: ['node_build_payloads','node_resume_l2_inputs'], end: 'node_build_payloads' },
  // node_prepare_sequence_inputs owns the L2 sub-phases below; while it runs the L2 card is active, not unstarted.
  { id: 'pipeline-l2', label: 'L2 特徵增強', phases: ['node_prepare_sequence_inputs','node_l2_timesfm_enrich','seal_l2_inputs','prepare_prediction_request'], end: 'prepare_prediction_request' },
  { id: 'pipeline-l3', label: 'L3 預測與封存', phases: ['dispatch_prediction','modal_prediction','modal_inference','node_l3_formal_predict','seal_l3_results'], end: 'seal_l3_results' },
] as const
export const expandPipelineStages = (id: string): string[] => id === 'pipeline'
  ? PIPELINE_STAGE_CARDS.map(c => c.id) : id === 'ml-predict' ? [] : [id]
const duration = (ms: number) => `${Math.floor(ms/60000)}分${Math.floor(ms/1000)%60}秒`
// One phase vocabulary for stage cards, the run summary and the phase list.
const PHASE_NAMES: Record<string,string> = {
  startup:'工作啟動',node_load_inputs:'讀取選股輸入',node_load_market_env:'市場環境',
  node_attach_serving_context:'服務合約驗證',node_prepare_l2_inputs:'L2 前輸入封存',node_resume_l2_inputs:'L2 前輸入重新驗證',
  awaiting_premarket:'次交易日盤前資訊',modal_prediction:'L3 模型運算結果',input_prep:'特徵批次結果',input_adjusted:'還原股價',
  node_capture_atomic_inputs:'Atomic 輸入重播',input_snapshot:'輸入快照匯出',
  feature_preparation:'特徵資料準備',node_build_payloads:'特徵與推論輸入',
  node_prepare_sequence_inputs:'序列與 L2 輸入準備',seal_l2_inputs:'封存 L2 輸入',prepare_prediction_request:'準備 L3 請求',dispatch_prediction:'派送 L3 模型',
  node_l2_timesfm_enrich:'L2 時序特徵',modal_inference:'Modal 模型推論',node_l3_formal_predict:'L3 結果驗證與整合',seal_l3_results:'封存 L3 結果',
  node_compute_personas:'推薦特徵',node_recommend:'L4 配置',node_llm_reasons:'推薦說明',
  node_write_d1:'寫入結果',node_paired_nav_setup:'配對證據',node_compute_sector_flow:'產業資金流',
  node_compute_pit_residual_shadow:'殘差證據',node_export_dataset_snapshot:'研究快照',
}
export const pipelinePhaseName = (phase: string): string => PHASE_NAMES[phase] ?? phase

type Progress = NonNullable<SchedulerJob['pipelineProgress']>
const ASSEMBLY_INDEX=PIPELINE_STAGE_CARDS.findIndex(c=>c.id==='pipeline-features')
// FU8-A: progress belongs to the canonical run; the ticket runId is only a fallback for older payloads.
const progressRunId = (parent: SchedulerJob) => parent.canonicalRunId ?? parent.runId
const runHistory = (p: Progress) => Object.values(p.executions ?? {legacy:p.completed}).flat()
const isSealed = (parent: SchedulerJob) => /\bawaiting_premarket\b/.test(parent.summary) && /\bl3_sealed=true\b/.test(parent.summary)
const isTerminal = (parent: SchedulerJob) => isSealed(parent) || ['failed','blocked','success'].includes(parent.lastStatus)
/** A finished run's clocks stop at its last evidence instead of following the browser clock. */
function runClock(parent: SchedulerJob, p: Progress, now: number): number {
  if (!isTerminal(parent)) return now
  const last=Math.max(Date.parse(p.observed_at)||0,...runHistory(p).map(r=>Date.parse(r.completed_at??'')||0))
  return last>0 ? Math.min(last,now) : now
}

export function pipelineStageCards(parent?: SchedulerJob, now=Date.now()): SchedulerJob[] {
  if (!parent) return []
  const p=parent.pipelineProgress
  const progress=p?.run_id === progressRunId(parent) && p?.run_date === parent.statusRunDate ? p : null
  const history=progress ? runHistory(progress) : []
  const sealed=isSealed(parent)
  const currentIndex=progress ? PIPELINE_STAGE_CARDS.findIndex(c=>(c.phases as readonly string[]).includes(progress.phase)) : -1
  // Only this run's progress can prove assembly ended; a sealed parent with another run's progress proves nothing.
  const assemblyDone=Boolean(progress) && (sealed || currentIndex>ASSEMBLY_INDEX
    || history.some(row=>row.phase==='node_build_payloads' && row.status==='completed'))
  const chainActive=Boolean(progress && ['running','waiting'].includes(parent.lastStatus) && !sealed)
  const parentFailed=['failed','blocked'].includes(parent.lastStatus)
  const clock=progress ? runClock(parent,progress,now) : now
  const candidate=parent.pipelineWork
  // The Worker already enforces 30s server-clock freshness; here allow one 60s poll plus browser clock skew.
  const workAge=now-Date.parse(candidate?.observed_at??'')
  const work=candidate && progress && candidate.run_id===progressRunId(parent) && candidate.run_date===parent.statusRunDate
    && candidate.phase===progress.phase && workAge>=-60_000 && workAge<=90_000 ? candidate : undefined
  return PIPELINE_STAGE_CARDS.map((card,index) => {
    const belongs=(phase:string)=>(card.phases as readonly string[]).includes(phase)
    const subJob='subJob' in card
    const rows=history.filter(row=>belongs(row.phase))
    const latest=[...rows].sort((a,b)=>Date.parse(b.completed_at??'')-Date.parse(a.completed_at??''))[0]
    const active=Boolean(progress && belongs(progress.phase))
    // A run now inside attach/prepare is from a current controller: market env is not its end.
    const legacyEnd='legacyEnd' in card && !rows.some(row=>row.phase===card.end || row.phase==='node_attach_serving_context')
      && !['node_attach_serving_context','node_prepare_l2_inputs'].includes(progress?.phase ?? '')
      ? card.legacyEnd : undefined
    const end=[...rows].reverse().find(row=>row.phase===card.end || row.phase===legacyEnd)
    const enrichment=[...rows].filter(row=>row.phase==='node_l2_timesfm_enrich')
      .sort((a,b)=>Date.parse(b.completed_at??'')-Date.parse(a.completed_at??''))[0]
    // Preparing a downstream request does not prove the optional sidecar ran.
    // Only a newer successful enrichment receipt clears its prior limitation.
    const enrichmentIssue=card.id==='pipeline-l2' && ['failed','blocked'].includes(enrichment?.status??'')
      && !(active && progress!.phase==='node_l2_timesfm_enrich' && progress!.status==='running')
    const newerAttempt=active && progress!.status==='running' && Boolean(end?.completed_at)
      && Date.parse(progress!.phase_started_at)>Date.parse(end!.completed_at!)
    const complete=(card.id==='pipeline-l3' && sealed) || (!newerAttempt && !enrichmentIssue && end?.status==='completed')
    const childRunning=active && chainActive && work?.status==='running' && work.active>0
    // A failed parent stops the current card even when its last phase receipt still says running.
    const failed=!complete && (enrichmentIssue || (active && (work?.status==='failed' || parentFailed))
      || (active ? ['failed','blocked'].includes(progress!.status) : ['failed','blocked'].includes(latest?.status??'')))
    const queued=active && !childRunning && (progress!.status==='waiting' || ['dispatch_prediction','modal_prediction'].includes(progress!.phase))
    const started=rows.map(r=>r.started_at).filter((v):v is string=>Boolean(v)).sort()[0]
      ?? (active ? progress!.phase_started_at : null)
    const batches=progress ? parent.pipelineBatches?.find(b=>belongs(b.phase)) : undefined
    const observed=Math.max(Date.parse(progress?.observed_at??'')||0,Date.parse(batches?.observed_at??'')||0,
      active && work?.status!=='unknown' ? Date.parse(work?.observed_at??'')||0 : 0)
    const stale=chainActive && active && !complete && !failed && now-observed>15*60_000
    // A sub-job is optional and dispatched from the assembly card: once assembly is done, no receipt means none ran.
    // A sealed or post-L3 run reports a phase outside every card (awaiting_premarket, node_write_d1), so the
    // assembly receipt or the seal decides, not only the current card.
    const noSubJob=subJob && rows.length===0 && !active && assemblyDone
    const missingEarlier=!subJob && rows.length===0 && progress && PIPELINE_STAGE_CARDS.findIndex(c=>(c.phases as readonly string[]).includes(progress.phase))>index
    const downstream=chainActive && currentIndex>=0 && index>currentIndex
    const upstreamBlocked=currentIndex>=0 && index>currentIndex && (['failed','blocked'].includes(parent.lastStatus)
      || ['failed','blocked'].includes(progress?.status??'') || work?.status==='failed')
    const visual: NonNullable<SchedulerJob['stageVisualStatus']>=complete?'completed':noSubJob?'noop':failed||upstreamBlocked?'blocked':stale||missingEarlier?'stale'
      :childRunning?'running':queued||downstream?'waiting':chainActive && active && progress!.status==='running'?'running':rows.length?'waiting':'not_started'
    const summary=(enrichmentIssue?`TimesFM ${enrichment.status==='blocked'?'條件未滿足':'執行失敗'}；流程已接續`:complete?'階段已完成':noSubJob?'本輪無子作業紀錄':failed?'階段失敗／條件未滿足':upstreamBlocked?'上游失敗／條件未滿足，尚未執行':missingEarlier?'缺少本輪階段紀錄':stale?'觀測超過 15 分鐘，待確認'
      :childRunning?(progress!.phase==='input_snapshot'?'快照匯出中':'特徵批次執行中')
      :active?pipelinePhaseName(progress!.phase):downstream?`等待${PIPELINE_STAGE_CARDS[index-1].label}完成`:rows.length?'等待接續回報'
      // Before assembly ends a sub-job may still be dispatched; it is only empty so far, never missing.
      :subJob && (noSubJob || currentIndex>index)?'本輪無子作業紀錄':'本輪尚未開始'
      )+(active && work && work.total>1?` · 已完成 ${work.completed}/${work.total} · 執行中 ${work.active}`:batches?` · 特徵批次 ${batches.completed}/${batches.total}`:'')
    const elapsed=rows.reduce((n,r)=>n+r.elapsed_ms,0) + (visual==='running' ? Math.max(0,clock-Date.parse(progress!.phase_started_at)) : 0)
    const ended=complete || (enrichmentIssue && end?.status==='completed')?end?.completed_at:failed?latest?.completed_at:undefined
    const wall=started && (!complete || ended) ? duration(Math.max(0,(ended?Date.parse(ended):clock)-Date.parse(started))) : undefined
    return {...parent,id:card.id,name:card.label,stageVisualStatus:visual,stageCard:true,
      stageElapsed:wall,
      lastStatus:visual==='completed'?'success':visual==='noop'?'skip':upstreamBlocked?'blocked':visual==='blocked'?'failed':visual==='running'?'running':'waiting',
      summary,summaryZh:undefined,details:[summary],displayNote:summary,lastError:failed?parent.lastError:undefined,
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
  if (!p || p.run_id!==progressRunId(parent) || p.run_date!==parent.statusRunDate) return '本輪階段紀錄尚未取得'
  const start=new Date(p.started_at).toLocaleTimeString('zh-TW',{timeZone:'Asia/Taipei',hour12:false})
  const sealed=isSealed(parent)
  const end=runHistory(p).reverse().find(r=>r.phase==='seal_l3_results'&&r.status==='completed')?.completed_at
  const elapsed=duration(Math.max(0,(sealed&&end?Date.parse(end):runClock(parent,p,now))-Date.parse(p.started_at)))
  return `Pipeline · ${start} 開始 · 經過 ${elapsed} · ${sealed?'L3 已封存，等待盤前接續':pipelinePhaseName(p.phase)}`
}
