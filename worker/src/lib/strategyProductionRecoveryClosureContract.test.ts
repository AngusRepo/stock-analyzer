import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const source = readFileSync(resolve(process.cwd(), 'src/routes/adminWriteRoutes.ts'), 'utf8')
const start = source.indexOf("adminWriteRoutes.post('/api/admin/strategy/production-policy/recover'")
const end = source.indexOf("adminWriteRoutes.post('/api/admin/entry-model-v2/replay'")
const recovery = source.slice(start, end)

assert.match(
  recovery,
  /WHERE signal_date<=\? AND status='success'[\s\S]*?ORDER BY signal_date DESC[\s\S]*?LIMIT 1/,
  'knowledge cutoff must bind to the latest completed formal closure',
)
assert.match(
  recovery,
  /loadStrategyEvidenceOwnerSnapshotBefore\(learningDb, specsResult\.specs, date, publicationCutoffAt\)/,
  'Shadow B owner readiness must be exposed before persistence',
)
assert.match(recovery, /body\.publication_evidence === true \? strategyPolicyPublicationCutoff\(date\) : undefined/,
  'historical cutoff remains the default; publication clock is server-owned and opt-in')
assert.match(recovery, /if \(!evidenceOwnerSnapshot\.integration_ready\)[\s\S]*?return c\.json[\s\S]*?409[\s\S]*?refreshStrategyProductionContributionPolicy/,
  'missing evidence must still block publication')
assert.doesNotMatch(recovery, /allowPromotion|submitOrder|LIVE_EXECUTION/,
  'recovery must not promote strategies or submit orders')
console.log('strategy production recovery closure contract tests passed')
