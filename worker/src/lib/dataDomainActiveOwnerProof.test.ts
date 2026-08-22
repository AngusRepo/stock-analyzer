import assert from 'node:assert/strict'
import { buildActiveDataDomainOwnerProof } from './dataDomainActiveOwnerProof'
import type { LatestEveningChainClosure } from './dataDomainShadowBackfillDrain'

const latest: LatestEveningChainClosure = {
  runDate: '2026-08-21',
  status: 'success',
  runScope: 'live_canonical',
  timestamp: '2026-08-22T03:37:43.152Z',
  runId: 'pipeline-dispatch:2026-08-21:test',
  terminalSuccess: true,
  reason: 'test',
}

const base = {
  domain: 'market' as const,
  latest_evening_chain: latest,
  cutover: { status: 'shadow', parity_checked_at: '2026-08-20T01:56:03.572Z' },
  writer: { epoch: 67463, writer_state: 'open' },
  probe: {
    source_epoch: 67463,
    parity_checked_at: '2026-08-20T01:56:03.572Z',
    read_write_readback_passed: 1,
    rollback_restore_passed: 1,
    status: 'passed',
    checked_at: '2026-08-22T04:00:00.000Z',
  },
  pending_projection_events: 0,
  projection_error_events: 0,
  anchor_date: '2026-08-21',
  anchor_rows: 1967,
}

assert.equal(buildActiveDataDomainOwnerProof(base).ready, true)
assert(buildActiveDataDomainOwnerProof({
  ...base,
  probe: { ...base.probe, checked_at: '2026-08-22T03:00:00.000Z' },
}).blockers.includes('owner_probe_not_fresh_after_latest_evening_chain'))
assert(buildActiveDataDomainOwnerProof({
  ...base,
  writer: { ...base.writer, epoch: 67464 },
}).blockers.includes('source_writer_epoch_changed_after_probe'))
assert(buildActiveDataDomainOwnerProof({
  ...base,
  anchor_date: '2026-08-20',
}).blockers.includes('market_owner_anchor_not_current'))
assert.equal(buildActiveDataDomainOwnerProof({
  ...base,
  cutover: { status: 'complete', parity_checked_at: base.cutover.parity_checked_at },
  writer: { epoch: 67463, writer_state: 'cutover' },
}).ready, true)

console.log('active data-domain owner proof tests passed')
