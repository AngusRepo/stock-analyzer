import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import { writeSystemLog } from './notify'

// NEW-47 / W0-4: any change to a champion pointer or the ensemble pointer is reported once,
// after the close, whoever made it. Seven days of lookback cover weekends and holidays; the
// message itself is the dedupe key, so a change seen on several runs is logged once.
const SOURCE = 'pointer-change'
const LOOKBACK = '-7 days'

type Change = { pointer: string; artifact_id: string | null; version: string | null; promoted_at: string; reason: string | null }

export async function alertPointerChanges(env: Bindings): Promise<{ changes: number; logged: number }> {
  const learning = databaseForDataDomain(env, 'learning')
  const champions = await learning.prepare(`
    SELECT 'champion:' || model_name AS pointer, champion_artifact_id AS artifact_id, champion_version AS version,
           promoted_at, promotion_reason AS reason
      FROM model_champion_pointers
     WHERE promoted_at >= datetime('now', ?) OR updated_at >= datetime('now', ?)`).bind(LOOKBACK, LOOKBACK).all<Change>()
  const ensemble = await learning.prepare(`
    SELECT 'ensemble' AS pointer, artifact_id, payload_checksum AS version, promoted_at, promotion_reason AS reason
      FROM active8_ensemble_pointer_v1
     WHERE singleton_id = 1 AND promoted_at >= datetime('now', ?)`).bind(LOOKBACK).all<Change>()
  const changes = [...(champions.results ?? []), ...(ensemble.results ?? [])]
  const ops = databaseForDataDomain(env, 'ops')
  let logged = 0
  for (const change of changes) {
    const message = `pointer changed: ${change.pointer} -> ${change.artifact_id ?? 'null'} (${change.version ?? 'null'}) at ${change.promoted_at}`
    const seen = await ops.prepare('SELECT 1 AS seen FROM system_logs WHERE cron_name = ? AND message = ? LIMIT 1')
      .bind(SOURCE, message).first<{ seen: number }>()
    if (seen) continue
    console.warn('[PointerChange] ' + message)
    await writeSystemLog(ops, 'warn', SOURCE, message, change)
    logged += 1
  }
  return { changes: changes.length, logged }
}
