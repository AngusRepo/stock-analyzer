import type { Bindings } from '../types'
import { buildDataQualityReport, daysBetweenDates, type DataQualityCheck, type DataQualityStatus } from './dataQualityMonitor'
import { buildWorkerHealthPayload } from './runtimeVersion'
import { getSchedulerStatus } from './schedulerStatus'

export interface GateCheck {
  id: string
  status: DataQualityStatus
  summary: string
  metrics?: Record<string, unknown>
}

export function summarizeGateChecks(checks: GateCheck[]): DataQualityStatus {
  if (checks.some((check) => check.status === 'fail')) return 'fail'
  if (checks.some((check) => check.status === 'warn')) return 'warn'
  return 'ok'
}

interface FinLabCanonicalFreshnessRow {
  canonical_chip_date?: string | null
  canonical_chip_rows?: number | null
  legacy_chip_date?: string | null
  legacy_chip_rows?: number | null
  margin_date?: string | null
  margin_rows?: number | null
  manifest_generated_at?: string | null
}

interface TableInfoRow {
  name?: string | null
}

function fromDataQuality(check: DataQualityCheck): GateCheck {
  return {
    id: `data_quality.${check.id}`,
    status: check.status,
    summary: check.summary,
    metrics: check.metrics,
  }
}

function latestDate(...values: Array<string | null | undefined>): string | null {
  const dates = values
    .map((value) => typeof value === 'string' ? value.slice(0, 10) : '')
    .filter(Boolean)
    .sort()
  return dates.at(-1) ?? null
}

export function buildFinLabCanonicalD1FreshnessCheck(row: FinLabCanonicalFreshnessRow): GateCheck {
  const canonicalDate = row.canonical_chip_date?.slice(0, 10) ?? null
  const sourceLatestDate = latestDate(row.legacy_chip_date, row.margin_date)
  const lagDays = sourceLatestDate ? daysBetweenDates(canonicalDate, sourceLatestDate) : null
  const canonicalRows = Number(row.canonical_chip_rows ?? 0)
  const legacyRows = Number(row.legacy_chip_rows ?? 0)
  const marginRows = Number(row.margin_rows ?? 0)

  if (!sourceLatestDate) {
    return {
      id: 'finlab_canonical_d1_freshness',
      status: 'warn',
      summary: 'FinLab legacy daily source tables have no latest date for canonical comparison',
      metrics: { ...row, source_latest_date: null },
    }
  }

  if (!canonicalDate) {
    return {
      id: 'finlab_canonical_d1_freshness',
      status: 'fail',
      summary: `canonical_chip_daily missing while source_latest=${sourceLatestDate}`,
      metrics: { ...row, source_latest_date: sourceLatestDate, lag_days: lagDays },
    }
  }

  const stale = lagDays != null && lagDays > 0
  const tooFewRows = canonicalRows < 1000
  const status: DataQualityStatus = stale || tooFewRows ? 'fail' : 'ok'
  return {
    id: 'finlab_canonical_d1_freshness',
    status,
    summary: `canonical_chip_daily latest=${canonicalDate} source_latest=${sourceLatestDate} lag=${lagDays ?? 'n/a'}d rows=${canonicalRows}`,
    metrics: {
      ...row,
      source_latest_date: sourceLatestDate,
      lag_days: lagDays,
      min_canonical_rows: 1000,
      source_rows: { chip_data: legacyRows, margin_data: marginRows },
      required_job_arg: '--apply-canonical-d1',
    },
  }
}

export function buildComputeProfileWaitColumnsCheck(rows: TableInfoRow[]): GateCheck {
  const present = new Set(rows.map((row) => String(row.name ?? '').trim()).filter(Boolean))
  const required = ['await_sec', 'compute_owner', 'remote_function']
  const missing = required.filter((name) => !present.has(name))
  if (missing.length > 0) {
    return {
      id: 'compute_profile_wait_columns',
      status: 'fail',
      summary: `compute_profile_events missing wait attribution columns: ${missing.join(', ')}`,
      metrics: {
        missing,
        required,
        migration: 'worker/migration_compute_profile_events_wait_columns.sql',
      },
    }
  }
  return {
    id: 'compute_profile_wait_columns',
    status: 'ok',
    summary: 'compute_profile_events wait attribution columns are present',
    metrics: { required },
  }
}

async function readFinLabCanonicalD1Freshness(db: D1Database): Promise<FinLabCanonicalFreshnessRow> {
  return await db.prepare(`
    WITH canonical_latest AS (
      SELECT MAX(date) AS date FROM canonical_chip_daily
    ),
    legacy_chip_latest AS (
      SELECT MAX(date) AS date FROM chip_data
    ),
    margin_latest AS (
      SELECT MAX(date) AS date FROM margin_data
    )
    SELECT
      (SELECT date FROM canonical_latest) AS canonical_chip_date,
      (SELECT COUNT(*) FROM canonical_chip_daily WHERE date = (SELECT date FROM canonical_latest)) AS canonical_chip_rows,
      (SELECT date FROM legacy_chip_latest) AS legacy_chip_date,
      (SELECT COUNT(*) FROM chip_data WHERE date = (SELECT date FROM legacy_chip_latest)) AS legacy_chip_rows,
      (SELECT date FROM margin_latest) AS margin_date,
      (SELECT COUNT(*) FROM margin_data WHERE date = (SELECT date FROM margin_latest)) AS margin_rows,
      (SELECT MAX(generated_at)
         FROM finlab_materialization_manifest
        WHERE json_extract(row_counts_json, '$.canonical_chip_daily') IS NOT NULL) AS manifest_generated_at
  `).first<FinLabCanonicalFreshnessRow>() ?? {}
}

async function readComputeProfileWaitColumns(db: D1Database): Promise<TableInfoRow[]> {
  const result = await db.prepare('PRAGMA table_info(compute_profile_events)').all<TableInfoRow>()
  return result.results ?? []
}

export async function buildDeployGateReport(env: Bindings, options: { date?: string; includeLiveController?: boolean } = {}) {
  const [dataQuality, scheduler, finlabCanonicalFreshness, computeProfileWaitColumns] = await Promise.all([
    buildDataQualityReport(env, { date: options.date }),
    getSchedulerStatus(env).catch((error) => ({
      stats: { failed24h: 1, successRate7d: 0 },
      error: error?.message || String(error),
    })),
    readFinLabCanonicalD1Freshness(env.DB)
      .then(buildFinLabCanonicalD1FreshnessCheck)
      .catch((error): GateCheck => ({
        id: 'finlab_canonical_d1_freshness',
        status: 'fail',
        summary: `FinLab canonical D1 freshness check failed: ${error?.message || String(error)}`,
      })),
    readComputeProfileWaitColumns(env.DB)
      .then(buildComputeProfileWaitColumnsCheck)
      .catch((error): GateCheck => ({
        id: 'compute_profile_wait_columns',
        status: 'fail',
        summary: `compute profile wait-column schema check failed: ${error?.message || String(error)}`,
      })),
  ])

  const checks: GateCheck[] = [
    {
      id: 'worker_health_payload',
      status: buildWorkerHealthPayload().status === 'ok' ? 'ok' : 'fail',
      summary: `worker=${buildWorkerHealthPayload().runtimeVersion}`,
    },
    {
      id: 'scheduler_failed_24h',
      status: Number((scheduler as any).stats?.failed24h ?? 0) > 0 ? 'fail' : 'ok',
      summary: `failed24h=${Number((scheduler as any).stats?.failed24h ?? 0)}`,
      metrics: { successRate7d: (scheduler as any).stats?.successRate7d ?? null },
    },
    {
      id: 'control_plane_env',
      status: env.ML_CONTROLLER_URL && env.ML_CONTROLLER_SECRET ? 'ok' : 'fail',
      summary: `ml_controller_url=${env.ML_CONTROLLER_URL ? 'configured' : 'missing'} secret=${env.ML_CONTROLLER_SECRET ? 'configured' : 'missing'}`,
    },
    finlabCanonicalFreshness,
    computeProfileWaitColumns,
    ...dataQuality.checks.map(fromDataQuality),
  ]

  if (options.includeLiveController && env.ML_CONTROLLER_URL) {
    try {
      const resp = await fetch(`${env.ML_CONTROLLER_URL}/health`, {
        headers: env.ML_CONTROLLER_SECRET ? { Authorization: `Bearer ${env.ML_CONTROLLER_SECRET}` } : {},
      })
      checks.push({
        id: 'controller_live_health',
        status: resp.ok ? 'ok' : 'fail',
        summary: `ml-controller /health http ${resp.status}`,
      })
    } catch (error: any) {
      checks.push({
        id: 'controller_live_health',
        status: 'fail',
        summary: `ml-controller /health failed: ${error?.message || String(error)}`,
      })
    }
  }

  return {
    date: dataQuality.date,
    generated_at: new Date().toISOString(),
    decision: summarizeGateChecks(checks) === 'fail' ? 'BLOCK' : summarizeGateChecks(checks) === 'warn' ? 'WARN' : 'PASS',
    status: summarizeGateChecks(checks),
    checks,
    data_quality: dataQuality,
  }
}
