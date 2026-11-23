import type { Bindings } from '../types'
import { paperExecutionNow } from './paperExecutionScope'

// The legacy stockvision-db is a frozen rollback source. This module is the
// only runtime file allowed to read `env.DB` (legacyDatabaseRetirement test).
// Everything else asks for one of three explicit roles:
//   - the cutover control plane (its location is DATA_DOMAIN_CONTROL_PLANE);
//   - the legacy source for migration-era tools, which fail closed once the
//     control plane moved to Ops or the binding is gone;
//   - an optional legacy capacity probe that reports nothing when unbound.

export type DataDomainControlPlaneLocation = 'legacy' | 'ops'

type LegacyEnv = Partial<Pick<Bindings, 'DB' | 'OPS_DB' | 'DATA_DOMAIN_CONTROL_PLANE'>>

export function dataDomainControlPlaneLocation(env: LegacyEnv): DataDomainControlPlaneLocation {
  const raw = String(env.DATA_DOMAIN_CONTROL_PLANE ?? '').trim().toLowerCase()
  if (!raw || raw === 'legacy') return 'legacy'
  if (raw === 'ops') return 'ops'
  throw new Error(`data_domain_control_plane_invalid:${raw}`)
}

export function legacyDatabaseBound(env: LegacyEnv): boolean {
  return Boolean(env.DB)
}

/** The legacy binding when it is still bound, otherwise null (capacity probes only). */
export function optionalLegacyDatabase(env: LegacyEnv): D1Database | null {
  return env.DB ?? null
}

export function requireLegacyDatabase(env: LegacyEnv, purpose: string): D1Database {
  if (!env.DB) throw new Error(`legacy_db_binding_retired:${purpose}`)
  return env.DB
}

/**
 * Database holding the cutover control plane (data_domain_* and
 * domain_projection_* tables). Never falls back silently: 'legacy' without the
 * binding throws, so a missing var cannot read the stale Ops mirror.
 */
export function dataDomainControlPlaneDatabase(env: LegacyEnv): D1Database {
  if (dataDomainControlPlaneLocation(env) === 'ops') {
    if (!env.OPS_DB) throw new Error('data_domain_control_plane_ops_binding_missing')
    return env.OPS_DB
  }
  return requireLegacyDatabase(env, 'data_domain_control_plane')
}

const CUTOVER_DOMAINS = ['core', 'market', 'learning', 'ops', 'execution', 'paper', 'research'] as const
const VERIFIED_TTL_MS = 300_000
const verifiedOpsControlPlanes = new WeakMap<D1Database, number>()

/**
 * The control plane for runtime readers. On 'ops' it is accepted only when the
 * Ops copy carries the cutover state the legacy copy holds: all seven domains
 * complete with a cutover writer epoch, and the per-table epoch and parity
 * receipts present. The pre-copy Ops mirror has none of that, so reading it
 * would make storage-health treat legacy as a live source again (full-table
 * EXISTS scans) and readiness checks report a stale cutover; it fails closed.
 */
export async function verifiedDataDomainControlPlaneDatabase(env: LegacyEnv, nowMs = paperExecutionNow()): Promise<D1Database> {
  const db = dataDomainControlPlaneDatabase(env)
  if (dataDomainControlPlaneLocation(env) !== 'ops') return db
  const verifiedAt = verifiedOpsControlPlanes.get(db)
  if (verifiedAt != null && nowMs - verifiedAt < VERIFIED_TTL_MS) return db
  const placeholders = CUTOVER_DOMAINS.map(() => '?').join(',')
  const row = await db.prepare(`
    SELECT
      (SELECT COUNT(DISTINCT c.domain) FROM data_domain_cutovers c
         JOIN data_domain_writer_epochs w ON w.domain=c.domain
        WHERE c.domain IN (${placeholders}) AND c.status='complete' AND w.writer_state='cutover') AS complete_domains,
      (SELECT COUNT(DISTINCT domain) FROM data_domain_table_writer_epochs WHERE domain IN (${placeholders})) AS epoch_domains,
      (SELECT COUNT(DISTINCT domain) FROM data_domain_parity_checks WHERE domain IN (${placeholders})) AS parity_domains
  `).bind(...CUTOVER_DOMAINS, ...CUTOVER_DOMAINS, ...CUTOVER_DOMAINS)
    .first<{ complete_domains?: number; epoch_domains?: number; parity_domains?: number }>()
  const complete = Number(row?.complete_domains ?? 0)
  const epochs = Number(row?.epoch_domains ?? 0)
  const parity = Number(row?.parity_domains ?? 0)
  if (complete !== CUTOVER_DOMAINS.length || epochs === 0 || parity === 0) {
    throw new Error(`data_domain_control_plane_ops_unverified:complete=${complete}:epoch_domains=${epochs}:parity_domains=${parity}`)
  }
  verifiedOpsControlPlanes.set(db, nowMs)
  return db
}

/**
 * True once all seven domains completed their cutover. The legacy DB is then a
 * frozen rollback source: it receives no writes, so scans of it only re-read
 * the same rows. Storage-health and retention archive-only skip it on this.
 */
export async function legacyDatabaseFrozen(env: LegacyEnv): Promise<boolean> {
  const row = await (await verifiedDataDomainControlPlaneDatabase(env)).prepare(`
    SELECT COUNT(DISTINCT c.domain) AS frozen_domains
      FROM data_domain_cutovers c
      JOIN data_domain_writer_epochs w ON w.domain=c.domain
     WHERE c.domain IN ('core','market','learning','ops','execution','paper','research')
       AND c.status='complete'
       AND w.writer_state='cutover'
  `).first<{ frozen_domains?: number }>()
  return Number(row?.frozen_domains ?? 0) === CUTOVER_DOMAINS.length
}

/**
 * Migration-era shadow/cutover machinery reads the legacy source and writes
 * the control plane in the same database. Once the control plane moved to Ops
 * that co-location is gone, so these tools are retired instead of half-routed.
 */
export function requireLegacyShadowSource(env: LegacyEnv, purpose: string): D1Database {
  if (dataDomainControlPlaneLocation(env) !== 'legacy') {
    throw new Error(`legacy_shadow_machinery_retired:${purpose}:control_plane_ops`)
  }
  return requireLegacyDatabase(env, purpose)
}
