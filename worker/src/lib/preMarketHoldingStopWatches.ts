import type { Bindings } from '../types'
import { syncHubStopWatchesAndBreaches, type HubStopWatch } from './paperExitIntent'
import { buildExitIntentKey, resolveEffectiveS12PositionStop } from './paperExitTasks'

const ACCOUNT_ID = 1
const PREMARKET_WATCH_TTL_SECONDS = 900

export type PreMarketHoldingStopWatchResult = {
  status: 'healthy_empty' | 'ok' | 'partial'
  positions: number
  watches: number
  registered: number
  recoveredBreaches: number
  missingStopSymbols: string[]
  errors: string[]
}

export async function prewarmHoldingStopWatches(env: Bindings): Promise<PreMarketHoldingStopWatchResult> {
  if (!env.SHIOAJI_PROXY_URL) {
    return {
      status: 'partial',
      positions: 0,
      watches: 0,
      registered: 0,
      recoveredBreaches: 0,
      missingStopSymbols: [],
      errors: ['missing_shioaji_proxy_url'],
    }
  }

  const loaded = await env.DB.prepare(`
    SELECT symbol, shares, avg_cost, entry_price, entry_date,
           initial_stop, trailing_stop, trade_lifecycle_json
      FROM paper_positions
     WHERE account_id=? AND shares>0
  `).bind(ACCOUNT_ID).all<Record<string, any>>()
  const positions = loaded.results ?? []
  if (positions.length === 0) {
    return {
      status: 'healthy_empty',
      positions: 0,
      watches: 0,
      registered: 0,
      recoveredBreaches: 0,
      missingStopSymbols: [],
      errors: [],
    }
  }

  const missingStopSymbols: string[] = []
  const watches = positions.map((position): HubStopWatch | null => {
    const stopPrice = resolveEffectiveS12PositionStop(position, position.entry_price ?? position.avg_cost)
    if (stopPrice == null) {
      missingStopSymbols.push(String(position.symbol))
      return null
    }
    return {
      intent_key: buildExitIntentKey({
        accountId: ACCOUNT_ID,
        symbol: String(position.symbol),
        entryDate: position.entry_date,
        shares: position.shares,
        stopVersion: stopPrice,
        action: 'full_sell',
      }),
      account_id: ACCOUNT_ID,
      symbol: String(position.symbol),
      entry_date: position.entry_date ?? null,
      requested_shares: Math.max(0, Math.floor(Number(position.shares ?? 0))),
      stop_price: stopPrice,
      stop_version: Number(stopPrice).toFixed(4),
    }
  }).filter((watch): watch is HubStopWatch => watch != null)

  const sync = await syncHubStopWatchesAndBreaches(
    env,
    watches,
    { ttlSeconds: PREMARKET_WATCH_TTL_SECONDS },
  )
  const errors = [...sync.errors]
  if (sync.registered !== watches.length) {
    errors.push(`registered_${sync.registered}_of_${watches.length}`)
  }
  if (missingStopSymbols.length > 0) {
    errors.push(`missing_stop_${missingStopSymbols.join('|')}`)
  }
  return {
    status: errors.length === 0 ? 'ok' : 'partial',
    positions: positions.length,
    watches: watches.length,
    registered: sync.registered,
    recoveredBreaches: sync.breaches,
    missingStopSymbols,
    errors,
  }
}
