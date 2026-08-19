import assert from 'node:assert/strict'
import { isFinalizedDeferredTableRepairAuthority } from './dataDomainShadowBackfill'

const allowed = isFinalizedDeferredTableRepairAuthority({
  domainActive: true,
  routeReady: false,
  shadowReady: true,
  cutoverStatus: 'complete',
  writerState: 'cutover',
})
assert.equal(allowed, true)

for (const blocked of [
  { domainActive: false, routeReady: false, shadowReady: true, cutoverStatus: 'complete', writerState: 'cutover' },
  { domainActive: true, routeReady: true, shadowReady: true, cutoverStatus: 'complete', writerState: 'cutover' },
  { domainActive: true, routeReady: false, shadowReady: false, cutoverStatus: 'complete', writerState: 'cutover' },
  { domainActive: true, routeReady: false, shadowReady: true, cutoverStatus: 'shadow', writerState: 'open' },
  { domainActive: true, routeReady: false, shadowReady: true, cutoverStatus: 'complete', writerState: 'open' },
]) {
  assert.equal(isFinalizedDeferredTableRepairAuthority(blocked), false)
}

console.log('data domain finalized deferred repair tests passed')
