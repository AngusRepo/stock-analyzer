import type { Bindings } from '../types'
import { controllerJson } from './controllerClient'
import type { ResearchEvaluationPlan, ResearchEvaluationStep } from './researchEvaluationPlan'

const SAFE_RESEARCH_ENDPOINTS = new Set([
  '/backtest/replay',
  '/walk_forward/dry-run',
  '/verify/dry-run',
  '/research/model-benchmark/dry-run',
])

export interface ResearchEvaluationRunResult {
  step_id: string
  kind: ResearchEvaluationStep['kind']
  endpoint: string | null
  status: 'ok' | 'skipped' | 'error'
  response?: unknown
  reason?: string
}

export interface ResearchEvaluationRunReport {
  success: boolean
  mode: 'dry_run_execution'
  experiment_id: string
  verdict: 'ready_for_review' | 'needs_attention'
  review_packet: string
  results: ResearchEvaluationRunResult[]
}

export interface StoredResearchEvaluationRunReport extends ResearchEvaluationRunReport {
  id: string
  created_at: string
}

export const RESEARCH_EVALUATION_RUN_PREFIX = 'research:evaluation_run:'

function evaluationRunPrefix(experimentId: string): string {
  return `${RESEARCH_EVALUATION_RUN_PREFIX}${experimentId}:`
}

function evaluationRunKey(experimentId: string, createdAt: string): string {
  return `${evaluationRunPrefix(experimentId)}${createdAt}`
}

function canExecuteStep(step: ResearchEvaluationStep): string | null {
  if (step.mutation_allowed !== false) return 'mutation_not_allowed'
  if (step.gate_decision !== 'ALLOW') return `gate_${step.gate_decision.toLowerCase()}`
  if (!step.execution_ready) return step.block_reason ?? 'execution_not_ready'
  if (!step.controller_endpoint) return 'controller_endpoint_missing'
  if (!SAFE_RESEARCH_ENDPOINTS.has(step.controller_endpoint)) return `unsafe_endpoint:${step.controller_endpoint}`
  return null
}

function buildResearchEvaluationReviewPacket(report: Omit<ResearchEvaluationRunReport, 'review_packet'>): string {
  const ok = report.results.filter((result) => result.status === 'ok').length
  const skipped = report.results.filter((result) => result.status === 'skipped').length
  const errors = report.results.filter((result) => result.status === 'error').length
  const benchmarkLines = report.results
    .filter((result) => result.kind === 'model_benchmark')
    .map((result) => {
      const response = result.response && typeof result.response === 'object'
        ? result.response as Record<string, unknown>
        : {}
      const candidate = String(response.candidate_id ?? response.candidate ?? result.step_id.split(':').pop() ?? 'unknown')
      const status = String(response.status ?? result.status)
      const evidence = response.benchmark_report && typeof response.benchmark_report === 'object'
        ? response.benchmark_report as Record<string, unknown>
        : response
      const oosIc = evidence.oos_ic_mean ?? evidence.oos_ic ?? null
      const pbo = evidence.pbo ?? evidence.cpcv_pbo ?? null
      const cost = evidence.cost_sensitivity && typeof evidence.cost_sensitivity === 'object'
        ? (evidence.cost_sensitivity as Record<string, unknown>).status ?? 'available'
        : 'missing'
      const blockers = Array.isArray(response.blockers)
        ? ` blockers=${response.blockers.join(',')}`
        : ''
      return `benchmark ${candidate}: status=${status}, oos_ic=${oosIc ?? 'missing'}, pbo=${pbo ?? 'missing'}, cost=${cost}${blockers}`
    })
  const lines = [
    `Research evaluation review: ${report.experiment_id}`,
    `verdict=${report.verdict}`,
    `steps=${report.results.length}, ok=${ok}, skipped=${skipped}, error=${errors}`,
    ...benchmarkLines,
    `next=${report.verdict === 'ready_for_review' ? 'manual review packet can be inspected; no production action is allowed by this runner' : 'fix skipped/error steps before any strategy review'}`,
  ]
  return lines.join('\n')
}

function finalizeResearchEvaluationRunReport(
  experimentId: string,
  results: ResearchEvaluationRunResult[],
): ResearchEvaluationRunReport {
  const success = results.every((result) => result.status === 'ok')
  const partial: Omit<ResearchEvaluationRunReport, 'review_packet'> = {
    success,
    mode: 'dry_run_execution',
    experiment_id: experimentId,
    verdict: success ? 'ready_for_review' : 'needs_attention',
    results,
  }
  return {
    ...partial,
    review_packet: buildResearchEvaluationReviewPacket(partial),
  }
}

export async function runResearchEvaluationPlan(
  env: Bindings,
  plan: ResearchEvaluationPlan,
  stepIds?: string[],
): Promise<ResearchEvaluationRunReport> {
  const selected = stepIds?.length ? new Set(stepIds) : null
  const results: ResearchEvaluationRunResult[] = []

  for (const step of plan.steps) {
    if (selected && !selected.has(step.id)) continue

    const skipReason = canExecuteStep(step)
    if (skipReason) {
      results.push({
        step_id: step.id,
        kind: step.kind,
        endpoint: step.controller_endpoint,
        status: 'skipped',
        reason: skipReason,
      })
      continue
    }

    try {
      const response = await controllerJson<unknown>(env, step.controller_endpoint, {
        method: step.method,
        jsonBody: {
          ...step.body,
          mutation_allowed: false,
          dry_run: true,
        },
        timeoutMs: 300_000,
      })
      results.push({
        step_id: step.id,
        kind: step.kind,
        endpoint: step.controller_endpoint,
        status: 'ok',
        response,
      })
    } catch (error: unknown) {
      results.push({
        step_id: step.id,
        kind: step.kind,
        endpoint: step.controller_endpoint,
        status: 'error',
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return finalizeResearchEvaluationRunReport(plan.experiment_id, results)
}

export async function putResearchEvaluationRunReport(
  kv: KVNamespace,
  report: ResearchEvaluationRunReport,
): Promise<StoredResearchEvaluationRunReport> {
  const createdAt = new Date().toISOString()
  const stored: StoredResearchEvaluationRunReport = {
    ...report,
    id: evaluationRunKey(report.experiment_id, createdAt),
    created_at: createdAt,
  }
  await kv.put(stored.id, JSON.stringify(stored))
  return stored
}

export async function listResearchEvaluationRunReports(
  kv: KVNamespace,
  experimentId: string,
  limit = 20,
): Promise<StoredResearchEvaluationRunReport[]> {
  const { keys } = await kv.list({ prefix: evaluationRunPrefix(experimentId), limit })
  const rows = await Promise.all(
    keys.map(async (key) => kv.get(key.name, 'json') as Promise<StoredResearchEvaluationRunReport | null>),
  )
  return rows
    .filter((row): row is StoredResearchEvaluationRunReport => Boolean(row))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
}
