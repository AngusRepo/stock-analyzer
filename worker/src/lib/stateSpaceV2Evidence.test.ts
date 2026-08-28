import assert from 'node:assert/strict'
import { validateStateSpaceV2Packet } from './stateSpaceV2Evidence'

function stableStringify(value: unknown): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite')
    const token = value.toFixed(12).replace(/\.?0+$/, '') || '0'
    return `{"$number":${JSON.stringify(token)}}`
  }
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

async function sha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableStringify(value)))
  return Buffer.from(digest).toString('hex')
}

async function main() {
  const observationCore = {
    schema_version: 'state-space-observation-v2',
    contract_version: 'local-linear-trend-gaussian-mle-v2',
    decision_role: 'risk_overlay_comparison_only',
    production_effect: false,
    symbol: '2330',
    stock_id: 1,
    as_of_date: '2026-08-27',
    horizon_sessions: 5,
    n_used: 90,
    observed_price: 100,
    latent_level: 100.1,
    latent_slope_1d: 0.001,
    forecast_return: 0.005,
    forecast_variance: 0.02,
    up_probability: 0.55,
    innovation_z: 0.1,
    level_uncertainty: 0.01,
    slope_uncertainty: 0.001,
    parameters: { q_level: 0.1, q_slope: 0.01, observation_variance: 0.2, log_likelihood: -1 },
    input_checksum: 'a'.repeat(64),
    sequence_source: 'immutable-test',
  }
  const observationChecksum = await sha256(observationCore)
  const observation = {
    ...observationCore,
    observation_checksum: observationChecksum,
    observation_id: `state-space-v2-${observationChecksum.slice(0, 40)}`,
  }
  const packetCore = {
    schema_version: 'state-space-observation-v2',
    contract_version: 'local-linear-trend-gaussian-mle-v2',
    run_id: 'state-space-v2-test',
    as_of_date: '2026-08-27',
    horizon_sessions: 5,
    production_effect: false,
    decision_role: 'risk_overlay_comparison_only',
    input_evidence: { snapshot_id: 'immutable-test' },
    observations: [observation],
    errors: [],
  }
  const packet = {
    ...packetCore,
    observation_count: 1,
    error_count: 0,
    payload_checksum: await sha256(packetCore),
  }

  assert.equal((await validateStateSpaceV2Packet(packet)).observations.length, 1)
  await assert.rejects(
    validateStateSpaceV2Packet({ ...packet, production_effect: true }),
    /production_boundary_violation/,
  )
  await assert.rejects(
    validateStateSpaceV2Packet({ ...packet, payload_checksum: '0'.repeat(64) }),
    /packet_checksum_mismatch/,
  )

  console.log('stateSpaceV2Evidence.test.ts passed')


}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
