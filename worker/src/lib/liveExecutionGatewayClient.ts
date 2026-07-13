import type { AuthoritativeExecutionSnapshot } from './authoritativeExecutionSnapshot'
import type { StockVisionOrderIntent } from './stockvisionOrderIntent'
import type { TwOrderLotType } from './twMarketRules'

export interface LiveExecutionBrokerTruth {
  status: 'ready'
  observed_at: string
  exchange: 'TSE' | 'OTC'
  reference_price: number
  limit_up: number
  limit_down: number
  available_cash: number
  position_shares: number
}

export interface LiveExecutionPacket {
  schema_version: 'stockvision-live-execution-packet-v1'
  idempotency_key: string
  trade_date: string
  generated_at: string
  expires_at: string
  approval: { approved_by: 'Wei'; scope: string }
  controls: {
    risk_checks_passed: true
    kill_switch_active: false
    market_session_open: true
    trading_day_confirmed: true
    market_phase: 'continuous'
    broker_truth_ready: true
  }
  intent: StockVisionOrderIntent
  execution_snapshots: Partial<Record<TwOrderLotType, Record<string, unknown>>>
  broker_truth: LiveExecutionBrokerTruth
}

export interface LiveExecutionClientEnv {
  EXECUTION_GATEWAY_URL?: string
  EXECUTION_GATEWAY_SERVICE_TOKEN?: string
  LIVE_EXECUTION_HMAC_SECRET?: string
  LIVE_EXECUTION_CLIENT_ENABLED?: string
  LIVE_TRADING_APPROVAL_SCOPE?: string
}

function truthy(value: unknown): boolean {
  return ['1', 'true', 'yes', 'enabled'].includes(String(value ?? '').trim().toLowerCase())
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    )
  }
  return value
}

export function canonicalExecutionPacketJson(packet: LiveExecutionPacket): string {
  return JSON.stringify(canonicalValue(packet))
}

export async function signExecutionPacket(packet: LiveExecutionPacket, secret: string): Promise<string> {
  if (!secret.trim()) throw new Error('live_execution_hmac_secret_missing')
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonicalExecutionPacketJson(packet)))
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function normalizeSnapshot(snapshot: AuthoritativeExecutionSnapshot): Record<string, unknown> {
  return {
    schema_version: snapshot.schemaVersion,
    status: snapshot.status,
    reason: snapshot.reason,
    lot_type: snapshot.lotType,
    selected_source: snapshot.selectedSource,
    bid: snapshot.bid,
    ask: snapshot.ask,
    bid_volume: snapshot.bidVolume,
    ask_volume: snapshot.askVolume,
    age_ms: snapshot.ageMs,
    disagreement_ticks: snapshot.disagreementTicks,
    hard_mismatch: snapshot.hardMismatch,
  }
}

export function buildLiveExecutionPacket(input: {
  intent: StockVisionOrderIntent
  idempotencyKey: string
  approvalScope: string
  snapshots: Partial<Record<TwOrderLotType, AuthoritativeExecutionSnapshot>>
  brokerTruth: LiveExecutionBrokerTruth
  controls: {
    riskChecksPassed: boolean
    killSwitchActive: boolean
    marketSessionOpen: boolean
    tradingDayConfirmed: boolean
    marketPhase: string
  }
  generatedAt?: Date
  ttlMs?: number
}): LiveExecutionPacket {
  if (input.idempotencyKey.trim().length < 16) throw new Error('live_execution_idempotency_key_invalid')
  if (!input.approvalScope.trim()) throw new Error('live_execution_approval_scope_missing')
  if (!input.controls.riskChecksPassed) throw new Error('live_execution_risk_checks_not_passed')
  if (input.controls.killSwitchActive) throw new Error('live_execution_kill_switch_active')
  if (!input.controls.marketSessionOpen || input.controls.marketPhase !== 'continuous') {
    throw new Error('live_execution_market_session_not_continuous')
  }
  if (!input.controls.tradingDayConfirmed) throw new Error('live_execution_trading_day_not_confirmed')
  const generatedAt = input.generatedAt ?? new Date()
  const ttlMs = Math.max(500, Math.min(Number(input.ttlMs ?? 3000), 5000))
  const executionSnapshots: Partial<Record<TwOrderLotType, Record<string, unknown>>> = {}
  for (const leg of input.intent.orderLegs) {
    const snapshot = input.snapshots[leg.lotType]
    if (!snapshot) throw new Error(`live_execution_snapshot_missing:${leg.lotType}`)
    executionSnapshots[leg.lotType] = normalizeSnapshot(snapshot)
  }
  return {
    schema_version: 'stockvision-live-execution-packet-v1',
    idempotency_key: input.idempotencyKey.trim(),
    trade_date: input.intent.tradeDate,
    generated_at: generatedAt.toISOString(),
    expires_at: new Date(generatedAt.getTime() + ttlMs).toISOString(),
    approval: { approved_by: 'Wei', scope: input.approvalScope.trim() },
    controls: {
      risk_checks_passed: true,
      kill_switch_active: false,
      market_session_open: true,
      trading_day_confirmed: true,
      market_phase: 'continuous',
      broker_truth_ready: true,
    },
    intent: input.intent,
    execution_snapshots: executionSnapshots,
    broker_truth: input.brokerTruth,
  }
}

export async function submitSignedLiveExecutionPacket(
  env: LiveExecutionClientEnv,
  packet: LiveExecutionPacket,
  fetchFn: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  if (!truthy(env.LIVE_EXECUTION_CLIENT_ENABLED)) {
    return { status: 'blocked', reason: 'live_execution_client_disabled', live_submit_enabled: false }
  }
  const gatewayUrl = env.EXECUTION_GATEWAY_URL?.trim().replace(/\/$/, '')
  const serviceToken = env.EXECUTION_GATEWAY_SERVICE_TOKEN?.trim()
  const hmacSecret = env.LIVE_EXECUTION_HMAC_SECRET?.trim()
  if (!gatewayUrl || !serviceToken || !hmacSecret) {
    return { status: 'blocked', reason: 'live_execution_client_config_incomplete', live_submit_enabled: false }
  }
  if (packet.approval.scope !== env.LIVE_TRADING_APPROVAL_SCOPE?.trim()) {
    return { status: 'blocked', reason: 'live_execution_approval_scope_mismatch', live_submit_enabled: false }
  }
  const signature = await signExecutionPacket(packet, hmacSecret)
  try {
    const response = await fetchFn(`${gatewayUrl}/v1/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${serviceToken}`,
        'X-Execution-Signature': signature,
      },
      body: JSON.stringify({ packet, allow_live_submit: true }),
      signal: AbortSignal.timeout(5000),
    })
    const payload = await response.json() as Record<string, unknown>
    if (!response.ok) {
      return { status: 'error', reason: `execution_gateway_http_${response.status}`, payload, live_submit_enabled: false }
    }
    return payload
  } catch (error) {
    return {
      status: 'unknown',
      reason: 'execution_gateway_response_unknown_reconciliation_required',
      error_type: error instanceof Error ? error.name : 'Error',
      live_submit_enabled: true,
    }
  }
}

export async function fetchLiveExecutionIntentStatus(
  env: LiveExecutionClientEnv,
  idempotencyKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const gatewayUrl = env.EXECUTION_GATEWAY_URL?.trim().replace(/\/$/, '')
  const serviceToken = env.EXECUTION_GATEWAY_SERVICE_TOKEN?.trim()
  if (!gatewayUrl || !serviceToken || idempotencyKey.trim().length < 16) {
    return { status: 'blocked', reason: 'live_execution_status_config_incomplete' }
  }
  try {
    const response = await fetchFn(`${gatewayUrl}/v1/intents/${encodeURIComponent(idempotencyKey.trim())}`, {
      headers: { Authorization: `Bearer ${serviceToken}` },
      signal: AbortSignal.timeout(3000),
    })
    const payload = await response.json() as Record<string, unknown>
    return response.ok ? payload : { status: 'error', reason: `execution_status_http_${response.status}`, payload }
  } catch (error) {
    return {
      status: 'unknown',
      reason: 'execution_status_unavailable',
      error_type: error instanceof Error ? error.name : 'Error',
    }
  }
}
