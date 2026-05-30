import { resolveApiBase } from '../const'

const BASE = resolveApiBase()
export const AUTH_TOKEN_EVENT = 'stockvision:auth-token'

let _token: string | null = sessionStorage.getItem('sv_token')

function formatApiError(path: string, status: number, statusText: string, payload: any): string {
  const serverMessage = typeof payload?.error === 'string' && payload.error.trim()
    ? payload.error.trim()
    : typeof payload?.message === 'string' && payload.message.trim()
      ? payload.message.trim()
      : ''
  const rawBase = serverMessage || statusText || `HTTP ${status}`
  const isOpaqueProxy500 = status === 500 && rawBase === 'Internal Server Error'
  const base = isOpaqueProxy500 ? 'API unavailable' : rawBase
  const localHint = isOpaqueProxy500 ? ' Local dev hint: check that the Worker API is running on localhost:8787.' : ''
  return `${base} (${path}, HTTP ${status}).${localHint}`
}

function emitAuthTokenEvent(authenticated: boolean) {
  window.dispatchEvent(new CustomEvent(AUTH_TOKEN_EVENT, { detail: { authenticated } }))
}

export function setToken(t: string) {
  _token = t
  sessionStorage.setItem('sv_token', t)
  emitAuthTokenEvent(true)
}

export function clearToken() {
  _token = null
  sessionStorage.removeItem('sv_token')
  emitAuthTokenEvent(false)
}
export function getToken() { return _token }

async function req<T>(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
  const headers: Record<string,string> = { 'Content-Type': 'application/json' }
  if (_token) headers['Authorization'] = `Bearer ${_token}`
  Object.assign(headers, extraHeaders)
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
  if (res.status === 401) { clearToken(); throw new Error('Unauthorized') }
  if (!res.ok) {
    const e = await res.json().catch(() => ({})) as any
    throw new Error(formatApiError(path, res.status, res.statusText, e))
  }
  return res.json()
}
const get  = <T>(p: string)            => req<T>('GET',    p)
const post = <T>(p: string, b?: unknown) => req<T>('POST',   p, b)
const put  = <T>(p: string, b?: unknown) => req<T>('PUT',    p, b)
const del  = <T>(p: string)            => req<T>('DELETE', p)

export const authApi = {
  me: () => get<any>('/auth/me'),
  loginUrl: () => `${BASE}/auth/google`,
  logout: () => post<any>('/auth/logout'),
  exchange: (code: string) => post<{ token: string }>('/auth/exchange', { code }),
}
export const stocksApi = {
  list:        () => get<any[]>('/stocks'),
  get:         (id: number) => get<any>(`/stocks/${id}`),
  search:      (q: string, limit = 20) => get<any[]>(`/stocks/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  add:         (body: any) => post<any>('/stocks', body),
  remove:      (id: number) => del<any>(`/stocks/${id}`),
  refresh:     (id: number) => post<any>(`/stocks/${id}/refresh`),
  prices:      (id: number, days = 365) => get<any[]>(`/stocks/${id}/prices?days=${days}`),
  indicators:  (id: number, days = 365) => get<any[]>(`/stocks/${id}/indicators?days=${days}`),
  financials:  (id: number, limit = 12) => get<any[]>(`/stocks/${id}/financials?limit=${limit}`),
  chips:       (id: number, days = 60) => get<any[]>(`/stocks/${id}/chips?days=${days}`),
  brokerFlow:  (id: number, days = 60) => get<any[]>(`/stocks/${id}/broker-flow?days=${days}`),
  news:        (id: number, days = 30) => get<any[]>(`/stocks/${id}/news?days=${days}`),
  predictions: (id: number) => get<any[]>(`/stocks/${id}/predictions`),
  factors:     (id: number) => get<any>(`/stocks/${id}/factors`),
  risk:        (id: number, period = '1y') => get<any>(`/stocks/${id}/risk?period=${period}`),
  valuations:  (id: number) => get<any>(`/stocks/${id}/valuations`),
  monthlyRevenue: (id: number, months = 12) => get<any[]>(`/stocks/${id}/monthly-revenue?months=${months}`),
  margin:         (id: number, days = 60) => get<any[]>(`/stocks/${id}/margin?days=${days}`),
  aiSummary:      (id: number) => get<any>(`/stocks/${id}/ai-summary`),
}
export const marketApi = {
  indices: () => get<any>('/market/indices'),
  risk:    () => get<any>('/market/risk'),
  riskHistory: (days = 30) => get<any>(`/market/risk/history?days=${days}`),
  exDividend: () => get<any[]>('/market/ex-dividend'),
  attentionStocks: () => get<any[]>('/market/attention-stocks'),
}
export const llmApi = {
  technicalAnalysis: (stockId: number) => post<any>('/llm/technical-analysis', { stockId }),
  tradingAdvice:     (stockId: number) => post<any>('/llm/trading-advice', { stockId }),
  analystSummary:    (stockId: number) => post<any>('/llm/analyst-summary', { stockId }),
  ask:               (stockId: number, question: string, history?: any[]) => post<any>('/llm/ask', { stockId, question, conversationHistory: history }),
}
export const watchlistApi = {
  list:   () => get<any[]>('/watchlist'),
  get:    (stockId: number) => get<any>(`/watchlist/${stockId}`),
  add:    (stockId: number) => post<any>(`/watchlist/${stockId}`, {}),
  remove: (stockId: number) => del<any>(`/watchlist/${stockId}`),
  upsert: (stockId: number, data: any) => put<any>(`/watchlist/${stockId}`, data),
}
export const alertsApi = {
  list:   () => get<any[]>('/alerts'),
  add:    (body: any) => post<any>('/alerts', body),
  remove: (id: number) => del<any>(`/alerts/${id}`),
}

export const newsApi = {
  crawl:     (stockId: number)             => post<any>(`/news/${stockId}/crawl`),
  sentiment: (stockId: number, days = 30)  => get<any>(`/news/${stockId}/sentiment?days=${days}`),
  trend:     (stockId: number, days = 30)  => get<any[]>(`/news/${stockId}/trend?days=${days}`),
  keywords:  (stockId: number, days = 30)  => get<any[]>(`/news/${stockId}/keywords?days=${days}`),
}

export const mlApi = {
  runPredict: (stockId: number) => post<any>(`/ml/predict/${stockId}`, {}),
  getPredict: (stockId: number) => get<any>(`/ml/predict/${stockId}`),
}

export const notificationsApi = {
  list:    () => get<any[]>('/notifications'),
  count:   () => get<{ count: number }>('/notifications/count'),
  readAll: () => post<any>('/notifications/read-all'),
}

export type SystemStatusReport = {
  overall: 'ok' | 'warning' | 'stale'
  updatedAt: string
  data: {
    prices: { lastDate: string | null; isRecent: boolean; rowCount?: number }
    chips: { lastDate: string | null; isRecent: boolean; source?: string | null }
    news: { lastDate: string | null; isRecent: boolean; rowCount?: number }
    predictions: { lastDate: string | null; isRecent: boolean }
    marketRisk: { lastDate: string | null; isRecent: boolean; riskLevel?: string | null; riskScore?: number | null; calculatedAt?: string | null }
  }
  meta: { activeStocks: number; dbSizeBytes: number | null }
}

export const systemApi = {
  status: () => get<SystemStatusReport>('/system/status'),
}

export const accuracyApi = {
  byStock: (stockId: number) => get<any[]>(`/ml/accuracy/${stockId}`),
  global: () => get<any>('/ml/accuracy/global'),
}

export const tradeApi = {
  performance: (stockId: number) => get<any[]>(`/ml/trade-performance/${stockId}`),
  globalPerf:  () => get<any[]>('/ml/trade-performance/global'),
  history:     (stockId: number, limit = 50) => get<any[]>(`/ml/trade-history/${stockId}?limit=${limit}`),
}

export const chatApi = {
  getSessions: (stockId?: number) =>
    get<any[]>(`/chat/sessions${stockId ? `?stockId=${stockId}` : ''}`),
  getMessages:   (sessionId: number) =>
    get<any[]>(`/chat/sessions/${sessionId}/messages`),
  createSession: (stockId?: number, title?: string) =>
    post<any>('/chat/sessions', { stockId, title }),
  addMessage:    (sessionId: number, role: 'user' | 'assistant', content: string) =>
    post<any>(`/chat/sessions/${sessionId}/messages`, { role, content }),
  deleteSession: (sessionId: number) =>
    del<any>(`/chat/sessions/${sessionId}`),
}

export const recommendationsApi = {
  daily:       (date?: string, opts?: { view?: 'full' | 'card' }) => {
    const params = new URLSearchParams()
    if (date) params.set('date', date)
    if (opts?.view) params.set('view', opts.view)
    const query = params.toString()
    return get<any>(`/recommendations/daily${query ? `?${query}` : ''}`)
  },
  history:     (days = 7) =>
    get<any[]>(`/recommendations/history?days=${days}`),
  sectorFlow:  (date?: string, type?: 'industry' | 'theme') => {
    const params = new URLSearchParams()
    if (date) params.set('date', date)
    if (type) params.set('type', type)
    const qs = params.toString()
    return get<any>(`/recommendations/sector-flow${qs ? `?${qs}` : ''}`)
  },
  sectorFlowStocks: (date?: string, classification?: 'top' | 'dark_horse') => {
    const params = new URLSearchParams()
    if (date) params.set('date', date)
    if (classification) params.set('classification', classification)
    const qs = params.toString()
    return get<any>(`/recommendations/sector-flow-stocks${qs ? `?${qs}` : ''}`)
  },
  sectorTrend: (sector: string, days = 14, type?: 'industry' | 'theme') => {
    const params = new URLSearchParams({ sector, days: String(days) })
    if (type) params.set('type', type)
    return get<any>(`/recommendations/sector-trend?${params}`)
  },
  dailyReport: (date?: string) =>
    get<any>(`/recommendations/daily-report${date ? `?date=${date}` : ''}`),
}

export const backtestApi = {
  latest: () => get<any>('/backtest/latest'),
  monteCarlo: () => get<any>('/backtest/monte-carlo'),
  pbo: () => get<any>('/backtest/pbo'),
}

export const cronApi = {
  schedule: () => get<{ schedule: { task: string; tw_time: string; description: string }[] }>('/cron/schedule'),
}

// 2026-04-21 Scheduler Dashboard API
export type SchedulerJob = {
  id: string
  name: string
  schedule: string
  cron: string
  group: 'pipeline_chain' | 'intraday' | 'weekly' | 'daily' | 'monthly'
  chainIndex?: number
  lastRun: string
  lastRunAt?: string | null
  lastAttemptAt?: string | null
  lastEffectiveRunAt?: string | null
  lastStatus: 'success' | 'failed' | 'running' | 'skip' | 'waiting' | 'sleep'
  lastDuration: string
  durationConcern?: 'expected_short' | 'suspicious_short' | null
  durationConcernReason?: string
  lastError?: string
  nextRun: string
  history7d: Array<'success' | 'failed' | 'skip'>
  rate7d: string
  summary: string
  consolidation?: {
    task: string
    owner: 'gcp_scheduler' | 'worker_chain' | 'controller_chain' | 'manual_only'
    consolidationClass:
      | 'keep_scheduler'
      | 'merge_into_chain'
      | 'downstream_evidence'
      | 'manual_maintenance_candidate'
      | 'disable_candidate'
    currentFunction: string
    replacementOwner?: string
    upstream: string[]
    downstream: string[]
    requiredBeforeDisable: string[]
    operatorRisk: 'low' | 'medium' | 'high'
    recommendation: string
  } | null
}

export type SchedulerStatus = {
  stats: {
    total: number
    active: number
    failed24h: number
    successRate7d: number
    nextJob: string
    nextIn: string
  }
  jobs: SchedulerJob[]
  dag?: {
    lastRun: string
    totalDuration: number
    steps: Array<{ id?: string; name: string; duration: string; status: string; lastRun?: string; summary?: string }>
  }
  dagSteps?: Array<{ name: string; duration: string; status: string }>
}

export const schedulerApi = {
  status: () => get<SchedulerStatus>('/scheduler/status'),
}

export type DataQualityStatus = 'ok' | 'warn' | 'fail'

export type DataQualityCheck = {
  id: string
  label: string
  status: DataQualityStatus
  summary: string
  metrics?: Record<string, unknown>
}

export type DataQualityReport = {
  date: string
  generated_at: string
  overall: DataQualityStatus
  checks: DataQualityCheck[]
}

export type DeployGateReport = {
  date: string
  generated_at: string
  decision: 'PASS' | 'WARN' | 'BLOCK'
  status: DataQualityStatus
  checks: Array<{ id: string; status: DataQualityStatus; summary: string; metrics?: Record<string, unknown> }>
  data_quality: DataQualityReport
}

export const dataQualityApi = {
  status: (date?: string) => get<DataQualityReport>(`/admin/data-quality/status${date ? `?date=${date}` : ''}`),
  v41RuntimeStatus: (date?: string) => get<V41DataRuntimeStatus>(`/dashboard/v4/data-runtime/status${date ? `?date=${date}` : ''}`),
}

export type V41DataRuntimeStatus = {
  date: string
  schema_version: string
  theme_signals?: { total: number; sources: number; latest_generated_at: string | null }
  stock_theme_features?: { total: number; symbols: number; latest_generated_at: string | null }
  external_evidence?: { total: number; accepted: number; rejected: number; latest_published_at: string | null }
  finlab_backfill?: Record<string, unknown> | null
  source_diff?: { total: number; missing_in_stockvision: number; value_conflicts: number; latest_generated_at: string | null }
  gap_fill_candidates?: { total: number; candidates: number; quarantined: number; latest_generated_at: string | null }
  canonical_rows?: {
    market_daily: number
    chip_daily: number
    institutional_amount_daily?: number
    broker_flow_daily?: number
    revenue_monthly: number
  }
  source_quality_metrics?: Array<{
    source: string
    dataset: string
    freshness_status: string
    missing_rate: number
    duplicate_rate: number
    schema_drift_status: string
    entity_link_confidence: number | null
    latest_materialization: string | null
  }>
  source_coverage?: Array<{
    source: string
    role: string
    rows: number
    freshness_status: string
    missing_rate: number
    duplicate_rate: number
    entity_link_confidence: number | null
    latest_materialization: string | null
    decision_effect: string
    runtime_state: 'production' | 'paper_active' | 'formal_shadow' | 'missing'
  }>
}

export type DashboardV4ChartPacket = {
  schemaVersion: 'dashboard-v4-chart-contract-v1'
  generatedAt: string
  chartLibrary: 'lightweight-charts'
  dataOwner: 'stockvision_owned'
  externalWidgetUrls: string[]
  stock: { id: number; symbol: string; name: string; market: string }
  panels: string[]
  series: {
    priceCandles: Array<{ time: string; open: number; high: number; low: number; close: number }>
    volumeHistogram: Array<{ time: string; value: number; color?: string }>
    modelMarkers: Array<{ time: string; position: 'aboveBar' | 'belowBar'; shape: 'arrowUp' | 'arrowDown' | 'circle'; color: string; text: string }>
    sectorFlow: Array<{ time: string; value: number; sector: string; classification: string; foreign_net: number | null; trust_net: number | null }>
  }
  lightweightChartsSpec: Record<string, unknown>
  regimeOverlay: Record<string, unknown> | null
  dataQuality: DataQualityReport | { overall: string; checks: unknown[] }
  finlabDiff: { mode: 'shadow_audit_only'; rows: Array<Record<string, unknown>>; empty: boolean }
  previewBlockedReasons: Array<{ status: string; reason: string; source: string; created_at: string }>
  executionPrePilotEvidence: Array<{ event_type: string; status: string; reason: string; created_at: string }>
  sourceOwnership: Record<string, string>
}

export const dashboardV4Api = {
  stockChart: (stockId: number, opts?: { days?: number; date?: string }) => {
    const params = new URLSearchParams()
    if (opts?.days) params.set('days', String(opts.days))
    if (opts?.date) params.set('date', opts.date)
    const query = params.toString()
    return get<DashboardV4ChartPacket>(`/dashboard/v4/stocks/${stockId}/chart${query ? `?${query}` : ''}`)
  },
}

export const deployGateApi = {
  predeploy: (opts?: { date?: string; live?: boolean }) => {
    const params = new URLSearchParams()
    if (opts?.date) params.set('date', opts.date)
    if (opts?.live) params.set('live', '1')
    const query = params.toString()
    return get<DeployGateReport>(`/admin/gate/predeploy${query ? `?${query}` : ''}`)
  },
}

export type ObservabilitySeverity = 'ok' | 'info' | 'warn' | 'error'
export type ObservabilityDomain = 'scheduler' | 'data_quality' | 'deploy_gate' | 'model_pool' | 'validation' | 'adaptive_meta' | 'owner_boundary'

export type ObservabilityEvent = {
  id: string
  ts: string
  severity: ObservabilitySeverity
  domain: ObservabilityDomain
  source: string
  status: string
  title: string
  summary: string
  owner: string
  impact: string
  next_action: string
  runbook?: string
  evidence: Record<string, unknown>
}

export type ObservabilityEventReport = {
  success: true
  version: 'obs-event-contract-v1'
  generated_at: string
  date: string
  overall: ObservabilitySeverity
  counts: Record<ObservabilitySeverity, number>
  events: ObservabilityEvent[]
  domains: Array<{
    domain: ObservabilityDomain
    owner: string
    severity: ObservabilitySeverity
    event_count: number
  }>
  owner_boundaries: Array<{
    owner: string
    responsibility: string
    source_of_truth: string
  }>
  audit?: {
    recent: Array<ObservabilityEvent & {
      event_id?: string
      created_at?: string
    }>
  }
}

export type ObservabilityIncident = {
  id: string
  severity: ObservabilitySeverity
  status: 'open' | 'watch' | 'resolved'
  domain: ObservabilityDomain
  owner: string
  title: string
  root_cause: string
  impact: string
  first_seen?: string
  last_seen?: string
  affected_symbols: string[]
  run_ids: string[]
  next_action: string
  source_event_ids: string[]
  evidence: Record<string, unknown>
}

export type ObservabilityDrilldownReport = {
  success: true
  version: 'obs-drilldown-v1'
  generated_at: string
  date: string
  overall: ObservabilitySeverity
  incidents: ObservabilityIncident[]
  domain_summary: Array<{
    domain: ObservabilityDomain
    owner: string
    open_count: number
    worst_severity: ObservabilitySeverity
  }>
  operator_questions: Array<{
    question: string
    answer_path: string
  }>
}

export const observabilityApi = {
  events: (opts?: { date?: string; live?: boolean }) => {
    const params = new URLSearchParams()
    if (opts?.date) params.set('date', opts.date)
    if (opts?.live) params.set('live', '1')
    const query = params.toString()
    return get<ObservabilityEventReport>(`/admin/observability/events${query ? `?${query}` : ''}`)
  },
  drilldown: (opts?: { date?: string; live?: boolean }) => {
    const params = new URLSearchParams()
    if (opts?.date) params.set('date', opts.date)
    if (opts?.live) params.set('live', '1')
    const query = params.toString()
    return get<ObservabilityDrilldownReport>(`/admin/observability/drilldown${query ? `?${query}` : ''}`)
  },
  reviewGaPromotion: (body: { action: 'request' | 'approve' | 'reject'; level?: 'L3' | 'L4'; reason?: string }) =>
    post<any>('/admin/ga-promotion/review', body),
}

export type OpsRunbookReport = {
  success: true
  version: 'ops-runbook-v1'
  mode: 'read_only'
  rollback_playbook: Array<{
    id: string
    title: string
    owner: string
    command_hint: string
    mutation_requires_approval: boolean
  }>
  resource_cleanup: Array<{
    id: string
    title: string
    owner: string
    command_hint: string
    mutation_requires_approval: boolean
  }>
  disaster_drill: Array<{
    id: string
    title: string
    owner: string
    command_hint: string
    mutation_requires_approval: boolean
  }>
  release_gate: string[]
}

export type OpsResourceAuditReport = {
  success: true
  version: 'ops-resource-audit-v1'
  mode: 'read_only'
  generated_at: string
  items: Array<{
    id: string
    owner: string
    status: 'ok' | 'warn' | 'manual_required'
    summary: string
    metrics: Record<string, unknown>
    mutation_allowed: false
    next_action: string
  }>
}

export const opsApi = {
  runbook: () => get<OpsRunbookReport>('/admin/ops/runbook'),
  resourceAudit: () => get<OpsResourceAuditReport>('/admin/ops/resource-audit'),
}

export type StrategySpecStatus = 'research' | 'shadow' | 'candidate' | 'active' | 'retired'
export type StrategySpec = {
  id: string
  version: string
  name: string
  status: StrategySpecStatus
  owner: 'strategy'
  alphaBucket: string
  supportedRegimes: string[]
  thesis: string
  thresholds: Record<string, unknown>
  riskNotes: string[]
  validation: { ok: boolean; errors: string[] }
}

export type StrategyOwnerBoundary = {
  owner: string
  owns: string[]
  forbidden: string[]
}

export type StrategySpecsResponse = {
  success: boolean
  version: string
  mode: 'read_only'
  source?: 'registry' | 'default_fallback'
  specs: StrategySpec[]
  owner_boundaries: StrategyOwnerBoundary[]
}

export type StrategyDryRunResult = {
  specId: string
  valid: boolean
  errors: string[]
  sampleSize: number
  matched: number
  matchRate: number
}

export type StrategyDryRunResponse = {
  success: boolean
  mode: 'dry_run'
  date: string
  source: 'request_body' | 'daily_recommendations'
  candidate_count: number
  results: StrategyDryRunResult[]
}

export type StrategyLearningResponse = {
  success: boolean
  mode: 'read_only'
  version: string
  date: string
  spec_source: 'registry' | 'default_fallback'
  specs: Array<Omit<StrategySpec, 'validation'> & {
    validation?: StrategySpec['validation']
    learning: {
      decisions: number
      matched: number
      match_rate: number | null
      samples: number
      hit_rate: number | null
      avg_return_pct: number | null
      max_drawdown_pct: number | null
      status: 'learning' | 'no_decisions' | 'no_reward'
    }
  }>
  promotion_gate: StrategyPromotionGate[]
  policy_state_preview: StrategyAdaptivePolicyState
}

export type StrategyPromotionGate = {
  strategy_id: string
  strategy_version: string
  strategy_status: StrategySpecStatus
  alpha_bucket: string
  current_stage?: 'L0_hypothesis' | 'L1_shadow' | 'L2_paper_active' | 'L3_production_allocation'
  recommended_stage?: 'L0_hypothesis' | 'L1_shadow' | 'L2_paper_active' | 'L3_production_allocation'
  decision: 'not_ready' | 'candidate_ready' | 'active_monitor'
  recommended_next_status: 'shadow' | 'candidate' | 'active'
  requires_wei_approval: boolean
  l3_requires_wei_approval?: boolean
  production_effect: false
  missing_evidence: string[]
  evidence: {
    decisions: number
    matched: number
    match_rate: number | null
    samples: number
    hit_rate: number | null
    avg_return_pct: number | null
    max_drawdown_pct: number | null
  }
}

export type StrategyAdaptivePolicyState = {
  policy_id: string
  version: string
  status: 'shadow' | 'candidate' | 'active' | 'retired'
  strategy_weights: Record<string, number>
  threshold_deltas: Record<string, {
    minSeedScore?: number
    minChipScore?: number
    minTechScore?: number
  }>
  evidence: {
    version: string
    date: string
    source: 'strategy_reward_ledger'
    production_effect: false
    requires_approval_to_activate: true
    eligible_strategy_count: number
    missing_evidence: Record<string, string[]>
  }
  updated_at: string
}

export type StrategyPolicyStateResponse = {
  success: boolean
  mode: 'read_only'
  date: string
  latest: StrategyAdaptivePolicyState | null
  preview: StrategyAdaptivePolicyState
  promotion_gate: StrategyPromotionGate[]
}

export type ResearchExperiment = {
  id: string
  version: string
  status: string
  hypothesis: string
  source_refs: string[]
  strategy_spec_ids: string[]
  data_slice: Record<string, unknown>
  metrics: string[]
  follow_up: string[]
  approval_gate: Record<string, boolean>
  created_at: string
  updated_at: string
  review_packet?: string
  evaluation_plan?: {
    experiment_id: string
    mode: 'dry_run_only'
    hypothesis: string
    warnings: string[]
    blocked_capabilities: string[]
    steps: Array<{
      id: string
      kind: string
      controller_endpoint: string | null
      method: 'POST'
      body: Record<string, unknown>
      mutation_allowed: false
      gate_decision: 'ALLOW' | 'REQUIRE_APPROVAL' | 'BLOCK'
      execution_ready: boolean
      block_reason?: string
    }>
  }
}

export type ResearchEvaluationRunResponse = {
  success: boolean
  mode: 'dry_run_execution'
  experiment?: ResearchExperiment
  report: {
    success: boolean
    mode: 'dry_run_execution'
    experiment_id: string
    verdict: 'ready_for_review' | 'needs_attention'
    review_packet: string
    results: Array<{
      step_id: string
      kind: string
      endpoint: string | null
      status: 'ok' | 'skipped' | 'error'
      response?: unknown
      reason?: string
    }>
  }
}

export type ResearchEvaluationRunsResponse = {
  success: boolean
  mode: 'read_only'
  experiment_id: string
  runs: Array<ResearchEvaluationRunResponse['report'] & {
    id: string
    created_at: string
  }>
}

export type ResearchExperimentsResponse = {
  success: boolean
  mode: 'read_only'
  experiments: ResearchExperiment[]
  meta_learning_tracks?: Array<{
    id: 'LinUCB' | 'NeuralUCB' | 'NeuralTS' | 'OnlinePortfolioBandit' | 'NeuCB'
    stage: 'production_baseline' | 'counterfactual_audit' | 'production_controller' | 'strategy_research' | 'research_only'
    role: string
    learning_targets: string[]
    required_evidence: string[]
    decision_queue_status:
      | 'production_baseline_needs_evidence'
      | 'run_counterfactual_audit'
      | 'controller_evidence_active'
      | 'needs_experiment_registry'
      | 'research_only'
    can_influence_production: boolean
    can_vote_alpha: false
    next_action: string
    registered_experiment_ids: string[]
    experiment_template: {
      hypothesis: string
      sourceRefs: string[]
      strategySpecIds: string[]
      dataSlice: Record<string, unknown>
      metrics: string[]
      followUp: string[]
    }
  }>
  meta_learning_evidence_matrix?: Array<{
    id: 'LinUCB' | 'NeuralUCB' | 'NeuralTS' | 'OnlinePortfolioBandit' | 'NeuCB'
    stage: 'production_baseline' | 'counterfactual_audit' | 'production_controller' | 'strategy_research' | 'research_only'
    decision_queue_status: string
    evidence_status: 'ready' | 'partial' | 'missing'
    reward_ledger_status: 'ready' | 'missing' | 'not_applicable'
    shadow_status: 'ready' | 'partial' | 'missing' | 'not_applicable'
    registered_experiment_count: number
    samples: number
    latest_evidence_at: string | null
    next_action: string
    missing_evidence: string[]
  }>
  meta_learning_decision_packet?: string
}

export type ModelUpgradeResearchStatusRow = {
  candidate_id: string
  stage: 'layer3_formal_family_slot' | 'retired' | 'meta_optimizer' | 'state_space_overlay'
  family: string
  role: string
  registry_status: 'track_only' | 'experiment_missing' | 'evaluation_pending' | 'needs_attention' | 'ready_for_review' | 'approved_for_patch' | 'rejected'
  registered_experiment_ids: string[]
  latest_experiment_id: string | null
  latest_experiment_status: string | null
  latest_evaluation_verdict: 'ready_for_review' | 'needs_attention' | null
  latest_evaluation_at: string | null
  latest_patch_handoff_id: string | null
  latest_patch_handoff_at: string | null
  latest_artifact_intent_id: string | null
  latest_artifact_intent_status: 'blocked_missing_artifact' | 'ready_for_registry_preflight' | null
  artifact_intent_missing_fields: string[]
  registry_preflight_ready: boolean
  requires_experiment_registry: boolean
  can_predict: boolean
  can_vote: boolean
  production_effect: false
  next_action: string
  missing_evidence: string[]
}

export type ModelUpgradeResearchStatusResponse = {
  success: true
  mode: 'read_only'
  version: string
  candidates: ModelUpgradeResearchStatusRow[]
}

export type ModelUpgradeEvaluationRunResponse = {
  success: true
  mode: 'dry_run_execution'
  version: string
  production_effect: false
  seeded: { created: string[]; existing: string[]; total: number } | null
  requested_candidates: string[]
  runs: Array<{
    candidate_id: string
    experiment_id: string
    stage: ModelUpgradeResearchStatusRow['stage']
    verdict: 'ready_for_review' | 'needs_attention'
    status_after: string
    stored_id: string
    ok_steps: number
    skipped_steps: number
    error_steps: number
  }>
  status: ModelUpgradeResearchStatusResponse
  blocked_capabilities: string[]
  note?: string
}

export type ResearchPatchHandoff = {
  id: string
  version: string
  mode: 'metadata_only'
  experiment_id: string
  experiment_status: ResearchExperiment['status']
  created_at: string
  reviewer: string
  reason: string | null
  production_effect: false
  can_write_model_artifact_registry: false
  artifact_bridge: {
    candidate_type: 'model_family_shadow' | 'research_benchmark' | 'strategy_patch'
    candidate_ids: string[]
    requires_external_artifact: boolean
    target_registry: 'model_artifact_registry' | 'strategy_spec_registry'
  }
  implementation_plan: string[]
  validation_plan: string[]
  latest_evaluation: {
    id: string
    created_at: string
    verdict: 'ready_for_review' | 'needs_attention'
    review_packet: string
  } | null
  blocked_capabilities: string[]
}

export type ResearchPatchHandoffsResponse = {
  success: boolean
  mode: 'read_only'
  experiment_id: string
  handoffs: ResearchPatchHandoff[]
}

export type ResearchArtifactIntent = {
  id: string
  version: string
  mode: 'metadata_only'
  experiment_id: string
  handoff_id: string
  status: 'blocked_missing_artifact' | 'ready_for_registry_preflight'
  created_at: string
  reviewer: string
  reason: string | null
  production_effect: false
  target_registry: 'model_artifact_registry'
  registry_candidate: {
    artifact_id: string
    model_name: string
    version: string
    candidate_type: 'model_family_shadow' | 'research_benchmark'
    state: 'registered'
    artifact_path: string | null
    metadata_path: string | null
    training_manifest_path: string | null
    feature_policy_version: string | null
    checksum: string | null
    source_run_date: string
    approval_state: 'required'
    promotion_decision: 'not_evaluated'
  }
  preflight: {
    can_write_registry: false
    ready_for_manual_registry_write: boolean
    missing_fields: string[]
    blockers: string[]
    required_manual_steps: string[]
  }
  blocked_capabilities: string[]
}

export type ResearchArtifactIntentsResponse = {
  success: boolean
  mode: 'read_only'
  experiment_id: string
  intents: ResearchArtifactIntent[]
}

export type ResearchGateResult = {
  decision: 'ALLOW' | 'REQUIRE_APPROVAL' | 'BLOCK'
  action: string
  reason: string
  allowed_next_steps: string[]
  blocked_capabilities: string[]
}

export type ResearchGateResponse = {
  success: boolean
  mode: 'read_only'
  gate: ResearchGateResult
}

export const strategyLabApi = {
  specs: () => get<StrategySpecsResponse>('/admin/strategy/specs'),
  dryRun: (date?: string) => post<StrategyDryRunResponse>(`/admin/strategy/dry-run${date ? `?date=${date}` : ''}`),
  learning: (date?: string) => get<StrategyLearningResponse>(`/admin/strategy/learning${date ? `?date=${date}` : ''}`),
  policyState: (date?: string) => get<StrategyPolicyStateResponse>(`/admin/strategy/policy-state${date ? `?date=${date}` : ''}`),
  materializeDecisionLog: (body?: { date?: string; limit?: number; dry_run?: boolean; confirm?: boolean }) => req<any>(
    'POST',
    '/admin/strategy/decision-log/materialize',
    { ...body, dry_run: body?.dry_run ?? false },
    body?.confirm !== false ? { 'X-Confirm-Strategy-Learning': 'true' } : undefined,
  ),
  refreshStrategyRewardLedger: (body?: { start_date?: string; end_date?: string; limit?: number; dry_run?: boolean; confirm?: boolean }) => req<any>(
    'POST',
    '/admin/strategy/reward-ledger/refresh',
    { ...body, dry_run: body?.dry_run ?? false },
    body?.confirm !== false ? { 'X-Confirm-Strategy-Learning': 'true' } : undefined,
  ),
  refreshStrategyPolicyState: (body?: { date?: string; dry_run?: boolean; confirm?: boolean }) => req<any>(
    'POST',
    '/admin/strategy/policy-state/refresh',
    { ...body, dry_run: body?.dry_run ?? false },
    body?.confirm !== false ? { 'X-Confirm-Strategy-Learning': 'true' } : undefined,
  ),
  experiments: () => get<ResearchExperimentsResponse>('/admin/research/experiments'),
  modelUpgradeStatus: () => get<ModelUpgradeResearchStatusResponse>('/admin/research/model-upgrade/status'),
  seedModelUpgradeRegistry: (body?: { dry_run?: boolean; confirm?: boolean }) => req<any>(
    'POST',
    '/admin/research/model-upgrade/seed',
    { ...body, dry_run: body?.dry_run ?? false },
    body?.confirm !== false ? { 'X-Confirm-Research': 'true' } : undefined,
  ),
  runModelUpgradeEvaluations: (body?: { candidate_ids?: string[]; limit?: number; dry_run?: boolean; seed_missing?: boolean; include_ready?: boolean; confirm?: boolean }) => req<ModelUpgradeEvaluationRunResponse>(
    'POST',
    '/admin/research/model-upgrade/evaluation-run',
    { ...body, dry_run: body?.dry_run ?? true, seed_missing: body?.seed_missing ?? true },
    body?.confirm !== false ? { 'X-Confirm-Research': 'true' } : undefined,
  ),
  updateExperimentStatus: (id: string, body: { status: 'running' | 'review_ready' | 'approved_for_shadow' | 'needs_more_evidence' | 'paper_active_requested' | 'approved_for_patch' | 'rejected' | 'archived'; reason?: string; confirm?: boolean }) => req<{ success: boolean; mode: 'metadata_only'; experiment: ResearchExperiment; production_effect: false; blocked_capabilities: string[] }>(
    'POST',
    `/admin/research/experiments/${encodeURIComponent(id)}/status`,
    { status: body.status, reason: body.reason },
    body.confirm !== false ? { 'X-Confirm-Research': 'true' } : undefined,
  ),
  createPatchHandoff: (id: string, body?: { reviewer?: string; reason?: string; dry_run?: boolean; confirm?: boolean }) => req<{ success: boolean; mode: 'metadata_only'; handoff: ResearchPatchHandoff; production_effect: false; note?: string }>(
    'POST',
    `/admin/research/experiments/${encodeURIComponent(id)}/patch-handoff`,
    { reviewer: body?.reviewer ?? 'Wei', reason: body?.reason, dry_run: body?.dry_run ?? true },
    body?.confirm !== false ? { 'X-Confirm-Research': 'true' } : undefined,
  ),
  patchHandoffs: (id: string) => get<ResearchPatchHandoffsResponse>(
    `/admin/research/experiments/${encodeURIComponent(id)}/patch-handoffs`,
  ),
  createArtifactIntent: (id: string, body?: {
    model_name?: string
    artifact_version?: string
    artifact_path?: string
    metadata_path?: string
    training_manifest_path?: string
    feature_policy_version?: string
    checksum?: string
    reviewer?: string
    reason?: string
    dry_run?: boolean
    confirm?: boolean
  }) => req<{ success: boolean; mode: 'metadata_only'; intent: ResearchArtifactIntent; production_effect: false; note?: string }>(
    'POST',
    `/admin/research/experiments/${encodeURIComponent(id)}/artifact-intent`,
    {
      model_name: body?.model_name,
      artifact_version: body?.artifact_version,
      artifact_path: body?.artifact_path,
      metadata_path: body?.metadata_path,
      training_manifest_path: body?.training_manifest_path,
      feature_policy_version: body?.feature_policy_version,
      checksum: body?.checksum,
      reviewer: body?.reviewer ?? 'Wei',
      reason: body?.reason,
      dry_run: body?.dry_run ?? true,
    },
    body?.confirm !== false ? { 'X-Confirm-Research': 'true' } : undefined,
  ),
  artifactIntents: (id: string) => get<ResearchArtifactIntentsResponse>(
    `/admin/research/experiments/${encodeURIComponent(id)}/artifact-intents`,
  ),
  gate: (action: string, opts?: { dryRun?: boolean }) => post<ResearchGateResponse>('/admin/research/gate', { action, dryRun: opts?.dryRun }),
  createExperiment: (body: {
    hypothesis: string
    sourceRefs?: string[]
    strategySpecIds?: string[]
    metrics?: string[]
    followUp?: string[]
    dataSlice?: Record<string, unknown>
    status?: string
    id?: string
    dry_run?: boolean
    confirm?: boolean
    }) => req<{ success: boolean; mode: 'dry_run' | 'persisted'; experiment: ResearchExperiment; review_packet: string; hint?: string }>(
      'POST',
      '/admin/research/experiments',
      body,
      body.confirm ? { 'X-Confirm-Research': 'true' } : undefined,
    ),
  runEvaluationPlan: (id: string) => post<ResearchEvaluationRunResponse>(
    `/admin/research/experiments/${encodeURIComponent(id)}/evaluation-plan/run`,
    { dry_run: true },
  ),
  evaluationRuns: (id: string) => get<ResearchEvaluationRunsResponse>(
    `/admin/research/experiments/${encodeURIComponent(id)}/evaluation-runs`,
  ),
  refreshLinucbRewardLedger: (body?: { start_date?: string; end_date?: string; limit?: number; dry_run?: boolean; confirm?: boolean }) => req<any>(
    'POST',
    '/admin/meta-learning/linucb/reward-ledger/refresh',
    { ...body, dry_run: body?.dry_run ?? false },
    body?.confirm !== false ? { 'X-Confirm-Meta-Learning': 'true' } : undefined,
  ),
  runNeuralShadow: (body: { policy_id: 'NeuralUCB' | 'NeuralTS'; start_date?: string; end_date?: string; limit?: number; dry_run?: boolean; confirm?: boolean }) => req<any>(
    'POST',
    '/admin/meta-learning/neural-shadow/run',
    { ...body, dry_run: body.dry_run ?? false },
    body.confirm !== false ? { 'X-Confirm-Meta-Learning': 'true' } : undefined,
  ),
}

export type ModelPoolLifecycleDiagnosis = {
  status?: string
  reason?: string
  blockers?: string[]
  coverage?: number | null
  sample_count?: number
  root_cause?: string | null
  error?: string | null
  metadata_feature_count?: number | null
}

export type ModelPoolLineageModel = {
  status?: string
  version?: string
  balance_family?: string
  model_type?: string
  gcs_path?: string
  artifact_uri?: string
  metadata_path?: string
  metadata_exists?: boolean
  metadata?: Record<string, unknown> | null
  rolling_ic?: number | null
  weekly_ic?: number[]
  ic_4w_avg?: number | null
  last_ic_status?: string | null
  last_ic_root_cause?: string | null
  last_ic_sample_count?: number
  last_ic_diagnostics?: Record<string, number>
  last_ic_score_sources?: Record<string, number>
  last_ic_by_segment?: Record<string, Record<string, unknown>>
  last_ic_error?: string | null
  lifecycle_diagnosis?: ModelPoolLifecycleDiagnosis
  consecutive_negative_weeks?: number
  challenger?: {
    version?: string
    status?: string
    gcs_path?: string
    metadata_path?: string
    metadata_exists?: boolean
    metadata?: Record<string, unknown> | null
    artifact_evidence?: {
      status?: string
      oos_ic?: number | null
      daily_ic_count?: number
      val_dir_accuracy?: number | null
      feature_policy?: unknown
      dataset_snapshot?: unknown
      reason?: string
    } | null
    shadow_since?: string
    rolling_ic?: number | null
    weekly_ic?: number[]
    ic_4w_avg?: number | null
    last_ic_status?: string | null
    last_ic_root_cause?: string | null
    last_ic_sample_count?: number
    last_ic_diagnostics?: Record<string, number>
    last_ic_score_sources?: Record<string, number>
    last_ic_by_segment?: Record<string, Record<string, unknown>>
    last_ic_error?: string | null
    lifecycle_diagnosis?: ModelPoolLifecycleDiagnosis
  } | null
}

export type ModelPoolStateOverlay = {
  status?: string
  version?: string
  model_type?: string
  balance_family?: string
  role?: string
  gcs_path?: string
  note?: string
}

export type ModelPoolLineage = {
  status: string
  schema_version?: string
  last_updated?: string
  models: Record<string, ModelPoolLineageModel>
  state_overlays?: Record<string, ModelPoolStateOverlay>
  meta_optimizers?: Record<string, Record<string, unknown>>
  formal_layer3_slots?: Record<string, Record<string, unknown>>
  research_benchmarks?: Record<string, Record<string, unknown>>
  events: Array<Record<string, unknown>>
  error?: string
}

export type ModelArtifactRegistryRow = {
  artifact_id: string
  model_name: string
  version: string
  candidate_type: 'monthly_release' | 'weekly_drift' | 'manual_hotfix' | 'unknown'
  state: string
  artifact_path?: string | null
  metadata_path?: string | null
  training_run_id?: string | null
  training_manifest_path?: string | null
  trained_from_snapshot?: string | null
  evaluation_baseline_version?: string | null
  final_compared_to?: string | null
  feature_policy_version?: string | null
  checksum?: string | null
  source_run_date?: string | null
  offline_gate_status?: string
  offline_gate_decision?: string
  offline_gate_failed_gates?: string[] | string
  offline_evidence_json?: Record<string, unknown> | string
  live_gate_status?: string
  live_evidence_json?: Record<string, unknown> | string
  promotion_decision?: string
  approval_state?: string
  updated_at?: string
  created_at?: string
}

export type ModelArtifactActionContext = {
  root_cause: string
  impact: string
  next_action: string
  affected_downstream?: string[]
  scheduler_dependency?: string[]
  evidence_status?: string
  failed_gates?: string[]
  metrics?: Record<string, unknown>
  selection_slot?: string | null
  blockers?: Array<{ code: string; label: string; next_action: string; severity?: string }>
}

export type ModelArtifactRegistryResponse = {
  status: string
  source_of_truth: string
  count: number
  artifacts: ModelArtifactRegistryRow[]
}

export type ModelArtifactSelectionResponse = {
  status: string
  source_of_truth: string
  selection_policy: string
  models: Record<string, {
    monthly_release_candidate?: ModelArtifactRegistryRow | null
    weekly_drift_candidate?: ModelArtifactRegistryRow | null
    archive_candidates: string[]
    superseded_candidates?: string[]
    action_context?: {
      monthly_release_candidate?: ModelArtifactActionContext
      weekly_drift_candidate?: ModelArtifactActionContext
    }
    policy: Record<string, unknown>
  }>
}

export type ModelArtifactPromotionQueueResponse = {
  status: string
  source_of_truth: string
  promotion_owner: string
  count: number
  suppressed_count?: number
  suppressed?: Array<{
    artifact_id?: string | null
    model_name: string
    candidate_version?: string | null
    candidate_type: string
    superseded_by?: string | null
    reason: string
  }>
  queue: Array<{
    artifact_id?: string | null
    model_name: string
    candidate_version?: string | null
    candidate_type: string
    state: string
    offline_gate_decision?: string | null
    live_gate_status?: string | null
    evaluation_baseline_version?: string | null
    final_compared_to?: string | null
    current_champion_version?: string | null
    promotion_decision: string
    approval_required: boolean
    next_action: string
    blockers?: Array<{ code: string; label: string; next_action: string; severity?: string }>
    blocker_codes?: string[]
    action_context?: ModelArtifactActionContext
  }>
}

export type ModelArtifactPromotionControllerRequest = {
  artifact_id: string
  confirm?: boolean
  approved?: boolean
  approved_by?: string
  reason?: string
}

export type ModelArtifactPromotionControllerResponse = {
  status: string
  promotion_owner?: string
  artifact_id?: string
  model_name?: string
  candidate_version?: string
  decision?: string
  can_promote?: boolean
  approval_required?: boolean
  approval_state?: string
  target_state?: string
  final_compared_to?: string | null
  next_action?: string
  evidence?: Record<string, unknown>
  errors?: string[]
  note?: string
}

export type ModelChampionPointersResponse = {
  status: string
  source_of_truth: string
  target_source_of_truth: string
  production_reader: string
  migration_ready: boolean
  ready_count: number
  model_count: number
  models: Record<string, {
    serving_version?: string | null
    d1_pointer_version?: string | null
    d1_pointer_artifact_id?: string | null
    artifact_link_status?: string | null
    readiness: string
    next_action: string
  }>
}

export const modelPoolApi = {
  status: () => get<any>('/model-pool/status'),
  lineage: () => get<ModelPoolLineage>('/model-pool/lineage'),
  artifactRegistry: (limit = 100) => get<ModelArtifactRegistryResponse>(`/model-pool/artifact_registry?limit=${limit}`),
  artifactSelection: (limit = 200) => get<ModelArtifactSelectionResponse>(`/model-pool/artifact_registry/selection?limit=${limit}`),
  artifactPromotionQueue: (limit = 200) => get<ModelArtifactPromotionQueueResponse>(`/model-pool/artifact_registry/promotion_queue?limit=${limit}`),
  promotionController: (body: ModelArtifactPromotionControllerRequest) => post<ModelArtifactPromotionControllerResponse>('/model-pool/artifact_registry/promotion_controller', body),
  championPointers: (limit = 200) => get<ModelChampionPointersResponse>(`/model-pool/artifact_registry/champion_pointers?limit=${limit}`),
  backfillChampionPointers: (body: { confirm: boolean; reason?: string; create_missing_artifacts?: boolean }) => post<any>('/model-pool/artifact_registry/champion_pointers/backfill', body),
}

// 2026-04-21 #43 Cost Tracking API
export type CostsToday = {
  date: string
  total_usd: number
  breakdown: Array<{
    source: string
    provider: string
    model: string
    calls: number
    tokens_in_total: number
    tokens_out_total: number
    compute_sec_total: number
    est_usd_total: number
  }>
}

export type CostsMonth = {
  total_usd: number
  by_source: Array<{
    source: string
    provider: string
    model: string
    total_usd: number
    calls: number
    tokens_in: number
    tokens_out: number
  }>
  by_day: Array<{ date: string; total_usd: number }>
}

export const costsApi = {
  today: (date?: string) => get<CostsToday>(`/admin/costs/today${date ? `?date=${date}` : ''}`),
  month: () => get<CostsMonth>('/admin/costs/month'),
}

export const paperApi = {
  account:         () => get<any>('/paper/account'),
  positions:       () => get<any>('/paper/positions'),
  orders:          (limit = 50) => get<any>(`/paper/orders?limit=${limit}`),
  pnl:             () => get<any>('/paper/pnl'),
  realized:        () => get<any>('/paper/realized'),
  journal:         () => get<any>('/paper/journal'),
  cronLogs:        (date?: string) => get<any>(`/admin/cron-logs${date ? `?date=${date}` : ''}`),
  quadrantFilter:  (date?: string) => get<any>(`/paper/quadrant-filter${date ? `?date=${date}` : ''}`),
  pendingBuys:     () => get<any>('/paper/pending-buys'),
  gateCalibration: (days = 7) => get<any>(`/paper/gate-calibration?days=${days}`),
}

export const adaptiveApi = {
  get:  () => get<any>('/admin/adaptive-params'),
  set:  (params: any) => post<any>('/admin/adaptive-params', params),
}

export const adminApi = {
  users:   () => get<any[]>('/auth/admin/users'),
  approveByToken: (token: string, action: 'approve' | 'reject') =>
    post<any>('/auth/admin/approve', { token, action }),
  setStatus: (userId: number, status: 'approved' | 'rejected') =>
    post<any>(`/auth/admin/users/${userId}/status`, { status }),
  setRole: (userId: number, role: 'user' | 'admin') =>
    post<any>(`/auth/admin/users/${userId}/role`, { role }),
}
