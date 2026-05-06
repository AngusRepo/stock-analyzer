import type { Bindings } from '../types'
import { buildDataQualityReport, type DataQualityCheck, type DataQualityStatus } from './dataQualityMonitor'
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

function fromDataQuality(check: DataQualityCheck): GateCheck {
  return {
    id: `data_quality.${check.id}`,
    status: check.status,
    summary: check.summary,
    metrics: check.metrics,
  }
}

export async function buildDeployGateReport(env: Bindings, options: { date?: string; includeLiveController?: boolean } = {}) {
  const [dataQuality, scheduler] = await Promise.all([
    buildDataQualityReport(env, { date: options.date }),
    getSchedulerStatus(env).catch((error) => ({
      stats: { failed24h: 1, successRate7d: 0 },
      error: error?.message || String(error),
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
