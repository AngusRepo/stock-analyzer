import {
  MULTI_D1_STRICT_ROUTING_READY,
  tablesForDataDomain,
  type DataDomain,
} from './dataDomainRegistry'

const DOMAINS: DataDomain[] = ['core', 'market', 'learning', 'ops', 'execution', 'paper', 'research']

export type DataDomainCutoverReadiness = {
  domain: DataDomain
  cutover_ready: boolean
  blockers: string[]
  owned_tables: number
  completed_tables: number
  parity_tables: number
  pending_projection_events: number
  cutover_status: string
  routing_contract_ready: boolean
}

export async function inspectDataDomainCutoverReadiness(
  db: D1Database,
  requestedDomain?: string | null,
): Promise<{
  schema_version: 'data-domain-cutover-readiness-v1'
  strict_enable_allowed: boolean
  domains: DataDomainCutoverReadiness[]
}> {
  const normalized = String(requestedDomain ?? '').trim().toLowerCase()
  const domains = normalized
    ? DOMAINS.filter((domain) => domain === normalized)
    : DOMAINS
  if (!domains.length) throw new Error(`invalid_data_domain:${normalized}`)

  const results: DataDomainCutoverReadiness[] = []
  for (const domain of domains) {
    const owned = tablesForDataDomain(domain)
    const [completed, parity, pending, cutover] = await Promise.all([
      db.prepare(`
        SELECT COUNT(*) count FROM data_domain_backfill_cursors
         WHERE domain=? AND status='complete'
      `).bind(domain).first<{ count?: number | string }>(),
      db.prepare(`
        SELECT COUNT(DISTINCT table_name) count FROM data_domain_parity_checks
         WHERE domain=? AND check_kind='full_table' AND status='pass'
      `).bind(domain).first<{ count?: number | string }>(),
      db.prepare(`
        SELECT COUNT(*) count FROM domain_projection_outbox
         WHERE (source_domain=? OR target_domain=?) AND status <> 'published'
      `).bind(domain, domain).first<{ count?: number | string }>(),
      db.prepare(`SELECT status FROM data_domain_cutovers WHERE domain=?`)
        .bind(domain).first<{ status?: string }>(),
    ])
    const completedTables = Number(completed?.count ?? 0)
    const parityTables = Number(parity?.count ?? 0)
    const pendingProjectionEvents = Number(pending?.count ?? 0)
    const blockers: string[] = []
    if (completedTables !== owned.length) blockers.push('initial_copy_incomplete')
    if (parityTables !== owned.length) blockers.push('full_table_parity_incomplete')
    if (pendingProjectionEvents > 0) blockers.push('projection_catchup_not_zero')
    if (!MULTI_D1_STRICT_ROUTING_READY) blockers.push('domain_access_router_not_closed')
    if (!['shadow', 'read_cutover', 'write_cutover', 'complete'].includes(String(cutover?.status ?? 'legacy'))) {
      blockers.push('shadow_state_not_ready')
    }
    results.push({
      domain,
      cutover_ready: blockers.length === 0,
      blockers,
      owned_tables: owned.length,
      completed_tables: completedTables,
      parity_tables: parityTables,
      pending_projection_events: pendingProjectionEvents,
      cutover_status: String(cutover?.status ?? 'legacy'),
      routing_contract_ready: MULTI_D1_STRICT_ROUTING_READY,
    })
  }
  return {
    schema_version: 'data-domain-cutover-readiness-v1',
    strict_enable_allowed: results.length === DOMAINS.length && results.every((item) => item.cutover_ready),
    domains: results,
  }
}
