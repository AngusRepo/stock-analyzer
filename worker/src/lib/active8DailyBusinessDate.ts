import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import { twToday } from './dateUtils'

/** Post-midnight native L4 bookkeeping belongs to the original pipeline date. */
export async function resolveActive8DailyBusinessDate(
  env: Bindings, task: string, requestedDate?: string,
): Promise<string | undefined> {
  if (requestedDate || task !== 'active8-oof-daily') return requestedDate
  const config = await env.KV.get('trading:config', 'json') as { l4Distribution?: unknown } | null
  if (config?.l4Distribution == null) return undefined
  // Keep the latest failed pipeline visible; never fall back to an older success.
  const row = await databaseForDataDomain(env, 'ops').prepare(`
    SELECT business_date FROM pipeline_stage_runs
     WHERE stage='pipeline_execution' AND business_date<=?
     ORDER BY business_date DESC LIMIT 1
  `).bind(twToday()).first<{ business_date: string }>()
  if (!row || !/^\d{4}-\d{2}-\d{2}$/.test(row.business_date)) {
    throw new Error('active8_daily_pipeline_business_date_missing')
  }
  return row.business_date
}
