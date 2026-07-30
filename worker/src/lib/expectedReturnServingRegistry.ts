import type { Bindings } from '../types'
import type { ExpectedReturnOwner } from './expectedReturnServingState'

type JsonRecord = Record<string, any>

export const EXPECTED_RETURN_BASELINE_VERSIONS: Record<ExpectedReturnOwner, string> = {
  l4_alpha_ev: 'l4-alpha-ev-abstention-baseline-v1',
  allocator_ev_fusion: 'allocator-ev-fusion-abstention-baseline-v1',
}

type PointerProjectionRow = {
  model_name: ExpectedReturnOwner
  champion_version: string
  champion_artifact_id: string | null
  pointer_updated_at: string
  registry_state: string | null
  registry_model_name: string | null
  registry_version: string | null
  payload_model_name: string | null
  payload_model_version: string | null
  artifact_json: string | null
  payload_checksum: string | null
  serving_mode: 'alpha' | 'abstention_baseline' | null
}

export interface ExpectedReturnPointerProjection {
  owner: ExpectedReturnOwner
  pointer_present: boolean
  champion_version: string | null
  champion_artifact_id: string | null
  serving_mode: 'alpha' | 'abstention_baseline' | null
  artifact: JsonRecord | null
  valid: boolean
  blockers: string[]
  pointer_updated_at: string | null
}

export interface ExpectedReturnConfigHydration {
  config: JsonRecord
  projections: Record<ExpectedReturnOwner, ExpectedReturnPointerProjection>
  alerts: string[]
}

function emptyProjection(owner: ExpectedReturnOwner): ExpectedReturnPointerProjection {
  return {
    owner,
    pointer_present: false,
    champion_version: null,
    champion_artifact_id: null,
    serving_mode: null,
    artifact: null,
    valid: false,
    blockers: ['champion_pointer_missing'],
    pointer_updated_at: null,
  }
}

function evConfigWithoutArtifacts(config: JsonRecord): JsonRecord {
  const ensemble = config.ensemble_v2 && typeof config.ensemble_v2 === 'object'
    ? { ...config.ensemble_v2 }
    : {}
  delete ensemble.l4AlphaEv
  delete ensemble.l4_alpha_ev
  delete ensemble.allocatorEvFusion
  delete ensemble.allocator_ev_fusion
  return { ...config, ensemble_v2: ensemble }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function isMissingServingSchema(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('no such table: expected_return_artifact_payloads')
    || message.includes('no such table: model_champion_pointers')
}

export async function loadExpectedReturnPointerProjections(
  db: D1Database,
): Promise<Record<ExpectedReturnOwner, ExpectedReturnPointerProjection>> {
  const projections: Record<ExpectedReturnOwner, ExpectedReturnPointerProjection> = {
    l4_alpha_ev: emptyProjection('l4_alpha_ev'),
    allocator_ev_fusion: emptyProjection('allocator_ev_fusion'),
  }
  let rows: PointerProjectionRow[] = []
  try {
    const result = await db.prepare(`
      SELECT p.model_name,
             p.champion_version,
             p.champion_artifact_id,
             p.updated_at AS pointer_updated_at,
             r.state AS registry_state,
             r.model_name AS registry_model_name,
             r.version AS registry_version,
             x.model_name AS payload_model_name,
             x.model_version AS payload_model_version,
             x.artifact_json,
             x.payload_checksum,
             x.serving_mode
        FROM model_champion_pointers p
        LEFT JOIN model_artifact_registry r
          ON r.artifact_id = p.champion_artifact_id
        LEFT JOIN expected_return_artifact_payloads x
          ON x.artifact_id = p.champion_artifact_id
       WHERE p.model_name IN ('l4_alpha_ev', 'allocator_ev_fusion')
    `).all<PointerProjectionRow>()
    rows = result.results ?? []
  } catch (error) {
    if (!isMissingServingSchema(error)) throw error
    for (const owner of Object.keys(projections) as ExpectedReturnOwner[]) {
      projections[owner].blockers = ['serving_registry_schema_missing']
    }
    return projections
  }

  for (const row of rows) {
    const owner = row.model_name
    if (!(owner in projections)) continue
    const blockers: string[] = []
    if (!row.champion_artifact_id) blockers.push('champion_artifact_id_missing')
    if (row.registry_state !== 'production') blockers.push('champion_registry_state_not_production')
    if (row.registry_model_name !== owner) blockers.push('champion_registry_owner_mismatch')
    if (row.registry_version !== row.champion_version) blockers.push('champion_registry_version_mismatch')
    if (row.payload_model_name !== owner) blockers.push('champion_payload_table_owner_mismatch')
    if (row.payload_model_version !== row.champion_version) {
      blockers.push('champion_payload_table_version_mismatch')
    }
    if (!row.artifact_json) blockers.push('champion_payload_missing')
    if (!/^[a-f0-9]{64}$/.test(String(row.payload_checksum ?? '').toLowerCase())) {
      blockers.push('champion_payload_checksum_invalid')
    }
    let artifact: JsonRecord | null = null
    if (row.artifact_json) {
      try {
        artifact = JSON.parse(row.artifact_json) as JsonRecord
      } catch {
        blockers.push('champion_payload_json_invalid')
      }
    }
    if (artifact && String(artifact.model_version ?? '') !== row.champion_version) {
      blockers.push('champion_pointer_payload_version_mismatch')
    }
    if (artifact && artifact.expected_return_owner !== owner) {
      blockers.push('champion_pointer_payload_owner_mismatch')
    }
    if (
      row.artifact_json
      && /^[a-f0-9]{64}$/.test(String(row.payload_checksum ?? '').toLowerCase())
      && await sha256Hex(row.artifact_json) !== String(row.payload_checksum).toLowerCase()
    ) {
      blockers.push('champion_payload_checksum_mismatch')
    }
    projections[owner] = {
      owner,
      pointer_present: true,
      champion_version: row.champion_version,
      champion_artifact_id: row.champion_artifact_id,
      serving_mode: row.serving_mode,
      artifact: blockers.length === 0 ? artifact : null,
      valid: blockers.length === 0,
      blockers,
      pointer_updated_at: row.pointer_updated_at,
    }
  }
  return projections
}

export async function hydrateExpectedReturnConfigFromPointers(
  db: D1Database,
  rawConfig: JsonRecord,
): Promise<ExpectedReturnConfigHydration> {
  const projections = await loadExpectedReturnPointerProjections(db)
  const config = evConfigWithoutArtifacts(rawConfig)
  const ensemble = config.ensemble_v2 as JsonRecord
  const alerts: string[] = []
  for (const owner of Object.keys(projections) as ExpectedReturnOwner[]) {
    const projection = projections[owner]
    if (!projection.valid || !projection.artifact) {
      alerts.push(...projection.blockers.map((blocker) => `${owner}:${blocker}`))
      continue
    }
    if (owner === 'l4_alpha_ev') {
      ensemble.l4AlphaEv = projection.artifact
      ensemble.l4_alpha_ev = projection.artifact
    } else {
      ensemble.allocatorEvFusion = projection.artifact
      ensemble.allocator_ev_fusion = projection.artifact
    }
  }
  const legacy = rawConfig.ensemble_v2 && typeof rawConfig.ensemble_v2 === 'object'
    ? rawConfig.ensemble_v2 as JsonRecord
    : {}
  if ((legacy.l4AlphaEv || legacy.l4_alpha_ev) && !projections.l4_alpha_ev.valid) {
    alerts.push('l4_alpha_ev:legacy_config_fallback_blocked')
  }
  if (
    (legacy.allocatorEvFusion || legacy.allocator_ev_fusion)
    && !projections.allocator_ev_fusion.valid
  ) {
    alerts.push('allocator_ev_fusion:legacy_config_fallback_blocked')
  }
  return { config, projections, alerts: [...new Set(alerts)] }
}

export async function commitExpectedReturnChampion(
  db: D1Database,
  input: {
    owner: ExpectedReturnOwner
    artifact: JsonRecord
    artifactPath: string
    artifactChecksum: string
    promotionPacketId: string
    candidateId: string
    sourceRunDate: string
  },
): Promise<{ artifact_id: string; previous_version: string | null; payload_checksum: string }> {
  const modelVersion = String(input.artifact.model_version ?? '').trim()
  const artifactId = `${input.owner}:${modelVersion}`
  const registry = await db.prepare(`
    SELECT artifact_id, model_name, version, state, artifact_path, checksum,
           offline_gate_decision
      FROM model_artifact_registry
     WHERE artifact_id = ? AND model_name = ? AND version = ?
     LIMIT 1
  `).bind(artifactId, input.owner, modelVersion).first<Record<string, any>>()
  if (!registry) throw new Error('expected_return_registry_candidate_missing')
  if (registry.offline_gate_decision !== 'PASS') {
    throw new Error('expected_return_registry_candidate_offline_gate_not_pass')
  }
  if (String(registry.artifact_path ?? '') !== input.artifactPath) {
    throw new Error('expected_return_registry_artifact_path_mismatch')
  }
  if (String(registry.checksum ?? '').toLowerCase() !== input.artifactChecksum.toLowerCase()) {
    throw new Error('expected_return_registry_artifact_checksum_mismatch')
  }
  const previous = await db.prepare(`
    SELECT champion_version, champion_artifact_id
      FROM model_champion_pointers
     WHERE model_name = ?
  `).bind(input.owner).first<{ champion_version?: string; champion_artifact_id?: string }>()
  const artifactJson = JSON.stringify(input.artifact)
  const payloadChecksum = await sha256Hex(artifactJson)
  const evidence = JSON.stringify({
    schema_version: 'expected-return-pointer-promotion-v1',
    owner: input.owner,
    candidate_id: input.candidateId,
    promotion_packet_id: input.promotionPacketId,
    source_run_date: input.sourceRunDate,
    artifact_path: input.artifactPath,
    artifact_checksum: input.artifactChecksum,
    payload_checksum: payloadChecksum,
  })
  const eventId = `expected-return:${input.owner}:${modelVersion}:${input.artifactChecksum.slice(0, 16)}`
  await db.batch([
    db.prepare(`
      INSERT INTO expected_return_artifact_payloads (
        artifact_id, model_name, model_version, serving_mode,
        artifact_json, payload_checksum, source_artifact_path,
        source_artifact_checksum, source_cohort_id, updated_at
      ) VALUES (?, ?, ?, 'alpha', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(artifact_id) DO UPDATE SET
        artifact_json = excluded.artifact_json,
        payload_checksum = excluded.payload_checksum,
        source_artifact_path = excluded.source_artifact_path,
        source_artifact_checksum = excluded.source_artifact_checksum,
        source_cohort_id = excluded.source_cohort_id,
        serving_mode = 'alpha',
        updated_at = CURRENT_TIMESTAMP
    `).bind(
      artifactId, input.owner, modelVersion, artifactJson, payloadChecksum,
      input.artifactPath, input.artifactChecksum,
      String(input.artifact.training_data?.cohort_id ?? ''),
    ),
    db.prepare(`
      UPDATE model_artifact_registry
         SET state = 'archived',
             promotion_decision = 'replaced_by_expected_return_champion',
             updated_at = CURRENT_TIMESTAMP
       WHERE model_name = ? AND state = 'production' AND artifact_id != ?
    `).bind(input.owner, artifactId),
    db.prepare(`
      UPDATE model_artifact_registry
         SET state = 'production',
             promotion_decision = 'expected_return_owner_promoted',
             approval_state = 'not_required',
             live_gate_status = 'promoted',
             updated_at = CURRENT_TIMESTAMP
       WHERE artifact_id = ?
    `).bind(artifactId),
    db.prepare(`
      INSERT INTO model_champion_pointers (
        model_name, champion_version, champion_artifact_id,
        rollback_version, rollback_artifact_id, promoted_at,
        promotion_reason, promotion_evidence_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(model_name) DO UPDATE SET
        champion_version = excluded.champion_version,
        champion_artifact_id = excluded.champion_artifact_id,
        rollback_version = excluded.rollback_version,
        rollback_artifact_id = excluded.rollback_artifact_id,
        promoted_at = CURRENT_TIMESTAMP,
        promotion_reason = excluded.promotion_reason,
        promotion_evidence_json = excluded.promotion_evidence_json,
        updated_at = CURRENT_TIMESTAMP
    `).bind(
      input.owner, modelVersion, artifactId,
      previous?.champion_version ?? null, previous?.champion_artifact_id ?? null,
      'automatic_expected_return_quality_and_parity_pass', evidence,
    ),
    db.prepare(`
      UPDATE model_champion_history
         SET retired_at = CURRENT_TIMESTAMP
       WHERE model_name = ? AND retired_at IS NULL
    `).bind(input.owner),
    db.prepare(`
      INSERT OR IGNORE INTO model_champion_history (
        event_id, model_name, version, artifact_id, effective_at,
        retired_at, source, evidence_grade, evidence_json
      ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, NULL,
                'model_champion_history', 'exact', ?)
    `).bind(eventId, input.owner, modelVersion, artifactId, evidence),
  ])
  return {
    artifact_id: artifactId,
    previous_version: previous?.champion_version ?? null,
    payload_checksum: payloadChecksum,
  }
}

export function resolveExpectedOofCoverageDates(sessionDatesInput: string[]): {
  requiredOofMaxDate: string
  newlyMatureSignalDate: string
} | null {
  const sessionDates = [...new Set(sessionDatesInput.map((value) => String(value ?? '').slice(0, 10)).filter(Boolean))].sort()
  if (sessionDates.length < 7) return null
  return {
    requiredOofMaxDate: sessionDates[sessionDates.length - 7],
    newlyMatureSignalDate: sessionDates[sessionDates.length - 6],
  }
}
export async function inspectExpectedReturnLifecycleHealth(
  env: Pick<Bindings, 'DB'>,
  runDate: string,
): Promise<{
  alerts: string[]
  warnings: string[]
  expected_mature_signal_date: string | null
  newly_mature_signal_date: string | null
  oof_max_dates: Record<string, string | null>
  latest_candidates: Record<ExpectedReturnOwner, JsonRecord | null>
}> {
  const alerts: string[] = []
  const warnings: string[] = []
  const projections = await loadExpectedReturnPointerProjections(env.DB)
  for (const owner of Object.keys(projections) as ExpectedReturnOwner[]) {
    const projection = projections[owner]
    if (!projection.valid) alerts.push(...projection.blockers.map((item) => `${owner}:${item}`))
    if (projection.serving_mode === 'abstention_baseline') warnings.push(`${owner}:alpha_champion_not_promoted`)
  }
  const candidateRows = await env.DB.prepare(`
    SELECT model_name, version, state, offline_gate_decision,
           offline_gate_failed_gates, source_run_date, updated_at
      FROM model_artifact_registry
     WHERE model_name IN ('l4_alpha_ev', 'allocator_ev_fusion')
       AND candidate_type IN ('l4_alpha_ev_refresh', 'allocator_ev_fusion_refresh')
     ORDER BY updated_at DESC
  `).all<Record<string, any>>()
  const latestCandidates: Record<ExpectedReturnOwner, JsonRecord | null> = {
    l4_alpha_ev: null,
    allocator_ev_fusion: null,
  }
  for (const row of candidateRows.results ?? []) {
    const owner = row.model_name as ExpectedReturnOwner
    if (owner in latestCandidates && !latestCandidates[owner]) latestCandidates[owner] = row
  }
  for (const owner of Object.keys(latestCandidates) as ExpectedReturnOwner[]) {
    const candidate = latestCandidates[owner]
    if (
      candidate?.state === 'production'
      && projections[owner].champion_artifact_id !== `${owner}:${candidate.version}`
    ) {
      alerts.push(`${owner}:production_candidate_not_champion_pointer`)
    }
  }
  const maxRows = await env.DB.prepare(`
    SELECT current.artifact_kind,
           current.max_date
      FROM active8_oof_materialized_artifacts current
      JOIN active8_oof_cohorts cohort
        ON cohort.cohort_id = current.cohort_id
       AND cohort.status = 'ready'
     WHERE current.cohort_id = (
       SELECT candidate.cohort_id
         FROM active8_oof_materialized_artifacts candidate
         JOIN active8_oof_cohorts candidate_cohort
           ON candidate_cohort.cohort_id = candidate.cohort_id
          AND candidate_cohort.status = 'ready'
        WHERE candidate.artifact_kind = current.artifact_kind
        ORDER BY candidate.updated_at DESC, candidate.cohort_id DESC
        LIMIT 1
     )
  `).all<{ artifact_kind: string; max_date: string | null }>()
  const oofMaxDates: Record<string, string | null> = {
    allocator_ev_snapshots: null,
    l4_predictions: null,
  }
  for (const row of maxRows.results ?? []) oofMaxDates[row.artifact_kind] = row.max_date
  const sessions = await env.DB.prepare(`
    SELECT session_date
      FROM (
        SELECT DISTINCT date(date) AS session_date
          FROM canonical_market_daily
         WHERE stock_id = '0050'
           AND source = 'finlab.price'
           AND date(date) <= date(?)
         ORDER BY session_date DESC
         LIMIT 7
      )
     ORDER BY session_date ASC
  `).bind(runDate).all<{ session_date: string }>()
  const sessionDates = (sessions.results ?? []).map((row) => row.session_date)
  const coverageDates = resolveExpectedOofCoverageDates(sessionDates)
  const expectedMatureSignalDate = coverageDates?.requiredOofMaxDate ?? null
  const newlyMatureSignalDate = coverageDates?.newlyMatureSignalDate ?? null
  if (!expectedMatureSignalDate) {
    alerts.push('oof_expected_mature_signal_date_unresolved')
  } else {
    for (const kind of ['allocator_ev_snapshots', 'l4_predictions']) {
      const maxDate = oofMaxDates[kind]
      if (!maxDate || maxDate < expectedMatureSignalDate) {
        alerts.push(`${kind}:oof_max_date_stale:${maxDate ?? 'missing'}<${expectedMatureSignalDate}`)
      } else if (newlyMatureSignalDate && maxDate < newlyMatureSignalDate) {
        warnings.push(`${kind}:awaiting_current_close_oof_materialization:${maxDate}<${newlyMatureSignalDate}`)
      }
    }
  }
  return {
    alerts: [...new Set(alerts)],
    warnings: [...new Set(warnings)],
    expected_mature_signal_date: expectedMatureSignalDate,
    newly_mature_signal_date: newlyMatureSignalDate,
    oof_max_dates: oofMaxDates,
    latest_candidates: latestCandidates,
  }
}
