import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {DAILY_READINESS_PHASES, PREMARKET_READINESS_IDS, dailyPhaseForStage} from '../components/observability/dailyReadinessPhases'
import {buildAttemptAwareJobMap} from '../components/observability/executionChainAttemptState'
import type {SchedulerJob} from './api'
const ids=DAILY_READINESS_PHASES.flatMap(p=>[...p.stages])
assert.equal(ids.length,new Set(ids).size)
for(const id of ['us-leading','news-analyst','morning-setup','pre-market-warmup']) assert.equal(dailyPhaseForStage(id),'premarket')
assert.equal(dailyPhaseForStage('intraday-check'),undefined)
const morning={id:'news-analyst',lastStatus:'failed',statusRunDate:'2026-10-02',lastError:'fresh failure'} as SchedulerJob
const base=new Map<string,SchedulerJob>([['news-analyst',morning],['evening-chain',{id:'evening-chain',lastStatus:'running',statusRunDate:'2026-10-01'} as SchedulerJob],['pipeline',{id:'pipeline',lastStatus:'running',statusRunDate:'2026-10-01'} as SchedulerJob]])
const columns=ids.map(id=>[id]).filter(column=>!column.some(id=>PREMARKET_READINESS_IDS.has(id)))
const next=buildAttemptAwareJobMap(base,{columns,orchestratorId:'evening-chain'},()=>null)
assert.strictEqual(next.get('news-analyst'),morning,'evening replay must not erase next-day morning failure')
const source=readFileSync('src/components/observability/ExecutionChainPanel.tsx','utf8')
const intraday=source.slice(source.indexOf("id: 'intraday',"),source.indexOf("id: 'weekly',"))
for(const id of PREMARKET_READINESS_IDS) assert.ok(!intraday.includes(id),id+' must leave intraday scope')
console.log('dailyReadinessPhases: unique coverage, morning ownership and replay isolation passed')

assert.equal(dailyPhaseForStage('dataset-snapshot-export'),'models')
for (const id of ['active8-oof-daily','allocator-ev-lifecycle-watchdog']) assert.equal(dailyPhaseForStage(id),'evidence')
