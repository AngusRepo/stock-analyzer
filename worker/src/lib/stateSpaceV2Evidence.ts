export const STATE_SPACE_V2_SCHEMA = 'state-space-observation-v2'
export const STATE_SPACE_V2_CONTRACT = 'local-linear-trend-gaussian-mle-v2'

type Observation = Record<string, unknown> & {
  observation_id: string
  observation_checksum: string
  symbol: string
  as_of_date: string
  horizon_sessions: number
  observed_price: number
  forecast_return: number
  up_probability: number
}

export type StateSpaceV2Packet = {
  schema_version: string
  contract_version: string
  run_id: string
  as_of_date: string
  horizon_sessions: number
  production_effect: false
  decision_role: 'risk_overlay_comparison_only'
  input_evidence: Record<string, unknown>
  observations: Observation[]
  errors: Array<Record<string, unknown>>
  observation_count: number
  error_count: number
  payload_checksum: string
}

function stableStringify(value: unknown): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('state_space_v2_non_finite_checksum_number')
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
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function finiteNumber(value: unknown, name: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`state_space_v2_${name}_invalid`)
  return parsed
}

async function validateObservation(raw: Record<string, unknown>, packet: StateSpaceV2Packet): Promise<Observation> {
  if (raw.schema_version !== STATE_SPACE_V2_SCHEMA || raw.contract_version !== STATE_SPACE_V2_CONTRACT) {
    throw new Error('state_space_v2_observation_contract_mismatch')
  }
  if (raw.production_effect !== false || raw.decision_role !== 'risk_overlay_comparison_only') {
    throw new Error('state_space_v2_production_boundary_violation')
  }
  if (raw.as_of_date !== packet.as_of_date || Number(raw.horizon_sessions) !== packet.horizon_sessions) {
    throw new Error('state_space_v2_observation_clock_mismatch')
  }
  const symbol = String(raw.symbol ?? '').trim()
  const observationId = String(raw.observation_id ?? '').trim()
  const expectedChecksum = String(raw.observation_checksum ?? '').toLowerCase()
  if (!symbol || !observationId || !/^[a-f0-9]{64}$/.test(expectedChecksum)) {
    throw new Error('state_space_v2_observation_identity_missing')
  }
  const canonical = { ...raw }
  delete canonical.observation_id
  delete canonical.observation_checksum
  if (await sha256(canonical) !== expectedChecksum) {
    throw new Error(`state_space_v2_observation_checksum_mismatch:${symbol}`)
  }
  const observedPrice = finiteNumber(raw.observed_price, 'observed_price')
  const forecastVariance = finiteNumber(raw.forecast_variance, 'forecast_variance')
  const upProbability = finiteNumber(raw.up_probability, 'up_probability')
  if (observedPrice <= 0 || forecastVariance <= 0 || upProbability < 0 || upProbability > 1) {
    throw new Error(`state_space_v2_observation_range_invalid:${symbol}`)
  }
  return raw as Observation
}

export async function validateStateSpaceV2Packet(raw: unknown): Promise<StateSpaceV2Packet> {
  if (!raw || typeof raw !== 'object') throw new Error('state_space_v2_packet_missing')
  const packet = raw as StateSpaceV2Packet
  if (packet.schema_version !== STATE_SPACE_V2_SCHEMA || packet.contract_version !== STATE_SPACE_V2_CONTRACT) {
    throw new Error('state_space_v2_packet_contract_mismatch')
  }
  if (packet.production_effect !== false || packet.decision_role !== 'risk_overlay_comparison_only') {
    throw new Error('state_space_v2_packet_production_boundary_violation')
  }
  if (!packet.run_id || !/^\d{4}-\d{2}-\d{2}$/.test(packet.as_of_date)) {
    throw new Error('state_space_v2_packet_identity_missing')
  }
  if (!Array.isArray(packet.observations) || !Array.isArray(packet.errors)) {
    throw new Error('state_space_v2_packet_rows_missing')
  }
  if (packet.observation_count !== packet.observations.length || packet.error_count !== packet.errors.length) {
    throw new Error('state_space_v2_packet_count_mismatch')
  }
  const core = {
    schema_version: packet.schema_version,
    contract_version: packet.contract_version,
    run_id: packet.run_id,
    as_of_date: packet.as_of_date,
    horizon_sessions: packet.horizon_sessions,
    production_effect: packet.production_effect,
    decision_role: packet.decision_role,
    input_evidence: packet.input_evidence ?? {},
    observations: packet.observations,
    errors: packet.errors,
  }
  if (await sha256(core) !== String(packet.payload_checksum ?? '').toLowerCase()) {
    throw new Error('state_space_v2_packet_checksum_mismatch')
  }
  const validated: Observation[] = []
  const identities = new Set<string>()
  for (const row of packet.observations) {
    const observation = await validateObservation(row, packet)
    if (identities.has(observation.symbol)) throw new Error(`state_space_v2_duplicate_symbol:${observation.symbol}`)
    identities.add(observation.symbol)
    validated.push(observation)
  }
  return { ...packet, observations: validated }
}

export async function persistStateSpaceV2Packet(db: D1Database, raw: unknown): Promise<{ run_id: string; observations: number }> {
  const packet = await validateStateSpaceV2Packet(raw)
  const statements: D1PreparedStatement[] = [
    db.prepare(`INSERT OR IGNORE INTO state_space_v2_runs
      (run_id, schema_version, contract_version, as_of_date, horizon_sessions,
       observation_count, error_count, input_evidence_json, errors_json,
       payload_checksum, production_effect, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'complete')`).bind(
      packet.run_id,
      packet.schema_version,
      packet.contract_version,
      packet.as_of_date,
      packet.horizon_sessions,
      packet.observation_count,
      packet.error_count,
      JSON.stringify(packet.input_evidence ?? {}),
      JSON.stringify(packet.errors),
      packet.payload_checksum,
    ),
  ]
  for (const row of packet.observations) {
    statements.push(db.prepare(`INSERT OR IGNORE INTO state_space_v2_observations
      (observation_id, run_id, as_of_date, symbol, stock_id, horizon_sessions,
       n_used, observed_price, latent_level, latent_slope_1d, forecast_return,
       forecast_variance, up_probability, innovation_z, level_uncertainty,
       slope_uncertainty, input_checksum, observation_checksum, sequence_source,
       parameters_json, production_effect)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`).bind(
      row.observation_id,
      packet.run_id,
      packet.as_of_date,
      row.symbol,
      row.stock_id == null ? null : Math.trunc(finiteNumber(row.stock_id, 'stock_id')),
      packet.horizon_sessions,
      Math.trunc(finiteNumber(row.n_used, 'n_used')),
      finiteNumber(row.observed_price, 'observed_price'),
      finiteNumber(row.latent_level, 'latent_level'),
      finiteNumber(row.latent_slope_1d, 'latent_slope_1d'),
      finiteNumber(row.forecast_return, 'forecast_return'),
      finiteNumber(row.forecast_variance, 'forecast_variance'),
      finiteNumber(row.up_probability, 'up_probability'),
      finiteNumber(row.innovation_z, 'innovation_z'),
      finiteNumber(row.level_uncertainty, 'level_uncertainty'),
      finiteNumber(row.slope_uncertainty, 'slope_uncertainty'),
      String(row.input_checksum),
      String(row.observation_checksum),
      String(row.sequence_source ?? 'unknown'),
      JSON.stringify(row.parameters ?? {}),
    ))
  }
  await db.batch(statements)
  const existing = await db.prepare(
    `SELECT payload_checksum, observation_count FROM state_space_v2_runs WHERE run_id = ?`,
  ).bind(packet.run_id).first<{ payload_checksum: string; observation_count: number }>()
  if (!existing || existing.payload_checksum !== packet.payload_checksum || Number(existing.observation_count) !== packet.observation_count) {
    throw new Error('state_space_v2_immutable_run_conflict')
  }
  const count = await db.prepare(
    `SELECT COUNT(*) AS count FROM state_space_v2_observations WHERE run_id = ?`,
  ).bind(packet.run_id).first<{ count: number }>()
  if (Number(count?.count ?? 0) !== packet.observation_count) {
    throw new Error('state_space_v2_observation_readback_mismatch')
  }
  return { run_id: packet.run_id, observations: packet.observation_count }
}

type PendingObservation = {
  observation_id: string
  as_of_date: string
  symbol: string
  horizon_sessions: number
  observed_price: number
  forecast_return: number
}

export async function matureStateSpaceV2Evidence(
  learningDb: D1Database,
  marketDb: D1Database,
  throughDate: string,
): Promise<{ evaluated: number; pending_dates: number }> {
  const { results } = await learningDb.prepare(`
    SELECT o.observation_id, o.as_of_date, o.symbol, o.horizon_sessions,
           o.observed_price, o.forecast_return
      FROM state_space_v2_observations o
      LEFT JOIN state_space_v2_evaluations e ON e.observation_id = o.observation_id
     WHERE e.observation_id IS NULL AND o.as_of_date < ?
     ORDER BY o.as_of_date, o.symbol
     LIMIT 5000
  `).bind(throughDate).all<PendingObservation>()
  const rows = results ?? []
  const byDate = new Map<string, PendingObservation[]>()
  for (const row of rows) byDate.set(row.as_of_date, [...(byDate.get(row.as_of_date) ?? []), row])
  const statements: D1PreparedStatement[] = []
  for (const [asOfDate, dateRows] of byDate) {
    const horizon = Math.max(...dateRows.map((row) => Number(row.horizon_sessions) || 0))
    const { results: sessions } = await marketDb.prepare(`
      SELECT date FROM stock_prices
       WHERE date > ? AND date <= ?
       GROUP BY date ORDER BY date ASC LIMIT ?
    `).bind(asOfDate, throughDate, horizon).all<{ date: string }>()
    if ((sessions?.length ?? 0) < horizon) continue
    const outcomeDate = String(sessions![horizon - 1].date)
    const symbols = [...new Set(dateRows.map((row) => row.symbol))]
    const outcomePrices = new Map<string, number>()
    for (let index = 0; index < symbols.length; index += 80) {
      const chunk = symbols.slice(index, index + 80)
      const placeholders = chunk.map(() => '?').join(',')
      const { results: prices } = await marketDb.prepare(
        `SELECT symbol, close FROM stock_prices WHERE date = ? AND symbol IN (${placeholders})`,
      ).bind(outcomeDate, ...chunk).all<{ symbol: string; close: number }>()
      for (const price of prices ?? []) outcomePrices.set(price.symbol, Number(price.close))
    }
    for (const row of dateRows) {
      const outcomePrice = outcomePrices.get(row.symbol)
      const observedPrice = Number(row.observed_price)
      if (!outcomePrice || !Number.isFinite(observedPrice) || observedPrice <= 0) continue
      const realizedReturn = outcomePrice / observedPrice - 1
      const forecastReturn = Number(row.forecast_return)
      const directionCorrect = (forecastReturn >= 0) === (realizedReturn >= 0) ? 1 : 0
      const error = forecastReturn - realizedReturn
      const evaluationId = `state-space-v2-eval-${row.observation_id.replace(/^state-space-v2-/, '')}`
      statements.push(learningDb.prepare(`INSERT OR IGNORE INTO state_space_v2_evaluations
        (evaluation_id, observation_id, outcome_date, outcome_price, realized_return,
         direction_correct, squared_error, absolute_error, production_effect)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`).bind(
        evaluationId,
        row.observation_id,
        outcomeDate,
        outcomePrice,
        realizedReturn,
        directionCorrect,
        error * error,
        Math.abs(error),
      ))
    }
  }
  for (let index = 0; index < statements.length; index += 100) {
    await learningDb.batch(statements.slice(index, index + 100))
  }
  return { evaluated: statements.length, pending_dates: byDate.size }
}
