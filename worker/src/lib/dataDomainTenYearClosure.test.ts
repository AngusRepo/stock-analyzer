import assert from 'node:assert/strict'
import { buildDataDomainTenYearClosure } from './dataDomainTenYearClosure'
import { DATA_DOMAINS, type DataDomain } from './dataDomainRegistry'
import type { DataDomainCutoverReadiness } from './dataDomainCutoverReadiness'

const noUnresolvedRoutes = Object.fromEntries(
  DATA_DOMAINS.map((domain) => [domain, [] as string[]]),
) as unknown as Record<DataDomain, readonly string[]>

const completeDomain = (domain: DataDomain): DataDomainCutoverReadiness => ({
  domain,
  data_ready: true,
  cutover_ready: true,
  blockers: [],
  data_blockers: [],
  contract_blockers: [],
  owned_tables: 1,
  completed_tables: 1,
  parity_tables: 1,
  incomplete_tables: [],
  parity_blocked_tables: [],
  unresolved_route_tables: [],
  pending_projection_events: 0,
  projection_error_events: 0,
  cutover_status: 'complete',
  aggregate_parity_checked_at: '2026-08-19T00:00:00.000Z',
  required_parity_not_before: null,
  routing_contract_ready: true,
  projection_contract_ready: true,
  cutover_probe_checked_at: '2026-08-19T00:00:00.000Z',
  cutover_probe_epoch: 1,
  current_writer_epoch: 1,
  current_writer_state: 'cutover',
})

const complete = buildDataDomainTenYearClosure({
  activeDomains: DATA_DOMAINS,
  strictRequested: true,
  domains: DATA_DOMAINS.map(completeDomain),
  unresolvedRouteTables: noUnresolvedRoutes,
})
assert.equal(complete.complete, true)
assert.equal(complete.claim_allowed, true)
assert.equal(complete.completed_domains, 7)

const postCutoverParityDrift = buildDataDomainTenYearClosure({
  activeDomains: DATA_DOMAINS,
  strictRequested: true,
  unresolvedRouteTables: noUnresolvedRoutes,
  domains: DATA_DOMAINS.map((domain) => domain === 'learning'
    ? {
        ...completeDomain(domain),
        data_ready: false,
        cutover_ready: false,
        blockers: ['aggregate_parity_stale_after_evening_chain', 'full_table_parity_incomplete_or_mismatch'],
        data_blockers: ['aggregate_parity_stale_after_evening_chain', 'full_table_parity_incomplete_or_mismatch'],
      }
    : completeDomain(domain)),
})
assert.equal(postCutoverParityDrift.complete, true)
assert.equal(postCutoverParityDrift.completed_domains, 7)

const finalizedContractFailure = buildDataDomainTenYearClosure({
  activeDomains: DATA_DOMAINS,
  strictRequested: true,
  unresolvedRouteTables: noUnresolvedRoutes,
  domains: DATA_DOMAINS.map((domain) => domain === 'learning'
    ? {
        ...completeDomain(domain),
        cutover_ready: false,
        blockers: ['projection_contract_not_closed'],
        contract_blockers: ['projection_contract_not_closed'],
      }
    : completeDomain(domain)),
})
assert.equal(finalizedContractFailure.complete, false)
assert.equal(finalizedContractFailure.completed_domains, 6)

const learningOnly = buildDataDomainTenYearClosure({
  activeDomains: ['learning'],
  strictRequested: true,
  unresolvedRouteTables: noUnresolvedRoutes,
  domains: DATA_DOMAINS.map((domain) => domain === 'learning'
    ? completeDomain(domain)
    : { ...completeDomain(domain), cutover_ready: false, cutover_status: 'legacy', current_writer_state: 'open' }),
})
assert.equal(learningOnly.complete, false)
assert.equal(learningOnly.claim_allowed, false)
assert.equal(learningOnly.completed_domains, 1)
assert.equal(learningOnly.legacy_role, 'mixed_runtime_source_do_not_delete')
assert(learningOnly.blockers.includes('seven_domain_cutover_incomplete'))

const deferredRoute = buildDataDomainTenYearClosure({
  activeDomains: DATA_DOMAINS,
  strictRequested: true,
  domains: DATA_DOMAINS.map(completeDomain),
  unresolvedRouteTables: { ...noUnresolvedRoutes, paper: ['pending_buy_runs'] },
})
assert.equal(deferredRoute.complete, false)
assert.equal(deferredRoute.completed_domains, 6)
assert.deepEqual(
  deferredRoute.domains.find((item) => item.domain === 'paper')?.unresolved_route_tables,
  ['pending_buy_runs'],
)

console.log('data domain ten-year closure tests passed')
