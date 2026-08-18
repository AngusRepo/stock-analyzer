import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'

export const HISTORICAL_SCREENER_ARTIFACT_SOURCE_LABELER = 'strategy-labeler-v1' as const

export type HistoricalScreenerArtifactEvidence = {
  artifact_id: string
  artifact_checksum: string
  producer_run_id: string
  canonical_at: string
  source_labeler_version: typeof HISTORICAL_SCREENER_ARTIFACT_SOURCE_LABELER
  candidate_count: number
  strategy_count: number
  expected_cell_count: number
  matrix_coverage_ratio: number
  regime: 'bull' | 'bear' | 'volatile' | 'sideways' | null
}

type ArtifactIndexRow = {
  artifact_id: string
  r2_key: string
  checksum: string
  canonical_at: string
}

function finiteInteger(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function normalizeRegime(value: unknown): HistoricalScreenerArtifactEvidence['regime'] {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (normalized.startsWith('bull')) return 'bull'
  if (normalized.startsWith('bear')) return 'bear'
  if (normalized.startsWith('volatile')) return 'volatile'
  if (normalized.startsWith('sideway')) return 'sideways'
  return null
}

async function sha256(body: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))
  return `sha256:${[...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')}`
}

export async function loadHistoricalScreenerArtifactEvidence(
  env: Pick<Bindings, 'DB' | 'OPS_DB' | 'ARTIFACTS'>,
  signalDate: string,
  producerRunId: string,
): Promise<HistoricalScreenerArtifactEvidence | null> {
  if (!env.ARTIFACTS || !/^\d{4}-\d{2}-\d{2}$/.test(signalDate) || !producerRunId) return null
  const opsDb = databaseForDataDomain(env as Bindings, 'ops')
  const row = await opsDb.prepare(`
    SELECT a.artifact_id, a.r2_key, a.checksum, p.canonical_at
      FROM pipeline_runs p
      JOIN run_artifacts a ON a.producer_run_id=p.run_id
     WHERE p.run_id=? AND p.business_date=? AND p.domain='screener'
       AND p.canonical_at IS NOT NULL
       AND a.domain='screener_funnel' AND a.status='ready'
       AND a.schema_version='screener-funnel-evidence-index-v1'
       AND a.payload_deleted_at IS NULL
     ORDER BY a.created_at DESC
     LIMIT 1
  `).bind(producerRunId, signalDate).first<ArtifactIndexRow>().catch(() => null)
  if (!row?.r2_key || !row.checksum || !row.canonical_at) return null

  const object = await (env.ARTIFACTS as any).get(row.r2_key).catch(() => null)
  if (!object) return null
  const body = await object.text().catch(() => '')
  if (!body || await sha256(body) !== row.checksum) return null

  let manifest: any
  try {
    manifest = JSON.parse(body)
  } catch {
    return null
  }
  const strategyPool = manifest?.payload?.payload_header?.metadata?.strategyCandidatePool
  const telemetry = strategyPool?.layer1_telemetry ?? strategyPool?.telemetry ?? {}
  const sourceLabeler = String(
    strategyPool?.strategy_labeler_version ?? telemetry?.strategy_labeler_version ?? '',
  ).trim()
  const candidateCount = finiteInteger(
    strategyPool?.strategy_matrix_candidate_count ?? telemetry?.strategy_matrix_candidate_count,
  )
  const strategyCount = finiteInteger(
    strategyPool?.strategy_matrix_strategy_count ?? telemetry?.strategy_matrix_strategy_count,
  )
  const expectedCellCount = finiteInteger(
    strategyPool?.strategy_matrix_expected_cell_count ?? telemetry?.strategy_matrix_expected_cell_count,
  )
  const coverageRatio = Number(
    strategyPool?.strategy_matrix_coverage_ratio ?? telemetry?.strategy_matrix_coverage_ratio,
  )
  if (
    manifest?.schema_version !== 'screener-funnel-evidence-index-v1'
    || manifest?.business_date !== signalDate
    || manifest?.payload?.storage_mode !== 'chunked_r2_manifest_v1'
    || manifest?.payload?.logical_schema_version !== 'screener-funnel-evidence-v3'
    || sourceLabeler !== HISTORICAL_SCREENER_ARTIFACT_SOURCE_LABELER
    || candidateCount == null
    || strategyCount == null
    || expectedCellCount !== candidateCount * strategyCount
    || coverageRatio !== 1
  ) return null

  return {
    artifact_id: row.artifact_id,
    artifact_checksum: row.checksum,
    producer_run_id: producerRunId,
    canonical_at: row.canonical_at,
    source_labeler_version: HISTORICAL_SCREENER_ARTIFACT_SOURCE_LABELER,
    candidate_count: candidateCount,
    strategy_count: strategyCount,
    expected_cell_count: expectedCellCount,
    matrix_coverage_ratio: coverageRatio,
    regime: normalizeRegime(strategyPool?.strategy_portfolio_metrics?.regime),
  }
}
