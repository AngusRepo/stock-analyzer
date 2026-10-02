import React from 'react'
import {createRoot} from 'react-dom/client'
import ExecutionChainPanel from '../src/components/observability/ExecutionChainPanel'
import {DAILY_READINESS_PHASES} from '../src/components/observability/dailyReadinessPhases'
import type {SchedulerJob} from '../src/lib/api'
import '../src/index.css'
const state=new URLSearchParams(location.search).get('case') ?? 'blocked'
const extra=['evening-chain','intraday-check','eod-exit','post-close-price-refresh','daily-snapshot','rescore-10','rescore-11','rescore-12','rescore-1230']
const ids=[...DAILY_READINESS_PHASES.flatMap(p=>[...p.stages]),...extra]
const jobs=ids.map(id=>({id,name:id,schedule:'event',cron:'',group:'daily',lastRun:'07:24',lastDuration:'12s',
 lastStatus:id==='news-analyst'?(state==='blocked'?'failed':state==='ready'?'success':'running'):['morning-setup','pre-market-warmup'].includes(id)&&state!=='ready'?'waiting':'success',
 statusRunDate:['us-leading','news-analyst','premarket-evidence-watchdog','morning-setup','pre-market-warmup'].includes(id)?'2026-10-02':'2026-10-01',
 lastError:id==='news-analyst'&&state==='blocked'?'缺少可驗證新聞證據；等待資料恢復。':undefined,
 summary:'本地合成狀態，非正式執行結果',history7d:[],rate7d:'—',nextRun:'event',
 accounting:{physicalRoot:false,accountingClass:'internal_chain'},ticket:{missing:false}} as SchedulerJob))
createRoot(document.getElementById('root')!).render(<main style={{padding:16,background:'#080c12',minHeight:'100vh'}}>
 <p style={{color:'#94a3b8',fontSize:12,marginBottom:12}}>本機合成驗證 · 非正式執行資料</p>
 <ExecutionChainPanel jobs={jobs} isFetching={false} dataUpdatedAt={Date.now()}/></main>)
