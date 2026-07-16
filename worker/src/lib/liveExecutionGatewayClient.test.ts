import assert from 'node:assert/strict'
import { resolveAuthoritativeBuyExecutionSnapshot, resolveAuthoritativeSellExecutionSnapshot } from './authoritativeExecutionSnapshot'
import { buildStockVisionOrderIntent } from './stockvisionOrderIntent'
import {
  buildLiveExecutionPacket,
  buildExecutionShadowPacket,
  canonicalExecutionPacketJson,
  fetchLiveExecutionIntentStatus,
  signExecutionPacket,
  submitSignedLiveExecutionPacket,
  submitOrReconcileSignedLiveExecutionPacket,
  submitSignedExecutionShadowPacket,
} from './liveExecutionGatewayClient'


const intent = buildStockVisionOrderIntent({
  accountId: 1,
  tradeDate: '2026-07-13',
  pending: { symbol: '4953', confidence: 0.9, risk_pct: 0.01 },
  limitPrice: 143,
  currentPrice: 143,
  budget: 143_000,
  shares: 1000,
  quote: { bestBid: 142.5, bestAsk: 143, source: 'shioaji_hub', quoteAgeMs: 100 },
  adaptivePolicy: { maxEntryChasePct: 0.003 },
})

const snapshot = resolveAuthoritativeBuyExecutionSnapshot({
  limitPrice: 143,
  lotType: 'board_lot',
  observations: [{
    source: 'shioaji_hub',
    lotType: 'board_lot',
    bid: 142.5,
    ask: 143,
    bidVolume: 10,
    askVolume: 5,
    ageMs: 100,
  }],
})

const packet = buildLiveExecutionPacket({
  intent,
  idempotencyKey: 'live-client-4953-buy-20260713-001',
  approvalScope: 'pilot-scope',
  snapshots: { board_lot: snapshot },
  brokerTruth: {
    status: 'ready',
    observed_at: '2026-07-13T01:01:00.000Z',
    exchange: 'TSE',
    reference_price: 143,
    limit_up: 157,
    limit_down: 129,
    available_cash: 1_000_000,
    position_shares: 0,
  },
  controls: {
    riskChecksPassed: true,
    killSwitchActive: false,
    marketSessionOpen: true,
    tradingDayConfirmed: true,
    marketPhase: 'continuous',
  },
  generatedAt: new Date('2026-07-13T01:01:00.000Z'),
  ttlMs: 3000,
})

async function main(): Promise<void> {
  assert.equal(packet.execution_snapshots.board_lot?.schema_version, 'authoritative_execution_snapshot_v2')
  assert.equal(packet.execution_snapshots.board_lot?.snapshot_id, snapshot.snapshotId)
  assert.equal(packet.controls.kill_switch_active, false)
  assert.equal(canonicalExecutionPacketJson(packet), canonicalExecutionPacketJson(packet), 'canonical packet JSON must be deterministic')
  const signature = await signExecutionPacket(packet, 'test-secret')
  assert.match(signature, /^[a-f0-9]{64}$/)
  assert.throws(() => buildLiveExecutionPacket({
    intent,
    idempotencyKey: 'live-client-kill-switch-block-001',
    approvalScope: 'pilot-scope',
    snapshots: { board_lot: snapshot },
    brokerTruth: packet.broker_truth,
    controls: { riskChecksPassed: true, killSwitchActive: true, marketSessionOpen: true, tradingDayConfirmed: true, marketPhase: 'continuous' },
  }), /live_execution_kill_switch_active/)

  let called = false
  const disabled = await submitSignedLiveExecutionPacket({}, packet, async () => {
    called = true
    return new Response('{}')
  })
  assert.equal(disabled.reason, 'live_execution_client_disabled')
  assert.equal(called, false)

  const guardDisabled = await submitSignedLiveExecutionPacket({ LIVE_EXECUTION_CLIENT_ENABLED: '1' }, packet, async () => {
    called = true
    return new Response('{}')
  })
  assert.equal(guardDisabled.reason, 'live_execution_submit_guard_disabled')

  let capturedHeaders = new Headers()
  let capturedBody: any = null
  let capturedLiveUrl = ''
  const submitted = await submitSignedLiveExecutionPacket({
    LIVE_EXECUTION_CLIENT_ENABLED: '1',
    LIVE_EXECUTION_SUBMIT_GUARD_ENABLED: '1',
    ML_CONTROLLER_URL: 'https://controller.invalid/',
    ML_CONTROLLER_SECRET: 'controller-token',
    LIVE_EXECUTION_HMAC_SECRET: 'test-secret',
    LIVE_TRADING_APPROVAL_SCOPE: 'pilot-scope',
  }, packet, async (input, init) => {
    capturedLiveUrl = String(input)
    capturedHeaders = new Headers(init?.headers)
    capturedBody = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({ status: 'submitted', intent_id: 'intent-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  assert.equal(capturedLiveUrl, 'https://controller.invalid/finlab/execution/live-submit')
  assert.equal(capturedHeaders.get('X-Controller-Token'), 'controller-token')
  assert.equal(capturedHeaders.get('X-Execution-Signature'), signature)
  assert.equal(capturedBody.packet.idempotency_key, packet.idempotency_key)
  assert.equal(capturedBody.allow_live_submit, true)
  assert.equal(submitted.status, 'submitted')

  let reconciliationCalls = 0
  const reconciled = await submitOrReconcileSignedLiveExecutionPacket({
    LIVE_EXECUTION_CLIENT_ENABLED: '1',
    LIVE_EXECUTION_SUBMIT_GUARD_ENABLED: '1',
    ML_CONTROLLER_URL: 'https://controller.invalid',
    ML_CONTROLLER_SECRET: 'controller-token',
    LIVE_EXECUTION_HMAC_SECRET: 'test-secret',
    LIVE_TRADING_APPROVAL_SCOPE: 'pilot-scope',
  }, packet, async (_input, init) => {
    reconciliationCalls += 1
    if (init?.method === 'POST') throw new DOMException('timeout', 'TimeoutError')
    return new Response(JSON.stringify({ status: 'ok', intent: { status: 'ACKNOWLEDGED' } }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  })
  assert.equal(reconciled.status, 'reconciliation_required')
  assert.equal(reconciliationCalls, 2, 'unknown submit must reconcile once and never resubmit')

  let serverErrorCalls = 0
  const reconciledServerError = await submitOrReconcileSignedLiveExecutionPacket({
    LIVE_EXECUTION_CLIENT_ENABLED: '1',
    LIVE_EXECUTION_SUBMIT_GUARD_ENABLED: '1',
    ML_CONTROLLER_URL: 'https://controller.invalid',
    ML_CONTROLLER_SECRET: 'controller-token',
    LIVE_EXECUTION_HMAC_SECRET: 'test-secret',
    LIVE_TRADING_APPROVAL_SCOPE: 'pilot-scope',
  }, packet, async (_input, init) => {
    serverErrorCalls += 1
    if (init?.method === 'POST') {
      return new Response(JSON.stringify({ detail: 'persistence unavailable' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ status: 'ok', intent: { status: 'UNKNOWN' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  assert.equal(reconciledServerError.status, 'reconciliation_required')
  assert.equal(serverErrorCalls, 2, 'non-2xx submit response must reconcile and never resubmit')

  const shadowPacket = buildExecutionShadowPacket({
    intent,
    idempotencyKey: 'shadow-client-4953-buy-20260713-001',
    shadowScope: 'paper-parity-v1',
    snapshots: { board_lot: snapshot },
    marketReference: { referencePrice: 143, limitUp: 157, limitDown: 129 },
    controls: {
      riskChecksPassed: true,
      killSwitchActive: false,
      marketSessionOpen: true,
      tradingDayConfirmed: true,
      marketPhase: 'continuous',
    },
    generatedAt: new Date('2026-07-13T01:01:00.000Z'),
  })
  let shadowUrl = ''
  let shadowHeaders = new Headers()
  const shadowResult = await submitSignedExecutionShadowPacket({
    LIVE_EXECUTION_SHADOW_CLIENT_ENABLED: '1',
    LIVE_EXECUTION_SHADOW_SCOPE: 'paper-parity-v1',
    LIVE_EXECUTION_HMAC_SECRET: 'test-secret',
    ML_CONTROLLER_URL: 'https://controller.invalid/',
    ML_CONTROLLER_SECRET: 'controller-token',
  }, shadowPacket, async (input, init) => {
    shadowUrl = String(input)
    shadowHeaders = new Headers(init?.headers)
    return new Response(JSON.stringify({ status: 'partial', reason: 'broker_truth_shadow_disabled' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  assert.equal(shadowUrl, 'https://controller.invalid/finlab/execution/shadow-relay')
  assert.equal(shadowHeaders.get('X-Controller-Token'), 'controller-token')
  assert.match(String(shadowHeaders.get('X-Execution-Signature')), /^[a-f0-9]{64}$/)
  assert.equal(shadowResult.status, 'partial')
  assert.equal(shadowResult.can_submit_real_order, false)

  let shadowCalled = false
  const shadowDisabled = await submitSignedExecutionShadowPacket({}, shadowPacket, async () => {
    shadowCalled = true
    return new Response('{}')
  })
  assert.equal(shadowDisabled.reason, 'execution_shadow_client_disabled')
  assert.equal(shadowCalled, false)

  const sellSnapshot = resolveAuthoritativeSellExecutionSnapshot({
    limitPrice: 142,
    lotType: 'board_lot',
    observations: [{ source: 'shioaji_hub', lotType: 'board_lot', bid: 142.5, ask: 143, ageMs: 100 }],
  })
  assert.equal(sellSnapshot.status, 'ready')
  const blockedSellSnapshot = resolveAuthoritativeSellExecutionSnapshot({
    limitPrice: 143,
    lotType: 'board_lot',
    observations: [{ source: 'shioaji_hub', lotType: 'board_lot', bid: 142.5, ask: 143, ageMs: 100 }],
  })
  assert.equal(blockedSellSnapshot.status, 'blocked')
  assert.match(blockedSellSnapshot.reason, /authoritative_bid_below_limit/)

  const lifecycle = await fetchLiveExecutionIntentStatus({
    ML_CONTROLLER_URL: 'https://controller.invalid',
    ML_CONTROLLER_SECRET: 'controller-token',
  }, packet.idempotency_key, async (input, init) => {
    assert.match(String(input), /\/finlab\/execution\/intents\/live-client-4953-buy-20260713-001$/)
    assert.equal(new Headers(init?.headers).get('X-Controller-Token'), 'controller-token')
    return new Response(JSON.stringify({ status: 'ok', legs: [{ status: 'ACKNOWLEDGED' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  assert.equal(lifecycle.status, 'ok')

  console.log('liveExecutionGatewayClient tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
