import type { Bindings } from '../types'
import { databaseForDataDomain, shadowDatabaseForDataDomain, type DataDomain } from './dataDomainRegistry'
import type { LatestEveningChainClosure } from './dataDomainShadowBackfillDrain'

type CutoverRow = { status?: string | null; parity_checked_at?: string | null }
type WriterRow = { epoch?: number | string | null; writer_state?: string | null }
type ProbeRow = {
  source_epoch?: number | string | null
  parity_checked_at?: string | null
  read_write_readback_passed?: number | string | null
  rollback_restore_passed?: number | string | null
  status?: string | null
  checked_at?: string | null
}

export type ActiveOwnerProofObservations = {
  domain: DataDomain
  latest_evening_chain: LatestEveningChainClosure
  cutover: CutoverRow | null
  writer: WriterRow | null
  probe: ProbeRow | null
  pending_projection_events: number
  projection_error_events: number
  anchor_date: string | null
  anchor_rows: number
}

function numeric(value: unknown): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function timestamp(value: unknown): number {
  const text = String(value ?? '').trim()
  if (!text) return Number.NaN
  return Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(text) ? text : `${text.replace(' ', 'T')}Z`)
}

export function buildActiveDataDomainOwnerProof(input: ActiveOwnerProofObservations) {
  const finalized = input.cutover?.status === 'complete' && input.writer?.writer_state === 'cutover'
  if (finalized) {
    return {
      schema_version: 'active-data-domain-owner-proof-v1' as const,
      domain: input.domain,
      required: false,
      ready: true,
      blockers: [] as string[],
      anchor_date: input.anchor_date,
      anchor_rows: input.anchor_rows,
      probe_checked_at: input.probe?.checked_at ?? null,
      writer_epoch: numeric(input.writer?.epoch),
    }
  }

  const blockers: string[] = []
  if (input.domain !== 'market') blockers.push('active_owner_anchor_contract_missing')
  if (!input.latest_evening_chain.terminalSuccess) blockers.push('latest_evening_chain_not_terminal')
  if (!input.latest_evening_chain.runDate) blockers.push('latest_evening_chain_date_missing')
  if (!input.latest_evening_chain.timestamp) blockers.push('latest_evening_chain_timestamp_missing')
  if (!['shadow', 'read_cutover', 'write_cutover'].includes(String(input.cutover?.status ?? ''))) {
    blockers.push('formal_cutover_source_state_invalid')
  }
  if (input.writer?.writer_state !== 'open') blockers.push('legacy_writer_not_open_for_probe')
  if (
    input.probe?.status !== 'passed'
    || numeric(input.probe?.read_write_readback_passed) !== 1
    || numeric(input.probe?.rollback_restore_passed) !== 1
  ) blockers.push('fresh_owner_probe_not_passed')
  if (numeric(input.probe?.source_epoch) !== numeric(input.writer?.epoch)) {
    blockers.push('source_writer_epoch_changed_after_probe')
  }
  if (String(input.probe?.parity_checked_at ?? '') !== String(input.cutover?.parity_checked_at ?? '')) {
    blockers.push('probe_not_bound_to_cutover_parity_receipt')
  }
  const probeAt = timestamp(input.probe?.checked_at)
  const eveningAt = timestamp(input.latest_evening_chain.timestamp)
  if (!Number.isFinite(probeAt) || !Number.isFinite(eveningAt) || probeAt < eveningAt) {
    blockers.push('owner_probe_not_fresh_after_latest_evening_chain')
  }
  if (
    !input.anchor_date
    || !input.latest_evening_chain.runDate
    || input.anchor_date < input.latest_evening_chain.runDate
    || input.anchor_rows <= 0
  ) blockers.push('market_owner_anchor_not_current')
  if (input.pending_projection_events !== 0) blockers.push('projection_pending_not_zero')
  if (input.projection_error_events !== 0) blockers.push('projection_errors_not_zero')

  return {
    schema_version: 'active-data-domain-owner-proof-v1' as const,
    domain: input.domain,
    required: true,
    ready: blockers.length === 0,
    blockers: [...new Set(blockers)],
    anchor_date: input.anchor_date,
    anchor_rows: input.anchor_rows,
    probe_checked_at: input.probe?.checked_at ?? null,
    writer_epoch: numeric(input.writer?.epoch),
  }
}

export async function inspectActiveDataDomainOwnerProof(
  env: Bindings,
  domain: DataDomain,
  latestEveningChain: LatestEveningChainClosure,
) {
  const targetDb = shadowDatabaseForDataDomain(env, domain)
  if (!targetDb) throw new Error(`data_domain_binding_missing:${domain}`)
  const opsDb = databaseForDataDomain(env, 'ops')
  const [cutover, writer, probe, projections, anchor] = await Promise.all([
    opsDb.prepare(`
      SELECT status, parity_checked_at
        FROM data_domain_cutovers
       WHERE domain=?
    `).bind(domain).first<CutoverRow>(),
    opsDb.prepare(`
      SELECT epoch, writer_state
        FROM data_domain_writer_epochs
       WHERE domain=?
    `).bind(domain).first<WriterRow>(),
    opsDb.prepare(`
      SELECT source_epoch, parity_checked_at, read_write_readback_passed,
             rollback_restore_passed, status, checked_at
        FROM data_domain_cutover_probe_receipts
       WHERE domain=?
       ORDER BY checked_at DESC
       LIMIT 1
    `).bind(domain).first<ProbeRow>(),
    opsDb.prepare(`
      SELECT SUM(CASE WHEN status <> 'published' THEN 1 ELSE 0 END) pending,
             SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) errors
        FROM domain_projection_outbox
       WHERE source_domain=? OR target_domain=?
    `).bind(domain, domain).first<{ pending?: number | string | null; errors?: number | string | null }>(),
    domain === 'market'
      ? targetDb.prepare(`
          SELECT MAX(date) anchor_date, COUNT(*) anchor_rows
            FROM canonical_market_daily
           WHERE source IN ('finlab.price', 'finlab.rotc_price')
             AND date=(SELECT MAX(date) FROM canonical_market_daily
                        WHERE source IN ('finlab.price', 'finlab.rotc_price'))
        `).first<{ anchor_date?: string | null; anchor_rows?: number | string | null }>()
      : Promise.resolve(null),
  ])
  return buildActiveDataDomainOwnerProof({
    domain,
    latest_evening_chain: latestEveningChain,
    cutover,
    writer,
    probe,
    pending_projection_events: numeric(projections?.pending),
    projection_error_events: numeric(projections?.errors),
    anchor_date: anchor?.anchor_date == null ? null : String(anchor.anchor_date),
    anchor_rows: numeric(anchor?.anchor_rows),
  })
}
