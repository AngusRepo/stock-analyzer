// Copied from frontend/src/pages/ObservabilityPage.tsx (P3 of the Grafana migration): the OBS readiness
// stage/gate mapping and the GA promotion threshold display, without React. The frontend copy stays until
// the OBS retirement phase.
import type { DataQualityCheck } from '../../lib/dataQualityMonitor'
import type { SchedulerJob } from './schedulerJob'

export type WorkstationTone = 'ok' | 'warn' | 'error' | 'info' | 'neutral'
export type ObservabilitySeverity = 'ok' | 'warn' | 'error' | 'info'
export type ObservabilityEvent = { domain: string; source: string; severity?: ObservabilitySeverity | null; ts?: string; next_action?: string; evidence?: unknown }
export type ApprovalReviewMetric = { label: string; candidate?: string; champion?: string; delta?: string; value?: string; detail?: string; tone?: WorkstationTone }
export type ApprovalReviewGate = { label: string; status: 'pass' | 'warn' | 'fail' | 'missing' | 'info'; detail?: string }
export type ApprovalReviewImpact = { label: string; value: string; detail?: string; tone?: WorkstationTone }

export type ReadinessStatus = 'ready' | 'running' | 'waiting' | 'blocked' | 'pending'

export type ReadinessStage = {
  id: string
  label: string
  owner: string
  detail: string
  status: ReadinessStatus
  tone: WorkstationTone
  job?: SchedulerJob
  nextAction: string
}

export type ReadinessGate = {
  id: string
  label: string
  status: ReadinessStatus
  tone: WorkstationTone
  value: string
  source: string
  detail: string
  latestDate?: string | null
}

export type MarketMaterializationItem = {
  key: string
  label: string
  status: string
  rows: number
  latest_date: string | null
  lag_days: number | null
  required: boolean
  source: string
  scope: string
  root_cause: string | null
}

export const READINESS_STAGES: Array<{
  id: string
  label: string
  owner: string
  detail: string
  jobIds: string[]
  nextAction: string
}> = [
  {
    id: 'market-close-refresh',
    label: '收盤資料刷新',
    owner: 'FinLab / TWSE-TPEX',
    detail: '價格、成交額、指數、期貨與信用交易先進 canonical。',
    jobIds: ['market-close-refresh', 'finlab-v4-backfill', 'update'],
    nextAction: '等待 FinLab canonical callback 或 TWSE/TPEX supplemental refresh。',
  },
  {
    id: 'source-readiness',
    label: '資料就緒閘門',
    owner: 'evening chain',
    detail: '由 evening chain 內建 source readiness retry 檢查 primary canonical 與官方補件。',
    jobIds: ['evening-chain', 'finlab-v4-backfill', 'update'],
    nextAction: '若未 ready，evening chain 會延遲重試；不再依賴獨立 probe job。',
  },
  {
    id: 'indicator-queue',
    label: '指標計算',
    owner: 'worker queue',
    detail: '技術、籌碼、題材、風險特徵入庫後才放行 screener。',
    jobIds: ['indicator-queue'],
    nextAction: '補齊指標產物，確認 downstream row count。',
  },
  {
    id: 'screener',
    label: '候選池',
    owner: 'screener',
    detail: 'L0-L2 篩選產生可辯論候選，不在 OBS 手動跳關。',
    jobIds: ['screener'],
    nextAction: '確認候選數與 hard gate reason 分布。',
  },
  {
    id: 'ml-pipeline',
    label: '模型與推薦',
    owner: 'pipeline-v2',
    detail: 'pipeline、ML predict、recommendation 必須共用同一 run date。',
    jobIds: ['pipeline', 'ml-predict', 'recommendation'],
    nextAction: '若卡住，先看前序 readiness，不直接 rerun recommendation。',
  },
  {
    id: 'post-verify',
    label: '驗證與回饋',
    owner: 'verify / learner',
    detail: 'verify、IC、LinUCB、adaptive evidence 回寫後形成隔日 guard。',
    jobIds: ['verify-v2', 'model-ic-rolling', 'linucb-reward-ledger', 'adapt'],
    nextAction: '確認 reward ledger 與 adaptive meta 沒有 stale evidence。',
  },
]

export function readinessTone(status: ReadinessStatus): WorkstationTone {
  if (status === 'ready') return 'ok'
  if (status === 'running') return 'info'
  if (status === 'waiting' || status === 'pending') return 'warn'
  return 'error'
}

export function readinessLabel(status: ReadinessStatus) {
  if (status === 'ready') return 'READY'
  if (status === 'running') return 'RUNNING'
  if (status === 'waiting') return 'WAITING'
  if (status === 'blocked') return 'BLOCKED'
  return 'PENDING'
}

export function readinessStatusFromScheduler(status?: string | null): ReadinessStatus {
  const value = String(status ?? '').toLowerCase()
  if (value === 'success') return 'ready'
  if (value === 'running') return 'running'
  if (value === 'failed' || value === 'error') return 'blocked'
  if (value === 'waiting') return 'waiting'
  if (value === 'sleep' || value === 'skip' || value === 'skipped') return 'pending'
  return 'pending'
}

function chooseRepresentativeJob(jobs: SchedulerJob[], ids: string[]) {
  const byId = new Map(jobs.map((job) => [job.id, job]))
  const candidates = ids.map((id) => byId.get(id)).filter((job): job is SchedulerJob => Boolean(job))
  return candidates.find((job) => ['failed', 'running', 'waiting'].includes(job.lastStatus)) ?? candidates.find((job) => job.lastStatus === 'success') ?? candidates[0]
}

export function stageFromDefinition(def: typeof READINESS_STAGES[number], jobs: SchedulerJob[]): ReadinessStage {
  const job = chooseRepresentativeJob(jobs, def.jobIds)
  const status = readinessStatusFromScheduler(job?.lastStatus)
  return {
    id: def.id,
    label: def.label,
    owner: def.owner,
    detail: job?.summary || def.detail,
    status,
    tone: readinessTone(status),
    job,
    nextAction: status === 'ready' ? '已放行下一段；保留 evidence 供 drilldown。' : def.nextAction,
  }
}

function parseMarketMaterialization(checks: DataQualityCheck[]): { check?: DataQualityCheck; items: MarketMaterializationItem[] } {
  const check = checks.find((row) => row.id === 'market_dashboard_materialization')
  const raw = check?.metrics?.materialization_checks
  return {
    check,
    items: Array.isArray(raw) ? raw as MarketMaterializationItem[] : [],
  }
}

export function gateStatusFromQuality(status?: string | null): ReadinessStatus {
  const value = String(status ?? '').toLowerCase()
  if (value === 'ok' || value === 'success' || value === 'ready') return 'ready'
  if (value === 'warn' || value === 'waiting') return 'waiting'
  if (value === 'fail' || value === 'failed' || value === 'blocked') return 'blocked'
  return 'pending'
}

export function buildReadinessGates(checks: DataQualityCheck[]): ReadinessGate[] {
  const { check, items } = parseMarketMaterialization(checks)
  if (items.length) {
    return items.map((item) => {
      const status = gateStatusFromQuality(item.status)
      const freshness = item.lag_days == null ? 'lag n/a' : `lag ${item.lag_days}d`
      return {
        id: item.key,
        label: item.label,
        status,
        tone: readinessTone(status),
        value: `${Number(item.rows ?? 0).toLocaleString()} rows`,
        source: item.source || 'canonical',
        detail: item.root_cause || `${item.scope || 'market dashboard'} / ${freshness}`,
        latestDate: item.latest_date,
      }
    })
  }

  const fallbackIds = ['price_freshness', 'market_dashboard_materialization', 'recommendation_payload', 'canonical_chip_daily']
  const selected = checks.filter((checkRow) => fallbackIds.some((id) => checkRow.id.includes(id))).slice(0, 8)
  if (selected.length) {
    return selected.map((checkRow) => {
      const status = gateStatusFromQuality(checkRow.status)
      return {
        id: checkRow.id,
        label: checkRow.label,
        status,
        tone: readinessTone(status),
        value: checkRow.status.toUpperCase(),
        source: 'data-quality report',
        detail: checkRow.summary,
        latestDate: null,
      }
    })
  }

  return [
    {
      id: 'finlab-canonical',
      label: 'FinLab canonical',
      status: 'pending',
      tone: 'warn',
      value: '待 API payload',
      source: 'data-quality API',
      detail: '目前 OBS 尚未取得 market_dashboard_materialization；local preview 只顯示結構。',
    },
    {
      id: 'official-supplement',
      label: 'TWSE/TPEX 補件',
      status: 'pending',
      tone: 'warn',
      value: '待 API payload',
      source: 'official supplemental',
      detail: '補件包含券商分點、融資融券與市場缺口修補。',
    },
  ]
}

export function severityTone(severity?: ObservabilitySeverity | null): WorkstationTone {
  if (severity === 'error') return 'error'
  if (severity === 'warn') return 'warn'
  if (severity === 'ok') return 'ok'
  return 'info'
}

export function fmtNumber(value: unknown, digits = 4) {
  const n = Number(value)
  return Number.isFinite(n) ? n.toFixed(digits) : '-'
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function scoreDelta(historyTail: unknown) {
  if (!Array.isArray(historyTail) || historyTail.length < 2) return '-'
  const prev = Number(asRecord(historyTail[historyTail.length - 2]).best_score)
  const last = Number(asRecord(historyTail[historyTail.length - 1]).best_score)
  if (!Number.isFinite(prev) || !Number.isFinite(last)) return '-'
  const delta = last - prev
  return `${delta >= 0 ? '+' : ''}${delta.toFixed(4)}`
}

/** AdaptiveMetaPanel's GA promotion review: the Sharpe/PBO/MDD95 thresholds, gates and blockers it shows. */
export function gaPromotionView(events: ObservabilityEvent[]) {
  const adaptive = events.find((event) => event.domain === 'adaptive_meta' && event.source === 'adaptive_params')
  const ga = events.find((event) => event.domain === 'adaptive_meta' && event.source === 'ga_optimizer')
  const evidence = asRecord(adaptive?.evidence)
  const gaEvidence = asRecord(ga?.evidence)
  const promotion = asRecord(gaEvidence.promotion)
  const bestMetrics = asRecord(gaEvidence.best_metrics)
  const historyTail = gaEvidence.history_tail
  const gaLearningUpdatedAt = String(gaEvidence.learning_updated_at ?? ga?.ts ?? '-')
  const gaRunPopulation = gaEvidence.run_population_size ?? gaEvidence.population_size
  const gaRunGenerations = gaEvidence.run_generations ?? gaEvidence.generations
  const requiredEvidence = Array.isArray(promotion.requiredEvidence)
    ? promotion.requiredEvidence.map(String)
    : Array.isArray(promotion.required_evidence)
      ? promotion.required_evidence.map(String)
      : []
  const missingEvidence = Array.isArray(promotion.missingEvidence)
    ? promotion.missingEvidence.map(String)
    : Array.isArray(promotion.missing_evidence)
      ? promotion.missing_evidence.map(String)
      : []
  const pendingApprovalRaw = String(promotion.pendingApprovalLevel ?? promotion.pending_approval_level ?? '').toUpperCase()
  const pendingApprovalLevel = (pendingApprovalRaw === 'L3' || pendingApprovalRaw === 'L4' ? pendingApprovalRaw : '') as '' | 'L3' | 'L4'
  const canRequestNextLevel = promotion.canRequestNextLevel === true || promotion.can_request_next_level === true
  const nextLevel = (String(promotion.nextLevel ?? promotion.next_level ?? 'L3').toUpperCase() === 'L4' ? 'L4' : 'L3') as 'L3' | 'L4'
  const gaNextAction = String(promotion.nextAction ?? ga?.next_action ?? '')
  const approvalRequiredForNextLevel =
    promotion.approvalRequiredForNextLevel === true || promotion.approval_required_for_next_level === true
  const rawL3Blockers = missingEvidence.length
    ? missingEvidence
    : canRequestNextLevel && approvalRequiredForNextLevel
      ? ['Wei approval']
      : pendingApprovalLevel
        ? [`pending ${pendingApprovalLevel}`]
        : ['keep collecting GA history']
  const gaRuntime = asRecord(evidence.ga_optimizer_runtime)
  const gaEffectPolicy = asRecord(gaRuntime.effect_policy)
  const historyRows = Array.isArray(historyTail) ? historyTail.map(asRecord) : []
  const previousHistory = historyRows.length >= 2 ? historyRows[historyRows.length - 2] : null
  const latestHistory = historyRows.length >= 1 ? historyRows[historyRows.length - 1] : null
  const validation = asRecord(gaEvidence.validation)
  const gaInfrastructureBlocked = validation.status === 'infra_blocked'
  const gate = asRecord(gaEvidence.gate)
  const failedGates = Array.isArray(gaEvidence.failed_gates)
    ? gaEvidence.failed_gates.map(String)
    : Array.isArray(gate.failed_gates)
      ? gate.failed_gates.map(String)
      : []
  const l3Blockers = gaInfrastructureBlocked ? [String(validation.reason ?? '驗證資料未就緒')] : rawL3Blockers.flatMap((item) => (
    item === 'primary_gate' && failedGates.length
      ? failedGates.map((gateName) => 'primary_gate / ' + gateName)
      : [item]
  ))
  const gaReviewStatusTone: WorkstationTone = pendingApprovalLevel
    ? 'warn'
    : missingEvidence.length || failedGates.length
      ? 'error'
      : canRequestNextLevel || approvalRequiredForNextLevel
        ? 'warn'
        : severityTone(ga?.severity)
  const gaMetrics: ApprovalReviewMetric[] = [
    {
      label: 'Best score',
      candidate: fmtNumber(gaEvidence.best_score, 4),
      champion: previousHistory ? fmtNumber(previousHistory.best_score, 4) : 'previous N/A',
      delta: scoreDelta(historyTail),
      detail: 'GA fitness；必須搭配 PBO/MDD/Sharpe，不可單看分數。',
      tone: Number(latestHistory?.best_score ?? gaEvidence.best_score) >= Number(previousHistory?.best_score ?? -Infinity) ? 'ok' : 'warn',
    },
    {
      label: 'Sharpe',
      value: fmtNumber(bestMetrics.sharpe, 2),
      detail: '候選策略風險調整後報酬；低於門檻不能只靠 score delta 通過。',
      tone: Number(bestMetrics.sharpe) >= 0.5 ? 'ok' : 'warn',
    },
    {
      label: 'PBO',
      value: fmtNumber(bestMetrics.pbo, 3),
      detail: '過擬合風險；越低越好，>= 0.5 應擋 promotion。',
      tone: Number(bestMetrics.pbo) < 0.5 ? 'ok' : 'error',
    },
    {
      label: 'MDD95',
      value: fmtNumber(bestMetrics.mdd_95th, 3),
      detail: 'Monte Carlo 95th percentile drawdown；用來避免只挑漂亮回測。',
      tone: Number(bestMetrics.mdd_95th) <= 0.2 ? 'ok' : 'warn',
    },
    {
      label: 'Training cadence',
      value: `${String(gaRunPopulation ?? '-')} pop / ${String(gaRunGenerations ?? '-')} gen`,
      detail: `history ${String(gaEvidence.history_count ?? (historyRows.length || '-'))}; last ${gaLearningUpdatedAt}`,
      tone: historyRows.length >= 2 ? 'ok' : 'warn',
    },
  ]
  const gaGates: ApprovalReviewGate[] = [
    ...(requiredEvidence.length ? requiredEvidence : ['policy_candidate', 'primary_gate', 'stable_history', 'pbo_mc_cost_governance'])
      .filter((item) => !(item === 'primary_gate' && failedGates.length))
      .map((item) => ({
      label: item,
      status: missingEvidence.includes(item) ? 'missing' as const : 'pass' as const,
      detail: missingEvidence.includes(item) ? '缺 evidence，不能升 L3/L4。' : 'promotion packet 已具備此 evidence。',
    })),
    ...(gaInfrastructureBlocked ? [{
      label: '驗證資料未就緒', status: 'missing' as const,
      detail: String(validation.reason ?? '缺少有效回測證據；尚未測得本輪績效。'),
    }] : failedGates.map((item) => ({
      label: 'primary_gate / ' + item,
      status: 'fail' as const,
      detail: '已完成驗證但未通過此門檻；保留原本晉級標準。',
    }))),
    {
      label: 'Wei approval boundary',
      status: pendingApprovalLevel || approvalRequiredForNextLevel ? 'warn' : 'pass',
      detail: pendingApprovalLevel
        ? `等待 ${pendingApprovalLevel} approval；通過前不改 production config。`
        : '目前沒有待批准層級。',
    },
  ]
  const gaImpacts: ApprovalReviewImpact[] = [
    {
      label: 'Runtime owner',
      value: String(gaRuntime.runtime_role ?? 'learning/review only'),
      detail: 'GA 不進 model_pool；由 adaptive meta context 消費。',
      tone: gaRuntime.runtime_role ? 'info' : 'neutral',
    },
    {
      label: 'Production write',
      value: gaEvidence.mutates_trading_config === false ? 'trading:config blocked' : 'unknown',
      detail: '批准也應走 gated resolver，不直接 raw mutate trading config。',
      tone: gaEvidence.mutates_trading_config === false ? 'ok' : 'error',
    },
    {
      label: 'Exposure cap',
      value: gaEffectPolicy.max_bandit_max_mult != null ? `bandit max ${fmtNumber(gaEffectPolicy.max_bandit_max_mult, 2)}x` : 'not active',
      detail: String(gaEffectPolicy.scope ?? 'L3 approved 才能套 capped meta-policy effect。'),
      tone: gaEffectPolicy.enabled === true ? 'warn' : 'neutral',
    },
  ]
  return {
    tone: gaReviewStatusTone, pendingApprovalLevel, canRequestNextLevel, nextLevel, nextAction: gaNextAction,
    blockers: l3Blockers, metrics: gaMetrics, gates: gaGates, impacts: gaImpacts,
    candidateId: String(gaEvidence.best_candidate_id ?? 'best GA policy'),
  }
}
