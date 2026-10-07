import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import assert from 'node:assert/strict'
import SchedulerPipelineChain, { pipelinePreparationLabel } from '../components/SchedulerPipelineChain'
import type { SchedulerJob } from './api'

const job = (id: string, status: SchedulerJob['lastStatus'], summary = '') => ({
  id, lastStatus: status, summary, statusRunDate: '2026-10-07',
} as SchedulerJob)
const jobs = [job('evening-chain', 'running'), job('pipeline', 'running', 'dependency=input_prep stage=prep modal_prediction=not_started'),
  job('regime-compute', 'success'), job('strategy-learning-mature-evidence', 'success'),
  job('screener', 'success'), job('ml-predict', 'waiting'), job('recommendation', 'waiting')]
const html = renderToStaticMarkup(<SchedulerPipelineChain jobs={jobs} />)
assert.ok(html.indexOf('data-stage="regime-compute"') < html.indexOf('data-stage="screener"'))
assert.ok(html.indexOf('data-stage="strategy-learning-mature-evidence"') < html.indexOf('data-stage="screener"'))
assert.ok(html.indexOf('data-stage="pipeline"') < html.indexOf('data-stage="ml-predict"'))
assert.ok(html.includes('特徵資料準備'))
const children = html.slice(html.indexOf('data-stage="ml-predict"'))
assert.equal((children.match(/等待上游/g) || []).length, 2)
assert.ok(!children.includes('執行中'))
assert.ok(pipelinePreparationLabel(job('pipeline', 'running', 'modal_prediction=spawned')).includes('ML 預測'))
const missing = renderToStaticMarkup(<SchedulerPipelineChain jobs={[job('pipeline', 'running')]} />)
assert.ok(missing.includes('尚無收據'))
assert.ok(!missing.includes('整體流程：完成'))
assert.ok(renderToStaticMarkup(<SchedulerPipelineChain jobs={jobs} error={new Error('unavailable')} />).includes('流程狀態讀取失敗'))
console.log('schedulerPipelineChain: passed')

assert.ok(pipelinePreparationLabel(job('pipeline', 'waiting', 'L3 已封存，等待下一交易日盤前接續')).includes('盤前資訊'))
