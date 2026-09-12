import type { Bindings } from '../types'
import type { ExpectedReturnOwner } from './expectedReturnServingState'
import { databaseForDataDomain } from './dataDomainRegistry'
import { expectedReturnOfflineAdmissionBlockers, finiteExpectedReturnMetric } from './expectedReturnOfflineAdmission'
import { verifyNavPromotionEvidence, navJournalFrontierGuard, originalNavComparisonContext } from './pairedNavPromotionEvidence'
import { verifyNavCurrentContext, verifyNavFormalBaseline, comparableConfig, navPointerCompareAndSwapGuard, type NavCurrentConfigReader } from './pairedNavPromotionContext'

type JsonRecord = Record<string, any>
export const EXPECTED_RETURN_PROSPECTIVE_MIN_DATES = 10

export type ExpectedReturnOwnerState = 'learned_champion' | 'safe_abstention' | 'no_champion'

type OwnerStateRow = {
  owner: ExpectedReturnOwner
  owner_state: ExpectedReturnOwnerState
  champion_artifact_id: string | null
  reason_code: string
  updated_at: string
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
  owner_state: ExpectedReturnOwnerState
  deprecated_pointer_ignored: boolean
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
    owner_state: 'no_champion',
    deprecated_pointer_ignored: false,
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
  let ownerStateRows: OwnerStateRow[] = []
  try {
    const states = await db.prepare(`
      SELECT owner, owner_state, champion_artifact_id, reason_code, updated_at
        FROM expected_return_owner_state_v2
       WHERE owner IN ('l4_alpha_ev', 'allocator_ev_fusion')
    `).all<OwnerStateRow>()
    ownerStateRows = states.results ?? []
  } catch (error) {
    if (!String(error).includes('no such table: expected_return_owner_state_v2')) throw error
  }
  const ownerStateByOwner = new Map(ownerStateRows.map((row) => [row.owner, row]))

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
    const declaredState = ownerStateByOwner.get(owner)
    if (row.serving_mode === 'abstention_baseline') {
      const blockers = declaredState?.owner_state === 'learned_champion'
        ? ['owner_state_champion_pointer_inconsistent']
        : []
      projections[owner] = {
        owner,
        owner_state: declaredState?.owner_state ?? 'safe_abstention',
        deprecated_pointer_ignored: true,
        pointer_present: false,
        champion_version: null,
        champion_artifact_id: null,
        serving_mode: 'abstention_baseline',
        artifact: null,
        valid: blockers.length === 0,
        blockers,
        pointer_updated_at: declaredState?.updated_at ?? row.pointer_updated_at,
      }
      continue
    }
    const blockers: string[] = []
    if (row.serving_mode !== 'alpha') blockers.push('champion_serving_mode_not_alpha')
    if (declaredState && declaredState.owner_state !== 'learned_champion') {
      blockers.push('owner_state_champion_pointer_inconsistent')
    }
    if (declaredState && declaredState.champion_artifact_id !== row.champion_artifact_id) {
      blockers.push('owner_state_champion_artifact_mismatch')
    }
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
      owner_state: 'learned_champion',
      deprecated_pointer_ignored: false,
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
  for (const state of ownerStateRows) {
    const current = projections[state.owner]
    if (state.owner_state === 'safe_abstention' && current.owner_state !== 'learned_champion') {
      projections[state.owner] = {
        ...emptyProjection(state.owner),
        owner_state: 'safe_abstention',
        serving_mode: 'abstention_baseline',
        valid: true,
        blockers: [],
        pointer_updated_at: state.updated_at,
        deprecated_pointer_ignored: current.deprecated_pointer_ignored,
      }
    } else if (state.owner_state === 'learned_champion' && !current.valid) {
      // Preserve declared authority when its pointer disappears. Otherwise a
      // corrupt learned owner looks like an ordinary never-promoted owner.
      current.owner_state = 'learned_champion'
      current.blockers = [...new Set([...current.blockers, 'owner_state_champion_pointer_inconsistent'])]
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

export type ExpectedReturnCommitReceipt = {
  artifact_id: string
  previous_version: string | null
  payload_checksum: string
  nav_review_date?: string
}

/** Recovery acknowledges an existing authoritative commit, never a new verdict.
 * The latest diagnostic/NAV verdict may differ from the immutable adoption packet.
 * No caller artifact bytes, current gate, or config cache can replace that packet.
 */
export async function readExpectedReturnCommitReceipt(
  db: D1Database,
  input: { owner: ExpectedReturnOwner; artifactId: string; modelVersion: string;
    artifactChecksum: string; artifactPath: string },
): Promise<ExpectedReturnCommitReceipt | null> {
  const checksum = input.artifactChecksum.trim().toLowerCase()
  const artifactId = input.artifactId.trim()
  if (!/^[0-9a-f]{64}$/.test(checksum)
      || artifactId !== `${input.owner}:${input.modelVersion}:${checksum}`
      || !input.artifactPath.endsWith(`/${checksum}.json`)) {
    throw new Error('expected_return_commit_receipt_identity_invalid')
  }
  const pointer = await db.prepare('SELECT champion_artifact_id FROM model_champion_pointers WHERE model_name=?')
    .bind(input.owner).first<JsonRecord>()
  if (pointer?.champion_artifact_id !== artifactId) return null
  const row = await db.prepare(`
    SELECT p.champion_artifact_id, p.champion_version, p.rollback_version, p.promotion_evidence_json,
           r.state, r.model_name AS registry_owner, r.version AS registry_version,
           r.checksum AS registry_checksum, r.artifact_path AS registry_path,
           x.model_name AS payload_owner, x.model_version AS payload_version,
           x.serving_mode, x.artifact_json, x.payload_checksum, x.source_artifact_checksum, x.source_artifact_path,
           s.owner_state, s.champion_artifact_id AS state_artifact_id,
           h.evidence_json AS history_evidence, h.version AS history_version,
           (SELECT COUNT(*) FROM model_champion_history active
             WHERE active.model_name=p.model_name AND active.retired_at IS NULL) AS active_history_count
      FROM model_champion_pointers p
      JOIN model_artifact_registry r ON r.artifact_id=p.champion_artifact_id
      JOIN expected_return_artifact_payloads x ON x.artifact_id=p.champion_artifact_id
      JOIN expected_return_owner_state_v2 s ON s.owner=p.model_name
      JOIN model_champion_history h ON h.model_name=p.model_name
        AND h.artifact_id=p.champion_artifact_id AND h.retired_at IS NULL
     WHERE p.model_name=?
  `).bind(input.owner).first<JsonRecord>()
  let artifact: JsonRecord | null = null
  let evidence: JsonRecord | null = null
  try {
    artifact = JSON.parse(row?.artifact_json ?? 'null')
    evidence = JSON.parse(row?.promotion_evidence_json ?? 'null')
  } catch { /* malformed committed bytes fail the same readback boundary below */ }
  if (!row || row.champion_artifact_id !== artifactId || row.champion_version !== input.modelVersion
      || row.state !== 'production' || row.registry_owner !== input.owner || row.registry_version !== input.modelVersion
      || row.registry_checksum !== checksum || row.registry_path !== input.artifactPath
      || row.payload_owner !== input.owner || row.payload_version !== input.modelVersion || row.serving_mode !== 'alpha'
      || row.source_artifact_checksum !== checksum || row.source_artifact_path !== input.artifactPath
      || row.owner_state !== 'learned_champion' || row.state_artifact_id !== artifactId
      || row.active_history_count !== 1 || row.history_version !== input.modelVersion
      || row.history_evidence !== row.promotion_evidence_json
      || artifact?.model_version !== input.modelVersion || artifact?.expected_return_owner !== input.owner
      || !/^[0-9a-f]{64}$/.test(row.payload_checksum ?? '')
      || await sha256Hex(row.artifact_json ?? '') !== row.payload_checksum
      || evidence?.schema_version !== 'expected-return-pointer-promotion-v1' || evidence?.owner !== input.owner
      || evidence?.artifact_checksum !== checksum || evidence?.artifact_path !== input.artifactPath
      || evidence?.payload_checksum !== row.payload_checksum) {
    throw new Error('expected_return_registry_pointer_commit_readback_mismatch')
  }
  const originalGate = evidence!.prospective_validation
  const reviewDate = originalGate?.nav_validation?.as_of_date
  const hasNavDate = originalGate?.schema_version === 'expected-return-candidate-nav-gate-v1'
  if (hasNavDate && (typeof reviewDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(reviewDate)
      || !Number.isFinite(Date.parse(reviewDate + 'T00:00:00Z'))
      || new Date(reviewDate + 'T00:00:00Z').toISOString().slice(0, 10) !== reviewDate)) {
    throw new Error('expected_return_commit_review_date_invalid')
  }
  return { artifact_id: artifactId, previous_version: row.rollback_version ?? null,
    payload_checksum: row.payload_checksum, ...(hasNavDate ? { nav_review_date: reviewDate } : {}) }
}

export async function verifyExpectedReturnCandidate(db: D1Database,
  input: Parameters<typeof commitExpectedReturnChampion>[1],
  identity: { artifactId: string; artifactChecksum: string; modelVersion: string }) {
  const { artifactId, artifactChecksum, modelVersion } = identity
  if (input.artifact.expected_return_owner !== input.owner) {
    throw new Error('expected_return_registry_payload_owner_mismatch')
  }
  const registry = await db.prepare(`
    SELECT artifact_id, model_name, version, state, artifact_path, checksum,
           offline_gate_decision, offline_gate_failed_gates, live_evidence_json
      FROM model_artifact_registry
     WHERE artifact_id = ? AND model_name = ? AND version = ?
     LIMIT 1
  `).bind(artifactId, input.owner, modelVersion).first<Record<string, any>>()
  if (!registry) throw new Error('expected_return_registry_candidate_missing')
  let failedGates: unknown
  try { failedGates = JSON.parse(registry.offline_gate_failed_gates) }
  catch { throw new Error('expected_return_registry_offline_evidence_invalid_json') }
  const admissionBlockers = expectedReturnOfflineAdmissionBlockers(input.owner, {
    decision: registry.offline_gate_decision, failed_gates: failedGates,
  }, input.offlineAdmission)
  if (admissionBlockers.length) {
    throw new Error(`expected_return_registry_offline_admission_invalid:${admissionBlockers.join(',')}`)
  }
  if (String(registry.artifact_path ?? '') !== input.artifactPath) {
    throw new Error('expected_return_registry_artifact_path_mismatch')
  }
  if (String(registry.checksum ?? '').toLowerCase() !== artifactChecksum) {
    throw new Error('expected_return_registry_artifact_checksum_mismatch')
  }
  const prospective = input.prospectiveValidation ?? {}
  const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
  let recordedGate: JsonRecord
  try { recordedGate = JSON.parse(registry.live_evidence_json) }
  catch { throw new Error('expected_return_registry_live_gate_missing') }
  if (JSON.stringify(canonical(recordedGate)) !== JSON.stringify(canonical(prospective))) {
    throw new Error('expected_return_registry_live_gate_mismatch')
  }
  const fingerprint = String(input.artifact.model_fingerprint ?? '').trim().toLowerCase()
  if (String(prospective.model_fingerprint ?? '').toLowerCase() !== fingerprint
    || prospective.source_run_date !== input.sourceRunDate.slice(0, 10)
    || prospective.artifact_trained_until !== String(input.artifact.trained_until ?? '').slice(0, 10)) {
    throw new Error('expected_return_registry_prospective_identity_mismatch')
  }
  const navProof = await verifyNavPromotionEvidence(db, { owner: input.owner, artifactId,
    artifactChecksum, gate: prospective })
  return { registry, navProof }
}

export async function commitExpectedReturnChampion(
  db: D1Database,
  input: {
    owner: ExpectedReturnOwner
    artifact: JsonRecord
    artifactId: string
    artifactPath: string
    artifactChecksum: string
    promotionPacketId: string
    candidateId: string
    sourceRunDate: string
    prospectiveValidation: JsonRecord
    offlineAdmission: JsonRecord
    currentConfigReader?: NavCurrentConfigReader
    navBindings?: import('../types').Bindings
  },
): Promise<ExpectedReturnCommitReceipt> {
  const modelVersion = String(input.artifact.model_version ?? '').trim()
  const artifactChecksum = input.artifactChecksum.trim().toLowerCase()
  const artifactId = input.artifactId.trim()
  if (!/^[0-9a-f]{64}$/.test(artifactChecksum)) {
    throw new Error('expected_return_registry_artifact_checksum_invalid')
  }
  if (artifactId !== `${input.owner}:${modelVersion}:${artifactChecksum}`) {
    throw new Error('expected_return_registry_artifact_id_checksum_mismatch')
  }
  if (!input.artifactPath.endsWith(`/${artifactChecksum}.json`)) {
    throw new Error('expected_return_registry_artifact_path_checksum_mismatch')
  }
  const existingReceipt = await readExpectedReturnCommitReceipt(db, { ...input, modelVersion })
  if (existingReceipt) return existingReceipt
  const prospective = input.prospectiveValidation ?? {}
  // Re-read original immutable review immediately before the serving transaction.
  // A plan's in-memory proof or HTTP PASS cannot replace this boundary check.
  const { registry, navProof } = await verifyExpectedReturnCandidate(db, input,
    { artifactId, artifactChecksum, modelVersion })
  const previous = await db.prepare(`
    SELECT champion_version, champion_artifact_id, rollback_version
      FROM model_champion_pointers
     WHERE model_name = ?
  `).bind(input.owner).first<{ champion_version?: string; champion_artifact_id?: string; rollback_version?: string | null }>()
  const artifactJson = JSON.stringify(input.artifact)
  const payloadChecksum = await sha256Hex(artifactJson)
  if (previous?.champion_artifact_id === artifactId) {
    const receipt = await readExpectedReturnCommitReceipt(db, { ...input, modelVersion })
    if (!receipt) throw new Error('expected_return_registry_pointer_commit_readback_mismatch')
    return receipt
  }
  const currentContext = await verifyNavCurrentContext(db, navProof, input.currentConfigReader!, input.navBindings)
  const evidence = JSON.stringify({
    schema_version: 'expected-return-pointer-promotion-v1',
    owner: input.owner,
    candidate_id: input.candidateId,
    promotion_packet_id: input.promotionPacketId,
    source_run_date: input.sourceRunDate,
    artifact_path: input.artifactPath,
    artifact_checksum: artifactChecksum,
    payload_checksum: payloadChecksum,
    prospective_validation: prospective,
    offline_admission: input.offlineAdmission,
  })
  const eventId = `expected-return:${input.owner}:${modelVersion}:${artifactChecksum.slice(0, 16)}`
  const statements = [
    navJournalFrontierGuard(db, navProof),
    navPointerCompareAndSwapGuard(db, navProof, currentContext, previous?.champion_artifact_id ?? null),
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
      input.artifactPath, artifactChecksum,
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
      INSERT INTO expected_return_owner_state_v2 (
        owner, owner_state, champion_artifact_id, reason_code,
        contract_manifest_version, updated_at
      ) VALUES (?, 'learned_champion', ?, 'learned_champion_pointer_active',
                'expected-return-contract-manifest-v1', CURRENT_TIMESTAMP)
      ON CONFLICT(owner) DO UPDATE SET
        owner_state='learned_champion',
        champion_artifact_id=excluded.champion_artifact_id,
        reason_code=excluded.reason_code,
        contract_manifest_version=excluded.contract_manifest_version,
        updated_at=CURRENT_TIMESTAMP
    `).bind(input.owner, artifactId),
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
  ]
  const committed = await db.batch(statements)
  if (committed.length !== statements.length || committed.some(result => result.success !== true)) {
    throw new Error('expected_return_registry_pointer_batch_incomplete')
  }
  const receipt = await readExpectedReturnCommitReceipt(db, { ...input, modelVersion })
  if (!receipt || receipt.payload_checksum !== payloadChecksum) {
    throw new Error('expected_return_registry_pointer_commit_readback_mismatch')
  }
  return {
    ...receipt,
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

function resolveForwardNotEvaluableRows(input: unknown): JsonRecord[] {
  let payload = input
  if (typeof input === 'string') {
    try { payload = JSON.parse(input) } catch { return [] }
  }
  if (!payload || typeof payload !== 'object') return []
  const rows = (payload as JsonRecord).not_evaluable
  if (!Array.isArray(rows)) return []
  return rows.filter((row): row is JsonRecord => Boolean(row && typeof row === 'object'))
}

export function resolveForwardNotEvaluableDates(input: unknown): string[] {
  return [...new Set(resolveForwardNotEvaluableRows(input)
    .map((row) => String(row.date ?? '').slice(0, 10))
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)))]
    .sort()
}

export function resolveLegalForwardNotEvaluableDates(input: unknown): string[] {
  return [...new Set(resolveForwardNotEvaluableRows(input)
    .filter((row) => row.reason === 'missing_native_pit_components')
    .map((row) => String(row.date ?? '').slice(0, 10))
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)))]
    .sort()
}

export function isExpectedOofCurrentCloseCovered(
  maxDate: string | null,
  newlyMatureSignalDate: string | null,
  legalNotEvaluableDates: string[],
): boolean {
  if (!newlyMatureSignalDate) return true
  return Boolean(maxDate && maxDate >= newlyMatureSignalDate)
    || legalNotEvaluableDates.includes(newlyMatureSignalDate)
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
  oof_base_max_dates: Record<string, string | null>
  oof_shadow_max_dates: Record<string, string | null>
  oof_not_evaluable_dates: Record<string, string[]>
  latest_candidates: Record<ExpectedReturnOwner, JsonRecord | null>
}> {
  const alerts: string[] = []
  const warnings: string[] = []
  const projections = await loadExpectedReturnPointerProjections(databaseForDataDomain(env, 'learning'))
  for (const owner of Object.keys(projections) as ExpectedReturnOwner[]) {
    const projection = projections[owner]
    if (!projection.valid) alerts.push(...projection.blockers.map((item) => `${owner}:${item}`))
    if (projection.serving_mode === 'abstention_baseline') warnings.push(`${owner}:alpha_champion_not_promoted`)
  }
  const candidateRows = await databaseForDataDomain(env, 'learning').prepare(`
    SELECT artifact_id, model_name, version, state, offline_gate_decision,
           offline_gate_failed_gates, source_run_date, updated_at
      FROM model_artifact_registry
     WHERE model_name IN ('l4_alpha_ev', 'allocator_ev_fusion')
       AND candidate_type IN ('l4_alpha_ev_refresh', 'allocator_ev_fusion_refresh')
     ORDER BY source_run_date DESC, updated_at DESC, version DESC, artifact_id DESC
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
      && projections[owner].champion_artifact_id !== String(candidate.artifact_id ?? '')
    ) {
      alerts.push(`${owner}:production_candidate_not_champion_pointer`)
    }
  }
  const maxRows = await databaseForDataDomain(env, 'learning').prepare(`
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
        ORDER BY candidate.max_date DESC, candidate.updated_at DESC, candidate.cohort_id DESC
        LIMIT 1
     )
  `).all<{ artifact_kind: string; max_date: string | null }>()
  const oofBaseMaxDates: Record<string, string | null> = {
    allocator_ev_snapshots: null,
    l4_predictions: null,
  }
  for (const row of maxRows.results ?? []) oofBaseMaxDates[row.artifact_kind] = row.max_date
  const shadowRows = await databaseForDataDomain(env, 'learning').prepare(`
    SELECT current.artifact_kind, current.max_date, current.date_eligibility_json
      FROM active8_oof_forward_extension_coverage current
      JOIN active8_oof_cohorts cohort
        ON cohort.cohort_id = current.cohort_id
       AND cohort.status = 'ready'
     WHERE current.coverage_status = 'verified'
       AND current.promotion_eligible = 0
       AND current.training_dispatched = 0
       AND current.policy_version = 'verified-frozen-forward-monitoring-v2'
       AND current.knowledge_cutoff_date <= date(?)
       AND current.cohort_id = (
         SELECT candidate.cohort_id
           FROM active8_oof_materialized_artifacts candidate
           JOIN active8_oof_cohorts candidate_cohort
             ON candidate_cohort.cohort_id = candidate.cohort_id
            AND candidate_cohort.status = 'ready'
          WHERE candidate.artifact_kind = current.artifact_kind
          ORDER BY candidate.max_date DESC, candidate.updated_at DESC, candidate.cohort_id DESC
          LIMIT 1
       )
     ORDER BY current.artifact_kind, current.max_date DESC, current.updated_at DESC
  `).bind(runDate).all<{
    artifact_kind: string
    max_date: string | null
    date_eligibility_json: string | null
  }>()
  const oofShadowMaxDates: Record<string, string | null> = {
    allocator_ev_snapshots: null,
    l4_predictions: null,
  }
  const oofNotEvaluableDateSets: Record<string, Set<string>> = {
    allocator_ev_snapshots: new Set(),
    l4_predictions: new Set(),
  }
  const oofLegalNotEvaluableDateSets: Record<string, Set<string>> = {
    allocator_ev_snapshots: new Set(),
    l4_predictions: new Set(),
  }
  for (const row of shadowRows.results ?? []) {
    const currentMax = oofShadowMaxDates[row.artifact_kind]
    if (!currentMax || (row.max_date && row.max_date > currentMax)) {
      oofShadowMaxDates[row.artifact_kind] = row.max_date
    }
    for (const date of resolveLegalForwardNotEvaluableDates(row.date_eligibility_json)) {
      oofLegalNotEvaluableDateSets[row.artifact_kind]?.add(date)
    }
    for (const date of resolveForwardNotEvaluableDates(row.date_eligibility_json)) {
      oofNotEvaluableDateSets[row.artifact_kind]?.add(date)
    }
  }
  const oofNotEvaluableDates = Object.fromEntries(
    Object.entries(oofNotEvaluableDateSets).map(([kind, dates]) => [kind, [...dates].sort()]),
  )
  const oofLegalNotEvaluableDates = Object.fromEntries(
    Object.entries(oofLegalNotEvaluableDateSets).map(([kind, dates]) => [kind, [...dates].sort()]),
  )
  const oofMaxDates: Record<string, string | null> = {
    allocator_ev_snapshots: null,
    l4_predictions: null,
  }
  for (const kind of Object.keys(oofMaxDates)) {
    const candidates = [oofBaseMaxDates[kind], oofShadowMaxDates[kind]]
      .filter((value): value is string => Boolean(value))
      .sort()
    oofMaxDates[kind] = candidates.at(-1) ?? null
  }
  const sessions = await databaseForDataDomain(env, 'market').prepare(`
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
      } else if (!isExpectedOofCurrentCloseCovered(
        maxDate,
        newlyMatureSignalDate,
        oofLegalNotEvaluableDates[kind] ?? [],
      )) {
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
    oof_base_max_dates: oofBaseMaxDates,
    oof_shadow_max_dates: oofShadowMaxDates,
    oof_not_evaluable_dates: oofNotEvaluableDates,
    latest_candidates: latestCandidates,
  }
}
