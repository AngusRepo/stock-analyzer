import { useMutation, useQuery } from '@tanstack/react-query'
import {
  ArrowRight,
  Database,
  ExternalLink,
  Loader2,
  Workflow,
} from 'lucide-react'
import AppShell from '@/components/AppShell'
import ExecutionChainPanel, { schedulerRefreshInterval } from '@/components/observability/ExecutionChainPanel'
import { Button } from '@/components/ui/button'
import {
  WorkstationPageTitle,
  WorkstationPanel,
  WorkstationStatusPill,
  type WorkstationTone,
} from '@/components/workstation/WorkstationChrome'
import { STATUS_CHIP, TW_COLORS } from '@/lib/colorTokens'
import { StatusIcon } from '@/components/ui/status'
import { humanSource, humanStatus, humanJobSummary, jobErrorText, jobSummaryText } from '@/lib/humanLabels'
import {
  ApprovalReviewPanel,
  type ApprovalReviewGate,
  type ApprovalReviewImpact,
  type ApprovalReviewMetric,
} from '@/components/workstation/ApprovalReviewPanel'
import {
  dataQualityApi,
  deployGateApi,
  observabilityApi,
  schedulerApi,
  storageApi,
  systemApi,
  type DataQualityCheck,
  type DataQualityReport,
  type ObservabilityEvent,
  type ObservabilitySeverity,
  type SchedulerJob,
  type SchedulerStatus,
  type ShadowEvidenceClockReport,
  type StorageCapacitySnapshot,
} from '@/lib/api'

function statusTone(status?: string | null): WorkstationTone {
  const value = String(status ?? '').toLowerCase()
  if (['ok', 'pass', 'success', 'resolved'].includes(value)) return 'ok'
  if (value === 'running') return 'info'
  if (['warn', 'warning', 'watch', 'waiting'].includes(value)) return 'warn'
  if (['sleep', 'skip', 'skipped'].includes(value)) return 'neutral'
  if (['fail', 'failed', 'error', 'block', 'blocked'].includes(value)) return 'error'
  return 'info'
}

function schedulerStatusLabel(status?: string | null) {
  const value = String(status ?? '').toLowerCase()
  if (value === 'blocked') return '上游阻擋'
  if (value === 'waiting') return '等待中'
  if (value === 'sleep') return '今日不跑'
  if (value === 'skip' || value === 'skipped') return '略過'
  if (value === 'success') return '成功'
  if (value === 'failed') return '失敗'
  if (value === 'running') return '執行中'
  return status || '未知'
}

const EXECUTION_REALISM_STATES = [
  'checked_waiting',
  'quote_unavailable',
  'stale_quote',
  'requoted',
  'partially_filled',
  'expired',
] as const

function severityTone(severity?: ObservabilitySeverity | null): WorkstationTone {
  if (severity === 'error') return 'error'
  if (severity === 'warn') return 'warn'
  if (severity === 'ok') return 'ok'
  return 'info'
}

function toneColor(tone: WorkstationTone) {
  if (tone === 'ok') return TW_COLORS.ok
  if (tone === 'warn') return TW_COLORS.warn
  if (tone === 'error') return TW_COLORS.fail
  if (tone === 'info') return '#38bdf8'
  return '#94a3b8'
}

/** 狀態碼 → 中文短名；原始碼放 title。 */
const OBS_STATUS_LABELS: Record<string, string> = {
  high_recent_loss_rate_force_explore: '近期虧損率高，強制探索',
}

// 狀態碼：先查白話對照，查不到就把底線換空白（可換行、不撐出右緣）；原碼不進 tooltip。
const GOVERNANCE_LABELS: Record<string, string> = {
  manual_only: '僅人工核准',
  comparison_only: '僅供比較',
  regime_independent: '不分盤勢',
}

// 後端識別名（snake_case）顯示時把底線換成空白，畫面不露原碼、長名稱可換行。
function plainCode(value: unknown): string {
  return String(value ?? '').replace(/_/g, ' ')
}

// GA 晉級所需 evidence 的中文名稱（後端 required_evidence 代碼）。
const GA_EVIDENCE_LABELS: Record<string, string> = {
  policy_candidate: '候選策略',
  primary_gate: '主要門檻',
  stable_history: '穩定歷史',
  pbo_mc_cost_governance: 'PBO／蒙地卡羅／成本治理',
}

const L3_BLOCKER_LABELS: Record<string, string> = {
  primary_gate: '主要門檻',
  min_trade_count: '交易筆數不足',
  min_sharpe: 'Sharpe 不足',
  max_drawdown: '最大回撤超標',
  pbo: '過度擬合機率（PBO）超標',
  promotion_packet: '升級封包未就緒',
  model_pool: '模型池未就緒',
}

// GA L3 阻擋原因：primary_gate / min_trade_count → 主要門檻／交易筆數不足。
function l3BlockerLabel(raw: string): string {
  return raw.split('/').map((part) => part.trim()).filter(Boolean)
    .map((part) => L3_BLOCKER_LABELS[part] ?? (looksInternalCode(part) ? part.replace(/_/g, ' ') : part)).join('／')
}

function looksInternalCode(text: string): boolean {
  return /^[a-z0-9]+(?:_[a-z0-9]+)+$/i.test(text)
}

function StatusCode({ raw, fallback = 'N/A' }: { raw?: string | null; fallback?: string }) {
  if (!raw) return <>{fallback}</>
  const key = String(raw).trim()
  const mapped = OBS_STATUS_LABELS[key.toLowerCase()]
  return <span>{mapped ?? humanStatus(key, key.replace(/_/g, ' ').toLowerCase())}</span>
}

function errorMessage(error: unknown) {
  if (!error) return null
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

function MiniBar({ value, tone }: { value: number; tone: WorkstationTone }) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0))
  return (
    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-800">
      <div className="h-full rounded-full" style={{ width: `${clamped}%`, backgroundColor: toneColor(tone) }} />
    </div>
  )
}

type ReadinessStatus = 'ready' | 'running' | 'waiting' | 'blocked' | 'pending'

type ReadinessStage = {
  id: string
  label: string
  owner: string
  detail: string
  status: ReadinessStatus
  tone: WorkstationTone
  job?: SchedulerJob
  nextAction: string
}

type ReadinessGate = {
  id: string
  label: string
  status: ReadinessStatus
  tone: WorkstationTone
  value: string
  source: string
  detail: string
  latestDate?: string | null
}

type MarketMaterializationItem = {
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

const READINESS_STAGES: Array<{
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

function readinessTone(status: ReadinessStatus): WorkstationTone {
  if (status === 'ready') return 'ok'
  if (status === 'running') return 'info'
  if (status === 'waiting' || status === 'pending') return 'warn'
  return 'error'
}

function readinessLabel(status: ReadinessStatus) {
  if (status === 'ready') return '就緒'
  if (status === 'running') return '執行中'
  if (status === 'waiting') return '等待中'
  if (status === 'blocked') return '阻擋'
  return '待定'
}

function readinessStatusFromScheduler(status?: string | null): ReadinessStatus {
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

function stageFromDefinition(def: typeof READINESS_STAGES[number], jobs: SchedulerJob[]): ReadinessStage {
  const job = chooseRepresentativeJob(jobs, def.jobIds)
  const status = readinessStatusFromScheduler(job?.lastStatus)
  return {
    id: def.id,
    label: def.label,
    owner: def.owner,
    detail: job?.summary ? jobSummaryText(job) : def.detail,
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

function gateStatusFromQuality(status?: string | null): ReadinessStatus {
  const value = String(status ?? '').toLowerCase()
  if (value === 'ok' || value === 'success' || value === 'ready') return 'ready'
  if (value === 'warn' || value === 'waiting') return 'waiting'
  if (value === 'fail' || value === 'failed' || value === 'blocked') return 'blocked'
  return 'pending'
}

function buildReadinessGates(checks: DataQualityCheck[]): ReadinessGate[] {
  const { check, items } = parseMarketMaterialization(checks)
  if (items.length) {
    return items.map((item) => {
      const status = gateStatusFromQuality(item.status)
      const freshness = item.lag_days == null ? '落後天數未知' : `落後 ${item.lag_days} 天`
      return {
        id: item.key,
        label: item.label,
        status,
        tone: readinessTone(status),
        value: `${Number(item.rows ?? 0).toLocaleString()} 筆`,
        // source／root_cause 是後端識別名（canonical_*、formal_shadow_fetch_failed），畫面只放白話。
        source: humanSource(item.source, '正式日資料'),
        detail: item.root_cause ? humanStatus(item.root_cause, '需要檢查來源') : `${humanSource(item.scope, '市場儀表板')}／${freshness}`,
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
      detail: '目前 OBS 尚未取得首頁資料匯入檢查；local preview 只顯示結構。',
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

function statusRingClass(tone: WorkstationTone) {
  if (tone === 'ok') return 'border-ok/35 bg-ok/10 text-ok'
  if (tone === 'warn') return 'border-warn/35 bg-warn/10 text-warn'
  if (tone === 'error') return 'border-fail/35 bg-fail/10 text-fail'
  if (tone === 'info') return 'border-sky-400/35 bg-sky-400/10 text-sky-100 shadow-[0_0_28px_rgba(56,189,248,0.10)]'
  return 'border-slate-500/35 bg-slate-500/10 text-slate-200'
}

function ReadinessGauge({ score, tone }: { score: number; tone: WorkstationTone }) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(score) ? score : 0))
  const color = toneColor(tone)
  return (
    <div className="relative grid h-20 w-20 shrink-0 place-items-center rounded-full border border-[#2b3a49] bg-[#070a10]">
      <div
        className="absolute inset-2 rounded-full"
        style={{ background: `conic-gradient(${color} ${clamped * 3.6}deg, rgba(148,163,184,0.14) 0deg)` }}
      />
      <div className="relative grid h-16 w-16 place-items-center rounded-full bg-[#0f151d] shadow-[inset_0_0_20px_rgba(0,0,0,0.45)]">
        <div className="text-center">
          <p className="sv-num text-2xl font-semibold text-[#f2ead8]">{clamped}</p>
          <p className="sv-num text-xs normal-case text-[#7f8ba0]">readiness</p>
        </div>
      </div>
    </div>
  )
}

function formatStorageBytes(bytes: number | null | undefined): string {
  const value = Number(bytes)
  if (!Number.isFinite(value)) return 'N/A'
  if (Math.abs(value) >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)} GB`
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} MB`
  return `${Math.round(value).toLocaleString()} B`
}

function capacityTone(status?: string): WorkstationTone {
  if (status === 'critical') return 'error'
  if (status === 'drain' || status === 'warning') return 'warn'
  return 'ok'
}

function StorageCapacityPanel({
  report,
  loading,
  error,
}: {
  report?: StorageCapacitySnapshot
  loading: boolean
  error?: string | null
}) {
  const priorities = new Map([['DB', 0], ['LEARNING_DB', 1], ['OPS_DB', 2]])
  const rows = [...(report?.d1.capacities ?? [])].sort((a, b) =>
    (priorities.get(a.binding_name) ?? 10) - (priorities.get(b.binding_name) ?? 10)
      || a.binding_name.localeCompare(b.binding_name),
  )
  const r2 = report?.r2
  const gcs = report?.gcs

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sky-200">
            <Database className="h-4 w-4" />
            <p className="text-sm font-semibold">D1 / R2 / GCS Storage Capacity</p>
          </div>
          <h3 className="mt-2 font-['Space_Grotesk'] text-xl font-semibold text-[#f8efe0]">資料庫容量</h3>
          <p className="mt-1 text-xs leading-5 text-[#9badbf]">D1 顯示即時 binding query metadata；R2／GCS 顯示可稽核 manifest 容量。</p>
        </div>
        <div className="flex gap-2">
          <WorkstationStatusPill tone={rows.length === report?.d1.expected_count ? 'ok' : 'warn'}>D1 {report?.d1.count ?? 0}/{report?.d1.expected_count ?? 8}</WorkstationStatusPill>
          <WorkstationStatusPill tone={r2?.count ? 'ok' : 'warn'}>R2 {r2?.count ?? 0}</WorkstationStatusPill>
          <WorkstationStatusPill tone={gcs?.count ? 'ok' : 'warn'}>GCS {gcs?.count ?? 0}</WorkstationStatusPill>
        </div>
      </div>
      {loading && <p className="mt-4 sv-num text-xs normal-case text-sky-200">Loading current storage snapshot...</p>}
      {error && <p className="mt-4 flex items-center gap-1 text-xs text-fail"><StatusIcon tone="fail" />Capacity API：{error}</p>}
      {!loading && !error && (
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {rows.map((row) => {
            const tone = capacityTone(row.status)
            return (
              <div key={row.binding_name} className={`border-0 border-l-2 p-2 ${statusRingClass(tone)}`}>
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate sv-num text-xs normal-case text-[#f2ead8]">{row.domain} · {row.binding_name}</p>
                  <span className="sv-num text-xs normal-case" style={{ color: toneColor(tone) }}>{row.utilization_pct.toFixed(2)}%</span>
                </div>
                <MiniBar value={row.utilization_pct} tone={tone} />
                <p className="mt-1 sv-num text-xs normal-case text-[#9badbf]">{formatStorageBytes(row.used_bytes)} / {formatStorageBytes(row.max_bytes)}</p>
                {row.daily_growth_bytes != null && row.daily_growth_bytes > 0 && (
                  <p className={`mt-1 text-xs ${row.projected_days_to_max != null && row.projected_days_to_max < 30 ? 'text-fail' : 'text-slate-400'}`}>
                    +{formatStorageBytes(row.daily_growth_bytes)}/日 · 預估 {row.projected_days_to_max ?? 'N/A'} 日滿載
                  </p>
                )}
                {row.growth_baseline_status === 'awaiting_post_cutover_observations' && (
                  <p className="mt-1 text-xs text-cyan-200">
                    等待 {row.growth_baseline_after ?? 'Learning 切轉'} 後容量基線
                  </p>
                )}
              </div>
            )
          })}
          <div className="border-l-2 border-violet-400/40 p-2 text-violet-100">
            <div className="flex items-center justify-between gap-2">
              <p className="sv-num text-xs normal-case">R2 · {r2?.binding_name ?? 'ARTIFACTS'}</p>
              <span className="sv-num text-xs normal-case">容量百分比 N/A</span>
            </div>
            <p className="mt-2 sv-num text-xs normal-case text-violet-200">{formatStorageBytes(r2?.tracked_bytes)} · {(r2?.tracked_object_count ?? 0).toLocaleString()} objects</p>
            <p className="mt-1 text-xs leading-4 text-slate-400">R2 bucket 無固定容量上限；不偽造百分比，改顯示 manifest 可稽核用量。</p>
          </div>
          <div className="border-l-2 border-sky-400/40 p-2 text-sky-100">
            <div className="flex items-center justify-between gap-2">
              <p className="sv-num text-xs normal-case">GCS · {gcs?.binding_name ?? 'GCS_BUCKET_NAME'}</p>
              <span className="sv-num text-xs normal-case">容量百分比 N/A</span>
            </div>
            <p className="mt-2 sv-num text-xs normal-case text-sky-200">{formatStorageBytes(gcs?.tracked_bytes)} · {(gcs?.tracked_object_count ?? 0).toLocaleString()} objects</p>
            <p className="mt-1 text-xs leading-4 text-slate-400">GCS 顯示 snapshot component manifest 去重後的可稽核用量。</p>
          </div>
        </div>
      )}
      <p className="mt-3 sv-num text-xs normal-case text-[#70809b]">snapshot {report?.generated_at ?? 'pending'}</p>
    </div>
  )
}

function ReadinessFlowMap({ stages }: { stages: ReadinessStage[] }) {
  return (
    <div className="pb-1">
      <div className="grid min-w-0 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {stages.map((stage, index) => {
          const detailItems = Array.isArray(stage.job?.details)
            ? [
                ...stage.job.details.filter((detail) => detail.toLowerCase().startsWith('waiting')),
                ...stage.job.details.filter((detail) => detail.toLowerCase().startsWith('ok')),
              ].slice(0, 3)
            : []
          return (
            <div key={stage.id} className="min-w-0">
              <div className={`min-h-[148px] rounded-2xl border p-3 ${statusRingClass(stage.tone)}`}>
                <div className="flex items-start justify-between gap-3">
                  <span className="grid h-8 w-8 place-items-center rounded-xl border border-white/10 bg-black/20 sv-num text-[12px] text-[#ffd87f]">{index + 1}</span>
                  <WorkstationStatusPill tone={stage.tone}>{readinessLabel(stage.status)}</WorkstationStatusPill>
                </div>
                <p className="mt-3 text-base font-semibold text-[#f8efe0]">{stage.label}</p>
                <p className="mt-1 sv-num text-xs normal-case text-[#9badbf]">{stage.owner}</p>
                <p className="mt-3 text-xs leading-5 text-[#a8b6c5]">{stage.detail}</p>
                {detailItems.length > 0 && (
                  <div className="mt-2 flex min-w-0 flex-wrap gap-1">
                    {detailItems.map((detail) => {
                      const waiting = detail.toLowerCase().startsWith('waiting')
                      const chipTone = waiting ? 'warn' : 'ok'
                      return (
                        <span
                          key={`${stage.id}-${detail}`}
                          className="max-w-full rounded-lg border px-2 py-1 sv-num text-xs leading-4 normal-case [overflow-wrap:anywhere]"
                          style={{
                            borderColor: `${toneColor(chipTone)}45`,
                            backgroundColor: `${toneColor(chipTone)}10`,
                            color: toneColor(chipTone),
                          }}
                        >
                          {detail.replace(/^ok\s+/i, '').replace(/^waiting\s+/i, '')}
                        </span>
                      )
                    })}
                  </div>
                )}
                <p className="mt-2 truncate sv-num text-xs normal-case text-[#70809b]">{stage.job?.lastRun || stage.job?.nextRun || 'no runtime evidence yet'}</p>
              </div>
              {index < stages.length - 1 && <ArrowRight className="hidden h-3.5 w-3.5 text-[#4d5b70]" />}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ReadinessGateMatrix({ gates, limit = 12 }: { gates: ReadinessGate[]; limit?: number }) {
  const visibleGates = limit > 0 ? gates.slice(0, limit) : gates
  return (
    <div className="grid gap-2 md:grid-cols-2 2xl:grid-cols-4">
      {visibleGates.map((gate) => (
        <div key={gate.id} className={`rounded-2xl border p-3 ${statusRingClass(gate.tone)}`}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="break-words text-sm font-semibold text-[#f2ead8]">{gate.label}</p>
              <p className="mt-1 break-words sv-num text-xs normal-case text-[#7f8ba0]">{gate.source}</p>
            </div>
            <WorkstationStatusPill tone={gate.tone}>{readinessLabel(gate.status)}</WorkstationStatusPill>
          </div>
          <div className="mt-3 flex items-end justify-between gap-3">
            <p className="sv-num text-xl font-semibold" style={{ color: toneColor(gate.tone) }}>{gate.value}</p>
            <p className="sv-num text-xs normal-case text-[#8b9bab]">{gate.latestDate ?? 'date n/a'}</p>
          </div>
          <MiniBar value={gate.status === 'ready' ? 94 : gate.status === 'running' ? 72 : gate.status === 'waiting' ? 48 : gate.status === 'blocked' ? 100 : 28} tone={gate.tone} />
          <p className="mt-2 break-words text-xs leading-5 text-[#9badbf]">{gate.detail}</p>
        </div>
      ))}
    </div>
  )
}

function DataQualityCompactMatrix({ gates, compact = false }: { gates: ReadinessGate[]; compact?: boolean }) {
  return (
    <div className={compact ? 'grid grid-cols-2 gap-2 lg:grid-cols-4' : 'grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-6'}>
      {gates.map((gate) => (
        <div key={gate.id} className={`min-h-[106px] rounded-xl border p-2 ${statusRingClass(gate.tone)}`}>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="break-words text-xs font-semibold text-[#f2ead8]">{gate.label}</p>
              <p className="mt-0.5 break-words sv-num text-xs normal-case text-[#7f8ba0]">{gate.source}</p>
            </div>
            <span className="shrink-0 rounded-full border border-white/10 bg-black/20 px-1.5 py-0.5 sv-num text-xs normal-case" style={{ color: toneColor(gate.tone) }}>
              {readinessLabel(gate.status)}
            </span>
          </div>
          <div className="mt-2 flex items-end justify-between gap-2">
            <p className="whitespace-nowrap sv-num text-base font-semibold" style={{ color: toneColor(gate.tone) }}>{gate.value}</p>
            <p className="shrink-0 sv-num text-xs normal-case text-[#8b9bab]">{gate.latestDate ?? 'n/a'}</p>
          </div>
          <MiniBar value={gate.status === 'ready' ? 94 : gate.status === 'running' ? 72 : gate.status === 'waiting' ? 48 : gate.status === 'blocked' ? 100 : 28} tone={gate.tone} />
          <p className="mt-1 break-words text-xs leading-4 text-[#9badbf]">{gate.detail}</p>
        </div>
      ))}
    </div>
  )
}

const SCHEDULER_GROUP_META: Record<SchedulerJob['group'], {
  label: string
  purpose: string
  tone: WorkstationTone
  expectedCount: number
  examples: string[]
}> = {
  pipeline_chain: {
    label: 'Daily readiness chain',
    purpose: '收盤資料、指標、推薦、驗證與隔日 evidence 的主鏈。',
    tone: 'info',
    expectedCount: 23,
    examples: ['Market Close Refresh', 'Readiness Probe', 'Pipeline', 'Verify'],
  },
  intraday: {
    label: 'Intraday execution',
    purpose: '盤中檢查、重評分、收盤前出場與收盤後持倉價格快取。',
    tone: 'ok',
    expectedCount: 4,
    examples: ['Intraday Check', 'Intraday Re-score', 'EOD Exit', 'Post-close Refresh'],
  },
  daily: {
    label: 'Daily standalone',
    purpose: '晨間、新聞、快照、外部 evidence、記憶保留與 queue 類日常排程。',
    tone: 'warn',
    expectedCount: 8,
    examples: ['US Leading', 'News Analyst', 'Morning Setup', 'External Evidence'],
  },
  weekly: {
    label: 'Weekly research',
    purpose: '週度審計、回測、Optuna、adaptive replay 與品質檢查。',
    tone: 'neutral',
    expectedCount: 9,
    examples: ['Weekly Audit', 'Weekly Backtest', 'Alpha Quality', 'Sector Leaders'],
  },
  monthly: {
    label: 'Monthly gated',
    purpose: '月度挖礦、Optuna 與 retrain，偏研究或 approval-gated。',
    tone: 'error',
    expectedCount: 3,
    examples: ['Monthly Optuna', 'Strategy Mining', 'Universal Retrain'],
  },
}

const SCHEDULER_GROUP_ANCHOR_PREFIX = 'scheduler-group-'

function schedulerGroupAnchor(group: SchedulerJob['group']) {
  return `${SCHEDULER_GROUP_ANCHOR_PREFIX}${group}`
}

function groupSchedulerJobs(jobs: SchedulerJob[]) {
  const jobsByGroup = new Map<SchedulerJob['group'], SchedulerJob[]>()
  for (const job of jobs) {
    const groupJobs = jobsByGroup.get(job.group) ?? []
    groupJobs.push(job)
    jobsByGroup.set(job.group, groupJobs)
  }
  return jobsByGroup
}

function schedulerStatusIs(job: SchedulerJob, statuses: string[]) {
  return statuses.includes(String(job.lastStatus ?? '').toLowerCase())
}

function summarizeSchedulerGroup(jobs: SchedulerJob[]) {
  const failed = jobs.filter((job) => schedulerStatusIs(job, ['failed', 'error'])).length
  const running = jobs.filter((job) => schedulerStatusIs(job, ['running'])).length
  const waiting = jobs.filter((job) => schedulerStatusIs(job, ['waiting'])).length
  const success = jobs.filter((job) => schedulerStatusIs(job, ['success'])).length
  const inactive = jobs.filter((job) => schedulerStatusIs(job, ['sleep', 'skip', 'skipped'])).length
  const tone: WorkstationTone = failed ? 'error' : running ? 'info' : waiting ? 'warn' : success ? 'ok' : 'neutral'
  const focus =
    jobs.find((job) => schedulerStatusIs(job, ['failed', 'error'])) ??
    jobs.find((job) => schedulerStatusIs(job, ['running'])) ??
    jobs.find((job) => schedulerStatusIs(job, ['waiting'])) ??
    jobs.find((job) => job.nextRun && job.nextRun !== 'N/A') ??
    jobs[0]

  return { failed, running, waiting, success, inactive, tone, focus }
}

function schedulerGroupHealthLabel(summary: ReturnType<typeof summarizeSchedulerGroup>, hasRuntimeJobs: boolean, groupJobCount: number) {
  if (!hasRuntimeJobs) return '離線'
  if (!groupJobCount) return '缺資料'
  if (summary.failed) return '失敗'
  if (summary.running) return '執行中'
  if (summary.waiting) return '等待中'
  if (summary.success || summary.inactive) return '正常'
  return '閒置'
}

function SchedulerCountChip({ label, value, tone }: { label: string; value: number; tone: WorkstationTone }) {
  return (
    <span className={`min-w-0 rounded-lg border px-1.5 py-1 text-center sv-num text-xs normal-case ${statusRingClass(tone)}`}>
      <span className="block leading-none">{label}</span>
      <span className="mt-1 block text-sm font-semibold leading-none">{value}</span>
    </span>
  )
}

function SchedulerShortcutCard({
  group,
  jobs,
  hasRuntimeJobs,
  schedulerApiError,
  className,
}: {
  group: SchedulerJob['group']
  jobs: SchedulerJob[]
  hasRuntimeJobs: boolean
  schedulerApiError?: string | null
  className?: string
}) {
  const meta = SCHEDULER_GROUP_META[group]
  const summary = summarizeSchedulerGroup(jobs)
  const cardTone: WorkstationTone = schedulerApiError
    ? 'error'
    : hasRuntimeJobs
    ? jobs.length
      ? summary.tone === 'neutral' ? 'neutral' : summary.tone
      : 'warn'
    : meta.tone
  const healthLabel = schedulerApiError ? 'API 異常' : schedulerGroupHealthLabel(summary, hasRuntimeJobs, jobs.length)
  const focusText = summary.focus
    ? `${summary.focus.name} · ${schedulerStatusLabel(summary.focus.lastStatus)}`
    : schedulerApiError
      ? `Scheduler API: ${schedulerApiError}`
    : `${meta.expectedCount} expected schedulers`

  return (
    <a
      href={`#${schedulerGroupAnchor(group)}`}
      className={`group min-w-0 rounded-xl border p-2.5 transition duration-200 hover:-translate-y-0.5 hover:border-sky-300/45 hover:bg-[#121b27] focus:outline-none focus:ring-2 focus:ring-sky-300/45 ${statusRingClass(cardTone)} ${className ?? ''}`}
      title={`Jump to ${meta.label}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-[#f8efe0]">{meta.label}</p>
          <p className="mt-0.5 break-words sv-num text-xs normal-case text-[#7f8ba0]">{plainCode(group)}</p>
        </div>
        <WorkstationStatusPill tone={cardTone}>{healthLabel}</WorkstationStatusPill>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-1">
        <SchedulerCountChip label="成功" value={summary.success} tone="ok" />
        <SchedulerCountChip label="執行" value={summary.running} tone="info" />
        <SchedulerCountChip label="等待" value={summary.waiting} tone="warn" />
        <SchedulerCountChip label="失敗" value={summary.failed} tone="error" />
      </div>
      <div className="mt-2 flex min-w-0 items-center justify-between gap-2">
        <p className="truncate sv-num text-xs normal-case text-[#9badbf]">{focusText}</p>
        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-[#6d7f97] transition group-hover:text-sky-200" />
      </div>
    </a>
  )
}

function SchedulerShortcutDeck({ jobs, schedulerApiError }: { jobs: SchedulerJob[]; schedulerApiError?: string | null }) {
  const hasRuntimeJobs = jobs.length > 0
  const jobsByGroup = groupSchedulerJobs(jobs)
  const groupJobs = (group: SchedulerJob['group']) => jobsByGroup.get(group) ?? []

  return (
    <div className="mt-3 grid min-w-0 gap-2 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-[minmax(0,1.14fr)_repeat(4,minmax(0,0.96fr))]">
      <SchedulerShortcutCard group="pipeline_chain" jobs={groupJobs('pipeline_chain')} hasRuntimeJobs={hasRuntimeJobs} schedulerApiError={schedulerApiError} />
      <SchedulerShortcutCard group="daily" jobs={groupJobs('daily')} hasRuntimeJobs={hasRuntimeJobs} schedulerApiError={schedulerApiError} />
      <SchedulerShortcutCard group="intraday" jobs={groupJobs('intraday')} hasRuntimeJobs={hasRuntimeJobs} schedulerApiError={schedulerApiError} />
      <SchedulerShortcutCard group="weekly" jobs={groupJobs('weekly')} hasRuntimeJobs={hasRuntimeJobs} schedulerApiError={schedulerApiError} />
      <SchedulerShortcutCard group="monthly" jobs={groupJobs('monthly')} hasRuntimeJobs={hasRuntimeJobs} schedulerApiError={schedulerApiError} />
    </div>
  )
}

function schedulerJobTone(job: SchedulerJob): WorkstationTone {
  const status = String(job.lastStatus ?? '').toLowerCase()
  if (status === 'blocked') return 'warn'
  if (status === 'failed' || status === 'error') return 'error'
  if (status === 'running') return 'info'
  if (status === 'waiting') return 'warn'
  if (status === 'success') return 'ok'
  if (status === 'sleep' || status === 'skip' || status === 'skipped') return 'neutral'
  return 'info'
}

function schedulerJobPriority(job: SchedulerJob) {
  const status = String(job.lastStatus ?? '').toLowerCase()
  if (status === 'blocked') return 0
  if (status === 'failed' || status === 'error') return 0
  if (status === 'running') return 1
  if (status === 'waiting') return 2
  if (status === 'success') return 3
  if (status === 'sleep') return 4
  if (status === 'skip' || status === 'skipped') return 5
  return 6
}

function schedulerDetailTone(detail: string): WorkstationTone {
  const text = detail.toLowerCase()
  if (text.includes('quota_blocked') || text.includes('failed') || text.includes('materializer_failed')) return 'error'
  if (text.includes('blocked') || text.includes('retry_keys') || text.includes('sentinel_keys')) return 'warn'
  if (text.startsWith('waiting') || text.includes('rows=0/') || text.includes('not ready')) return 'warn'
  if (text.startsWith('ok')) return 'ok'
  return 'neutral'
}

function schedulerPlainSummary(job: SchedulerJob): string {
  const raw = String(job.lastError || job.summary || job.durationConcernReason || '').trim()
  if (!raw) return ''
  const utilization = raw.match(/utilization=([0-9.]+)%/i)?.[1]
  if (/weekly_readiness_blocked/i.test(raw) && /storage admission/i.test(raw)) {
    return `本週流程未完成閉環：必要的高寫入研究工作被 D1 容量保護擋住${utilization ? `（legacy D1 ${utilization}%）` : ''}。已完成的 weekly 工作仍有效，但整體 readiness 維持 blocked。`
  }
  if (/blocked by storage admission/i.test(raw)) {
    return `D1 容量保護已阻擋這個高寫入工作${utilization ? `；legacy D1 目前使用 ${utilization}%` : ''}。這不是策略或模型失敗，而是為避免資料庫碰到 10 GB 上限而停止新增研究資料。`
  }
  if (job.lastError) return jobErrorText(job)
  if (job.summary) return jobSummaryText(job)
  return humanJobSummary(raw)
}

function schedulerReadinessDetails(job: SchedulerJob): string[] {
  const details = Array.isArray(job.details) ? job.details.filter(Boolean) : []
  if (!details.length) return []
  const readinessJob = job.id === 'finlab-v4-backfill' || job.id === 'evening-chain' || job.id === 'update'
  const hasCanonicalDetail = details.some((detail) => /canonical_|official_supplemental|finlab_|source_key|retry_keys|skipped_ok_keys|sentinel_keys|quota_blocked_keys|materialized_datasets|blocked_datasets/i.test(detail))
  if (!readinessJob && !hasCanonicalDetail) return []
  const keyLevel = details.filter((detail) => /source_key|retry_keys|skipped_ok_keys|sentinel_keys|quota_blocked_keys|materialized_datasets|blocked_datasets/i.test(detail))
  const waiting = details.filter((detail) => detail.toLowerCase().startsWith('waiting'))
  const ok = details.filter((detail) => detail.toLowerCase().startsWith('ok'))
  return [...keyLevel, ...waiting, ...ok].slice(0, 10)
}

function SchedulerJobRow({ job, compact = false }: { job: SchedulerJob; compact?: boolean }) {
  const tone = schedulerJobTone(job)
  const readinessDetails = schedulerReadinessDetails(job)
  return (
    <div className={`group min-w-0 overflow-hidden rounded-xl border bg-[#070a10]/88 transition duration-200 hover:-translate-y-0.5 hover:bg-[#0b1118] ${compact ? 'p-2.5' : 'p-3'}`} style={{ borderColor: `${toneColor(tone)}40` }}>
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full shadow-[0_0_12px_currentColor]" style={{ color: toneColor(tone), backgroundColor: toneColor(tone) }} />
            <p className="truncate text-sm font-semibold text-[#f8efe0]">{job.name}</p>
          </div>
          <p className="mt-1 break-words sv-num text-xs normal-case text-[#7f8ba0]">{plainCode(job.id)} · {job.schedule}</p>
        </div>
        <WorkstationStatusPill tone={tone}>{schedulerStatusLabel(job.lastStatus)}</WorkstationStatusPill>
      </div>
      <div className="mt-2 grid min-w-0 grid-cols-1 gap-1 sv-num text-xs normal-case text-[#9badbf] sm:grid-cols-3">
        <span className="min-w-0 truncate rounded-lg border border-[#253244] bg-[#111824] px-2 py-1">last {job.lastRun || '-'}</span>
        <span className="min-w-0 truncate rounded-lg border border-[#253244] bg-[#111824] px-2 py-1">next {job.nextRun || '-'}</span>
        <span className="min-w-0 truncate rounded-lg border border-[#253244] bg-[#111824] px-2 py-1">7d {job.rate7d || '-'}</span>
      </div>
      {(job.summary || job.lastError || job.durationConcernReason) && (
        <p className={`mt-2 min-w-0 break-words text-xs leading-5 [overflow-wrap:anywhere] ${tone === 'error' ? 'text-fail' : tone === 'warn' ? 'text-warn' : 'text-[#9badbf]'}`}>
          {schedulerPlainSummary(job)}
        </p>
      )}
      {readinessDetails.length > 0 && (
        <div className="mt-2 flex min-w-0 flex-wrap gap-1">
          {readinessDetails.map((detail) => {
            const detailTone = schedulerDetailTone(detail)
            return (
              <span
                key={`${job.id}-${detail}`}
                className="max-w-full rounded-lg border px-2 py-1 sv-num text-xs leading-4 normal-case [overflow-wrap:anywhere]"
                style={{
                  borderColor: `${toneColor(detailTone)}45`,
                  backgroundColor: `${toneColor(detailTone)}10`,
                  color: toneColor(detailTone),
                }}
              >
                {detail.replace(/^ok\s+/i, '').replace(/^waiting\s+/i, '')}
              </span>
            )
          })}
          {Array.isArray(job.details) && job.details.length > readinessDetails.length && (
            <span className="rounded-lg border border-[#2f3c4c] bg-[#111824] px-2 py-1 sv-num text-xs leading-4 text-[#9badbf]">
              +{job.details.length - readinessDetails.length}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

function SchedulerGroupCard({
  group,
  jobsByGroup,
  hasRuntimeJobs,
  schedulerApiError,
  className = '',
  jobGridClass = '',
}: {
  group: SchedulerJob['group']
  jobsByGroup: Map<SchedulerJob['group'], SchedulerJob[]>
  hasRuntimeJobs: boolean
  schedulerApiError?: string | null
  className?: string
  jobGridClass?: string
}) {
  const groupJobs = [...(jobsByGroup.get(group) ?? [])].sort((a, b) =>
    schedulerJobPriority(a) - schedulerJobPriority(b) ||
    Number(a.chainIndex ?? 999) - Number(b.chainIndex ?? 999) ||
    a.name.localeCompare(b.name),
  )
  const meta = SCHEDULER_GROUP_META[group]
  const summary = summarizeSchedulerGroup(groupJobs)
  const cardTone = schedulerApiError ? 'error' : hasRuntimeJobs ? (summary.tone === 'neutral' ? meta.tone : summary.tone) : meta.tone
  return (
    <div id={schedulerGroupAnchor(group)} className={`min-w-0 scroll-mt-24 overflow-hidden rounded-2xl border p-3 ${statusRingClass(cardTone)} ${className}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[#f8efe0]">{meta.label}</p>
          <p className="mt-1 sv-num text-xs normal-case text-[#7f8ba0]">{group}</p>
        </div>
        <WorkstationStatusPill tone={schedulerApiError ? 'error' : hasRuntimeJobs ? summary.tone : meta.tone}>
          {schedulerApiError ? 'API 異常' : hasRuntimeJobs ? groupJobs.length : `預期 ${meta.expectedCount}`}
        </WorkstationStatusPill>
      </div>
      <p className="mt-3 min-h-10 text-xs leading-5 text-[#9badbf]">{meta.purpose}</p>
      {hasRuntimeJobs ? (
        <>
          <div className="mt-3 grid grid-cols-4 gap-1 sv-num text-xs normal-case">
            <span className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 ${STATUS_CHIP.ok}`}><StatusIcon tone="ok" size={10} />成功 {summary.success}</span>
            <span className="rounded-lg border border-sky-400/20 bg-sky-400/[0.06] px-2 py-1 text-sky-200">執行 {summary.running}</span>
            <span className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 ${STATUS_CHIP.warn}`}><StatusIcon tone="warn" size={10} />等待 {summary.waiting}</span>
            <span className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 ${STATUS_CHIP.fail}`}><StatusIcon tone="fail" size={10} />失敗 {summary.failed}</span>
          </div>
          <div className={`mt-3 grid min-w-0 gap-2 ${jobGridClass || (group === 'pipeline_chain' || group === 'daily' || group === 'weekly' ? 'lg:grid-cols-2' : '')}`}>
            {groupJobs.map((job) => <SchedulerJobRow key={job.id} job={job} compact={group !== 'pipeline_chain'} />)}
          </div>
        </>
      ) : (
        <div className={`mt-3 rounded-xl border p-2 text-xs leading-5 ${schedulerApiError ? STATUS_CHIP.fail : STATUS_CHIP.warn}`}>
          {schedulerApiError
            ? `Scheduler API 失敗：${schedulerApiError}；此卡只顯示預期 job universe，不當作執行結果。`
            : 'Runtime 狀態等待 `/api/scheduler/status`；此卡只提示預期 job universe，不當作執行結果。'}
        </div>
      )}
      {!hasRuntimeJobs && (
        <div className="mt-2 flex flex-wrap gap-1">
          {meta.examples.map((label) => (
            <span key={`${group}-${label}`} className="max-w-full truncate rounded-full border border-[#2f3c4c] bg-[#171d27] px-2 py-1 text-xs font-semibold text-[#dbeafe]" style={{ borderColor: `${toneColor(meta.tone)}55`, color: toneColor(meta.tone) }}>
              {label}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function SchedulerReadinessGroupBoard({ jobs, schedulerApiError }: { jobs: SchedulerJob[]; schedulerApiError?: string | null }) {
  const hasRuntimeJobs = jobs.length > 0
  const jobsByGroup = groupSchedulerJobs(jobs)

  return (
    <div className="mt-3 grid min-w-0 items-stretch gap-3 2xl:grid-cols-[minmax(0,0.78fr)_minmax(700px,1.22fr)]">
      <div className="grid min-w-0 gap-3 2xl:h-full 2xl:grid-rows-[auto_auto_minmax(0,1fr)]">
        <SchedulerGroupCard
          group="daily"
          jobsByGroup={jobsByGroup}
          hasRuntimeJobs={hasRuntimeJobs}
          schedulerApiError={schedulerApiError}
          jobGridClass="lg:grid-cols-2"
        />
        <div className="grid min-w-0 gap-3 xl:grid-cols-2">
          <SchedulerGroupCard group="intraday" jobsByGroup={jobsByGroup} hasRuntimeJobs={hasRuntimeJobs} schedulerApiError={schedulerApiError} />
          <SchedulerGroupCard group="monthly" jobsByGroup={jobsByGroup} hasRuntimeJobs={hasRuntimeJobs} schedulerApiError={schedulerApiError} />
        </div>
        <SchedulerGroupCard
          group="weekly"
          jobsByGroup={jobsByGroup}
          hasRuntimeJobs={hasRuntimeJobs}
          schedulerApiError={schedulerApiError}
          className="2xl:h-full"
          jobGridClass="lg:grid-cols-2 xl:grid-cols-3"
        />
      </div>
      <SchedulerGroupCard
        group="pipeline_chain"
        jobsByGroup={jobsByGroup}
        hasRuntimeJobs={hasRuntimeJobs}
        schedulerApiError={schedulerApiError}
        className="2xl:h-full"
        jobGridClass="lg:grid-cols-2 xl:grid-cols-2"
      />
    </div>
  )
}

function CriticalSchedulerErrors({ jobs }: { jobs: SchedulerJob[] }) {
  const failed = jobs
    .filter((job) => schedulerHasRootCause(job))
    .sort((a, b) => {
      const aTime = a.lastRunAt ? Date.parse(a.lastRunAt) : 0
      const bTime = b.lastRunAt ? Date.parse(b.lastRunAt) : 0
      return bTime - aTime
    })
    .slice(0, 6)

  if (!failed.length) return null

  return (
    <div className="mt-3 rounded-2xl border border-fail/25 bg-[#0f151d] p-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <StatusIcon tone="fail" size={14} />
          <p className="text-sm font-semibold text-[#f8efe0]">Critical Scheduler Errors / 錯誤追蹤</p>
        </div>
        <WorkstationStatusPill tone="error">失敗 {failed.length} 筆</WorkstationStatusPill>
      </div>
      <div className="space-y-2">
        {failed.map((job) => (
          <div key={job.id} className="grid gap-3 rounded-2xl border border-fail/20 bg-[#070a10]/90 p-3 text-xs leading-5 xl:grid-cols-[minmax(180px,0.7fr)_minmax(0,1.15fr)_minmax(0,1.25fr)_minmax(0,1fr)_88px]">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <WorkstationStatusPill tone="error">{schedulerStatusLabel(job.lastStatus)}</WorkstationStatusPill>
                <p className="truncate text-base font-semibold text-[#f8efe0]">{job.name}</p>
              </div>
              <p className="mt-1 break-words sv-num text-xs normal-case text-[#71839a]">{plainCode(job.group)} / {job.schedule}</p>
              <p className="mt-2 sv-num text-xs normal-case text-[#9badbf]">發生 {job.lastRun || '-'} · {job.lastDuration || '-'}</p>
            </div>
            <p className="min-w-0 text-[#a9d7ff]">
              <span className="font-semibold text-[#f8efe0]">狀態紀錄：</span>{schedulerStatusLog(job)}
            </p>
            <p className="min-w-0 text-fail">
              <span className="font-semibold text-[#f8efe0]">Root cause：</span>{schedulerRootCause(job)}
            </p>
            <p className="min-w-0 text-[#c5d3e2]">
              <span className="font-semibold text-[#f8efe0]">可能影響：</span>{schedulerImpact(job)}
            </p>
            <a href="/scheduler" className="inline-flex items-start justify-end gap-1 sv-num text-xs normal-case text-sky-200 hover:text-sky-100">
              Drilldown <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        ))}
      </div>
    </div>
  )
}

function OperationalReadinessDeck({
  jobs,
  checks,
  schedulerApiError,
  schedulerFetching,
  schedulerDataUpdatedAt,
  schedulerGovernance,
  capacityReport,
  capacityLoading,
  capacityError,
}: {
  jobs: SchedulerJob[]
  checks: DataQualityCheck[]
  schedulerApiError?: string | null
  schedulerFetching: boolean
  schedulerDataUpdatedAt: number
  schedulerGovernance?: SchedulerStatus['governance']
  capacityReport?: StorageCapacitySnapshot
  capacityLoading: boolean
  capacityError?: string | null
}) {
  const gates = buildReadinessGates(checks)

  return (
    <div className="border-b border-[#263247] bg-[#080b11] p-3">
      <div className="grid items-stretch gap-3 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <StorageCapacityPanel report={capacityReport} loading={capacityLoading} error={capacityError} />

        <section className="flex h-full min-w-0 flex-col border-t border-border pt-3 xl:border-l xl:border-t-0 xl:pl-3 xl:pt-0" aria-labelledby="source-gates-title">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <Database className="h-4 w-4 shrink-0 text-sky-300" />
              <p id="source-gates-title" className="truncate text-sm font-semibold text-[#f2ead8]">Source Gates / &#36039;&#26009;&#23601;&#32210;</p>
            </div>
            <a href="/data-quality" className="inline-flex shrink-0 items-center gap-1 sv-num text-xs normal-case text-sky-200 hover:text-sky-100">
              Data Quality <ExternalLink className="h-3 w-3" />
            </a>
          </div>
          <DataQualityCompactMatrix gates={gates} compact />
        </section>
      </div>
    </div>
  )
}

function fmtNumber(value: unknown, digits = 4) {
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

function summarizeLearnedPolicy(policy: Record<string, unknown>) {
  const allocation = asRecord(asRecord(policy.allocation).weights)
  const bull = asRecord(allocation.bull)
  const risk = asRecord(policy.riskOverlay)
  const scoring = asRecord(policy.scoring)
  const parts = [
    bull.trend_following != null ? `bull trend=${fmtNumber(bull.trend_following, 2)}` : null,
    bull.breakout_volatility_expansion != null ? `breakout=${fmtNumber(bull.breakout_volatility_expansion, 2)}` : null,
    risk.highVolThreshold != null ? `highVol=${fmtNumber(risk.highVolThreshold, 3)}` : null,
    scoring.buyThreshold != null ? `buy=${fmtNumber(scoring.buyThreshold, 2)}` : null,
  ].filter(Boolean)
  return parts.length ? parts.join(' / ') : 'learned params not exposed'
}

function EvidenceClockPanel({
  report,
  loading,
  error,
}: {
  report?: ShadowEvidenceClockReport
  loading: boolean
  error: string | null
}) {
  return (
    <WorkstationPanel title="Independent Evidence Clocks" kicker="comparison lanes do not share maturity credit">
      <div className="p-3">
        <p className="mb-3 text-xs leading-5 text-slate-400">
          各條有效 evidence clock 獨立累積；已證偽或退役的機制不再占用成熟時鐘，也不會影響正式決策。
        </p>
        {loading ? (
          <div className="flex items-center gap-2 border-t border-border p-4 text-xs text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin text-sky-300" /> Loading evidence clocks
          </div>
        ) : error ? (
          <div className={`flex items-center gap-2 p-1 text-xs text-fail`}><StatusIcon tone="fail" />{error}</div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {(report?.clocks ?? []).filter(clock => clock.mechanism !== 'shadow_a').map((clock) => (
              <article key={clock.mechanism} className="min-w-0 border-t border-border p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="break-words text-sm font-medium text-slate-100">{clock.label}</p>
                    <p className="mt-1 sv-num text-xs normal-case text-muted-foreground">{GOVERNANCE_LABELS[String(clock.governance)] ?? String(clock.governance ?? '').replace(/_/g, ' ')} · auto promote OFF</p>
                  </div>
                  <WorkstationStatusPill tone={statusTone(clock.status)}><StatusCode raw={clock.status} /></WorkstationStatusPill>
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  <div><dt className="text-muted-foreground">latest</dt><dd className="sv-num mt-1 text-slate-200">{clock.latest_evidence_date ?? 'N/A'}</dd></div>
                  <div>
                    <dt className="text-muted-foreground">{clock.mechanism === 'rfs_allocator' ? '有效配置配對' : 'samples'}</dt>
                    <dd className="sv-num mt-1 text-slate-200">
                      {clock.mechanism === 'execution_parity' && clock.status === 'not_applicable_no_real_intents'
                        ? 'N/A'
                        : (clock.sample_count ?? 'N/A')}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{clock.mechanism === 'rfs_allocator' ? '有效配置日期' : 'dates'}</dt>
                    <dd className="sv-num mt-1 text-slate-200">
                      {clock.mechanism === 'execution_parity' && clock.status === 'not_applicable_no_real_intents'
                        ? 'N/A'
                        : clock.distinct_dates}
                    </dd>
                  </div>
                  <div><dt className="text-muted-foreground">coverage</dt><dd className="sv-num mt-1 text-slate-200">{clock.coverage == null ? 'N/A' : (clock.coverage * 100).toFixed(1) + '%'}</dd></div>
                </dl>
                <div className="mt-3 space-y-1 border-t border-[#1c2534] pt-2 sv-num text-xs normal-case text-muted-foreground">
                  <p>regimes {clock.supported_regimes.length ? clock.supported_regimes.join(' / ') : 'N/A'}</p>
                  <p>delta {clock.incumbent_delta == null ? 'N/A' : clock.incumbent_delta.toFixed(4)} · LCB {clock.confidence_bound == null ? 'N/A' : clock.confidence_bound.toFixed(4)}</p>
                  <p className="truncate">receipt {clock.artifact_or_packet_checksum?.slice(0, 16) ?? 'N/A'}</p>
                </div>
                {clock.mechanism === 'rfs_allocator' && (
                  <div className="mt-2 border-l-2 border-border p-2 text-xs leading-5 text-slate-400">
                    <p>配置配對 {clock.sample_count ?? 0} · 阻擋 {String(asRecord(clock.details).blocked_receipts ?? 0)}</p>
                    <p>同池候選 {String(asRecord(clock.details).candidate_count ?? 'N/A')} · 對手 sparse allocator</p>
                    <p>5 日成熟 {String(asRecord(clock.details).mature_5_session_dates ?? 0)} · 20 日成熟 {String(asRecord(clock.details).mature_20_session_dates ?? 0)}</p>
                    <p>相同輸入與配置限制；固定籃子收盤價比較，不代表 Paper 帳戶績效。</p>
                  </div>
                )}
                {clock.mechanism === 'execution_parity' && (
                  <div className="mt-2 border-l-2 border-border p-2 text-xs leading-5 text-slate-400">
                    <p>paper intents {String(asRecord(clock.details).paper_intents ?? 0)} · real intents {String(asRecord(clock.details).real_intents ?? 0)}</p>
                    {clock.status === 'not_applicable_no_real_intents' && (
                      <p className="text-sky-200">No real-order authority is enabled; parity is not applicable, so zero is not treated as maturity evidence.</p>
                    )}
                  </div>
                )}
                <div className="mt-2 text-xs leading-5 text-slate-400 [overflow-wrap:anywhere]">
                  {clock.blockers.length ? clock.blockers.join(' · ').replace(/_/g, ' ') : 'No current blocker'}
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </WorkstationPanel>
  )
}

function AdaptiveMetaPanel({
  events,
  onGaReview,
  gaReviewPending = false,
  gaReviewError,
}: {
  events: ObservabilityEvent[]
  onGaReview?: (action: 'request' | 'approve' | 'reject', level: 'L3' | 'L4') => void
  gaReviewPending?: boolean
  gaReviewError?: string | null
}) {
  const adaptive = events.find((event) => event.domain === 'adaptive_meta' && event.source === 'adaptive_params')
  const ga = events.find((event) => event.domain === 'adaptive_meta' && event.source === 'ga_optimizer')
  const thresholdPolicyEvent = events.find((event) => event.domain === 'ml_threshold_policy' && event.source === 'predictions.forecast_data')
  const evidence = asRecord(adaptive?.evidence)
  const threshold = asRecord(evidence.threshold_components)
  const thresholdInputs = asRecord(threshold.inputs)
  const thresholdPolicyEvidence = asRecord(thresholdPolicyEvent?.evidence)
  const runtimePolicy = asRecord(thresholdPolicyEvidence.policy)
  const runtimePolicyThresholds = asRecord(runtimePolicy.thresholds)
  const runtimePolicyOverlay = asRecord(runtimePolicy.adaptive_overlay)
  const runtimeSignalPolicy = asRecord(runtimePolicy.signal_policy)
  const runtimePolicyRequestedDate = String(thresholdPolicyEvidence.requested_date ?? '-')
  const runtimePolicyEvidenceDate = String(thresholdPolicyEvidence.evidence_date ?? '-')
  const runtimePolicyStaleDays = thresholdPolicyEvidence.stale_days
  const bandit = asRecord(evidence.bandit_context)
  const linucbLedger = asRecord(bandit.linucb_reward_ledger)
  const expandedContext = asRecord(bandit.expanded_context)
  const gaEvidence = asRecord(ga?.evidence)
  const promotion = asRecord(gaEvidence.promotion)
  const bestMetrics = asRecord(gaEvidence.best_metrics)
  const learnedPolicy = asRecord(gaEvidence.learned_alpha_framework)
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
  const gaNextAction = plainCode(promotion.nextAction ?? ga?.next_action ?? '')
  const approvalRequiredForNextLevel =
    promotion.approvalRequiredForNextLevel === true || promotion.approval_required_for_next_level === true
  const rawL3Blockers = missingEvidence.length
    ? missingEvidence
    : canRequestNextLevel && approvalRequiredForNextLevel
      ? ['Wei approval']
      : pendingApprovalLevel
        ? [`pending ${pendingApprovalLevel}`]
        : ['keep collecting GA history']
  const metaLearners: Array<[string, string, string, string]> = []
  const tone = severityTone(adaptive?.severity ?? ga?.severity)
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
      label: GA_EVIDENCE_LABELS[item] ?? item.replace(/_/g, ' '),
      status: missingEvidence.includes(item) ? 'missing' as const : 'pass' as const,
      detail: missingEvidence.includes(item) ? '缺 evidence，不能升 L3/L4。' : 'promotion packet 已具備此 evidence。',
    })),
    ...(gaInfrastructureBlocked ? [{
      label: '驗證資料未就緒', status: 'missing' as const,
      detail: String(validation.reason ?? '缺少有效回測證據；尚未測得本輪績效。'),
    }] : failedGates.map((item) => ({
      label: '主要門檻 / ' + item.replace(/_/g, ' '),
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
      value: plainCode(gaRuntime.runtime_role ?? 'learning/review only'),
      detail: 'GA 不進模型池；由 adaptive meta context 消費。',
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
      detail: plainCode(gaEffectPolicy.scope ?? 'L3 approved 才能套 capped meta-policy effect。'),
      tone: gaEffectPolicy.enabled === true ? 'warn' : 'neutral',
    },
  ]
  const gaCandidateSummary = (
    <>
      <div>candidate: {plainCode(gaEvidence.best_candidate_id ?? 'best GA policy')}</div>
      <div>learned policy: {summarizeLearnedPolicy(learnedPolicy)}</div>
      <div>requested: {pendingApprovalLevel || (canRequestNextLevel ? `${nextLevel} ready for approval` : 'none')}</div>
    </>
  )
  const gaCurrentSummary = (
    <>
      <div>level: {String(promotion.level ?? 'L0')} / status: {String(promotion.status ?? ga?.status ?? '-')}</div>
      <div>runtime: {plainCode(gaRuntime.runtime_role ?? 'no approved runtime effect')}</div>
      <div>last candidate generated: {gaLearningUpdatedAt}</div>
    </>
  )
  const gaActions = (
    <>
      {canRequestNextLevel && !pendingApprovalLevel && (
        <Button
          size="sm"
          variant="outline"
          disabled={!onGaReview || gaReviewPending}
          className="h-8 rounded-full border-sky-400/30 px-3 text-xs text-sky-200 hover:bg-sky-400/10"
          onClick={() => onGaReview?.('request', nextLevel)}
        >
          {gaReviewPending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
          Request {nextLevel} review
        </Button>
      )}
      {pendingApprovalLevel && (
        <>
          <Button
            size="sm"
            variant="outline"
            disabled={!onGaReview || gaReviewPending}
            className="h-8 rounded-full border-ok/30 px-3 text-xs text-ok hover:bg-ok/10"
            onClick={() => onGaReview?.('approve', pendingApprovalLevel)}
          >
            {gaReviewPending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
            Approve {pendingApprovalLevel}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!onGaReview || gaReviewPending}
            className="h-8 rounded-full border-fail/30 px-3 text-xs text-fail hover:bg-fail/10"
            onClick={() => onGaReview?.('reject', pendingApprovalLevel)}
          >
            Reject {pendingApprovalLevel}
          </Button>
        </>
      )}
      <a href="/strategy-lab" className="inline-flex items-center gap-1 sv-num text-xs normal-case text-sky-200 hover:text-sky-100">
        Review GA candidate <ExternalLink className="h-3 w-3" />
      </a>
    </>
  )

  return (
    <WorkstationPanel title="Adaptive / Meta Evidence" kicker="threshold, bandit, GA">
      <div className="grid items-stretch gap-3 p-3 xl:grid-cols-[minmax(0,0.78fr)_minmax(0,1.22fr)]">
        <div className="grid h-full gap-3 xl:grid-rows-[auto_minmax(0,1fr)]">
          <div className="border-t border-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="sv-num text-xs normal-case text-[#70809b]">Threshold Policy</p>
              <WorkstationStatusPill tone={tone}><StatusCode raw={adaptive?.status} fallback="缺資料" /></WorkstationStatusPill>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
              <div>
                <p className="text-muted-foreground">effective delta</p>
                <p className="sv-num text-lg text-sky-200">{fmtNumber(threshold.effective_delta ?? evidence.confidence_delta)}</p>
              </div>
              <div>
                <p className="text-muted-foreground">regime</p>
                <p className="sv-num text-lg text-slate-100">{String(thresholdInputs.regime ?? asRecord(evidence.provenance).regime ?? '-')}</p>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-400">
              <span>risk {fmtNumber(threshold.risk_penalty)}</span>
              <span>model {fmtNumber(threshold.model_quality_penalty)}</span>
              <span>vol {fmtNumber(threshold.volatility_penalty)}</span>
              <span>credit {fmtNumber(Number(threshold.regime_opportunity_credit ?? 0) + Number(threshold.trend_quality_credit ?? 0))}</span>
            </div>
            <div className="mt-3 border-l-2 border-border p-2 text-xs leading-5 text-slate-300">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="sv-num text-sky-200">Runtime Active-8 signal policy</span>
                <WorkstationStatusPill tone={severityTone(thresholdPolicyEvent?.severity)}><StatusCode raw={thresholdPolicyEvent?.status} fallback="缺資料" /></WorkstationStatusPill>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 break-all">
                <span>id {String(runtimePolicy.policy_id ?? '-')}</span>
                <span>scope {GOVERNANCE_LABELS[String(runtimePolicy.selected_regime)] ?? plainCode(runtimePolicy.selected_regime ?? '-')}</span>
                <span>buy coverage {fmtNumber(runtimePolicyThresholds.buyCoverage ?? runtimeSignalPolicy.buy_coverage, 3)}</span>
                <span>strong coverage {fmtNumber(runtimePolicyThresholds.strongCoverage ?? runtimeSignalPolicy.strong_coverage, 3)}</span>
                <span>overlay {runtimePolicyOverlay.applied_delta == null ? 'N/A' : fmtNumber(runtimePolicyOverlay.applied_delta, 3)}</span>
                <span>hash {String(runtimePolicy.evidence_hash ?? '-').slice(0, 10)}</span>
                <span>requested {runtimePolicyRequestedDate}</span>
                <span>evidence {runtimePolicyEvidenceDate}</span>
                <span>age {runtimePolicyStaleDays == null ? '-' : String(runtimePolicyStaleDays) + 'd'}</span>
                <span>rows {String(thresholdPolicyEvidence.sample_count ?? '-')}</span>
              </div>
            </div>
          </div>

          <div className="border-t border-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="sv-num text-xs normal-case text-[#70809b]">LinUCB Risk Guard</p>
              <WorkstationStatusPill tone={bandit.decision ? 'ok' : 'warn'}><StatusCode raw={bandit.decision == null ? null : String(bandit.decision)} fallback="缺資料" /></WorkstationStatusPill>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
              <div>
                <p className="text-muted-foreground">max mult</p>
                <p className="sv-num text-lg text-foreground">{fmtNumber(evidence.bandit_max_mult, 2)}</p>
              </div>
              <div>
                <p className="text-muted-foreground">loss rate</p>
                <p className="sv-num text-lg text-foreground">{bandit.loss_rate == null ? '-' : `${fmtNumber(bandit.loss_rate, 2)}`}</p>
              </div>
              <div>
                <p className="text-muted-foreground">5d paper exits</p>
                <p className="sv-num text-lg text-slate-100">{String(bandit.total_5d ?? '-')}</p>
              </div>
            </div>
            <div className="mt-3 border-l-2 border-border p-2 text-xs leading-5 text-slate-300">
              <div className="flex flex-wrap items-center gap-2">
                <WorkstationStatusPill tone={linucbLedger.reward_ledger_status === 'updated' ? 'ok' : 'warn'}>
                  ledger <StatusCode raw={linucbLedger.reward_ledger_status == null ? null : String(linucbLedger.reward_ledger_status)} fallback="缺資料" />
                </WorkstationStatusPill>
                <span>arms {String(linucbLedger.arm_count ?? '-')}</span>
                <span>lifetime ledger samples {String(linucbLedger.total_samples ?? linucbLedger.source_rows ?? '-')}</span>
                <span>ledger updated {String(linucbLedger.updated_at ?? '-')}</span>
                <span>ctx {String(expandedContext.version ?? linucbLedger.context_version ?? '-')}</span>
              </div>
              <p className="mt-2 text-[#70809b]">
                上方 5d paper exits 只控制近期虧損保護；lifetime ledger samples 才是 LinUCB 的學習樣本。兩者不可互相代稱。NeuralUCB / NeuralTS 只使用這些 evidence 做 shadow 訓練，不直接改 production。
              </p>
            </div>
          </div>
        </div>

        <ApprovalReviewPanel
          title="GA Promotion"
          kicker="parameter candidate / manual approval"
          status={`${String(promotion.status ?? ga?.status ?? 'learning')} / ${String(promotion.level ?? 'L0')}`}
          statusTone={gaReviewStatusTone}
          candidate={gaCandidateSummary}
          champion={gaCurrentSummary}
          summary="weekly/monthly GA 只產生候選政策與 promotion packet；approval 前必須看分數、PBO、MDD、history、gate 與 production impact。"
          metrics={gaMetrics}
          gates={gaGates}
          impacts={gaImpacts}
          blockers={l3Blockers.map((item) => `L3：${l3BlockerLabel(item)}`)}
          nextAction={(gaReviewError ?? gaNextAction) || 'GA promotion state has not exposed a next action yet.'}
          actions={gaActions}
        />
      </div>
      <div className="border-t border-[#263247] p-3">
        <div className="grid gap-2 xl:grid-cols-5">
          {metaLearners.map(([name, description, stage, evidenceNeed]) => (
            <div key={String(name)} className="border-t border-border p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="sv-num text-xs normal-case text-[#70809b]">{String(name)}</p>
                <WorkstationStatusPill tone={stage === 'production baseline' ? 'ok' : stage === 'research only' ? 'warn' : 'info'}>
                  {String(stage)}
                </WorkstationStatusPill>
              </div>
              <p className="mt-2 text-xs leading-5 text-slate-300">{String(description)}</p>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">needs: {String(evidenceNeed)}</p>
            </div>
          ))}
          {!metaLearners.length && (
            <div className="border-t border-border p-3 text-xs leading-5 text-muted-foreground xl:col-span-5">
              Meta learner research cards are owned by Strategy Lab / Model Pool. OBS only shows operational evidence: Active-8 signal policy, LinUCB ledger, and GA promotion health.
            </div>
          )}
        </div>
      </div>
    </WorkstationPanel>
  )
}

function schedulerStatusLog(job: SchedulerJob) {
  if (job.summary) return schedulerPlainSummary(job)
  if (job.lastStatus === 'success') return '已完成，產物可供後續流程使用。'
  if (job.lastStatus === 'waiting') return '等待前序 stage callback 完成。'
  if (job.lastStatus === 'sleep') return '今天不是此排程的執行日。'
  if (job.lastStatus === 'skip') return '被交易日曆、holiday policy 或執行條件跳過。'
  if (job.lastStatus === 'running') return '執行中，等待 final callback。'
  return job.lastRun ? `最近執行：${job.lastRun}` : '-'
}

function schedulerHasRootCause(job: SchedulerJob) {
  const status = String(job.lastStatus ?? '').toLowerCase()
  if (job.lastError) return true
  if (status === 'failed' || status === 'error') return true
  return Boolean(job.durationConcern && job.durationConcern !== 'expected_short')
}

function schedulerRootCause(job: SchedulerJob) {
  if (job.lastError) return schedulerPlainSummary(job)
  if (job.durationConcern && job.durationConcern !== 'expected_short') {
    return job.durationConcernReason || (job.summary ? jobSummaryText(job) : job.durationConcern)
  }
  if (schedulerHasRootCause(job) && job.summary) return schedulerPlainSummary(job)
  if (job.lastStatus === 'waiting') return '等待前序 stage callback 完成。'
  if (job.lastStatus === 'sleep') return '今天不是此排程的執行日。'
  if (job.lastStatus === 'skip') return '沒有今日 run log，或被交易日曆 / policy 跳過。'
  return '-'
}

function schedulerImpact(job: SchedulerJob) {
  if (job.lastStatus === 'blocked') return '上游未完成，此階段尚未執行；請先處理原始阻擋原因。'
  if (job.lastStatus === 'success') return '下游可使用此階段產物。'
  if (job.lastStatus === 'running') return '下游仍在等待；若超過 SLA，推薦、驗證或報表可能延遲。'
  if (job.lastStatus === 'waiting') return '目前等待前序 callback，不應手動跳階段。'
  if (job.lastStatus === 'failed') {
    if (job.id === 'evening-chain' || job.id === 'indicator-queue') return '價格、籌碼或技術指標可能不完整，後續推薦不可完全信任。'
    if (job.id === 'pipeline' || job.id === 'ml-predict' || job.id === 'recommendation') return 'AI Top Picks、ML 權重與 daily recommendation 可能仍是舊資料。'
    if (job.id === 'model-ic-rolling' || job.id === 'model-ic-full-check') return 'IC, lifecycle, promotion and live-gate evidence may be delayed.'
    if (job.id === 'verify-v2' || job.id === 'model-ic-tracker') return 'IC、lifecycle、promotion/live gate evidence 會延遲更新。'
    return '相關下游資料可能 stale，需先修復此 scheduler。'
  }
  if (job.lastStatus === 'sleep') return '非今日執行項目，不影響今日 pipeline。'
  return '若今天應執行，請檢查 Scheduler job 或 holiday policy。'
}

export default function ObservabilityPage() {
  const scheduler = useQuery({
    queryKey: ['obs', 'scheduler'],
    queryFn: schedulerApi.status,
    refetchInterval: (query) => schedulerRefreshInterval(query.state.data?.jobs),
    refetchIntervalInBackground: false,
    staleTime: 1_000,
  })
  const dataQuality = useQuery({ queryKey: ['obs', 'data-quality'], queryFn: () => dataQualityApi.status(undefined, { reuseRecent: true }), refetchInterval: 60_000, staleTime: 30_000 })
  const deployGate = useQuery({ queryKey: ['obs', 'deploy-gate'], queryFn: () => deployGateApi.predeploy({ reuseRecent: true }), refetchInterval: 60_000, staleTime: 30_000 })
  const system = useQuery({ queryKey: ['obs', 'system'], queryFn: systemApi.status, refetchInterval: 60_000, staleTime: 30_000 })
  const observability = useQuery({ queryKey: ['obs', 'events'], queryFn: () => observabilityApi.events({ reuseRecent: true }), refetchInterval: 60_000, staleTime: 30_000 })
  const evidenceClocks = useQuery({
    queryKey: ['obs', 'evidence-clocks'],
    queryFn: observabilityApi.evidenceClocks,
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
  const capacity = useQuery({
    queryKey: ['obs', 'storage-capacity'],
    queryFn: storageApi.capacity,
    refetchInterval: 300_000,
    refetchIntervalInBackground: false,
    staleTime: 240_000,
  })
  const gaReview = useMutation({
    mutationFn: ({ action, level }: { action: 'request' | 'approve' | 'reject'; level: 'L3' | 'L4' }) =>
      observabilityApi.reviewGaPromotion({ action, level, reason: `obs_ui_${action}` }),
    onSuccess: () => {
      observability.refetch()
    },
  })

  const events = observability.data?.events ?? []
  const jobs = scheduler.data?.jobs ?? []
  const dqChecks = dataQuality.data?.checks ?? []
  const schedulerScore = Number(scheduler.data?.stats?.successRate7d ?? 0)
  const schedulerApiError = errorMessage(scheduler.error)
  const initialLoading = [scheduler, dataQuality, deployGate, system, observability].some((query) => query.isLoading)
  const readinessStages = READINESS_STAGES.map((stage) => stageFromDefinition(stage, jobs))
  const readinessScore = Math.round(schedulerScore)
  const readinessTone: WorkstationTone = schedulerApiError
    || readinessStages.some((stage) => stage.status === 'blocked')
    ? 'error'
    : readinessStages.some((stage) => stage.status === 'waiting' || stage.status === 'running' || stage.status === 'pending')
      ? 'warn'
      : 'ok'

  return (
    <AppShell>
      <div className="sv-stockintelli-page relative min-h-[70vh] p-4 lg:p-5">
        {initialLoading && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-[#05070c]/95 backdrop-blur-sm">
            <div className="rounded-xl border border-[#263247] bg-[#070a10] px-5 py-4 text-center shadow-xl">
              <Loader2 className="mx-auto h-6 w-6 animate-spin text-sky-300" />
              <p className="mt-3 sv-num text-xs normal-case text-sky-200">Loading OBS evidence</p>
              <p className="mt-1 text-xs text-muted-foreground">scheduler / data quality / deploy gate / model events</p>
            </div>
          </div>
        )}
        <div className={`space-y-4 ${initialLoading ? 'pointer-events-none opacity-0' : 'opacity-100 transition-opacity duration-300'}`}>
        <WorkstationPageTitle
          kicker="Observability"
          title="OBS 可觀測中心"
          description="用事件、時間、count、SLO 與 drilldown CTA 回答：哪裡壞、多久了、影響哪一層。"
          action={
            <div className="flex flex-wrap items-center gap-3">
              <ReadinessGauge score={readinessScore} tone={readinessTone} />
              <div className="flex max-w-xs flex-wrap gap-2">
                <WorkstationStatusPill tone={statusTone(deployGate.data?.decision)}>Gate <StatusCode raw={deployGate.data?.decision} /></WorkstationStatusPill>
                <WorkstationStatusPill tone={severityTone(observability.data?.overall)}>OBS <StatusCode raw={observability.data?.overall} /></WorkstationStatusPill>
                <WorkstationStatusPill tone={system.error ? 'error' : 'ok'}>System {system.error ? '異常' : '連線中'}</WorkstationStatusPill>
                <span className="w-full sv-num text-xs normal-case text-muted-foreground">Readiness-gated Chain Control</span>
              </div>
            </div>
          }
        />

        <WorkstationPanel title="Operational Drilldown / 維運追蹤" kicker="full rows, not fake tabs">
          <OperationalReadinessDeck
            jobs={jobs}
            checks={dqChecks}
            schedulerApiError={schedulerApiError}
            schedulerFetching={scheduler.isFetching}
            schedulerDataUpdatedAt={scheduler.dataUpdatedAt}
            schedulerGovernance={scheduler.data?.governance}
            capacityReport={capacity.data}
            capacityLoading={capacity.isLoading}
            capacityError={errorMessage(capacity.error)}
          />
          <div className="border-b border-[#263247] p-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs leading-5 text-slate-400">
                Scheduler row 直接顯示 root cause、發生時間與可能影響；OBS 不再另外維護重複的事件收件匣。
              </p>
              <div className="flex flex-wrap gap-2 text-xs">
                <a href="/scheduler" className="inline-flex items-center gap-1 rounded border border-sky-500/25 bg-sky-500/10 px-3 py-1.5 sv-num text-sky-200 hover:border-sky-300/50">
                  Scheduler <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            </div>
          </div>
        </WorkstationPanel>

        <ExecutionChainPanel jobs={jobs} isFetching={scheduler.isFetching}
          dataUpdatedAt={scheduler.dataUpdatedAt} apiError={schedulerApiError}
          governance={scheduler.data?.governance} />

        <section>
          <EvidenceClockPanel
            report={evidenceClocks.data}
            loading={evidenceClocks.isLoading}
            error={errorMessage(evidenceClocks.error)}
          />
        </section>

        <section>
          <AdaptiveMetaPanel
            events={events}
            onGaReview={(action, level) => gaReview.mutate({ action, level })}
            gaReviewPending={gaReview.isPending}
            gaReviewError={gaReview.error ? (gaReview.error as Error).message : null}
          />
        </section>
        </div>
      </div>
    </AppShell>
  )
}
