import assert from 'node:assert/strict'
import {isMissedWatchdog} from './missedWatchdog'
import {currentStage, scopeById, visualStatus} from './executionChainDag'
import type {SchedulerJob} from './schedulerJob'
const missed={id:'premarket-evidence-watchdog',lastError:'missed: no 2026-11-03 receipt since its window opened at 07:00 TW'}
assert.equal(isMissedWatchdog(missed),true)
assert.equal(isMissedWatchdog({...missed,lastError:'stale running: no final callback after 2h'}),false,'a watchdog that ran and failed is a real blocker')
assert.equal(isMissedWatchdog({...missed,id:'pipeline'}),false,'only watchdogs are recovery jobs')
assert.equal(isMissedWatchdog(undefined),false)
// Q39: the daily readiness "Blocked here" card skips a missed watchdog; its row keeps the failed look.
// (Frontend asserted this on the panel source; here on the copied currentStage/visualStatus.)
const daily=scopeById('daily_readiness')
const watchdog={id:'premarket-evidence-watchdog',lastStatus:'failed',lastError:missed.lastError} as SchedulerJob
const waiting={id:'morning-setup',lastStatus:'waiting'} as SchedulerJob
const jobs=new Map([[watchdog.id,watchdog],[waiting.id,waiting]])
assert.equal(visualStatus(watchdog),'blocked','the row itself still renders as failed')
assert.equal(currentStage(jobs,daily).id,'morning-setup','a missed watchdog never takes the current-stage card')
const realFailure={...watchdog,lastError:'stale running: no final callback after 2h'} as SchedulerJob
assert.equal(currentStage(new Map([[watchdog.id,realFailure],[waiting.id,waiting]]),daily).id,'premarket-evidence-watchdog')
// (Q38 24h Failed wording is SchedulerPage.tsx display and stays in the frontend test.)
console.log('missedWatchdog ok')
