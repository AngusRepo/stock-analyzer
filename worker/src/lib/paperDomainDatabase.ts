import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'

export type PaperDomainDatabaseEnv = Pick<Bindings, 'DB'> & Partial<Bindings>

export function paperDomainDatabase(env: PaperDomainDatabaseEnv): D1Database {
  return databaseForDataDomain(env, 'paper')
}
