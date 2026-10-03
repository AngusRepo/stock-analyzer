import type { Bindings } from '../types'
import { controllerFetch } from './controllerClient'

const MODEL = '@cf/mistralai/mistral-small-3.1-24b-instruct'

/** Controller owns the shared account budget; Worker owns evidence validation/cache. */
export async function callNewsLLM(
  env: { ML_CONTROLLER_URL?: string; ML_CONTROLLER_SECRET?: string },
  system: string, user: string, temperature = 0.2,
): Promise<{ text: string; source: string }> {
  if (!env.ML_CONTROLLER_URL || !env.ML_CONTROLLER_SECRET) throw new Error('news_controller_unconfigured')
  const response = await controllerFetch(env as Bindings, '/news/analyze', {
    method: 'POST', timeoutMs: 120_000,
    jsonBody: { system_prompt: system, user_prompt: user, temperature, model: MODEL },
  })
  if (!response.ok) {
    const error = await response.json().catch(() => null) as {detail?: unknown} | null
    const detail = typeof error?.detail === 'string' && /^workers_ai_debate_[a-z0-9_]+$/.test(error.detail)
      ? ':' + error.detail : ''
    throw new Error(`news_cloudflare_http_${response.status}${detail}`)
  }
  const result = await response.json() as { text?: unknown; source?: unknown }
  if (typeof result.text !== 'string' || !result.text.trim()
      || result.source !== `cloudflare_workers_ai:${MODEL}`) throw new Error('news_cloudflare_response_invalid')
  return { text: result.text, source: result.source }
}
