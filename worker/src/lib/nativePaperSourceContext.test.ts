import assert from 'node:assert/strict'
import test from 'node:test'
import { captureNativePaperSourceContext } from './nativePaperSourceContext'

test('native context preserves actual flags while credentials and unrelated account data cannot escape', async () => {
  const result = await captureNativePaperSourceContext({
    KV: { get: async (key: string) => key.endsWith('debate_max_rounds') ? '3' : '{}' },
    FINLAB_L5_MARKET_DATA_ENABLED: '1', S12_INTRADAY_GATE_MODE: 'assist_entry',
    ML_CONTROLLER_URL: 'https://controller.invalid', ML_CONTROLLER_SECRET: 'never-record-this',
    PROXY_SERVICE_TOKEN: 'never-record-this-either', DISCORD_WEBHOOK_URL: 'private-webhook',
    STOCKVISION_AUTH_TOKEN: 'private-service-token',
  } as any)
  assert.equal(result.variables.FINLAB_L5_MARKET_DATA_ENABLED, '1')
  assert.equal(result.variables.S12_INTRADAY_GATE_MODE, 'assist_entry')
  assert.equal(result.variables.ML_CONTROLLER_SECRET, '__SEALED_CREDENTIAL__')
  assert.equal(result.frozen_kv['ml:config.debate_max_rounds'], '3')
  assert.doesNotMatch(JSON.stringify(result), /never-record-this|private-webhook|private-service-token/)
})

test('unknown/error policy reads cannot masquerade as an empty/default configuration', async () => {
  await assert.rejects(captureNativePaperSourceContext({ KV: { get: async () => { throw new Error('kv_outage') } } } as any), /kv_outage/)
  await assert.rejects(captureNativePaperSourceContext({ KV: { get: async () => '{"api_key":"sensitive"}' } } as any), /contains_credentials/)
  await assert.rejects(captureNativePaperSourceContext({ KV: { get: async () => '{"nested":{"accessToken":"sensitive"}}' } } as any), /contains_credentials/)
})
