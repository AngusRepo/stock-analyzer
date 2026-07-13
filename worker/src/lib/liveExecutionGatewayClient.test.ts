import assert from 'node:assert/strict'
import { resolveAuthoritativeBuyExecutionSnapshot } from './authoritativeExecutionSnapshot'
import { buildStockVisionOrderIntent } from './stockvisionOrderIntent'
import {
  buildLiveExecutionPacket,
  canonicalExecutionPacketJson,
  fetchLiveExecutionIntentStatus,
  signExecutionPacket,
  submitSignedLiveExecutionPacket,
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
  assert.equal(packet.execution_snapshots.board_lot?.schema_version, 'authoritative_execution_snapshot_v1')
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

  let capturedHeaders = new Headers()
  let capturedBody: any = null
  const submitted = await submitSignedLiveExecutionPacket({
    LIVE_EXECUTION_CLIENT_ENABLED: '1',
    EXECUTION_GATEWAY_URL: 'https://gateway.invalid/',
    EXECUTION_GATEWAY_SERVICE_TOKEN: 'service-token',
    LIVE_EXECUTION_HMAC_SECRET: 'test-secret',
    LIVE_TRADING_APPROVAL_SCOPE: 'pilot-scope',
  }, packet, async (_input, init) => {
    capturedHeaders = new Headers(init?.headers)
    capturedBody = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({ status: 'submitted', intent_id: 'intent-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  assert.equal(capturedHeaders.get('Authorization'), 'Bearer service-token')
  assert.equal(capturedHeaders.get('X-Execution-Signature'), signature)
  assert.equal(capturedBody.packet.idempotency_key, packet.idempotency_key)
  assert.equal(capturedBody.allow_live_submit, true)
  assert.equal(submitted.status, 'submitted')

  const lifecycle = await fetchLiveExecutionIntentStatus({
    EXECUTION_GATEWAY_URL: 'https://gateway.invalid',
    EXECUTION_GATEWAY_SERVICE_TOKEN: 'service-token',
  }, packet.idempotency_key, async (input, init) => {
    assert.match(String(input), /\/v1\/intents\/live-client-4953-buy-20260713-001$/)
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer service-token')
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
