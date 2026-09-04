import type { Bindings } from '../types'
import type { AuthoritativeExecutionSnapshot } from './authoritativeExecutionSnapshot'
import {
  buildExecutionShadowPacket,
  submitSignedExecutionShadowPacket,
  type ExecutionShadowClientEnv,
} from './liveExecutionGatewayClient'
import { recordPaperExecutionEvent } from './paperExecutionEvents'
import { getRiskConfig } from './riskConfig'
import type { StockVisionOrderIntent } from './stockvisionOrderIntent'
import type { TwOrderLotType } from './twMarketRules'
import { validateOrder } from './validateOrder'

export interface ExecutionShadowEnv extends Pick<Bindings, 'DB' | 'KV'>, ExecutionShadowClientEnv {
  LIVE_EXECUTION_SHADOW_GUARD_ENABLED?: string
}

function truthy(value: unknown): boolean {
  return ['1', 'true', 'yes', 'enabled', 'on'].includes(String(value ?? '').trim().toLowerCase())
}

function idempotencyKey(intent: StockVisionOrderIntent): string {
  const strategy = intent.strategyType.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 32)
  return `shadow:${intent.tradeDate}:${intent.symbol}:${intent.side}:${strategy}:${intent.requestedShares}:${intent.limitPrice}`.slice(0, 200)
}

export async function runLiveExecutionShadow(input: {
  env: ExecutionShadowEnv
  intent: StockVisionOrderIntent
  snapshots: Partial<Record<TwOrderLotType, AuthoritativeExecutionSnapshot>>
  referencePrice: number
  limitUp: number
  limitDown: number
  marketSessionOpen: boolean
  tradingDayConfirmed: boolean
  marketPhase: string
  avgVolume20d?: number | null
  pendingRunId?: number | null
  source: string
  fetchFn?: typeof fetch
}): Promise<{ result: Record<string, unknown>; guardBlocked: boolean }> {
  if (!truthy(input.env.LIVE_EXECUTION_SHADOW_CLIENT_ENABLED)) {
    return {
      result: { status: 'blocked', reason: 'execution_shadow_client_disabled', can_submit_real_order: false },
      guardBlocked: false,
    }
  }
  const riskConfig = await getRiskConfig(input.env.KV)
  const killSwitchActive = riskConfig.system.killSwitch !== false
  const validation = await validateOrder({
    symbol: input.intent.symbol,
    side: input.intent.side,
    shares: input.intent.requestedShares,
    limitPrice: input.intent.limitPrice,
    refClose: input.referencePrice,
    avgVolume20d: input.avgVolume20d ?? null,
    sizingAuthorization: input.intent.riskContext.sizingAuthorization,
  }, riskConfig)
  const riskChecksPassed = validation.approved && validation.adjustedOrder == null
  let result: Record<string, unknown>
  try {
    const packet = buildExecutionShadowPacket({
      intent: input.intent,
      idempotencyKey: idempotencyKey(input.intent),
      shadowScope: String(input.env.LIVE_EXECUTION_SHADOW_SCOPE ?? ''),
      snapshots: input.snapshots,
      marketReference: {
        referencePrice: input.referencePrice,
        limitUp: input.limitUp,
        limitDown: input.limitDown,
      },
      controls: {
        riskChecksPassed,
        killSwitchActive,
        marketSessionOpen: input.marketSessionOpen,
        tradingDayConfirmed: input.tradingDayConfirmed,
        marketPhase: input.marketPhase,
      },
    })
    result = await submitSignedExecutionShadowPacket(input.env, packet, input.fetchFn ?? fetch)
  } catch (error) {
    result = {
      status: 'blocked',
      reason: error instanceof Error ? error.message : 'execution_shadow_packet_build_failed',
      can_submit_real_order: false,
      live_submit_enabled: false,
    }
  }
  const status = String(result.status ?? 'unknown')
  const reason = String(result.reason ?? 'execution_shadow_unknown')
  await recordPaperExecutionEvent(input.env, {
    tradeDate: input.intent.tradeDate,
    symbol: input.intent.symbol,
    side: input.intent.side,
    eventType: 'live_execution_shadow',
    status,
    reason,
    detail: {
      source: input.source,
      order_intent: input.intent,
      order_validation: validation,
      shadow_result: result,
      can_submit_real_order: false,
      live_submit_enabled: false,
    },
    pendingRunId: input.pendingRunId ?? null,
    source: input.source,
  })
  return {
    result,
    guardBlocked: truthy(input.env.LIVE_EXECUTION_SHADOW_GUARD_ENABLED) && !['pass', 'partial'].includes(status),
  }
}
