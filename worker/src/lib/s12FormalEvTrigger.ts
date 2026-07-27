import type { Bindings } from '../types'

export interface S12FormalEvTriggerSummary {
  status: 'empty' | 'triggered' | 'running'
  ready_count: number
  observation_date: string
}

export async function triggerPendingS12FormalEv(
  env: Bindings,
  observationDate: string,
): Promise<S12FormalEvTriggerSummary> {
  const ready = await env.DB.prepare(`
    SELECT COUNT(*) AS ready_count
      FROM s12_structure_snapshots s
     WHERE s.trade_date=?
       AND s.source='s12_intraday_setup_watch'
       AND s.ready=1
       AND COALESCE(s.invalidated, 0)=0
       AND NOT EXISTS (
         SELECT 1 FROM s12_formal_ev_decisions d
          WHERE d.observation_date=s.trade_date
            AND d.symbol=s.symbol
            AND d.structure_snapshot_id=s.id
            AND datetime(d.updated_at) >= datetime(s.updated_at)
       )
  `).bind(observationDate).first<{ ready_count?: number }>()
  const readyCount = Number(ready?.ready_count ?? 0)
  if (readyCount <= 0) {
    return { status: 'empty', ready_count: 0, observation_date: observationDate }
  }
  if (!env.ML_CONTROLLER_URL || !env.ML_CONTROLLER_SECRET) {
    throw new Error('s12_formal_ev_controller_missing')
  }
  const response = await fetch(
    `${env.ML_CONTROLLER_URL.replace(/\/$/, '')}/s12-formal-ev/run`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Controller-Token': env.ML_CONTROLLER_SECRET,
      },
      body: JSON.stringify({
        observation_date: observationDate,
        producer_run_id: `s12-formal-ev:${observationDate}`,
      }),
      signal: AbortSignal.timeout(60_000),
    },
  )
  if (response.status === 409) {
    return { status: 'running', ready_count: readyCount, observation_date: observationDate }
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`s12_formal_ev_trigger_${response.status}:${detail.slice(0, 300)}`)
  }
  return { status: 'triggered', ready_count: readyCount, observation_date: observationDate }
}
