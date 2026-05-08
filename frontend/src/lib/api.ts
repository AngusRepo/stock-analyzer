const BASE = import.meta.env.VITE_API_URL ?? '/api'
export const AUTH_TOKEN_EVENT = 'stockvision:auth-token'

let _token: string | null = sessionStorage.getItem('sv_token')

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

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string,string> = { 'Content-Type': 'application/json' }
  if (_token) headers['Authorization'] = `Bearer ${_token}`
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
  if (res.status === 401) { clearToken(); throw new Error('Unauthorized') }
  if (!res.ok) { const e = await res.json().catch(() => ({ error: res.statusText })) as any; throw new Error(e.error ?? `HTTP ${res.status}`) }
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

export const systemApi = {
  status: () => get<any>('/system/status'),
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
  lastError?: string
  nextRun: string
  history7d: Array<'success' | 'failed' | 'skip'>
  rate7d: string
  summary: string
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
    stage: 'production_baseline' | 'shadow_challenger' | 'strategy_research' | 'research_only'
    role: string
    learning_targets: string[]
    required_evidence: string[]
    decision_queue_status:
      | 'production_baseline_needs_evidence'
      | 'run_shadow'
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
    stage: 'production_baseline' | 'shadow_challenger' | 'strategy_research' | 'research_only'
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
  experiments: () => get<ResearchExperimentsResponse>('/admin/research/experiments'),
  gate: (action: string, opts?: { dryRun?: boolean }) => post<ResearchGateResponse>('/admin/research/gate', { action, dryRun: opts?.dryRun }),
  createExperiment: (body: {
    hypothesis: string
    sourceRefs?: string[]
    strategySpecIds?: string[]
    metrics?: string[]
    followUp?: string[]
    dry_run?: boolean
  }) => post<{ success: boolean; mode: 'dry_run' | 'persisted'; experiment: ResearchExperiment; review_packet: string; hint?: string }>(
    '/admin/research/experiments',
    body,
  ),
  runEvaluationPlan: (id: string) => post<ResearchEvaluationRunResponse>(
    `/admin/research/experiments/${encodeURIComponent(id)}/evaluation-plan/run`,
    { dry_run: true },
  ),
  evaluationRuns: (id: string) => get<ResearchEvaluationRunsResponse>(
    `/admin/research/experiments/${encodeURIComponent(id)}/evaluation-runs`,
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
  events: Array<Record<string, unknown>>
  error?: string
}

export const modelPoolApi = {
  status: () => get<any>('/model-pool/status'),
  lineage: () => get<ModelPoolLineage>('/model-pool/lineage'),
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
  orders:          (limit = 50) => get<any[]>(`/paper/orders?limit=${limit}`),
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
