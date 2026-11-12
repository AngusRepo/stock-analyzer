import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {isMissedWatchdog} from '../components/observability/missedWatchdog'
const missed={id:'premarket-evidence-watchdog',lastError:'missed: no 2026-11-03 receipt since its window opened at 07:00 TW'}
assert.equal(isMissedWatchdog(missed),true)
assert.equal(isMissedWatchdog({...missed,lastError:'stale running: no final callback after 2h'}),false,'a watchdog that ran and failed is a real blocker')
assert.equal(isMissedWatchdog({...missed,id:'pipeline'}),false,'only watchdogs are recovery jobs')
assert.equal(isMissedWatchdog(undefined),false)
// Q39: the daily readiness "Blocked here" card skips a missed watchdog; its row keeps the failed look.
const panel=readFileSync(new URL('../components/observability/ExecutionChainPanel.tsx',import.meta.url),'utf8')
assert.match(panel,/\.filter\(\(job\) => \['running', 'blocked', 'waiting'\]\.includes\(visualStatus\(job\)\) && !isMissedWatchdog\(job\)\)/)
assert.match(panel,/if \(job\.lastStatus === 'failed'\) return 'blocked'/,'the row itself still renders as failed')
// Q38: 24h Failed shows missed watchdogs on top of the deploy gate's failed24h.
const page=readFileSync(new URL('../pages/SchedulerPage.tsx',import.meta.url),'utf8')
assert.match(page,/const failed24hShown = stats\.failed24h \+ missed24h/)
assert.match(page,/label="24h Failed" value=\{String\(failed24hShown\)\}/)
console.log('missedWatchdog ok')
