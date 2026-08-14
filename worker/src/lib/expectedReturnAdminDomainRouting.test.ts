import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync('src/routes/adminConfigCoreRoutes.ts', 'utf8')
const configGetStart = source.indexOf("adminConfigCoreRoutes.get('/api/admin/config'")
const configGetEnd = source.indexOf("adminConfigCoreRoutes.put('/api/admin/config'", configGetStart)
const configGetBody = source.slice(configGetStart, configGetEnd)
const promoteStart = source.indexOf("adminConfigCoreRoutes.post('/api/admin/config/expected-return/promote'")
const promoteEnd = source.indexOf("adminConfigCoreRoutes.post('/api/admin/config/push-defaults'", promoteStart)
const promoteBody = source.slice(promoteStart, promoteEnd)
const configPutBody = source.slice(configGetEnd, promoteStart)
const pushDefaultsEnd = source.indexOf("adminConfigCoreRoutes.get('/api/admin/config/repair-plan'", promoteEnd)
const pushDefaultsBody = source.slice(promoteEnd, pushDefaultsEnd)

assert(configGetStart >= 0 && configGetEnd > configGetStart)
assert(promoteStart >= 0 && promoteEnd > promoteStart)
assert(source.includes("import { databaseForDataDomain } from '../lib/dataDomainRegistry'"))
assert(configGetBody.includes("const learningDb = databaseForDataDomain(c.env, 'learning')"))
assert(configGetBody.includes('hydrateExpectedReturnConfigFromPointers(learningDb'))
assert(!configGetBody.includes('hydrateExpectedReturnConfigFromPointers(c.env.DB'))

assert(promoteBody.includes("const learningDb = databaseForDataDomain(c.env, 'learning')"))
for (const call of [
  'hydrateExpectedReturnConfigFromPointers',
  'recordParameterCandidateFromSandbox',
  'recordParameterCandidateEvidence',
  'validatePromotionPacketForProd',
  'commitExpectedReturnChampion',
  'markParameterCandidatePromoted',
]) {
  assert(promoteBody.includes(`${call}(learningDb`), `${call} must use the learning domain database`)
}
assert(!promoteBody.includes('c.env.DB'))
assert(configPutBody.includes("const learningDb = databaseForDataDomain(c.env, 'learning')"))
assert(configPutBody.includes('validatePromotionPacketForProd(learningDb'))
assert(configPutBody.includes('recordProductionOverride(learningDb'))
assert(!configPutBody.includes('c.env.DB'))
assert(pushDefaultsBody.includes("const learningDb = databaseForDataDomain(c.env, 'learning')"))
assert(pushDefaultsBody.includes('recordProductionOverride(learningDb'))
assert(!pushDefaultsBody.includes('c.env.DB'))
assert(!source.includes('c.env.DB'))


console.log('expected-return admin learning-domain routing tests passed')
