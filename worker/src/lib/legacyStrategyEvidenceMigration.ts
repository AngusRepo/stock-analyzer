import type { Bindings } from '../types'
import { retainArtifactHardReference, writeEvidenceArtifact } from './artifactLifecycle'
import { sha256Text } from './datasetSnapshots'
import { checkpointLegacyMigration, loadLegacyMigrationCursor } from './legacyMigrationCursor'

type LegacyStrategyDecisionRow = {
  decision_id: string
  date: string
  symbol: string
  name: string | null
  strategy_id: string
  strategy_version: string
  strategy_status: string
  alpha_bucket: string
  matched: number
  match_score: number | null
  reason_code: string
  context_json: string
  evidence_json: string
  created_at: string
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function contextPointer(input: {
  contextId: string
  artifactId: string
  r2Key: string
  checksum: string
}): string {
  return JSON.stringify({
    schema_version: 'strategy-context-pointer-v1',
    context_id: input.contextId,
    artifact_id: input.artifactId,
    r2_key: input.r2Key,
    checksum: input.checksum,
  })
}

function evidencePointer(input: {
  decisionId: string
  artifactId: string
  r2Key: string
  checksum: string
}): string {
  return JSON.stringify({
    schema_version: 'strategy-evidence-pointer-v1',
    decision_id: input.decisionId,
    artifact_id: input.artifactId,
    r2_key: input.r2Key,
    checksum: input.checksum,
  })
}

export async function runLegacyStrategyEvidenceMigration(
  env: Pick<Bindings, 'DB' | 'ARTIFACTS'>,
  options: { symbolLimit?: number } = {},
): Promise<{
  candidate_contexts: number
  migrated_decisions: number
  artifacts: number
  original_blob_bytes: number
  compact_blob_bytes: number
  backlog_remaining: boolean
}> {
  if (!env.ARTIFACTS) throw new Error('artifact_r2_binding_missing')
  const symbolLimit = Math.max(1, Math.min(Math.floor(options.symbolLimit ?? 20), 40))
  const taskName = 'legacy_strategy_evidence_v2'
  const cursor = await loadLegacyMigrationCursor(env.DB, taskName)
  const cursorDate = cursor?.cursor_date ?? ''
  const cursorSymbol = cursor?.cursor_key ?? ''
  const { results } = await env.DB.prepare(`
    WITH candidate_contexts AS (
      SELECT date, symbol
        FROM strategy_decision_log
       WHERE context_id IS NULL
         AND (date > ? OR (date = ? AND symbol > ?))
       GROUP BY date, symbol
       ORDER BY date ASC, symbol ASC
       LIMIT ?
    )
    SELECT d.decision_id, d.date, d.symbol, d.name, d.strategy_id, d.strategy_version,
           d.strategy_status, d.alpha_bucket, d.matched, d.match_score, d.reason_code,
           d.context_json, d.evidence_json, d.created_at
      FROM strategy_decision_log d
      JOIN candidate_contexts c ON c.date=d.date AND c.symbol=d.symbol
     WHERE d.context_id IS NULL
     ORDER BY d.date ASC, d.symbol ASC, d.strategy_id ASC, d.decision_id ASC
  `).bind(cursorDate, cursorDate, cursorSymbol, symbolLimit).all<LegacyStrategyDecisionRow>()
  const rows = results ?? []
  if (!rows.length) {
    await checkpointLegacyMigration(env.DB, { taskName, status: 'complete' })
    return {
      candidate_contexts: 0, migrated_decisions: 0, artifacts: 0,
      original_blob_bytes: 0, compact_blob_bytes: 0, backlog_remaining: false,
    }
  }
  const contextKeys = [...new Set(rows.map((row) => `${row.date}:${row.symbol}`))]
  const groupedByDate = new Map<string, LegacyStrategyDecisionRow[]>()
  for (const row of rows) {
    const group = groupedByDate.get(row.date) ?? []
    group.push(row)
    groupedByDate.set(row.date, group)
  }

  let artifacts = 0
  let migratedDecisions = 0
  let originalBlobBytes = 0
  let compactBlobBytes = 0
  for (const [date, dateRows] of groupedByDate) {
    const contexts = new Map<string, {
      date: string
      symbol: string
      context_hash: string
      context_json: string
    }>()
    for (const row of dateRows) {
      const contextHash = await sha256Text(row.context_json)
      contexts.set(`${row.symbol}:${contextHash}`, {
        date: row.date,
        symbol: row.symbol,
        context_hash: contextHash,
        context_json: row.context_json,
      })
      originalBlobBytes += new TextEncoder().encode(row.context_json).length
      originalBlobBytes += new TextEncoder().encode(row.evidence_json).length
    }
    const first = dateRows[0]
    const last = dateRows[dateRows.length - 1]
    const artifact = await writeEvidenceArtifact(env, {
      domain: 'legacy_strategy_decision_evidence',
      businessDate: date,
      producerRunId: `legacy-strategy:${date}:${first.decision_id}:${last.decision_id}`,
      retentionClass: 'canonical_model_evidence',
      schemaVersion: 'legacy-strategy-decision-evidence-v2',
      payload: {
        contexts: [...contexts.values()],
        decisions: dateRows.map((row) => ({
          decision_id: row.decision_id,
          date: row.date,
          symbol: row.symbol,
          name: row.name,
          strategy_id: row.strategy_id,
          strategy_version: row.strategy_version,
          strategy_status: row.strategy_status,
          alpha_bucket: row.alpha_bucket,
          matched: row.matched,
          match_score: row.match_score,
          reason_code: row.reason_code,
          evidence_json: row.evidence_json,
          created_at: row.created_at,
        })),
      },
      rowCount: dateRows.length,
      metadata: {
        migration: 'legacy_strategy_decision_hot_json',
        exact_context_count: contexts.size,
        source_rows_preserved: true,
      },
    })
    artifacts += 1

    const contextIdByKey = new Map<string, string>()
    const contextStatements: D1PreparedStatement[] = []
    for (const context of contexts.values()) {
      const digest = context.context_hash.replace(/^sha256:/, '').slice(0, 16)
      const contextId = `strategy-context:${context.date}:${context.symbol}:${digest}`
      contextIdByKey.set(`${context.symbol}:${context.context_hash}`, contextId)
      const parsed = parseJsonObject(context.context_json)
      const candidate = parseJsonObject(JSON.stringify(parsed?.candidate ?? null))
      const rawSignals = parseJsonObject(JSON.stringify(candidate?.raw_signals ?? null)) ?? {}
      if (parsed?.score_v2 !== undefined) rawSignals.score_v2 = parsed.score_v2
      contextStatements.push(env.DB.prepare(`
        INSERT OR IGNORE INTO strategy_candidate_contexts (
          context_id, date, symbol, context_hash, raw_signals_json,
          current_price, industry, artifact_id, r2_key, checksum, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        contextId,
        context.date,
        context.symbol,
        context.context_hash,
        JSON.stringify(rawSignals),
        candidate?.current_price ?? null,
        candidate?.industry ?? null,
        artifact.artifact_id,
        artifact.r2_key,
        artifact.checksum,
        first.created_at,
      ))
    }
    for (let offset = 0; offset < contextStatements.length; offset += 50) {
      await env.DB.batch(contextStatements.slice(offset, offset + 50))
    }

    await retainArtifactHardReference(env.DB, {
      artifactId: artifact.artifact_id,
      ownerType: 'strategy_decision_evidence_batch',
      ownerId: artifact.artifact_id,
    })

    const updateStatements: D1PreparedStatement[] = []
    for (const row of dateRows) {
      const contextHash = await sha256Text(row.context_json)
      const contextId = contextIdByKey.get(`${row.symbol}:${contextHash}`)
      if (!contextId) throw new Error(`legacy_strategy_context_id_missing:${row.decision_id}`)
      const compactContext = contextPointer({
        contextId,
        artifactId: artifact.artifact_id,
        r2Key: artifact.r2_key,
        checksum: artifact.checksum,
      })
      const compactEvidence = evidencePointer({
        decisionId: row.decision_id,
        artifactId: artifact.artifact_id,
        r2Key: artifact.r2_key,
        checksum: artifact.checksum,
      })
      compactBlobBytes += new TextEncoder().encode(compactContext).length
      compactBlobBytes += new TextEncoder().encode(compactEvidence).length
      updateStatements.push(env.DB.prepare(`
        UPDATE strategy_decision_log
           SET context_json=?, evidence_json=?, context_id=?, evidence_artifact_id=?
         WHERE decision_id=?
           AND (context_id IS NULL OR evidence_artifact_id IS NULL)
      `).bind(
        compactContext,
        compactEvidence,
        contextId,
        artifact.artifact_id,
        row.decision_id,
      ))
    }
    for (let offset = 0; offset < updateStatements.length; offset += 50) {
      await env.DB.batch(updateStatements.slice(offset, offset + 50))
    }
    migratedDecisions += dateRows.length
  }

  const lastRow = rows[rows.length - 1]
  const backlogRemaining = contextKeys.length === symbolLimit
  await checkpointLegacyMigration(env.DB, {
    taskName,
    status: backlogRemaining ? 'running' : 'complete',
    cursorDate: lastRow.date,
    cursorKey: lastRow.symbol,
    scannedRows: rows.length,
    archivedRows: migratedDecisions,
  })
  return {
    candidate_contexts: contextKeys.length,
    migrated_decisions: migratedDecisions,
    artifacts,
    original_blob_bytes: originalBlobBytes,
    compact_blob_bytes: compactBlobBytes,
    backlog_remaining: backlogRemaining,
  }
}
