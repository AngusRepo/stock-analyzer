import assert from 'node:assert/strict'
import { sendDiscordEmbeds, sendDiscordNotification } from './notify'

async function run(): Promise<void> {
  let calls = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    calls += 1
    return new Response(null, { status: 204 })
  }) as typeof fetch

  try {
    await sendDiscordNotification('http://169.254.169.254/latest/meta-data', 'blocked')
    await sendDiscordEmbeds('https://example.com/api/webhooks/not-discord', [{ title: 'blocked' }])
    assert.equal(calls, 0, 'invalid webhook targets must be rejected before fetch')

    await sendDiscordNotification('https://discord.com/api/webhooks/1/token', 'allowed')
    assert.equal(calls, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
