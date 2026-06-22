import { strict as assert } from 'node:assert'
import { runPreMarketWarmup } from './cronOrchestrator'

async function withMockedFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  fn: () => Promise<void>,
) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = handler as typeof fetch
  try {
    await fn()
  } finally {
    globalThis.fetch = originalFetch
  }
}

void (async () => {
  await withMockedFetch(async (input, init) => {
    const url = String(input)
    if (url.endsWith('/warmup')) {
      assert.equal(new Headers(init?.headers).get('X-Controller-Token'), 'secret')
      return new Response(JSON.stringify({
        targets: {
          predict_batch_v2: { status: 'ok' },
          strategy_similarity_evidence: { status: 'ok' },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    throw new Error(`unexpected fetch ${url}`)
  }, async () => {
    const summary = await runPreMarketWarmup({
      ML_CONTROLLER_URL: 'https://controller.example',
      ML_CONTROLLER_SECRET: 'secret',
    } as any)

    assert.match(summary, /ML-Controller:ok warmup=ok/)
    assert(!summary.startsWith('ERROR:'), 'successful controller warmup must not trip control-plane drift')
  })

  await withMockedFetch(async (input) => {
    const url = String(input)
    if (url.endsWith('/warmup')) {
      throw new Error('The operation was aborted due to timeout')
    }
    if (url.endsWith('/health')) {
      return new Response(JSON.stringify({
        pipelineJobConfigured: true,
        verifyJobConfigured: true,
        callbackConfigured: true,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    throw new Error(`unexpected fetch ${url}`)
  }, async () => {
    const summary = await runPreMarketWarmup({
      ML_CONTROLLER_URL: 'https://controller.example',
      ML_CONTROLLER_SECRET: 'secret',
    } as any)

    assert.match(summary, /ML-Controller:ok health_fallback/)
    assert.match(summary, /warmup_error=The operation was aborted due to timeout/)
    assert(!summary.startsWith('ERROR:'), 'health fallback should prevent cold-start timeout from becoming a hard failure')
  })

  await withMockedFetch(async (input) => {
    const url = String(input)
    if (url.endsWith('/warmup')) {
      return new Response(JSON.stringify({
        targets: {
          predict_batch_v2: { status: 'ok' },
          strategy_similarity_evidence: { status: 'degraded' },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    throw new Error(`unexpected fetch ${url}`)
  }, async () => {
    const summary = await runPreMarketWarmup({
      ML_CONTROLLER_URL: 'https://controller.example',
      ML_CONTROLLER_SECRET: 'secret',
    } as any)

    assert.match(summary, /ERROR: control-plane drift/)
    assert.match(summary, /ML-Controller:fail\(warmup degraded/)
  })
})()
