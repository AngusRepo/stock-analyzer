import type { Bindings } from '../types'
import { shadowDatabaseForDataDomain, tablesForDataDomainRouteReady, type DataDomain } from './dataDomainRegistry'

const DOMAIN_BASELINES: Partial<Record<DataDomain, string>> = {
  execution: '0001_execution_baseline.sql',
  paper: '0001_paper_baseline.sql',
}

export interface DomainSchemaReadiness {
  domain: 'execution' | 'paper'
  migration_catalog: 'domain_baseline'
  expected_migration: string
  applied_migrations: string[]
  pending_migrations: number
  expected_tables: number
  present_tables: number
  missing_tables: string[]
  ready: boolean
  error: string | null
}

async function inspectDomain(
  env: Pick<Bindings, 'DB'> & Partial<Bindings>,
  domain: 'execution' | 'paper',
): Promise<DomainSchemaReadiness> {
  const expectedMigration = DOMAIN_BASELINES[domain]!
  const expectedTables = tablesForDataDomainRouteReady(domain)
  const db = shadowDatabaseForDataDomain(env, domain)
  if (!db) {
    return {
      domain, migration_catalog: 'domain_baseline', expected_migration: expectedMigration,
      applied_migrations: [], pending_migrations: 1, expected_tables: expectedTables.length,
      present_tables: 0, missing_tables: expectedTables, ready: false,
      error: `data_domain_shadow_binding_missing:${domain}`,
    }
  }
  try {
    const [migrationResult, schemaResult] = await Promise.all([
      db.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{ name: string }>(),
      db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all<{ name: string }>(),
    ])
    const appliedMigrations = (migrationResult.results ?? []).map((row) => String(row.name))
    const presentSet = new Set((schemaResult.results ?? []).map((row) => String(row.name)))
    const missingTables = expectedTables.filter((table) => !presentSet.has(table))
    const pendingMigrations = appliedMigrations.includes(expectedMigration) ? 0 : 1
    return {
      domain, migration_catalog: 'domain_baseline', expected_migration: expectedMigration,
      applied_migrations: appliedMigrations, pending_migrations: pendingMigrations,
      expected_tables: expectedTables.length, present_tables: expectedTables.length - missingTables.length,
      missing_tables: missingTables,
      ready: pendingMigrations === 0 && missingTables.length === 0,
      error: null,
    }
  } catch (error) {
    return {
      domain, migration_catalog: 'domain_baseline', expected_migration: expectedMigration,
      applied_migrations: [], pending_migrations: 1, expected_tables: expectedTables.length,
      present_tables: 0, missing_tables: expectedTables, ready: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function inspectSplitDomainSchemaReadiness(
  env: Pick<Bindings, 'DB'> & Partial<Bindings>,
): Promise<DomainSchemaReadiness[]> {
  return Promise.all([inspectDomain(env, 'execution'), inspectDomain(env, 'paper')])
}
