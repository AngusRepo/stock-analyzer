export type ParameterCandidateStatus =
  | 'NO_CANDIDATE'
  | 'SHADOW_COLLECTING'
  | 'VALIDATION_BLOCKED'
  | 'PROMOTION_READY'
  | 'APPROVAL_REQUIRED'
  | 'PROD_ACTIVE'

export const PARAMETER_CANDIDATE_SCHEMA_VERSION = 'parameter-candidate-registry-v1'
export const PRODUCTION_OVERRIDE_HEADER = 'X-Confirm-Production-Override'

type JsonRecord = Record<string, unknown>

export interface ParameterCandidateRecordInput {
  source: string
  candidateId?: string
  sandboxId?: string
  configHash?: string
  cadence?: string
  runId?: string
  status?: ParameterCandidateStatus
  metadata?: JsonRecord | null
}

export interface ParameterCandidateEvidenceInput {
  candidateId: string
  evidenceType?: string
  decision?: string
  evidence?: JsonRecord | null
  promotionPacketId?: string | null
}

export interface CandidateEvidenceValidationInput {
  candidateId?: string
  evidencePacket?: JsonRecord | null
  promotionPacketId?: string | null
}

export interface ProductionOverrideInput {
  route: string
  reason: string
  actor?: string | null
  candidateId?: string | null
  promotionPacketId?: string | null
  detail?: JsonRecord | null
}

function safeJson(value: unknown): string {
  return JSON.stringify(value ?? null)
}

function parseJson(raw: unknown): JsonRecord {
  if (!raw) return {}
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as JsonRecord
  try {
    const parsed = JSON.parse(String(raw))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonRecord : {}
  } catch {
    return {}
  }
}

function sanitizeIdPart(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9:._-]+/g, '_').slice(0, 180)
}

export function normalizeParameterCandidateSource(source: unknown): string {
  const text = String(source ?? '').trim().toLowerCase()
  return sanitizeIdPart(text || 'unknown')
}

export function candidateIdFromSandbox(source: string, sandboxId: string): string {
  const suffix = sandboxId.replace(/^trading:config:sandbox:/, '')
  return `parameter:${normalizeParameterCandidateSource(source)}:${sanitizeIdPart(suffix)}`
}

export function evidenceDecision(evidence: JsonRecord | null | undefined): string {
  const gate = evidence?.gate && typeof evidence.gate === 'object' ? evidence.gate as JsonRecord : {}
  const packet = evidence?.validation_packet && typeof evidence.validation_packet === 'object'
    ? evidence.validation_packet as JsonRecord
    : gate.validation_packet && typeof gate.validation_packet === 'object'
      ? gate.validation_packet as JsonRecord
      : {}
  const gateDecision = String(gate.decision ?? evidence?.decision ?? '').toUpperCase()
  const packetDecision = String(packet.decision ?? '').toUpperCase()
  if (gateDecision === 'PASS' && packetDecision === 'PASS') return 'PASS'
  if (String(evidence?.decision ?? '').toUpperCase() === 'PASS' && packetDecision === 'PASS') return 'PASS'
  return 'FAIL'
}

export async function ensureParameterCandidateTables(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS parameter_candidate_registry (
        candidate_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        config_hash TEXT,
        sandbox_id TEXT,
        cadence TEXT,
        run_id TEXT,
        status TEXT NOT NULL,
        metadata_json TEXT,
        latest_evidence_json TEXT,
        promotion_packet_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS parameter_candidate_evidence (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        candidate_id TEXT NOT NULL,
        evidence_type TEXT NOT NULL,
        decision TEXT NOT NULL,
        evidence_json TEXT,
        promotion_packet_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS parameter_candidate_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        candidate_id TEXT,
        event_type TEXT NOT NULL,
        detail_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    ),
  ])
}

export async function recordParameterCandidateEvent(
  db: D1Database,
  candidateId: string | null,
  eventType: string,
  detail: JsonRecord | null = null,
): Promise<void> {
  await ensureParameterCandidateTables(db)
  await db.prepare(
    `INSERT INTO parameter_candidate_events (candidate_id, event_type, detail_json)
     VALUES (?, ?, ?)`,
  ).bind(candidateId, eventType, safeJson(detail)).run()
}

export async function recordParameterCandidateFromSandbox(
  db: D1Database,
  input: ParameterCandidateRecordInput,
): Promise<{ candidate_id: string; status: ParameterCandidateStatus }> {
  await ensureParameterCandidateTables(db)
  const source = normalizeParameterCandidateSource(input.source)
  const candidateId = input.candidateId
    ? sanitizeIdPart(input.candidateId)
    : input.sandboxId
      ? candidateIdFromSandbox(source, input.sandboxId)
      : `parameter:${source}:${Date.now()}`
  const status = input.status ?? 'SHADOW_COLLECTING'
  const metadata = {
    schema_version: PARAMETER_CANDIDATE_SCHEMA_VERSION,
    ...(input.metadata ?? {}),
  }

  await db.prepare(
    `INSERT INTO parameter_candidate_registry
       (candidate_id, source, config_hash, sandbox_id, cadence, run_id, status, metadata_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(candidate_id) DO UPDATE SET
       source = excluded.source,
       config_hash = COALESCE(excluded.config_hash, parameter_candidate_registry.config_hash),
       sandbox_id = COALESCE(excluded.sandbox_id, parameter_candidate_registry.sandbox_id),
       cadence = COALESCE(excluded.cadence, parameter_candidate_registry.cadence),
       run_id = COALESCE(excluded.run_id, parameter_candidate_registry.run_id),
       status = excluded.status,
       metadata_json = excluded.metadata_json,
       updated_at = datetime('now')`,
  ).bind(
    candidateId,
    source,
    input.configHash ?? null,
    input.sandboxId ?? null,
    input.cadence ?? null,
    input.runId ?? null,
    status,
    safeJson(metadata),
  ).run()

  await recordParameterCandidateEvent(db, candidateId, 'candidate_registered', {
    source,
    sandbox_id: input.sandboxId ?? null,
    cadence: input.cadence ?? null,
    run_id: input.runId ?? null,
    status,
  })
  return { candidate_id: candidateId, status }
}

export async function recordGaParameterCandidate(
  db: D1Database,
  input: {
    promotionKey?: string
    runId?: string
    cadence?: string
    promotion?: JsonRecord | null
    metadata?: JsonRecord | null
  },
): Promise<{ candidate_id: string; status: ParameterCandidateStatus }> {
  const level = String(input.promotion?.level ?? input.promotion?.approved_level ?? '').trim()
  const status: ParameterCandidateStatus = input.promotion?.approvalRequiredForNextLevel
    ? 'APPROVAL_REQUIRED'
    : 'SHADOW_COLLECTING'
  return recordParameterCandidateFromSandbox(db, {
    source: 'ga_optimizer',
    candidateId: `parameter:ga_optimizer:${sanitizeIdPart(input.promotionKey ?? input.runId ?? String(Date.now()))}`,
    runId: input.runId,
    cadence: input.cadence,
    status,
    metadata: {
      ...(input.metadata ?? {}),
      promotion: input.promotion ?? null,
      level: level || null,
      mutates_trading_config: false,
    },
  })
}

export async function recordParameterCandidateEvidence(
  db: D1Database,
  input: ParameterCandidateEvidenceInput,
): Promise<{ candidate_id: string; status: ParameterCandidateStatus; promotion_packet_id: string | null }> {
  await ensureParameterCandidateTables(db)
  const decision = String(input.decision ?? evidenceDecision(input.evidence)).toUpperCase() === 'PASS' ? 'PASS' : 'FAIL'
  const promotionPacketId = input.promotionPacketId ?? (
    decision === 'PASS' ? `promotion_packet:${sanitizeIdPart(input.candidateId)}:${Date.now()}` : null
  )
  const status: ParameterCandidateStatus = decision === 'PASS' ? 'PROMOTION_READY' : 'VALIDATION_BLOCKED'
  const evidence = {
    schema_version: PARAMETER_CANDIDATE_SCHEMA_VERSION,
    ...(input.evidence ?? {}),
    candidate_id: input.candidateId,
    decision,
    promotion_packet_id: promotionPacketId,
  }

  await db.prepare(
    `INSERT INTO parameter_candidate_evidence
       (candidate_id, evidence_type, decision, evidence_json, promotion_packet_id)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(
    input.candidateId,
    input.evidenceType ?? 'candidate_specific_validation',
    decision,
    safeJson(evidence),
    promotionPacketId,
  ).run()

  await db.prepare(
    `UPDATE parameter_candidate_registry
     SET status = ?, latest_evidence_json = ?, promotion_packet_id = ?, updated_at = datetime('now')
     WHERE candidate_id = ?`,
  ).bind(status, safeJson(evidence), promotionPacketId, input.candidateId).run()

  await recordParameterCandidateEvent(db, input.candidateId, 'candidate_evidence_recorded', {
    decision,
    status,
    promotion_packet_id: promotionPacketId,
    evidence_type: input.evidenceType ?? 'candidate_specific_validation',
  })
  return { candidate_id: input.candidateId, status, promotion_packet_id: promotionPacketId }
}

async function latestCandidateRow(
  db: D1Database,
  candidateId: string,
): Promise<{
  candidate_id: string
  status: string
  latest_evidence_json: string | null
  promotion_packet_id: string | null
} | null> {
  await ensureParameterCandidateTables(db)
  return await db.prepare(
    `SELECT candidate_id, status, latest_evidence_json, promotion_packet_id
     FROM parameter_candidate_registry
     WHERE candidate_id = ?`,
  ).bind(candidateId).first<any>()
}

async function candidateRowByPromotionPacket(
  db: D1Database,
  promotionPacketId: string,
): Promise<{
  candidate_id: string
  status: string
  latest_evidence_json: string | null
  promotion_packet_id: string | null
} | null> {
  await ensureParameterCandidateTables(db)
  return await db.prepare(
    `SELECT candidate_id, status, latest_evidence_json, promotion_packet_id
     FROM parameter_candidate_registry
     WHERE promotion_packet_id = ?`,
  ).bind(promotionPacketId).first<any>()
}

export async function validateParameterCandidateEvidencePacket(
  db: D1Database,
  input: CandidateEvidenceValidationInput,
): Promise<{ ok: boolean; error?: string; candidate_id?: string; promotion_packet_id?: string | null }> {
  const packet = input.evidencePacket ?? null
  const candidateId = String(input.candidateId ?? packet?.candidate_id ?? '').trim()
  if (!candidateId) return { ok: false, error: 'candidate_id_required' }

  if (packet) {
    const packetCandidateId = String(packet.candidate_id ?? '').trim()
    if (packetCandidateId && packetCandidateId !== candidateId) {
      return { ok: false, error: 'candidate_id_evidence_mismatch', candidate_id: candidateId }
    }
    if (evidenceDecision(packet) !== 'PASS') {
      return { ok: false, error: 'evidence_packet_not_pass', candidate_id: candidateId }
    }
    return {
      ok: true,
      candidate_id: candidateId,
      promotion_packet_id: String(packet.promotion_packet_id ?? input.promotionPacketId ?? '') || null,
    }
  }

  const row = await latestCandidateRow(db, candidateId)
  if (!row) return { ok: false, error: 'candidate_not_registered', candidate_id: candidateId }
  if (String(row.status) !== 'PROMOTION_READY') {
    return { ok: false, error: 'candidate_not_promotion_ready', candidate_id: candidateId }
  }
  if (input.promotionPacketId && row.promotion_packet_id !== input.promotionPacketId) {
    return { ok: false, error: 'promotion_packet_mismatch', candidate_id: candidateId }
  }
  const evidence = parseJson(row.latest_evidence_json)
  if (evidenceDecision(evidence) !== 'PASS') {
    return { ok: false, error: 'latest_evidence_not_pass', candidate_id: candidateId }
  }
  return {
    ok: true,
    candidate_id: candidateId,
    promotion_packet_id: row.promotion_packet_id ?? null,
  }
}

export async function validatePromotionPacketForProd(
  db: D1Database,
  input: CandidateEvidenceValidationInput,
): Promise<{ ok: boolean; error?: string; candidate_id?: string; promotion_packet_id?: string | null }> {
  const promotionPacketId = String(input.promotionPacketId ?? '').trim()
  if (!promotionPacketId) return { ok: false, error: 'promotion_packet_id_required' }
  if (!input.candidateId) {
    const row = await candidateRowByPromotionPacket(db, promotionPacketId)
    if (!row) return { ok: false, error: 'promotion_packet_not_found', promotion_packet_id: promotionPacketId }
    return validatePromotionPacketForProd(db, {
      ...input,
      candidateId: row.candidate_id,
    })
  }
  const validation = await validateParameterCandidateEvidencePacket(db, input)
  if (!validation.ok) return validation
  if (validation.promotion_packet_id !== promotionPacketId) {
    return {
      ok: false,
      error: 'promotion_packet_mismatch',
      candidate_id: validation.candidate_id,
      promotion_packet_id: validation.promotion_packet_id,
    }
  }
  return validation
}

export function isExplicitProductionOverride(headerValue: unknown, reason: unknown): boolean {
  return String(headerValue ?? '').trim().toLowerCase() === 'true' && String(reason ?? '').trim().length >= 8
}

export async function recordProductionOverride(
  db: D1Database,
  input: ProductionOverrideInput,
): Promise<{ audit_id: string }> {
  await ensureParameterCandidateTables(db)
  const auditId = `production_override:${Date.now()}`
  await recordParameterCandidateEvent(db, input.candidateId ?? null, 'production_override', {
    audit_id: auditId,
    route: input.route,
    reason: input.reason,
    actor: input.actor ?? null,
    promotion_packet_id: input.promotionPacketId ?? null,
    detail: input.detail ?? null,
  })
  return { audit_id: auditId }
}
