import type { Bindings } from '../types'
import { inspectDataDomainCutoverReadiness } from './dataDomainCutoverReadiness'
import {
  activeDataDomains,
  DATA_DOMAINS,
  shadowDatabaseForDataDomain,
  type DataDomain,
} from './dataDomainRegistry'
import { inspectActiveDataDomainOwnerProof } from './dataDomainActiveOwnerProof'
import { inspectLatestEveningChainClosure } from './dataDomainShadowBackfillDrain'

export function formalDataDomainCutoverConfirmation(domain: DataDomain): string {
  return `COMPLETE_DATA_DOMAIN_CUTOVER:${domain}`
}

export function parseFormalDataDomain(raw: string): DataDomain {
  const domain = raw.trim().toLowerCase() as DataDomain
  if (!DATA_DOMAINS.includes(domain)) throw new Error(`invalid_data_domain:${raw}`)
  return domain
}

export async function inspectFormalDataDomainCutover(
  env: Bindings,
  domain: DataDomain,
) {
  const active = activeDataDomains(env).has(domain)
  const latestEveningChain = await inspectLatestEveningChainClosure(env.KV, env.DB)
  const activeOwnerProof = active
    ? await inspectActiveDataDomainOwnerProof(env, domain, latestEveningChain)
    : null
  const strict = String(env.MULTI_D1_STRICT ?? '').trim().toLowerCase() === 'true'
  const readiness = await inspectDataDomainCutoverReadiness(env.DB, domain, {
    upstreamTerminalReady: latestEveningChain.terminalSuccess,
    parityNotBefore: activeOwnerProof?.ready ? null : latestEveningChain.timestamp,
    learningTargetDb: domain === 'learning'
      ? shadowDatabaseForDataDomain(env, 'learning') ?? undefined
      : undefined,
  })
  const item = readiness.domains[0] ?? null
  const blockers: string[] = []
  if (!active) blockers.push(`${domain}_runtime_route_not_active`)
  if (!strict) blockers.push('multi_d1_strict_not_enabled')
  if (!latestEveningChain.terminalSuccess) blockers.push('latest_evening_chain_not_terminal')
  const finalized = item?.cutover_status === 'complete' && item.current_writer_state === 'cutover'
  if (activeOwnerProof?.required && !activeOwnerProof.ready) {
    blockers.push(...activeOwnerProof.blockers)
  }
  if (!item?.cutover_ready) blockers.push(...(
    finalized ? item.contract_blockers : item?.blockers ?? [`${domain}_cutover_readiness_missing`]
  ))
  if (!item || !['shadow', 'read_cutover', 'write_cutover', 'complete'].includes(item.cutover_status)) {
    blockers.push(`${domain}_cutover_state_invalid:${item?.cutover_status ?? 'missing'}`)
  }
  return {
    schema_version: 'formal-data-domain-cutover-preflight-v1' as const,
    domain,
    ready: blockers.length === 0,
    blockers: [...new Set(blockers)],
    active,
    strict,
    latest_evening_chain: latestEveningChain,
    active_owner_proof: activeOwnerProof,
    readiness,
    item,
  }
}

export async function completeFormalDataDomainCutover(
  env: Bindings,
  domain: DataDomain,
) {
  const preflight = await inspectFormalDataDomainCutover(env, domain)
  if (!preflight.ready || !preflight.item) {
    throw new Error(`formal_data_domain_cutover_blocked:${domain}:${preflight.blockers.join(',')}`)
  }
  if (
    preflight.item.cutover_status === 'complete'
    && preflight.item.current_writer_state === 'cutover'
  ) {
    return { transitioned: false, status: 'complete' as const, preflight }
  }
  const expectedStatus = preflight.item.cutover_status
  const expectedEpoch = Number(preflight.item.current_writer_epoch)
  const parityCheckedAt = String(preflight.item.aggregate_parity_checked_at ?? '')
  if (
    !['shadow', 'read_cutover', 'write_cutover'].includes(expectedStatus)
    || !Number.isSafeInteger(expectedEpoch)
    || expectedEpoch < 0
    || !Number.isFinite(Date.parse(parityCheckedAt))
  ) throw new Error(`formal_data_domain_cutover_precondition_invalid:${domain}`)

  const results = await env.DB.batch([
    env.DB.prepare(`
      SELECT json(CASE WHEN EXISTS (
        SELECT 1 FROM data_domain_cutovers
         WHERE domain=? AND status=? AND parity_checked_at=?
      ) AND EXISTS (
        SELECT 1 FROM data_domain_writer_epochs
         WHERE domain=? AND writer_state='open' AND epoch=?
      ) AND EXISTS (
        SELECT 1 FROM data_domain_cutover_probe_receipts
         WHERE domain=? AND status='passed' AND source_epoch=?
           AND parity_checked_at=? AND read_write_readback_passed=1
           AND rollback_restore_passed=1
      ) THEN '{}' ELSE 'formal_data_domain_cutover_guard_failed' END) guard
    `).bind(
      domain, expectedStatus, parityCheckedAt,
      domain, expectedEpoch,
      domain, expectedEpoch, parityCheckedAt,
    ),
    env.DB.prepare(`
      UPDATE data_domain_writer_epochs
         SET writer_state='cutover', updated_at=CURRENT_TIMESTAMP
       WHERE domain=? AND writer_state='open' AND epoch=?
    `).bind(domain, expectedEpoch),
    env.DB.prepare(`
      UPDATE data_domain_cutovers
         SET status='complete', updated_at=CURRENT_TIMESTAMP
       WHERE domain=? AND status=? AND parity_checked_at=?
    `).bind(domain, expectedStatus, parityCheckedAt),
  ])
  if (Number(results[1]?.meta?.changes ?? 0) !== 1 || Number(results[2]?.meta?.changes ?? 0) !== 1) {
    throw new Error(`formal_data_domain_cutover_cas_failed:${domain}`)
  }
  const readback = await inspectFormalDataDomainCutover(env, domain)
  if (
    !readback.ready
    || readback.item?.cutover_status !== 'complete'
    || readback.item.current_writer_state !== 'cutover'
  ) throw new Error(`formal_data_domain_cutover_readback_failed:${domain}`)
  return { transitioned: true, status: 'complete' as const, preflight, readback }
}
