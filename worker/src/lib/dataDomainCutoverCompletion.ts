import type { Bindings } from '../types'
import { activeDataDomains } from './dataDomainRegistry'
import { inspectDataDomainCutoverReadiness } from './dataDomainCutoverReadiness'
import { inspectLatestEveningChainClosure } from './dataDomainShadowBackfillDrain'

export const LEARNING_CUTOVER_CONFIRMATION = 'complete:learning' as const

export async function inspectLearningDataDomainCompletion(
  env: Pick<Bindings, 'DB' | 'KV' | 'LEARNING_DB'> & Partial<Bindings>,
) {
  const latestEveningChain = await inspectLatestEveningChainClosure(env.KV, env.DB)
  const readiness = await inspectDataDomainCutoverReadiness(env.DB, 'learning', {
    upstreamTerminalReady: latestEveningChain.terminalSuccess,
    parityNotBefore: latestEveningChain.timestamp,
    learningTargetDb: env.LEARNING_DB,
  })
  const domain = readiness.domains[0] ?? null
  const active = activeDataDomains(env).has('learning')
  const strict = String(env.MULTI_D1_STRICT ?? '').trim().toLowerCase() === 'true'
  const blockers: string[] = []
  if (!active) blockers.push('learning_runtime_route_not_active')
  if (!strict) blockers.push('multi_d1_strict_not_enabled')
  if (!latestEveningChain.terminalSuccess) blockers.push('latest_evening_chain_not_terminal')
  if (!readiness.strict_enable_allowed || !domain?.cutover_ready) {
    blockers.push(...(domain?.blockers ?? ['learning_cutover_readiness_missing']))
  }
  if (!domain || !['shadow', 'read_cutover', 'write_cutover', 'complete'].includes(domain.cutover_status)) {
    blockers.push(`learning_cutover_state_invalid:${domain?.cutover_status ?? 'missing'}`)
  }
  return {
    schema_version: 'learning-data-domain-completion-preflight-v1' as const,
    ready: blockers.length === 0,
    blockers: [...new Set(blockers)],
    active,
    strict,
    latest_evening_chain: latestEveningChain,
    readiness,
    domain,
  }
}

export async function completeLearningDataDomainCutover(
  env: Pick<Bindings, 'DB' | 'KV' | 'LEARNING_DB'> & Partial<Bindings>,
) {
  const preflight = await inspectLearningDataDomainCompletion(env)
  if (!preflight.ready || !preflight.domain) {
    throw new Error(`learning_data_domain_completion_blocked:${preflight.blockers.join(',')}`)
  }
  if (
    preflight.domain.cutover_status === 'complete'
    && preflight.domain.current_writer_state === 'cutover'
  ) {
    return {
      schema_version: 'learning-data-domain-completion-v1' as const,
      transitioned: false,
      status: 'complete' as const,
      writer_state: 'cutover' as const,
      epoch: preflight.domain.current_writer_epoch,
      parity_checked_at: preflight.domain.aggregate_parity_checked_at,
      preflight,
    }
  }

  const expectedStatus = preflight.domain.cutover_status
  const expectedEpoch = Number(preflight.domain.current_writer_epoch)
  const parityCheckedAt = String(preflight.domain.aggregate_parity_checked_at ?? '')
  if (
    !['shadow', 'read_cutover', 'write_cutover'].includes(expectedStatus)
    || !Number.isSafeInteger(expectedEpoch)
    || expectedEpoch < 0
    || !Number.isFinite(Date.parse(parityCheckedAt))
  ) {
    throw new Error('learning_data_domain_completion_precondition_invalid')
  }

  const results = await env.DB.batch([
    env.DB.prepare(`
      SELECT json(CASE WHEN
        EXISTS (
          SELECT 1 FROM data_domain_cutovers
           WHERE domain='learning' AND status=? AND parity_checked_at=?
        )
        AND EXISTS (
          SELECT 1 FROM data_domain_writer_epochs
           WHERE domain='learning' AND writer_state='open' AND epoch=?
        )
        AND EXISTS (
          SELECT 1 FROM data_domain_cutover_probe_receipts
           WHERE domain='learning' AND status='passed' AND source_epoch=?
             AND parity_checked_at=?
             AND read_write_readback_passed=1
             AND rollback_restore_passed=1
        )
        THEN '{}' ELSE 'learning_cutover_completion_guard_failed' END) AS guard
    `).bind(expectedStatus, parityCheckedAt, expectedEpoch, expectedEpoch, parityCheckedAt),
    env.DB.prepare(`
      UPDATE data_domain_writer_epochs
         SET writer_state='cutover', updated_at=CURRENT_TIMESTAMP
       WHERE domain='learning' AND writer_state='open' AND epoch=?
    `).bind(expectedEpoch),
    env.DB.prepare(`
      UPDATE data_domain_cutovers
         SET status='complete', updated_at=CURRENT_TIMESTAMP
       WHERE domain='learning' AND status=? AND parity_checked_at=?
    `).bind(expectedStatus, parityCheckedAt),
  ])
  if (
    Number(results[1]?.meta?.changes ?? 0) !== 1
    || Number(results[2]?.meta?.changes ?? 0) !== 1
  ) throw new Error('learning_data_domain_completion_cas_failed')

  const [cutover, writer] = await Promise.all([
    env.DB.prepare(`
      SELECT status, parity_checked_at, updated_at
        FROM data_domain_cutovers WHERE domain='learning'
    `).first<{ status?: string; parity_checked_at?: string; updated_at?: string }>(),
    env.DB.prepare(`
      SELECT epoch, writer_state, updated_at
        FROM data_domain_writer_epochs WHERE domain='learning'
    `).first<{ epoch?: number | string; writer_state?: string; updated_at?: string }>(),
  ])
  if (
    cutover?.status !== 'complete'
    || cutover.parity_checked_at !== parityCheckedAt
    || writer?.writer_state !== 'cutover'
    || Number(writer.epoch) !== expectedEpoch
  ) throw new Error('learning_data_domain_completion_readback_failed')

  return {
    schema_version: 'learning-data-domain-completion-v1' as const,
    transitioned: true,
    status: 'complete' as const,
    writer_state: 'cutover' as const,
    epoch: expectedEpoch,
    parity_checked_at: parityCheckedAt,
    completed_at: cutover.updated_at ?? writer.updated_at ?? null,
    preflight,
  }
}
