import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  dataDomainProjectionContractReady,
  dataDomainRoutingContractReady,
} from './dataDomainRegistry'

assert.equal(dataDomainRoutingContractReady('paper'), true)
assert.equal(dataDomainProjectionContractReady('paper'), true)

const runtimeContract = fs.readFileSync('src/lib/paperDomainRuntimeClosure.test.ts', 'utf8')
const routeSource = fs.readFileSync('src/routes/paper.ts', 'utf8')
assert(runtimeContract.includes('paper domain runtime closure contracts passed'))
assert(routeSource.includes('paperDomainDatabase(c.env)'))
assert(routeSource.includes("databaseForDataDomain(c.env, 'core')"))
assert(routeSource.includes('batchGetAtrByDomain(c.env'))
assert(routeSource.includes('getLatestPriceByDomain(c.env'))
assert(!routeSource.includes('batchGetATR(c.env.DB'))
assert(!routeSource.includes('getLatestPrice(c.env.DB'))

console.log('paper D1 routing closure tests passed')
