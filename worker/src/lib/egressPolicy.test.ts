import assert from 'node:assert/strict'
import { assertDiscordWebhookUrl, assertGithubDownloadUrl, assertPublicServiceUrl } from './egressPolicy'

assert.throws(() => assertPublicServiceUrl('http://169.254.169.254/latest', { name: 'test' }))
assert.throws(() => assertPublicServiceUrl('https://metadata.google.internal/', { name: 'test' }))
assert.throws(() => assertPublicServiceUrl('https://user:secret@example.com/', { name: 'test' }))
assert.equal(
  assertPublicServiceUrl('https://service-abc.a.run.app', { name: 'test', originOnly: true }).hostname,
  'service-abc.a.run.app',
)
assert.equal(
  assertPublicServiceUrl('http://127.0.0.1:8080', { name: 'test', environment: 'test' }).port,
  '8080',
)
assert.throws(() => assertDiscordWebhookUrl('https://example.com/api/webhooks/1/token'))
assert.equal(assertDiscordWebhookUrl('https://discord.com/api/webhooks/1/token').hostname, 'discord.com')
assert.throws(() => assertGithubDownloadUrl('https://evil.example/report.md'))
assert.equal(
  assertGithubDownloadUrl('https://raw.githubusercontent.com/org/repo/main/report.md').hostname,
  'raw.githubusercontent.com',
)
