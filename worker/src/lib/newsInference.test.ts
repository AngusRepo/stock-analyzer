import assert from 'node:assert/strict'
import test from 'node:test'
import { callNewsLLM } from './newsInference'

test('news adapter sends original evidence to authenticated Cloudflare route', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://controller.invalid/news/analyze')
    assert.equal((init?.headers as Record<string, string>)['X-Controller-Token'], 'fixture')
    const body = JSON.parse(String(init?.body))
    assert.equal(body.user_prompt, 'original article excerpt')
    assert.equal(body.model, '@cf/mistralai/mistral-small-3.1-24b-instruct')
    return Response.json({ text: '{}', source: 'cloudflare_workers_ai:' + body.model })
  }
  try {
    assert.equal((await callNewsLLM({ ML_CONTROLLER_URL: 'https://controller.invalid', ML_CONTROLLER_SECRET: 'fixture' },
      'rules', 'original article excerpt')).text, '{}')
  } finally { globalThis.fetch = original }
})

test('news adapter preserves quota cause and rejects missing configuration or wrong source', async () => {
  const original = globalThis.fetch
  let calls = 0
  const env = { ML_CONTROLLER_URL: 'https://controller.invalid', ML_CONTROLLER_SECRET: 'fixture' }
  globalThis.fetch = async () => { calls++; return Response.json({ detail: 'workers_ai_debate_daily_safe_budget_exhausted' }, { status: 503 }) }
  try {
    await assert.rejects(callNewsLLM({}, 's', 'u'), /news_controller_unconfigured/)
    assert.equal(calls, 0)
    await assert.rejects(callNewsLLM(env, 's', 'u'), /daily_safe_budget_exhausted/)
    assert.equal(calls, 1)
    globalThis.fetch = async () => Response.json({text: '{}', source: 'unapproved-provider'})
    await assert.rejects(callNewsLLM(env, 's', 'u'), /news_cloudflare_response_invalid/)
  } finally { globalThis.fetch = original }
})
