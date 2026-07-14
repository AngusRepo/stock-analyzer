import type { Bindings } from '../types'
import { AI_BUDGET, EXPECTED_FEATURE_COUNT, EXPECTED_STRATEGY_COUNT, MODEL_REGISTRY } from './config'
import type { DashboardState } from './domain'
import { loadFeatureRegistrySnapshot } from './featureRegistry'
import { hashJson } from './hashing'
import { StrategyDiscoveryArtifacts } from './artifacts'
import { resolveButtonState } from './buttonState'
import { StrategyDiscoveryRepository } from './repositories'
import { buildStrategyRegistrySnapshot } from './strategyRegistry'

const ACTIVE_STATUSES = new Set(['CREATED', 'PREFLIGHT', 'RUNNING'])
const STALE_AFTER_MS = 15 * 60 * 1000

function utcDay(now: Date): string { return now.toISOString().slice(0, 10) }

function artifactMetadata(value: { metadata_json?: string } | null): Record<string, unknown> {
  try { return value?.metadata_json ? JSON.parse(value.metadata_json) as Record<string, unknown> : {} } catch { return {} }
}

async function externalReservation(env: Bindings, day: string): Promise<{ value: number; configured: boolean }> {
  const key = `strategy-discovery:external-neurons:${day}`
  const fromKv = await env.KV.get(key, 'text').catch(() => null)
  const raw = fromKv ?? env.STRATEGY_DISCOVERY_EXTERNAL_RESERVED_NEURONS
  const number = Number(raw)
  return { value: Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0, configured: raw != null && raw !== '' }
}

async function workflowLooksStale(env: Bindings, run: Awaited<ReturnType<StrategyDiscoveryRepository['latestRun']>>, now: Date): Promise<boolean> {
  if (!run || !ACTIVE_STATUSES.has(run.status)) return false
  const heartbeat = run.heartbeat_at ? Date.parse(run.heartbeat_at) : Date.parse(run.updated_at)
  if (Number.isFinite(heartbeat) && now.getTime() - heartbeat <= STALE_AFTER_MS) return false
  if (!run.workflow_instance_id || !env.STRATEGY_DISCOVERY_WORKFLOW) return true
  try {
    const instance = await env.STRATEGY_DISCOVERY_WORKFLOW.get(run.workflow_instance_id)
    const status = await instance.status()
    return !['running', 'queued', 'waiting', 'paused'].includes(String(status.status).toLowerCase())
  } catch { return true }
}

export async function analyzeCurrentState(env: Bindings, now = new Date()): Promise<DashboardState> {
  const repository = new StrategyDiscoveryRepository(env.DB)
  const warnings: string[] = []
  const blockers: string[] = []
  if (env.STRATEGY_DISCOVERY_ENABLED === '0') blockers.push('Strategy Discovery Lab disabled')
  if (!env.ARTIFACTS) blockers.push('R2 ARTIFACTS binding 不存在')
  if (!env.AI) blockers.push('Workers AI binding 不存在')
  if (!env.STRATEGY_DISCOVERY_WORKFLOW) blockers.push('Strategy Discovery Workflow binding 不存在')

  let featureSnapshot: Awaited<ReturnType<typeof loadFeatureRegistrySnapshot>> | null = null
  let strategySnapshot: Awaited<ReturnType<typeof buildStrategyRegistrySnapshot>> | null = null
  try { strategySnapshot = await buildStrategyRegistrySnapshot(await repository.activeStrategyRows()) }
  catch (error) { blockers.push(error instanceof Error ? error.message : String(error)) }
  try { featureSnapshot = await loadFeatureRegistrySnapshot(strategySnapshot?.featureUsage ?? {}) }
  catch (error) { blockers.push(error instanceof Error ? error.message : String(error)) }
  if (featureSnapshot && featureSnapshot.cards.length !== EXPECTED_FEATURE_COUNT) blockers.push(`Feature Pool 必須為 ${EXPECTED_FEATURE_COUNT}`)
  if (strategySnapshot && strategySnapshot.cards.length !== EXPECTED_STRATEGY_COUNT) blockers.push(`現有策略必須為 ${EXPECTED_STRATEGY_COUNT}`)
  const regimeEvidence = await repository.regimeSampleEvidence().catch(() => [])
  if (regimeEvidence.filter((row) => row.max_samples > 0).length < 2) blockers.push('Mode D 需要至少兩個有真實樣本證據的固定 Regime')

  const uniqueModels = [...new Set(Object.values(MODEL_REGISTRY).map((config) => config.model))]
  const availability = await Promise.all(uniqueModels.map(async (model) => {
    const cached = await env.KV.get(`strategy-discovery:model-availability:${model}`, 'json').catch(() => null) as { ok?: boolean; error?: string } | null
    return { model, cached }
  }))
  for (const status of availability) {
    if (status.cached?.ok === false) blockers.push(`必要模型 unavailable：${status.model}${status.cached.error ? `（${status.cached.error}）` : ''}`)
    else if (!status.cached) warnings.push(`必要模型尚無近期 availability probe：${status.model}`)
  }

  const day = utcDay(now)
  const knownUsed = await repository.knownUsedNeurons(day).catch(() => 0)
  const reservation = await externalReservation(env, day)
  if (env.STRATEGY_DISCOVERY_REQUIRE_EXTERNAL_USAGE_RESERVATION === '1' && !reservation.configured) {
    blockers.push('Workers AI 非 Lab 用量保留值尚未設定')
  } else if (!reservation.configured) warnings.push('Workers AI 用量為 Lab ledger 範圍；未設定外部用量保留值')
  const safeRemaining = Math.max(0, AI_BUDGET.dailySoftLimit - knownUsed - reservation.value)
  if (safeRemaining < AI_BUDGET.preflightReservationNeurons) {
    blockers.push(`預估完整分析需要 ${AI_BUDGET.preflightReservationNeurons} Neurons；目前安全餘額為 ${safeRemaining} Neurons`)
  }

  const latestRun = await repository.latestRun().catch(() => null)
  const staleWorkflow = await workflowLooksStale(env, latestRun, now)
  if (staleWorkflow) warnings.push('偵測到 stale Workflow，可從最後 checkpoint 恢復')
  let bundleReady = false
  let resultReady = false
  let artifactMismatch = false
  let bundleManifest: Awaited<ReturnType<StrategyDiscoveryRepository['artifact']>> = null
  if (latestRun && env.ARTIFACTS) {
    const artifactStore = new StrategyDiscoveryArtifacts(env.ARTIFACTS, repository)
    const bundle = await repository.artifact(latestRun.run_id, 'jury-bundle').catch(() => null)
    bundleManifest = bundle
    const result = await repository.artifact(latestRun.run_id, 'codex-result').catch(() => null)
    if (bundle) bundleReady = await artifactStore.exists(bundle.r2_key, bundle.artifact_hash).catch(() => false)
    if (result) resultReady = await artifactStore.exists(result.r2_key, result.artifact_hash).catch(() => false)
    artifactMismatch = Boolean((bundle && !bundleReady) || (result && !resultReady))
    if (artifactMismatch) warnings.push('D1 artifact manifest 與 R2 object 不一致')
  }
  const buttons = resolveButtonState({ latestRun, blockers, staleWorkflow, bundleReady, resultReady, artifactMismatch })
  const snapshotHash = featureSnapshot && strategySnapshot
    ? await hashJson({ feature: featureSnapshot.snapshotHash, strategy: strategySnapshot.snapshotHash })
    : ''
  return {
    ...buttons,
    current_snapshot: featureSnapshot && strategySnapshot ? {
      feature_version: featureSnapshot.featureVersion,
      strategy_version: strategySnapshot.strategyVersion,
      strategy_count: strategySnapshot.cards.length,
      feature_count: featureSnapshot.cards.length,
      snapshot_hash: snapshotHash,
    } : null,
    latest_run: latestRun,
    codex_handoff: latestRun && bundleReady && bundleManifest ? {
      run_id: latestRun.run_id,
      bundle_hash: String(artifactMetadata(bundleManifest).bundle_hash ?? bundleManifest.artifact_hash),
      bundle_created_at: bundleManifest.created_at ?? latestRun.updated_at,
      repo_skill: 'strategy-discovery-jury',
      command: [
        '$strategy-discovery-jury',
        '',
        `Review the latest jury bundle for ${latestRun.run_id}.`,
        '',
        'Verify all material claims using repository evidence and executable tests.',
        '',
        `Write the final result to audits/outbox/${latestRun.run_id}/codex-result.zip`,
      ].join('\n'),
    } : null,
    workers_ai: {
      usage_scope: reservation.configured ? 'ACCOUNT' : 'LAB_ONLY',
      known_used_neurons: knownUsed,
      external_reserved_neurons: reservation.value,
      estimated_run_neurons: AI_BUDGET.preflightReservationNeurons,
      safe_remaining_neurons: safeRemaining,
    },
    warnings,
    blockers,
  }
}
