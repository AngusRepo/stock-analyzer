import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const completionSource = readFileSync(
  resolve(process.cwd(), 'src/lib/dataDomainCutoverCompletion.ts'),
  'utf8',
)
const readinessSource = readFileSync(
  resolve(process.cwd(), 'src/lib/dataDomainCutoverReadiness.ts'),
  'utf8',
)
const adminWriteSource = readFileSync(
  resolve(process.cwd(), 'src/routes/adminWriteRoutes.ts'),
  'utf8',
)
const routeStart = adminWriteSource.indexOf(
  "adminWriteRoutes.post('/api/admin/data-domains/learning/cutover/complete'",
)
const routeEnd = adminWriteSource.indexOf("adminWriteRoutes.post('/api/admin/update'")
const completionRoute = adminWriteSource.slice(routeStart, routeEnd)

assert(routeStart >= 0 && routeEnd > routeStart, 'protected Learning completion route must exist')
assert.match(completionRoute, /requireAdminOrServiceToken/)
assert.match(completionRoute, /body\.dry_run !== false/)
assert.match(completionRoute, /X-Confirm-Data-Domain-Cutover/)
assert.match(completionRoute, /LEARNING_CUTOVER_CONFIRMATION/)
assert.match(completionRoute, /inspectLearningDataDomainCompletion\(c\.env\)/)
assert.match(completionRoute, /cutover_status !== 'complete'/)
assert.match(completionRoute, /current_writer_state !== 'cutover'/)
assert.doesNotMatch(completionRoute, /DELETE\s+FROM|retrain|allowPromotion|submitOrder|LIVE_EXECUTION/i)

assert.match(completionSource, /activeDataDomains\(env\)\.has\('learning'\)/)
assert.match(completionSource, /MULTI_D1_STRICT/)
assert.match(completionSource, /inspectLatestEveningChainClosure/)
assert.match(completionSource, /inspectDataDomainCutoverReadiness/)
assert.match(completionSource, /data_domain_cutover_probe_receipts[\s\S]*?status='passed'[\s\S]*?source_epoch=\?[\s\S]*?parity_checked_at=\?[\s\S]*?read_write_readback_passed=1[\s\S]*?rollback_restore_passed=1/)
assert.match(completionSource, /const results = await env\.DB\.batch\(\[[\s\S]*?writer_state='cutover'[\s\S]*?status='complete'[\s\S]*?\]\)/)
assert.match(completionSource, /results\[1\]\?\.meta\?\.changes[\s\S]*?results\[2\]\?\.meta\?\.changes/)
assert.match(completionSource, /learning_data_domain_completion_readback_failed/)
assert.doesNotMatch(completionSource, /DELETE\s+FROM|retrain|allowPromotion|submitOrder|LIVE_EXECUTION/i)

assert.match(
  readinessSource,
  /const requiredWriterState = cutoverStatus === 'complete' \? 'cutover' : 'open'/,
  'post-cutover readiness must require the permanent source-writer fence',
)
assert.match(readinessSource, /writerEpoch\.writer_state !== requiredWriterState/)

console.log('Learning data-domain completion contract tests passed')