export type HistoricalEvidenceExclusion = {
  signal_date: string
  status: string
  reason: string
  approval_ref: string
  evidence_ref: string
  evidence_sha256: string
  approved_at: string
  source_rows: number
}

/** No automatic waiver: explicit approval, preserved incident evidence, and source absence.
 * If data later appears, closure must stop for review instead of silently accepting it.
 */
export async function loadHistoricalEvidenceExclusions(
  db: D1Database, startDate: string, endDate: string,
): Promise<HistoricalEvidenceExclusion[]> {
  const result = await db.prepare(`
    SELECT d.*,
      (SELECT COUNT(*) FROM strategy_label_matrix_runs_v4 m WHERE m.signal_date=d.signal_date)
      + (SELECT COUNT(*) FROM strategy_label_matrix_v4 m WHERE m.signal_date=d.signal_date)
      + (SELECT COUNT(*) FROM selection_reference_snapshots_v1 r WHERE r.signal_date=d.signal_date)
      + (SELECT COUNT(*) FROM canonical_selection_labels_v4 l WHERE l.signal_date=d.signal_date)
      + (SELECT COUNT(*) FROM strategy_evidence_rebuild_runs_v5 e WHERE e.signal_date=d.signal_date)
      AS source_rows
    FROM strategy_evidence_gap_dispositions_v1 d
    WHERE d.signal_date BETWEEN ? AND ? AND d.status='excluded_missing_source'
  `).bind(startDate,endDate).all<HistoricalEvidenceExclusion>()
  return result.results ?? []
}

export function validHistoricalEvidenceExclusion(row: HistoricalEvidenceExclusion): boolean {
  return row.status === 'excluded_missing_source'
    && /^\d{4}-\d{2}-\d{2}$/.test(row.signal_date)
    && !!row.reason?.trim() && !!row.approval_ref?.trim() && !!row.evidence_ref?.trim()
    && /^[a-f0-9]{64}$/.test(row.evidence_sha256)
    && Number.isFinite(Date.parse(row.approved_at))
    && Date.parse(row.approved_at) <= Date.now()
    && Number(row.source_rows) === 0
}

