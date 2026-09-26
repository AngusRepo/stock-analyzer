import { Hono } from 'hono'
import { requireAdminOrServiceToken } from '../lib/auth'
import { controllerFetch } from '../lib/controllerClient'
import type { Bindings, Variables } from '../types'

export const researchValidationRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

for (const resource of ['runs', 'run', 'bundle', 'production_bundle'] as const) {
  researchValidationRoutes.get(`/api/admin/research-validation/${resource}`, async (c) => {
    const authError = await requireAdminOrServiceToken(c)
    if (authError) return authError
    const runKey = c.req.query('run_key')
    if (!['runs', 'production_bundle'].includes(resource) && (!runKey || runKey.length > 240)) {
      return c.json({ error: 'run_key_required' }, 400)
    }
    const path = `/research_validation/${resource}${runKey ? `?run_key=${encodeURIComponent(runKey)}` : ''}`
    try {
      const response = await controllerFetch(c.env, path, { timeoutMs: 120_000 })
      return new Response(response.body, {
        status: response.status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      })
    } catch {
      return c.json({ error: 'research_validation_unavailable' }, 503)
    }
  })
}

researchValidationRoutes.post('/api/admin/research-validation/causal', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError
  const body = await c.req.json().catch(() => null)
  if (!body) return c.json({ error: 'invalid_body' }, 400)
  try {
    const response = await controllerFetch(c.env, '/research_validation/causal', {
      method: 'POST', jsonBody: body, timeoutMs: 300_000,
    })
    return new Response(response.body, {
      status: response.status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    })
  } catch {
    return c.json({ error: 'causal_audit_unavailable' }, 503)
  }
})
