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

export interface ExecutionShadowPacket {
  schema_version: 'stockvision-execution-shadow-packet-v1'
  idempotency_key: string
  trade_date: string
  generated_at: string
  expires_at: string
  shadow_scope: string
  controls: {
    risk_checks_passed: true
    kill_switch_active: false
    market_session_open: true
    trading_day_confirmed: true
    market_phase: 'continuous'
  }
  intent: StockVisionOrderIntent
  execution_snapshots: Partial<Record<TwOrderLotType, Record<string, unknown>>>
  market_reference: {
    reference_price: number
    limit_up: number
    limit_down: number
  }
}

export interface LiveExecutionClientEnv {
  ML_CONTROLLER_URL?: string
  ML_CONTROLLER_SECRET?: string
  LIVE_EXECUTION_HMAC_SECRET?: string
  LIVE_EXECUTION_CLIENT_ENABLED?: string
  LIVE_EXECUTION_SUBMIT_GUARD_ENABLED?: string
  LIVE_TRADING_APPROVAL_SCOPE?: string
}

export interface ExecutionShadowClientEnv {
  ML_CONTROLLER_URL?: string
  ML_CONTROLLER_SECRET?: string
  LIVE_EXECUTION_HMAC_SECRET?: string
  LIVE_EXECUTION_SHADOW_CLIENT_ENABLED?: string
  LIVE_EXECUTION_SHADOW_SCOPE?: string
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

export function canonicalExecutionPacketJson(packet: LiveExecutionPacket | ExecutionShadowPacket): string {
  return JSON.stringify(canonicalValue(packet))
}

export async function signExecutionPacket(packet: LiveExecutionPacket | ExecutionShadowPacket, secret: string): Promise<string> {
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

export function buildExecutionShadowPacket(input: {
  intent: StockVisionOrderIntent
  idempotencyKey: string
  shadowScope: string
  snapshots: Partial<Record<TwOrderLotType, AuthoritativeExecutionSnapshot>>
  marketReference: { referencePrice: number; limitUp: number; limitDown: number }
  controls: {
    riskChecksPassed: boolean
    killSwitchActive: boolean
    marketSessionOpen: boolean
    tradingDayConfirmed: boolean
    marketPhase: string
  }
  generatedAt?: Date
  ttlMs?: number
}): ExecutionShadowPacket {
  if (input.idempotencyKey.trim().length < 16) throw new Error('execution_shadow_idempotency_key_invalid')
  if (!input.shadowScope.trim()) throw new Error('execution_shadow_scope_missing')
  if (!input.controls.riskChecksPassed) throw new Error('execution_shadow_risk_checks_not_passed')
  if (input.controls.killSwitchActive) throw new Error('execution_shadow_kill_switch_active')
  if (!input.controls.marketSessionOpen || input.controls.marketPhase !== 'continuous') {
    throw new Error('execution_shadow_market_session_not_continuous')
  }
  if (!input.controls.tradingDayConfirmed) throw new Error('execution_shadow_trading_day_not_confirmed')
  const reference = input.marketReference
  if (![reference.referencePrice, reference.limitUp, reference.limitDown].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error('execution_shadow_market_reference_invalid')
  }
  const generatedAt = input.generatedAt ?? new Date()
  const ttlMs = Math.max(500, Math.min(Number(input.ttlMs ?? 3000), 5000))
  const executionSnapshots: Partial<Record<TwOrderLotType, Record<string, unknown>>> = {}
  for (const leg of input.intent.orderLegs) {
    const snapshot = input.snapshots[leg.lotType]
    if (!snapshot) throw new Error(`execution_shadow_snapshot_missing:${leg.lotType}`)
    executionSnapshots[leg.lotType] = normalizeSnapshot(snapshot)
  }
  return {
    schema_version: 'stockvision-execution-shadow-packet-v1',
    idempotency_key: input.idempotencyKey.trim(),
    trade_date: input.intent.tradeDate,
    generated_at: generatedAt.toISOString(),
    expires_at: new Date(generatedAt.getTime() + ttlMs).toISOString(),
    shadow_scope: input.shadowScope.trim(),
    controls: {
      risk_checks_passed: true,
      kill_switch_active: false,
      market_session_open: true,
      trading_day_confirmed: true,
      market_phase: 'continuous',
    },
    intent: input.intent,
    execution_snapshots: executionSnapshots,
    market_reference: {
      reference_price: reference.referencePrice,
      limit_up: reference.limitUp,
      limit_down: reference.limitDown,
    },
  }
}

export async function submitSignedExecutionShadowPacket(
  env: ExecutionShadowClientEnv,
  packet: ExecutionShadowPacket,
  fetchFn: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  if (!truthy(env.LIVE_EXECUTION_SHADOW_CLIENT_ENABLED)) {
    return { status: 'blocked', reason: 'execution_shadow_client_disabled', can_submit_real_order: false, live_submit_enabled: false }
  }
  const controllerUrl = env.ML_CONTROLLER_URL?.trim().replace(/\/$/, '')
  const controllerToken = env.ML_CONTROLLER_SECRET?.trim()
  const hmacSecret = env.LIVE_EXECUTION_HMAC_SECRET?.trim()
  if (!controllerUrl || !controllerToken || !hmacSecret) {
    return { status: 'blocked', reason: 'execution_shadow_client_config_incomplete', can_submit_real_order: false, live_submit_enabled: false }
  }
  if (packet.shadow_scope !== env.LIVE_EXECUTION_SHADOW_SCOPE?.trim()) {
    return { status: 'blocked', reason: 'execution_shadow_scope_mismatch', can_submit_real_order: false, live_submit_enabled: false }
  }
  const signature = await signExecutionPacket(packet, hmacSecret)
  try {
    const response = await fetchFn(`${controllerUrl}/finlab/execution/shadow-relay`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Controller-Token': controllerToken,
        'X-Execution-Signature': signature,
      },
      body: JSON.stringify({ packet }),
      signal: AbortSignal.timeout(4500),
    })
    const payload = await response.json() as Record<string, unknown>
    if (!response.ok) {
      return { status: 'error', reason: `execution_shadow_relay_http_${response.status}`, payload, can_submit_real_order: false, live_submit_enabled: false }
    }
    return { ...payload, can_submit_real_order: false, live_submit_enabled: false }
  } catch (error) {
    return {
      status: 'unknown',
      reason: 'execution_shadow_response_unknown',
      error_type: error instanceof Error ? error.name : 'Error',
      can_submit_real_order: false,
      live_submit_enabled: false,
    }
  }
}

function normalizeSnapshot(snapshot: AuthoritativeExecutionSnapshot): Record<string, unknown> {
  if (snapshot.status !== 'ready' || snapshot.hardMismatch) {
    throw new Error(`execution_snapshot_not_ready:${snapshot.reason}`)
  }
  if (snapshot.ageMs == null || snapshot.ageMs > snapshot.maxAgeMs) {
    throw new Error('execution_snapshot_stale')
  }
  return {
    schema_version: snapshot.schemaVersion,
    snapshot_id: snapshot.snapshotId,
    created_at: snapshot.createdAt,
    side: snapshot.side,
    status: snapshot.status,
    reason: snapshot.reason,
    lot_type: snapshot.lotType,
    normalized_limit_price: snapshot.normalizedLimitPrice,
    tick_size: snapshot.tickSize,
    max_age_ms: snapshot.maxAgeMs,
    selected_source: snapshot.selectedSource,
    selected_source_time: snapshot.selectedSourceTime,
    selected_received_at: snapshot.selectedReceivedAt,
    session_epoch: snapshot.sessionEpoch,
    source_agreement: snapshot.sourceAgreement,
    bid: snapshot.bid,
    ask: snapshot.ask,
    bid_volume: snapshot.bidVolume,
    ask_volume: snapshot.askVolume,
    age_ms: snapshot.ageMs,
    disagreement_ticks: snapshot.disagreementTicks,
    hard_mismatch: snapshot.hardMismatch,
    observations: snapshot.observations,
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
  if (!truthy(env.LIVE_EXECUTION_SUBMIT_GUARD_ENABLED)) {
    return { status: 'blocked', reason: 'live_execution_submit_guard_disabled', live_submit_enabled: false }
  }
  const controllerUrl = env.ML_CONTROLLER_URL?.trim().replace(/\/$/, '')
  const controllerToken = env.ML_CONTROLLER_SECRET?.trim()
  const hmacSecret = env.LIVE_EXECUTION_HMAC_SECRET?.trim()
  if (!controllerUrl || !controllerToken || !hmacSecret) {
    return { status: 'blocked', reason: 'live_execution_client_config_incomplete', live_submit_enabled: false }
  }
  if (packet.approval.scope !== env.LIVE_TRADING_APPROVAL_SCOPE?.trim()) {
    return { status: 'blocked', reason: 'live_execution_approval_scope_mismatch', live_submit_enabled: false }
  }
  const signature = await signExecutionPacket(packet, hmacSecret)
  try {
    const response = await fetchFn(`${controllerUrl}/finlab/execution/live-submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Controller-Token': controllerToken,
        'X-Execution-Signature': signature,
      },
      body: JSON.stringify({ packet, allow_live_submit: true }),
      signal: AbortSignal.timeout(5000),
    })
    const payload = await response.json() as Record<string, unknown>
    if (!response.ok) {
      return {
        status: 'unknown',
        reason: `execution_gateway_http_${response.status}_reconciliation_required`,
        payload,
        live_submit_enabled: true,
      }
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

export async function submitOrReconcileSignedLiveExecutionPacket(
  env: LiveExecutionClientEnv,
  packet: LiveExecutionPacket,
  fetchFn: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const submitted = await submitSignedLiveExecutionPacket(env, packet, fetchFn)
  if (String(submitted.status ?? '').toLowerCase() !== 'unknown') return submitted
  const lifecycle = await fetchLiveExecutionIntentStatus(env, packet.idempotency_key, fetchFn)
  return {
    status: 'reconciliation_required',
    reason: 'submit_response_unknown_no_automatic_resubmit',
    submission: submitted,
    lifecycle,
    live_submit_enabled: true,
  }
}

export async function fetchLiveExecutionIntentStatus(
  env: LiveExecutionClientEnv,
  idempotencyKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const controllerUrl = env.ML_CONTROLLER_URL?.trim().replace(/\/$/, '')
  const controllerToken = env.ML_CONTROLLER_SECRET?.trim()
  if (!controllerUrl || !controllerToken || idempotencyKey.trim().length < 16) {
    return { status: 'blocked', reason: 'live_execution_status_config_incomplete' }
  }
  try {
    const response = await fetchFn(`${controllerUrl}/finlab/execution/intents/${encodeURIComponent(idempotencyKey.trim())}`, {
      headers: { 'X-Controller-Token': controllerToken },
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
