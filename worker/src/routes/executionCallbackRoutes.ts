import { Hono } from 'hono'
import type { Bindings, Variables } from '../types'
import { persistPaperStopBreach } from '../lib/paperExitIntent'

export const executionCallbackRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

executionCallbackRoutes.post('/internal/execution/stop-breach', async (c) => {
  const configured = String(c.env.PROXY_SERVICE_TOKEN ?? '')
  const provided = String(c.req.header('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!configured || provided !== configured) {
    return c.json({ status: 'unauthorized' }, 401)
  }
  let payload: unknown
  try {
    payload = await c.req.json()
  } catch {
    return c.json({ status: 'invalid_json' }, 400)
  }
  try {
    const result = await persistPaperStopBreach(c.env, payload)
    return c.json({
      status: result.inserted ? 'latched' : 'duplicate',
      intent_key: result.intent.intent_key,
      symbol: result.intent.symbol,
    }, result.inserted ? 202 : 200)
  } catch (error) {
    return c.json({
      status: 'invalid_payload',
      error: error instanceof Error ? error.message : String(error),
    }, 400)
  }
})
