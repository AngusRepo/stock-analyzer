import assert from 'node:assert/strict'
import fs from 'node:fs'
import { register } from 'node:module'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SchedulerJob } from '../src/lib/api'

// FG-10: should-have-run work must not read as a neutral no-op, and every "last run" names its replay run_date.
// Component modules import CSS; the standalone tsx runner cannot load it, so stub it out.
register('data:text/javascript,export async function load(u,c,n){return u.endsWith(".css")?{format:"module",source:"",shortCircuit:true}:n(u,c)}')
Object.assign(globalThis, { React })
const { default: JobRunTiming } = await import('../src/components/observability/JobRunTiming')
const { default: StandaloneJobRegistry } = await import('../src/components/observability/StandaloneJobRegistry')
const chain = await import('../src/components/observability/ExecutionChainPanel')
const display = await import('../src/lib/schedulerDisplay')

const job = (id: string, overrides: Partial<SchedulerJob> = {}): SchedulerJob => ({
  id, name: id, schedule: 'event', cron: '', group: 'pipeline_chain', lastRun: '11/2 14:32',
  lastRunAt: '2026-11-02T06:32:01Z', lastDuration: '<1s', lastStatus: 'success', history7d: [], rate7d: 'N/A',
  nextRun: 'event', summary: '', accounting: { schedulerJobId: null, task: id, physicalRoot: false, desiredState: null,
    accountingClass: 'internal_chain', dependencyReviewed: true, ticketRequired: false },
  ticket: { ticketId: null, physicalRootId: null, logicalTask: id, status: 'success', runDate: null,
    authority: 'scheduler_kv', durable: false, missing: false },
  ...overrides,
})
const adapt = job('adapt', {
  lastStatus: 'skip', statusScope: 'historical_replay', statusRunDate: '2026-10-30',
  summary: 'skipped non-production-authoritative callback run_date=2026-10-30; adapt is live-canonical only',
  attentionReason: 'live-canonical task did not run: run_date=2026-10-30 only reached it as a historical replay',
})

test('U2: last run and the replay run_date are shown separately', () => {
  assert.equal(display.historicalReplayLabel(adapt), 'Historical replay · 10/30')
  assert.equal(display.historicalReplayLabel(job('x', { statusScope: 'today', statusRunDate: '2026-11-02' })), null)
  const html = renderToStaticMarkup(<JobRunTiming job={adapt} />)
  assert.match(html, /上次執行/)
  assert.match(html, /Historical replay · 10\/30/)
})

test('U1/U2: the standalone registry shows the attention reason and replay date, not "No action"', () => {
  const watchdog = job('strategy-learning-watchdog', { lastStatus: 'skip', statusScope: 'historical_replay',
    statusRunDate: '2026-10-31', summary: 'SKIPPED strategy-learning recovery recoverable_run_missing',
    attentionReason: 'no strategy-learning run found in the recovery lookback' })
  const html = renderToStaticMarkup(<StandaloneJobRegistry jobs={[watchdog]} mappedJobIds={new Set()} />)
  assert.doesNotMatch(html, /No action/)
  assert.match(html, /no strategy-learning run found/)
  assert.match(html, /is-attention/)
  assert.match(html, /Historical replay · 10\/31/)
})

test('U1/U11/U12: the execution chain gives attention skips their own state and does not complete through skips', () => {
  assert.equal(chain.visualStatus(adapt), 'attention')
  assert.equal(chain.visualStatus(job('rescore-10', { lastStatus: 'skip' })), 'skipped')
  assert.equal(chain.connectorStatus([adapt], [job('daily-report', { lastStatus: 'skip' })]), 'attention')
  assert.equal(chain.connectorStatus([job('a', { lastStatus: 'skip' }), job('b', { lastStatus: 'skip' })], [undefined]), 'skipped')
  assert.equal(chain.connectorStatus([job('a'), job('b', { lastStatus: 'skip' })], [undefined]), 'completed')
  const html = renderToStaticMarkup(<chain.default jobs={[adapt]} isFetching={false} dataUpdatedAt={0} />)
  assert.match(html, /Skipped · 未正式執行/)
  assert.match(html, /live-canonical task did not run/, 'the reason is on the stage card, not only in the detail')
})

test('U5: every history cell has its own strip style', () => {
  const cells = ['success', 'failed', 'running', 'triggered', 'waiting', 'blocked', 'attention', 'missing', 'skip', 'none'] as const
  const classes = cells.map((cell) => display.historyCellStyle(cell).className)
  assert.equal(new Set(classes).size, cells.length)
})

test('U1/U2/U5: SchedulerPage rows use the shared replay, attention and strip helpers', () => {
  const page = fs.readFileSync(new URL('../src/pages/SchedulerPage.tsx', import.meta.url), 'utf8')
  for (const helper of ['historicalReplayLabel(', 'attentionSkipReason(', 'historyCellStyle(']) {
    assert.ok(page.includes(helper), `SchedulerPage must use ${helper}`)
  }
})
