function cleanRepairValue(value: unknown): string {
  return String(value ?? '').trim()
}

function canonicalRepairScoreV2(value: unknown): string | null {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    return parsed && typeof parsed === 'object' && String((parsed as any).version ?? '') === 'score_v2'
      ? JSON.stringify(parsed)
      : null
  } catch {
    return null
  }
}

function parseRepairObject(value: unknown): Record<string, unknown> | null {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

export interface SelectionReferenceRepairResult {
  signal_date: string
  producer_run_id: string
  source_artifact_id: string
  source_artifact_checksum: string
  source_artifact_schema: 'screener-funnel-evidence-v2' | 'screener-funnel-evidence-v3'
  expected_rows: number
  persisted_rows: number
  strategy_matrix_status: 'unavailable'
  dry_run: boolean
}

export const SELECTION_REFERENCE_RECONSTRUCTION_VERSION =
  'selection-reference-historical-reconstruction-v1'

export async function repairHistoricalSelectionReferences(
  db: D1Database,
  signalDate: string,
  options: { dryRun?: boolean } = {},
): Promise<SelectionReferenceRepairResult> {
  if (signalDate.length !== 10 || Number.isNaN(Date.parse(signalDate + 'T00:00:00Z'))) {
    throw new Error('selection_reference_repair_invalid_date')
  }
  const source = await db.prepare(`
    SELECT h.run_id producer_run_id, sfr.candidate_count expected_rows,
           ra.artifact_id source_artifact_id, ra.checksum source_artifact_checksum,
           ra.schema_version source_artifact_schema
      FROM canonical_run_heads h
      JOIN pipeline_runs p ON p.run_id=h.run_id AND p.status='canonical'
      JOIN screener_funnel_runs sfr
        ON sfr.run_id=h.run_id AND sfr.date=? AND sfr.status='success'
      JOIN run_artifacts ra
        ON ra.producer_run_id=h.run_id AND ra.domain='screener_funnel'
       AND ra.business_date=? AND ra.status='ready'
       AND ra.schema_version IN ('screener-funnel-evidence-v2', 'screener-funnel-evidence-v3')
       AND ra.checksum_verified_at IS NOT NULL
     WHERE h.logical_run_key='screener:' || ? || ':TW:production:market_screener'
     ORDER BY ra.created_at DESC
     LIMIT 1
  `).bind(signalDate, signalDate, signalDate).first<any>()
  const producerRunId = cleanRepairValue(source?.producer_run_id)
  const artifactId = cleanRepairValue(source?.source_artifact_id)
  const artifactChecksum = cleanRepairValue(source?.source_artifact_checksum)
  const artifactSchema = cleanRepairValue(source?.source_artifact_schema) as SelectionReferenceRepairResult['source_artifact_schema']
  const expectedRows = Math.max(0, Number(source?.expected_rows ?? 0))
  if (!producerRunId || !artifactId || !artifactChecksum || !artifactSchema || expectedRows <= 0) {
    throw new Error(`selection_reference_repair_canonical_artifact_unavailable:${signalDate}`)
  }

  const coverage = await db.prepare(`
    SELECT COUNT(*) row_count, COUNT(DISTINCT symbol) symbol_count,
           SUM(CASE WHEN decision='pass' THEN 1 ELSE 0 END) pass_count,
           SUM(CASE WHEN json_valid(evidence)=1 THEN 1 ELSE 0 END) valid_evidence_count,
           SUM(CASE WHEN json_extract(json_extract(evidence, '$.score_components'), '$.version')='score_v2'
                    THEN 1 ELSE 0 END) score_v2_count
      FROM screener_funnel_items
     WHERE run_id=? AND date=? AND stage='scoring'
  `).bind(producerRunId, signalDate).first<any>()
  const coverageCounts = [
    Number(coverage?.row_count ?? 0),
    Number(coverage?.symbol_count ?? 0),
    Number(coverage?.pass_count ?? 0),
    Number(coverage?.valid_evidence_count ?? 0),
    Number(coverage?.score_v2_count ?? 0),
  ]
  if (coverageCounts.some((count) => count !== expectedRows)) {
    throw new Error(`selection_reference_repair_scoring_coverage_mismatch:${coverageCounts.join('/')}/${expectedRows}`)
  }

  const existing = await db.prepare(`
    SELECT COUNT(*) row_count, COUNT(DISTINCT producer_run_id) run_count,
           COUNT(DISTINCT source_artifact_checksum) checksum_count,
           SUM(CASE WHEN stock_id IS NOT NULL THEN 1 ELSE 0 END) identity_count,
           MIN(producer_run_id) producer_run_id,
           MIN(source_artifact_checksum) source_artifact_checksum
      FROM selection_reference_snapshots_v1
     WHERE signal_date=?
  `).bind(signalDate).first<any>()
  const existingRows = Number(existing?.row_count ?? 0)
  if (existingRows > 0) {
    const idempotent = existingRows === expectedRows
      && Number(existing?.run_count ?? 0) === 1
      && Number(existing?.checksum_count ?? 0) === 1
      && Number(existing?.identity_count ?? 0) === expectedRows
      && cleanRepairValue(existing?.producer_run_id) === producerRunId
      && cleanRepairValue(existing?.source_artifact_checksum) === artifactChecksum
    if (!idempotent) throw new Error(`selection_reference_repair_immutable_conflict:${signalDate}`)
    return {
      signal_date: signalDate,
      producer_run_id: producerRunId,
      source_artifact_id: artifactId,
      source_artifact_checksum: artifactChecksum,
      source_artifact_schema: artifactSchema,
      expected_rows: expectedRows,
      persisted_rows: existingRows,
      strategy_matrix_status: 'unavailable',
      dry_run: Boolean(options.dryRun),
    }
  }

  const result = {
    signal_date: signalDate,
    producer_run_id: producerRunId,
    source_artifact_id: artifactId,
    source_artifact_checksum: artifactChecksum,
    source_artifact_schema: artifactSchema,
    expected_rows: expectedRows,
    persisted_rows: 0,
    strategy_matrix_status: 'unavailable' as const,
    dry_run: Boolean(options.dryRun),
  }
  if (options.dryRun) return result

  await db.prepare(`
    INSERT INTO selection_reference_repair_runs_v1 (
      signal_date, producer_run_id, status, expected_rows, persisted_rows,
      source_artifact_id, source_artifact_checksum, source_artifact_schema, strategy_matrix_status
    ) VALUES (?, ?, 'writing', ?, 0, ?, ?, ?, 'unavailable')
    ON CONFLICT(signal_date, producer_run_id) DO UPDATE SET
      status='writing', error_code=NULL, updated_at=CURRENT_TIMESTAMP
  `).bind(signalDate, producerRunId, expectedRows, artifactId, artifactChecksum, artifactSchema).run()

  try {
    let afterId = 0
    let sourceRows = 0
    for (;;) {
      const page = await db.prepare(`
        SELECT i.id, i.symbol, i.name, i.score_after, i.evidence,
               st.id stock_id, st.market market_segment, st.sector,
               EXISTS (
                 SELECT 1 FROM stock_prices sp
                  WHERE sp.stock_id=st.id AND date(sp.date)=date(i.date)
                    AND sp.open>0 AND sp.high>0 AND sp.low>0 AND sp.close>0
               ) price_available
          FROM screener_funnel_items i
          LEFT JOIN stocks st ON st.symbol=i.symbol
         WHERE i.run_id=? AND i.date=? AND i.stage='scoring'
           AND i.decision='pass' AND i.id>?
         ORDER BY i.id
         LIMIT 150
      `).bind(producerRunId, signalDate, afterId).all<any>()
      const rows = page.results ?? []
      if (!rows.length) break
      const statements = rows.map((row: any) => {
        const stockId = Number(row.stock_id)
        if (!Number.isInteger(stockId) || stockId <= 0) {
          throw new Error(`selection_reference_repair_stock_identity_missing:${row.symbol}`)
        }
        const evidence = parseRepairObject(row.evidence)
        const scoreComponents = canonicalRepairScoreV2(evidence?.score_components)
        return db.prepare(`
          INSERT OR IGNORE INTO selection_reference_snapshots_v1 (
            signal_date, symbol, producer_run_id, stock_id, name, market_segment, sector,
            hard_gate_passed, hard_gate_reason, feature_available, feature_rejection_reason,
            strategy_labeled, strategy_selected, ml_selected, l4_selected,
            ev_owner_available, final_signal, selection_stage, rejection_reason,
            selection_propensity, score_v2, score_components, allocation_selected,
            decision_evidence_reconciled_at, strategy_labeler_version,
            strategy_router_version, strategy_registry_checksum,
            feature_contract_version, evidence_artifact_id, reference_source,
            strategy_matrix_status, reconstruction_reason, source_artifact_checksum
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'canonical_scoring_pass', ?, ?,
                    0, 0, 0, 0, 0, NULL, 'l0_reference_reconstructed',
                    'strategy_matrix_point_in_time_evidence_unavailable', 1.0, ?, ?, 0,
                    NULL, NULL, NULL, 'unavailable:historical-pre-v4', ?, ?,
                    'historical_reconstruction', 'unavailable',
                    'canonical_l0_preserved_but_v4_strategy_vectors_absent', ?)
        `).bind(
          signalDate, cleanRepairValue(row.symbol), producerRunId, stockId,
          cleanRepairValue(row.name) || null, cleanRepairValue(row.market_segment) || null,
          cleanRepairValue(row.sector) || null, scoreComponents ? 1 : 0,
          scoreComponents ? null : 'score_v2_components_missing_or_invalid',
          Number.isFinite(Number(row.score_after)) ? Number(row.score_after) : null,
          scoreComponents, SELECTION_REFERENCE_RECONSTRUCTION_VERSION,
          artifactId, artifactChecksum,
        )
      })
      await db.batch(statements)
      sourceRows += rows.length
      afterId = Number(rows.at(-1).id)
      if (rows.length < 150) break
    }
    const finalCount = await db.prepare(`
      SELECT COUNT(*) row_count
        FROM selection_reference_snapshots_v1
       WHERE signal_date=? AND producer_run_id=?
         AND reference_source='historical_reconstruction'
         AND strategy_labeled=0 AND strategy_matrix_status='unavailable'
         AND source_artifact_checksum=?
    `).bind(signalDate, producerRunId, artifactChecksum).first<any>()
    const persistedRows = Number(finalCount?.row_count ?? 0)
    if (sourceRows !== expectedRows || persistedRows !== expectedRows) {
      throw new Error(`selection_reference_repair_persisted_coverage_mismatch:${sourceRows}/${persistedRows}/${expectedRows}`)
    }
    await db.prepare(`
      UPDATE selection_reference_repair_runs_v1
         SET status='ready', persisted_rows=?, updated_at=CURRENT_TIMESTAMP
       WHERE signal_date=? AND producer_run_id=? AND status='writing'
    `).bind(persistedRows, signalDate, producerRunId).run()
    return { ...result, persisted_rows: persistedRows, dry_run: false }
  } catch (error) {
    await db.prepare(`
      UPDATE selection_reference_repair_runs_v1
         SET status='failed', error_code=?, updated_at=CURRENT_TIMESTAMP
       WHERE signal_date=? AND producer_run_id=?
    `).bind(
      error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      signalDate,
      producerRunId,
    ).run().catch(() => {})
    throw error
  }
}


export interface SelectionReferenceIdentityRepairResult {
  run_id: string
  start_date: string
  end_date: string
  expected_rows: number
  missing_before: number
  repaired_rows: number
  missing_after: number
  dry_run: boolean
}

type ReferenceIdentityRow = {
  signal_date: string
  symbol: string
  producer_run_id: string
  stock_id: number | null
}

function assertRepairDate(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value + 'T00:00:00Z'))) {
    throw new Error(`selection_reference_identity_repair_invalid_${field}`)
  }
  return value
}

export async function repairSelectionReferenceStockIdentities(
  coreDb: D1Database,
  learningDb: D1Database,
  options: { startDate: string; endDate: string; dryRun?: boolean },
): Promise<SelectionReferenceIdentityRepairResult> {
  const startDate = assertRepairDate(options.startDate, 'start_date')
  const endDate = assertRepairDate(options.endDate, 'end_date')
  if (startDate > endDate) throw new Error('selection_reference_identity_repair_invalid_range')
  const rows: ReferenceIdentityRow[] = []
  let cursorDate = ''
  let cursorSymbol = ''
  let cursorRunId = ''
  for (;;) {
    const page = await learningDb.prepare(`
      SELECT signal_date, symbol, producer_run_id, stock_id
        FROM selection_reference_snapshots_v1
       WHERE signal_date >= ? AND signal_date <= ? AND hard_gate_passed=1
         AND (
           signal_date > ?
           OR (signal_date = ? AND symbol > ?)
           OR (signal_date = ? AND symbol = ? AND producer_run_id > ?)
         )
       ORDER BY signal_date, symbol, producer_run_id
       LIMIT 400
    `).bind(
      startDate, endDate,
      cursorDate, cursorDate, cursorSymbol,
      cursorDate, cursorSymbol, cursorRunId,
    ).all<ReferenceIdentityRow>()
    const pageRows = page.results ?? []
    rows.push(...pageRows)
    if (pageRows.length < 400) break
    const last = pageRows.at(-1)!
    cursorDate = last.signal_date
    cursorSymbol = last.symbol
    cursorRunId = last.producer_run_id
  }

  const symbols = [...new Set(rows.map((row) => cleanRepairValue(row.symbol)).filter(Boolean))]
  const stockIds = new Map<string, number>()
  for (let offset = 0; offset < symbols.length; offset += 80) {
    const chunk = symbols.slice(offset, offset + 80)
    const placeholders = chunk.map(() => '?').join(',')
    const result = await coreDb.prepare(`
      SELECT id, symbol FROM stocks WHERE symbol IN (${placeholders})
    `).bind(...chunk).all<{ id: number; symbol: string }>()
    for (const row of result.results ?? []) {
      const stockId = Number(row.id)
      if (Number.isInteger(stockId) && stockId > 0) stockIds.set(cleanRepairValue(row.symbol), stockId)
    }
  }
  const missingSymbols = symbols.filter((symbol) => !stockIds.has(symbol))
  if (missingSymbols.length) {
    throw new Error(`selection_reference_identity_repair_unresolved_symbols:${missingSymbols.slice(0, 20).join(',')}`)
  }
  for (const row of rows) {
    const expected = stockIds.get(cleanRepairValue(row.symbol))!
    const actual = Number(row.stock_id)
    if (Number.isInteger(actual) && actual > 0 && actual !== expected) {
      throw new Error(`selection_reference_identity_repair_conflict:${row.signal_date}:${row.symbol}:${actual}/${expected}`)
    }
  }

  const missingRows = rows.filter((row) => row.stock_id == null)
  const runId = `selection-reference-identity-${startDate}-${endDate}-${Date.now().toString(36)}`
  const result: SelectionReferenceIdentityRepairResult = {
    run_id: runId,
    start_date: startDate,
    end_date: endDate,
    expected_rows: rows.length,
    missing_before: missingRows.length,
    repaired_rows: options.dryRun ? 0 : missingRows.length,
    missing_after: options.dryRun ? missingRows.length : 0,
    dry_run: Boolean(options.dryRun),
  }
  if (options.dryRun) return result

  await learningDb.prepare(`
    INSERT INTO selection_reference_identity_repair_runs_v1 (
      run_id, start_date, end_date, status, expected_rows, missing_before
    ) VALUES (?, ?, ?, 'running', ?, ?)
  `).bind(runId, startDate, endDate, rows.length, missingRows.length).run()
  try {
    const statements = missingRows.map((row) => learningDb.prepare(`
      UPDATE selection_reference_snapshots_v1
         SET stock_id=?
       WHERE signal_date=? AND symbol=? AND producer_run_id=? AND stock_id IS NULL
    `).bind(stockIds.get(cleanRepairValue(row.symbol)), row.signal_date, row.symbol, row.producer_run_id))
    for (let offset = 0; offset < statements.length; offset += 200) {
      await learningDb.batch(statements.slice(offset, offset + 200))
    }
    const coverage = await learningDb.prepare(`
      SELECT COUNT(*) expected_rows,
             SUM(CASE WHEN stock_id IS NULL THEN 1 ELSE 0 END) missing_rows
        FROM selection_reference_snapshots_v1
       WHERE signal_date >= ? AND signal_date <= ? AND hard_gate_passed=1
    `).bind(startDate, endDate).first<{ expected_rows: number; missing_rows: number }>()
    const expectedRows = Number(coverage?.expected_rows ?? 0)
    const missingAfter = Number(coverage?.missing_rows ?? 0)
    if (expectedRows !== rows.length || missingAfter !== 0) {
      throw new Error(`selection_reference_identity_repair_coverage_failed:${expectedRows}/${rows.length}:missing=${missingAfter}`)
    }
    await learningDb.prepare(`
      UPDATE selection_reference_identity_repair_runs_v1
         SET status='success', repaired_rows=?, missing_after=0, completed_at=CURRENT_TIMESTAMP
       WHERE run_id=?
    `).bind(missingRows.length, runId).run()
    return { ...result, expected_rows: expectedRows, missing_after: 0 }
  } catch (error) {
    await learningDb.prepare(`
      UPDATE selection_reference_identity_repair_runs_v1
         SET status='error', last_error=?, completed_at=CURRENT_TIMESTAMP
       WHERE run_id=?
    `).bind(error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500), runId).run().catch(() => {})
    throw error
  }
}
