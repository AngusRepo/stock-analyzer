import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  formalDataDomainCutoverConfirmation,
  parseFormalDataDomain,
} from './dataDomainFormalCutover'

const source = readFileSync('src/lib/dataDomainFormalCutover.ts', 'utf8')
const routes = readFileSync('src/routes/adminWriteRoutes.ts', 'utf8')

assert.equal(parseFormalDataDomain('MARKET'), 'market')
assert.throws(() => parseFormalDataDomain('unknown'), /invalid_data_domain/)
assert.equal(
  formalDataDomainCutoverConfirmation('paper'),
  'COMPLETE_DATA_DOMAIN_CUTOVER:paper',
)
assert.match(source, /inspectDataDomainCutoverReadiness/)
assert.match(source, /inspectLatestEveningChainClosure/)
assert.match(source, /inspectActiveDataDomainOwnerProof/)
assert.match(source, /parityNotBefore: activeOwnerProof\?\.ready \? null : latestEveningChain\.timestamp/)
assert.match(source, /active_owner_proof: activeOwnerProof/)
assert.match(source, /formal_data_domain_cutover_guard_failed/)
assert.match(source, /writer_state='cutover'/)
assert.match(source, /status='complete'/)
assert.match(source, /read_write_readback_passed=1/)
assert.match(source, /rollback_restore_passed=1/)
assert.doesNotMatch(source, /DELETE\s+FROM|retrain|submitOrder|LIVE_EXECUTION/i)
assert.match(routes, /\/api\/admin\/data-domains\/:domain\/cutover\/complete/)
assert.match(routes, /body\.dry_run !== false/)
assert.match(routes, /X-Confirm-Data-Domain-Cutover/)

console.log('formal data-domain cutover contract tests passed')
