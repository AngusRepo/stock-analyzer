import { useEffect, useMemo, useState } from 'react'
import AppShell from '@/components/AppShell'
import {
  strategyLabApi,
  type ModelUpgradeResearchStatusResponse,
  type ModelUpgradeResearchStatusRow,
  type ResearchEvaluationRunResponse,
  type ResearchEvaluationRunsResponse,
  type ResearchExperimentsResponse,
  type ResearchGateResponse,
  type StrategyDryRunResponse,
  type StrategyLearningResponse,
  type StrategyPromotionGate,
  type StrategySpec,
  type StrategySpecsResponse,
} from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Activity, BrainCircuit, FlaskConical, GitBranch, Loader2, PlayCircle, RefreshCw, ShieldCheck, TestTube2 } from 'lucide-react'
import StrategyExperimentTimeline from '@/components/charts/StrategyExperimentTimeline'

type MetaLearningTrack = NonNullable<ResearchExperimentsResponse['meta_learning_tracks']>[number]
type MetaLearningEvidenceRow = NonNullable<ResearchExperimentsResponse['meta_learning_evidence_matrix']>[number]
type ArtifactIntentDraft = {
  model_name: string
  artifact_version: string
  artifact_path: string
  metadata_path: string
  training_manifest_path: string
  feature_policy_version: string
  checksum: string
}

const EMPTY_ARTIFACT_INTENT_DRAFT: ArtifactIntentDraft = {
  model_name: '',
  artifact_version: '',
  artifact_path: '',
  metadata_path: '',
  training_manifest_path: '',
  feature_policy_version: '',
  checksum: '',
}

const ARTIFACT_INTENT_FIELDS: Array<{ key: keyof ArtifactIntentDraft; label: string; placeholder: string; required?: boolean }> = [
  { key: 'model_name', label: 'model name', placeholder: 'ResidualMLP / GNN' },
  { key: 'artifact_version', label: 'artifact version', placeholder: 'v20260519-shadow-a' },
  { key: 'artifact_path', label: 'artifact path', placeholder: 'gs://stockvision-models/...' , required: true },
  { key: 'training_manifest_path', label: 'training manifest', placeholder: 'gs://.../training_manifest.json', required: true },
  { key: 'feature_policy_version', label: 'feature policy', placeholder: 'model-feature-policy-v1', required: true },
  { key: 'checksum', label: 'checksum', placeholder: 'sha256:...', required: true },
  { key: 'metadata_path', label: 'metadata path', placeholder: 'gs://.../metadata.json' },
]

function statusClass(status?: string) {
  if (status === 'active' || status === 'candidate') return 'border-emerald-500/25 bg-emerald-500/15 text-emerald-200'
  if (status === 'shadow' || status === 'research') return 'border-sky-500/25 bg-sky-500/15 text-sky-200'
  if (status === 'retired') return 'border-zinc-600/50 bg-zinc-700/30 text-zinc-300'
  return 'border-amber-500/25 bg-amber-500/15 text-amber-200'
}

function gateClass(decision?: string) {
  if (decision === 'ALLOW') return 'border-emerald-500/25 bg-emerald-500/15 text-emerald-200'
  if (decision === 'REQUIRE_APPROVAL') return 'border-amber-500/25 bg-amber-500/15 text-amber-200'
  return 'border-red-500/30 bg-red-500/15 text-red-200'
}

function strategyGateClass(decision?: StrategyPromotionGate['decision']) {
  if (decision === 'candidate_ready') return 'border-emerald-500/25 bg-emerald-500/15 text-emerald-200'
  if (decision === 'active_monitor') return 'border-cyan-500/25 bg-cyan-500/15 text-cyan-200'
  return 'border-amber-500/25 bg-amber-500/15 text-amber-200'
}

function pct(value?: number | null) {
  if (value == null || !Number.isFinite(Number(value))) return '-'
  return `${(Number(value) * 100).toFixed(1)}%`
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

function splitCsv(value: string) {
  return value.split(',').map((part) => part.trim()).filter(Boolean)
}

function compactEvidenceLabel(value: string) {
  return value
    .replace('status_must_enter_shadow_before_promotion', '需先進 shadow')
    .replace('avg_return_not_positive', '平均報酬未轉正')
    .replace('decisions_lt_', '決策數不足 ')
    .replace('match_rate_lt_', '命中覆蓋不足 ')
    .replace('samples_lt_', '樣本不足 ')
    .replace('hit_rate_lt_', '勝率不足 ')
    .replace('max_drawdown_lt_', 'MDD 超限 ')
}

function modelUpgradeStatusTone(status?: ModelUpgradeResearchStatusRow['registry_status']) {
  if (status === 'track_only') return 'border-sky-500/25 bg-sky-500/10 text-sky-200'
  if (status === 'approved_for_patch') return 'border-violet-500/25 bg-violet-500/15 text-violet-100'
  if (status === 'ready_for_review') return 'border-emerald-500/25 bg-emerald-500/15 text-emerald-200'
  if (status === 'evaluation_pending') return 'border-cyan-500/25 bg-cyan-500/15 text-cyan-200'
  if (status === 'needs_attention') return 'border-amber-500/25 bg-amber-500/15 text-amber-200'
  if (status === 'rejected') return 'border-zinc-600/50 bg-zinc-700/30 text-zinc-300'
  return 'border-red-500/30 bg-red-500/15 text-red-200'
}

function artifactIntentTone(status?: ModelUpgradeResearchStatusRow['latest_artifact_intent_status'] | null) {
  if (status === 'ready_for_registry_preflight') return 'border-emerald-500/25 bg-emerald-500/15 text-emerald-200'
  if (status === 'blocked_missing_artifact') return 'border-amber-500/25 bg-amber-500/15 text-amber-200'
  return 'border-slate-700 bg-slate-900/80 text-slate-300'
}

function experimentIdForCandidate(experimentIds: string[], candidateId: string) {
  const needle = candidateId.toLowerCase()
  return experimentIds.find((id) => id.toLowerCase().includes(needle)) ?? null
}

function applyModelUpgradeSeedFeedback(
  status: ModelUpgradeResearchStatusResponse | null,
  experimentIds: string[],
): ModelUpgradeResearchStatusResponse | null {
  if (!status || experimentIds.length === 0) return status
  return {
    ...status,
    candidates: status.candidates.map((row) => {
      if (!row.requires_experiment_registry || row.registry_status !== 'experiment_missing') return row
      const experimentId = experimentIdForCandidate(experimentIds, row.candidate_id)
      if (!experimentId) return row
      return {
        ...row,
        registry_status: 'evaluation_pending',
        registered_experiment_ids: [experimentId, ...row.registered_experiment_ids.filter((id) => id !== experimentId)].slice(0, 5),
        latest_experiment_id: experimentId,
        latest_experiment_status: row.stage === 'shadow_challenger' ? 'running' : 'queued',
        next_action: 'run_strategy_lab_dry_run_evaluation_plan',
        missing_evidence: ['evaluation_run_missing'],
      }
    }),
  }
}

function shortIdentifier(value?: string | null) {
  if (!value) return '-'
  return value.length > 46 ? `${value.slice(0, 28)}...${value.slice(-10)}` : value
}

function trimDraft(draft: ArtifactIntentDraft) {
  return Object.fromEntries(
    Object.entries(draft).map(([key, value]) => [key, value.trim() || undefined]),
  ) as Partial<ArtifactIntentDraft>
}

function StrategySpecCard({ spec, dryRun }: { spec: StrategySpec; dryRun?: StrategyDryRunResponse['results'][number] }) {
  const thresholds = Object.entries(spec.thresholds ?? {}).slice(0, 5)
  return (
    <div className="rounded-2xl border border-slate-700/70 bg-slate-950/55 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-slate-100">{spec.name}</span>
            <Badge variant="outline" className={statusClass(spec.status)}>{spec.status}</Badge>
            <Badge variant="outline" className="border-cyan-500/20 bg-cyan-500/10 text-cyan-200">{spec.alphaBucket}</Badge>
          </div>
          <div className="mt-1 text-[11px] text-slate-500">{spec.id} / {spec.version}</div>
        </div>
        <Badge variant="outline" className={spec.validation.ok ? 'border-emerald-500/25 text-emerald-300' : 'border-red-500/30 text-red-300'}>
          {spec.validation.ok ? 'contract ok' : 'contract fail'}
        </Badge>
      </div>

      <p className="mt-3 text-sm leading-relaxed text-slate-300">{spec.thesis}</p>

      <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
        <div className="rounded-xl border border-slate-800 bg-black/20 p-3">
          <div className="text-slate-500">Dry-run 命中數</div>
          <div className="mt-1 text-lg font-semibold text-slate-100">{dryRun ? `${dryRun.matched}/${dryRun.sampleSize}` : '-'}</div>
        </div>
        <div className="rounded-xl border border-slate-800 bg-black/20 p-3">
          <div className="text-slate-500">命中率</div>
          <div className="mt-1 text-lg font-semibold text-cyan-200">{pct(dryRun?.matchRate)}</div>
        </div>
        <div className="rounded-xl border border-slate-800 bg-black/20 p-3">
          <div className="text-slate-500">Regime</div>
          <div className="mt-1 text-sm font-semibold text-slate-100">{spec.supportedRegimes.join(' / ')}</div>
        </div>
      </div>

      <div className="mt-4 space-y-2">
        <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">Why it matters</div>
        <div className="flex flex-wrap gap-2">
          {thresholds.map(([key, value]) => (
            <Badge key={key} variant="outline" className="border-slate-700 text-slate-300">
              {key}: {Array.isArray(value) ? value.join(',') : String(value)}
            </Badge>
          ))}
          {thresholds.length === 0 && <span className="text-xs text-slate-500">No explicit threshold.</span>}
        </div>
      </div>

      <div className="mt-3 space-y-1 text-xs text-slate-400">
        {spec.riskNotes.slice(0, 3).map((note) => <div key={note}>Risk note: {note}</div>)}
        {!spec.validation.ok && <div className="text-red-300">Contract errors: {spec.validation.errors.join(', ')}</div>}
      </div>
    </div>
  )
}

function ModelUpgradeLaunchpad({
  status,
  busy,
  actionResult,
  actionError,
  onSeedRegistry,
  onRunEvaluations,
}: {
  status: ModelUpgradeResearchStatusResponse | null
  busy: string | null
  actionResult: string | null
  actionError: string | null
  onSeedRegistry: () => void
  onRunEvaluations: () => void
}) {
  const rows = status?.candidates ?? []
  const registryRows = rows.filter((row) => row.requires_experiment_registry)
  const trackOnlyRows = rows.filter((row) => !row.requires_experiment_registry)
  const isModelUpgradeBusy = busy === 'model-upgrade-seed' || busy === 'model-upgrade-evaluation'
  const counts = registryRows.reduce(
    (acc, row) => {
      acc[row.registry_status] = (acc[row.registry_status] ?? 0) + 1
      return acc
    },
    {} as Record<string, number>,
  )
  return (
    <Card className="border-slate-800 bg-slate-950/70">
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <span className="flex items-center gap-2">
            <GitBranch className="h-4 w-4 text-cyan-300" /> Model Upgrade Launchpad
          </span>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={isModelUpgradeBusy} onClick={onSeedRegistry}>
              {busy === 'model-upgrade-seed' ? '建立中...' : 'Seed missing experiments'}
            </Button>
            <Button size="sm" variant="outline" disabled={isModelUpgradeBusy} onClick={onRunEvaluations}>
              {busy === 'model-upgrade-evaluation'
                ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                : <PlayCircle className="mr-1 h-3.5 w-3.5" />}
              {busy === 'model-upgrade-evaluation' ? '驗證中...' : 'Run next dry-run'}
            </Button>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isModelUpgradeBusy && (
          <div aria-live="polite" className="rounded-xl border border-cyan-500/25 bg-cyan-500/10 px-3 py-2 text-xs leading-5 text-cyan-100">
            {busy === 'model-upgrade-seed'
              ? '正在寫入 Strategy Lab experiment registry metadata；完成後會更新 missing / pending counters 與下方 Experiment Registry。'
              : '正在執行 shadow/benchmark dry-run evaluation；完成後會更新 review-ready / needs-attention evidence。'}
          </div>
        )}
        {actionResult && (
          <div aria-live="polite" className="rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-xs leading-5 text-emerald-100">
            {actionResult}
          </div>
        )}
        {actionError && (
          <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs leading-5 text-red-100">
            <div>{actionError}</div>
            <div className="mt-1 text-red-100/75">
              若出現 Unauthorized，代表目前瀏覽器 session 沒有 admin/service token；重新登入後再按一次。
            </div>
          </div>
        )}
        <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-5">
          <div className="rounded-xl border border-slate-800 bg-black/20 p-3">
            <div className="text-slate-500">research tracks</div>
            <div className="mt-1 text-xl font-semibold text-slate-100">{registryRows.length}</div>
          </div>
          <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-3">
            <div className="text-slate-400">missing</div>
            <div className="mt-1 text-xl font-semibold text-red-100">{counts.experiment_missing ?? 0}</div>
          </div>
          <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/10 p-3">
            <div className="text-slate-400">pending</div>
            <div className="mt-1 text-xl font-semibold text-cyan-100">{counts.evaluation_pending ?? 0}</div>
          </div>
          <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-3">
            <div className="text-slate-400">review ready</div>
            <div className="mt-1 text-xl font-semibold text-emerald-100">{counts.ready_for_review ?? 0}</div>
          </div>
          <div className="rounded-xl border border-violet-500/20 bg-violet-500/10 p-3">
            <div className="text-slate-400">governance elsewhere</div>
            <div className="mt-1 text-xl font-semibold text-violet-100">{trackOnlyRows.length}</div>
          </div>
        </div>
        <div className="rounded-xl border border-slate-800 bg-black/20 p-3 text-xs leading-5 text-slate-400">
          這裡只列需要 Strategy Lab experiment registry 的模型研究項目。Dry-run 每次只跑下一個 pending experiment，避免 backtest / walk-forward / verify / benchmark 整批 sequential timeout。
        </div>
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-5">
          {registryRows.map((row) => (
            <div key={row.candidate_id} className="rounded-2xl border border-slate-800 bg-black/20 p-3 text-xs">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-semibold text-slate-100">{row.candidate_id}</div>
                  <div className="mt-1 text-[11px] text-slate-500">{row.stage}</div>
                </div>
                <Badge variant="outline" className={modelUpgradeStatusTone(row.registry_status)}>
                  {row.registry_status}
                </Badge>
              </div>
              <div className="mt-3 text-slate-400">{row.family}</div>
              <div className="mt-2 rounded-xl border border-slate-800 bg-slate-950/60 p-2 text-[11px] leading-5 text-slate-400">
                <div>registry mode: experiment required</div>
                <div>experiment: {row.latest_experiment_id ?? '-'}</div>
                <div>evaluation: {row.latest_evaluation_verdict ?? '-'}</div>
                <div>vote: {String(row.can_vote)} / predict: {String(row.can_predict)}</div>
                <div>handoff: {shortIdentifier(row.latest_patch_handoff_id)}</div>
                <div className="flex flex-wrap items-center gap-1">
                  <span>artifact intent:</span>
                  <Badge variant="outline" className={artifactIntentTone(row.latest_artifact_intent_status)}>
                    {row.latest_artifact_intent_status ?? 'none'}
                  </Badge>
                </div>
                <div>registry preflight: {row.registry_preflight_ready ? 'ready' : 'blocked'}</div>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {row.missing_evidence.slice(0, 3).map((item) => (
                  <Badge key={item} variant="outline" className="border-amber-500/25 bg-amber-500/10 text-amber-200">
                    {item}
                  </Badge>
                ))}
                {!row.missing_evidence.length && (
                  <Badge variant="outline" className="border-emerald-500/25 bg-emerald-500/10 text-emerald-200">
                    evidence ready
                  </Badge>
                )}
                {row.artifact_intent_missing_fields.slice(0, 3).map((field) => (
                  <Badge key={`artifact-${field}`} variant="outline" className="border-orange-500/25 bg-orange-500/10 text-orange-200">
                    missing {field}
                  </Badge>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="rounded-xl border border-slate-800 bg-black/20 p-3 text-xs leading-5 text-slate-400">
          這裡只建立 Strategy Lab experiment 與 evaluation packet。ResidualMLP/GNN 是 shadow challenger，TabM/iTransformer/TimesFM 是 benchmark-only；兩者都不會進 production vote，通過 review 後才可能進下一層 promotion gate。
        </div>
      </CardContent>
    </Card>
  )
}

function StrategyLearningPanel({
  learning,
  busy,
  onMaterialize,
  onRefreshRewards,
  onRefreshPolicy,
}: {
  learning: StrategyLearningResponse | null
  busy: string | null
  onMaterialize: () => void
  onRefreshRewards: () => void
  onRefreshPolicy: () => void
}) {
  const rows = learning?.specs ?? []
  const gateById = new Map((learning?.promotion_gate ?? []).map((gate) => [`${gate.strategy_id}:${gate.strategy_version}`, gate]))
  const policy = learning?.policy_state_preview
  const policyWeights = Object.entries(policy?.strategy_weights ?? {})
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 5)
  const totals = rows.reduce(
    (acc, row) => {
      acc.decisions += row.learning.decisions
      acc.matched += row.learning.matched
      acc.samples += row.learning.samples
      return acc
    },
    { decisions: 0, matched: 0, samples: 0 },
  )
  return (
    <Card className="border-slate-800 bg-slate-950/70">
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <span className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-emerald-300" /> Strategy Learning Curve
          </span>
          <span className="text-[11px] font-normal text-slate-500">
            {learning?.date ?? '-'} / {learning?.spec_source ?? 'default_fallback'}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-2 text-xs md:grid-cols-4">
          <div className="rounded-xl border border-slate-800 bg-black/20 p-3">
            <div className="text-slate-500">Decision rows</div>
            <div className="mt-1 text-xl font-semibold text-slate-100">{totals.decisions}</div>
          </div>
          <div className="rounded-xl border border-slate-800 bg-black/20 p-3">
            <div className="text-slate-500">Matched</div>
            <div className="mt-1 text-xl font-semibold text-cyan-200">{totals.matched}</div>
          </div>
          <div className="rounded-xl border border-slate-800 bg-black/20 p-3">
            <div className="text-slate-500">Reward samples</div>
            <div className="mt-1 text-xl font-semibold text-emerald-200">{totals.samples}</div>
          </div>
          <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-3">
            <div className="text-slate-400">Adaptive policy</div>
            <div className="mt-1 text-xl font-semibold text-emerald-100">{policy?.status ?? 'shadow'}</div>
            <div className="mt-1 text-[11px] text-emerald-200/80">
              eligible {policy?.evidence?.eligible_strategy_count ?? 0} / production effect false
            </div>
          </div>
        </div>
        <div className="rounded-2xl border border-cyan-500/15 bg-cyan-500/5 p-4 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold text-cyan-100">
                <ShieldCheck className="h-4 w-4" /> Adaptive Policy Shadow State
              </div>
              <div className="mt-1 text-slate-400">
                reward ledger 只產生策略權重與門檻 delta 建議；不改 production strategy，不改 model vote，不下單。
              </div>
            </div>
            <Badge variant="outline" className="border-amber-500/25 bg-amber-500/10 text-amber-200">
              Wei approval required to activate
            </Badge>
          </div>
          <div className="mt-4 grid grid-cols-1 gap-3 xl:grid-cols-[0.8fr_1.2fr]">
            <div className="rounded-xl border border-slate-800 bg-black/20 p-3">
              <div className="text-[10px] uppercase tracking-[0.16em] text-slate-500">policy id</div>
              <div className="mt-1 break-all font-semibold text-slate-100">{policy?.policy_id ?? '-'}</div>
              <div className="mt-2 text-slate-500">updated {policy?.updated_at ?? '-'}</div>
            </div>
            <div className="space-y-2">
              {policyWeights.map(([strategyId, weight]) => (
                <div key={strategyId}>
                  <div className="flex justify-between gap-3 text-[10px] uppercase tracking-[0.14em] text-slate-500">
                    <span className="truncate">{strategyId}</span><span>{pct(Number(weight))}</span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-800">
                    <div className="h-full bg-gradient-to-r from-cyan-300 via-emerald-300 to-amber-200" style={{ width: `${Math.max(0, Math.min(100, Number(weight) * 100))}%` }} />
                  </div>
                </div>
              ))}
              {!policyWeights.length && <div className="rounded-xl border border-dashed border-slate-700 p-3 text-slate-500">reward evidence 尚不足，policy weight 暫不給建議。</div>}
            </div>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
          {rows.map((row) => {
            const matchPct = row.learning.match_rate == null ? 0 : Math.max(0, Math.min(100, row.learning.match_rate * 100))
            const hitPct = row.learning.hit_rate == null ? 0 : Math.max(0, Math.min(100, row.learning.hit_rate * 100))
            const gate = gateById.get(`${row.id}:${row.version}`)
            return (
              <div key={`${row.id}:${row.version}`} className="rounded-2xl border border-slate-800 bg-black/20 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-sm font-semibold text-slate-100">{row.name}</div>
                    <div className="mt-1 text-[11px] text-slate-500">{row.id}</div>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <Badge variant="outline" className={statusClass(row.learning.status)}>{row.learning.status}</Badge>
                    {gate && <Badge variant="outline" className={strategyGateClass(gate.decision)}>{gate.decision}</Badge>}
                  </div>
                </div>
                <div className="mt-4 space-y-3">
                  <div>
                    <div className="flex justify-between text-[10px] uppercase tracking-[0.16em] text-slate-500">
                      <span>match rate</span><span>{pct(row.learning.match_rate)}</span>
                    </div>
                    <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-800">
                      <div className="h-full bg-cyan-300" style={{ width: `${matchPct}%` }} />
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between text-[10px] uppercase tracking-[0.16em] text-slate-500">
                      <span>hit rate</span><span>{pct(row.learning.hit_rate)}</span>
                    </div>
                    <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-800">
                      <div className="h-full bg-emerald-300" style={{ width: `${hitPct}%` }} />
                    </div>
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-xl border border-slate-800 p-2">
                    <div className="text-slate-500">avg return</div>
                    <div className={Number(row.learning.avg_return_pct ?? 0) >= 0 ? 'text-emerald-300' : 'text-red-300'}>
                      {pct(row.learning.avg_return_pct)}
                    </div>
                  </div>
                  <div className="rounded-xl border border-slate-800 p-2">
                    <div className="text-slate-500">MDD</div>
                    <div className="text-amber-200">{pct(row.learning.max_drawdown_pct)}</div>
                  </div>
                </div>
                <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950/70 p-3 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-slate-200">Promotion gate</span>
                    <span className="text-slate-500">next: {gate?.recommended_next_status ?? '-'}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {(gate?.missing_evidence ?? []).slice(0, 4).map((item) => (
                      <Badge key={item} variant="outline" className="border-amber-500/25 bg-amber-500/10 text-amber-200">
                        {compactEvidenceLabel(item)}
                      </Badge>
                    ))}
                    {gate && gate.missing_evidence.length === 0 && (
                      <Badge variant="outline" className="border-emerald-500/25 bg-emerald-500/10 text-emerald-200">
                        evidence ready
                      </Badge>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy === 'strategy-decision-log'} onClick={onMaterialize}>
            {busy === 'strategy-decision-log' ? '寫入中...' : 'Materialize decision log'}
          </Button>
          <Button size="sm" variant="outline" disabled={busy === 'strategy-reward-ledger'} onClick={onRefreshRewards}>
            {busy === 'strategy-reward-ledger' ? '刷新中...' : 'Refresh reward ledger'}
          </Button>
          <Button size="sm" variant="outline" disabled={busy === 'strategy-policy-state'} onClick={onRefreshPolicy}>
            {busy === 'strategy-policy-state' ? '更新中...' : 'Refresh adaptive policy shadow'}
          </Button>
        </div>
        <p className="text-[11px] leading-5 text-slate-500">
          這裡是策略自己的學習曲線：decision log 記錄每天每檔是否命中策略；reward ledger 在 verify/paper outcome 後回灌報酬。Adaptive 只能學策略權重與門檻 delta，不直接改 production strategy。
        </p>
      </CardContent>
    </Card>
  )
}

function metaStageClass(stage: string) {
  if (stage === 'production_baseline') return 'border-emerald-500/25 bg-emerald-500/15 text-emerald-200'
  if (stage === 'shadow_challenger') return 'border-sky-500/25 bg-sky-500/15 text-sky-200'
  if (stage === 'strategy_research') return 'border-amber-500/25 bg-amber-500/15 text-amber-200'
  return 'border-slate-600/50 bg-slate-800/40 text-slate-300'
}

function decisionZhClean(status: string) {
  const map: Record<string, string> = {
    production_baseline_needs_evidence: 'Production baseline 需要補 evidence',
    run_shadow: '執行 shadow 驗證',
    needs_experiment_registry: '需要 experiment registry',
    research_only: '研究層，不影響 production',
  }
  return map[status] ?? status
}

function evidenceTone(status?: string) {
  if (status === 'ready') return 'border-emerald-500/25 text-emerald-300'
  if (status === 'partial') return 'border-sky-500/25 text-sky-200'
  if (status === 'not_applicable') return 'border-slate-700 text-slate-400'
  return 'border-red-500/30 text-red-200'
}

function evidenceLabel(status?: string) {
  if (status === 'ready') return 'ready'
  if (status === 'partial') return 'partial'
  if (status === 'missing') return 'missing'
  if (status === 'not_applicable') return 'n/a'
  return status ?? 'missing'
}

function MetaLearningDecisionDesk({
  tracks,
  matrix,
  actionBusy,
  onCreateTrackExperiment,
  onRefreshLinucb,
  onRunNeuralShadow,
  actionResult,
}: {
  tracks: MetaLearningTrack[]
  matrix: MetaLearningEvidenceRow[]
  actionBusy: string | null
  onCreateTrackExperiment: (track: MetaLearningTrack) => void
  onRefreshLinucb: () => void
  onRunNeuralShadow: (policyId: 'NeuralUCB' | 'NeuralTS') => void
  actionResult: string | null
}) {
  const visible = tracks.length ? tracks : []
  const matrixById = new Map(matrix.map((row) => [row.id, row]))
  return (
    <Card className="border-slate-800 bg-slate-950/70">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <BrainCircuit className="h-4 w-4 text-cyan-300" /> Meta Learning Decision Desk
        </CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-3 xl:grid-cols-[1.05fr_0.95fr]">
        {actionResult && (
          <div className="xl:col-span-2 rounded-xl border border-cyan-500/20 bg-cyan-500/10 px-3 py-2 text-xs leading-5 text-cyan-100">
            {actionResult}
          </div>
        )}
        <div className="grid gap-3 md:grid-cols-2">
          {visible.map((track) => (
            <div key={track.id} className="rounded-2xl border border-slate-800 bg-black/20 p-4">
              {(() => {
                const evidence = matrixById.get(track.id)
                return (
                  <>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="font-semibold text-slate-100">{track.id}</div>
                  <div className="mt-1 text-[11px] text-slate-500">{track.learning_targets.slice(0, 3).join(' / ')}</div>
                </div>
                <Badge variant="outline" className={metaStageClass(track.stage)}>{track.stage}</Badge>
              </div>
              <p className="mt-3 text-sm leading-relaxed text-slate-300">{track.role}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Badge variant="outline" className={track.can_influence_production ? 'border-emerald-500/25 text-emerald-300' : 'border-slate-700 text-slate-400'}>
                  {track.can_influence_production ? 'production baseline' : 'no production effect'}
                </Badge>
                <Badge variant="outline" className={evidence?.evidence_status === 'ready' ? 'border-emerald-500/25 text-emerald-300' : evidence?.evidence_status === 'partial' ? 'border-sky-500/25 text-sky-200' : 'border-red-500/30 text-red-200'}>
                  evidence {evidence?.evidence_status ?? 'missing'}
                </Badge>
                <Badge variant="outline" className="border-amber-500/25 text-amber-200">{decisionZhClean(track.decision_queue_status)}</Badge>
                <Badge variant="outline" className="border-cyan-500/20 text-cyan-200">
                  samples {evidence?.samples ?? 0}
                </Badge>
              </div>
              <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-xs leading-5 text-slate-400">
                下一步：{evidence?.next_action ?? track.next_action}
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-2">
                  <div className="text-slate-500">Reward ledger</div>
                  <div className={evidenceTone(evidence?.reward_ledger_status)}>{evidenceLabel(evidence?.reward_ledger_status)}</div>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-2">
                  <div className="text-slate-500">Shadow</div>
                  <div className={evidenceTone(evidence?.shadow_status)}>{evidenceLabel(evidence?.shadow_status)}</div>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-2">
                  <div className="text-slate-500">Registry</div>
                  <div className={track.registered_experiment_ids.length ? 'text-emerald-300' : 'text-amber-200'}>{track.registered_experiment_ids.length} 筆</div>
                </div>
              </div>
              <div className="mt-3 rounded-xl border border-cyan-500/15 bg-cyan-500/5 p-3 text-xs leading-5 text-slate-300">
                <div className="font-semibold text-cyan-200">建議研究模板</div>
                <div className="mt-1 text-slate-400">{track.experiment_template.hypothesis}</div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {track.experiment_template.metrics.slice(0, 5).map((metric) => (
                    <Badge key={metric} variant="outline" className="border-cyan-500/20 text-cyan-200">{metric}</Badge>
                  ))}
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" disabled={actionBusy === `experiment:${track.id}`} onClick={() => onCreateTrackExperiment(track)}>
                    {actionBusy === `experiment:${track.id}` ? '建立中...' : '建立研究實驗'}
                  </Button>
                  {track.id === 'LinUCB' && (
                    <Button size="sm" variant="outline" disabled={actionBusy === 'linucb-ledger'} onClick={onRefreshLinucb}>
                      {actionBusy === 'linucb-ledger' ? '刷新中...' : '刷新 Reward Ledger'}
                    </Button>
                  )}
                  {(track.id === 'NeuralUCB' || track.id === 'NeuralTS') && (
                    <Button size="sm" className="bg-cyan-400 text-slate-950 hover:bg-cyan-300" disabled={actionBusy === `shadow:${track.id}`} onClick={() => onRunNeuralShadow(track.id as 'NeuralUCB' | 'NeuralTS')}>
                      {actionBusy === `shadow:${track.id}` ? '執行中...' : '執行 Shadow 驗證'}
                    </Button>
                  )}
                </div>
                <p className="mt-2 text-[11px] leading-5 text-slate-500">
                  建立研究實驗只寫入 hypothesis / dataset / metrics / gate 規格；Shadow 驗證才會用既有資料跑反事實決策並產出 reward evidence。只有 NeuralUCB / NeuralTS 是 live meta-router shadow，所以才有 Shadow 按鈕。
                </p>
              </div>
                  </>
                )
              })()}
            </div>
          ))}
          {!visible.length && (
            <div className="rounded-xl border border-dashed border-slate-700 p-4 text-sm text-slate-400">
              尚未取得 meta learning tracks；請確認 NeuralUCB / NeuralTS / Portfolio Bandit / NeuCB 的 research registry 是否已建立。
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-slate-800 bg-black/20 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
            <Activity className="h-4 w-4 text-emerald-300" /> Evidence Matrix
          </div>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-xs">
              <thead className="text-[10px] uppercase tracking-[0.16em] text-slate-500">
                <tr>
                  <th className="border-b border-slate-800 py-2 pr-3">Track</th>
                  <th className="border-b border-slate-800 py-2 pr-3">Evidence required</th>
                  <th className="border-b border-slate-800 py-2 pr-3">Registry</th>
                  <th className="border-b border-slate-800 py-2 pr-3">Decision</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((track) => {
                  const evidence = matrixById.get(track.id)
                  return (
                  <tr key={track.id} className="align-top">
                    <td className="border-b border-slate-900 py-3 pr-3 font-semibold text-slate-100">{track.id}</td>
                    <td className="border-b border-slate-900 py-3 pr-3 text-slate-400">{evidence?.missing_evidence.slice(0, 5).join(' / ') || 'ready'}</td>
                    <td className="border-b border-slate-900 py-3 pr-3 text-slate-300">{track.registered_experiment_ids.join(', ') || 'missing'} / latest {evidence?.latest_evidence_at ?? '-'}</td>
                    <td className="border-b border-slate-900 py-3 pr-3 text-amber-200">{decisionZhClean(track.decision_queue_status)} / ledger {evidenceLabel(evidence?.reward_ledger_status)} / shadow {evidenceLabel(evidence?.shadow_status)}</td>
                  </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs leading-5 text-slate-500">
            這裡是 research gate，不會直接 promote production。OOS IC、CPCV/PBO、DSR、turnover、slippage、T+1/T+5/T+10 都要先寫入 evaluation registry。
          </p>
        </div>
      </CardContent>
    </Card>
  )
}

export default function StrategyLabPage() {
  const [specs, setSpecs] = useState<StrategySpecsResponse | null>(null)
  const [dryRun, setDryRun] = useState<StrategyDryRunResponse | null>(null)
  const [strategyLearning, setStrategyLearning] = useState<StrategyLearningResponse | null>(null)
  const [experiments, setExperiments] = useState<ResearchExperimentsResponse | null>(null)
  const [modelUpgradeStatus, setModelUpgradeStatus] = useState<ModelUpgradeResearchStatusResponse | null>(null)
  const [researchGates, setResearchGates] = useState<ResearchGateResponse[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draftHypothesis, setDraftHypothesis] = useState('')
  const [draftSpecIds, setDraftSpecIds] = useState('breakout_vol_expansion_seed_v1')
  const [draftMetrics, setDraftMetrics] = useState('ic_4w_avg, walk_forward_sharpe, pbo')
  const [draftFollowUp, setDraftFollowUp] = useState('run dry-run backtest, prepare review packet')
  const [draftResult, setDraftResult] = useState<string | null>(null)
  const [draftError, setDraftError] = useState<string | null>(null)
  const [draftSaving, setDraftSaving] = useState(false)
  const [draftPersisting, setDraftPersisting] = useState(false)
  const [runningExperimentId, setRunningExperimentId] = useState<string | null>(null)
  const [metaActionBusy, setMetaActionBusy] = useState<string | null>(null)
  const [metaActionResult, setMetaActionResult] = useState<string | null>(null)
  const [modelUpgradeActionResult, setModelUpgradeActionResult] = useState<string | null>(null)
  const [modelUpgradeActionError, setModelUpgradeActionError] = useState<string | null>(null)
  const [runResults, setRunResults] = useState<Record<string, ResearchEvaluationRunResponse>>({})
  const [runHistory, setRunHistory] = useState<Record<string, ResearchEvaluationRunsResponse>>({})
  const [runErrors, setRunErrors] = useState<Record<string, string>>({})
  const [artifactIntentDrafts, setArtifactIntentDrafts] = useState<Record<string, ArtifactIntentDraft>>({})

  function artifactIntentDraftFor(id: string): ArtifactIntentDraft {
    return artifactIntentDrafts[id] ?? EMPTY_ARTIFACT_INTENT_DRAFT
  }

  function updateArtifactIntentDraft(id: string, field: keyof ArtifactIntentDraft, value: string) {
    setArtifactIntentDrafts((prev) => ({
      ...prev,
      [id]: {
        ...(prev[id] ?? EMPTY_ARTIFACT_INTENT_DRAFT),
        [field]: value,
      },
    }))
  }

  async function load() {
    try {
      setError(null)
      const [specResponse, dryRunResponse, learningResponse, experimentResponse, modelUpgradeResponse, ...gateResponses] = await Promise.all([
        strategyLabApi.specs(),
        strategyLabApi.dryRun(),
        strategyLabApi.learning(),
        strategyLabApi.experiments(),
        strategyLabApi.modelUpgradeStatus(),
        strategyLabApi.gate('generate_hypothesis'),
        strategyLabApi.gate('request_backtest_dry_run', { dryRun: true }),
        strategyLabApi.gate('generate_patch'),
        strategyLabApi.gate('deploy_prod'),
        strategyLabApi.gate('place_trade'),
      ])
      setSpecs(specResponse)
      setDryRun(dryRunResponse)
      setStrategyLearning(learningResponse)
      setExperiments(experimentResponse)
      setModelUpgradeStatus(modelUpgradeResponse)
      setResearchGates(gateResponses)
    } catch (e: unknown) {
      setError(getErrorMessage(e, 'Strategy Lab API 載入失敗'))
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const dryRunBySpec = useMemo(() => {
    return new Map((dryRun?.results ?? []).map((result) => [result.specId, result]))
  }, [dryRun])

  const stats = useMemo(() => {
    const strategyCount = specs?.specs.length ?? 0
    const safeGateCount = researchGates.filter((gate) => gate.gate.decision === 'ALLOW').length
    const blockedGateCount = researchGates.filter((gate) => gate.gate.decision === 'BLOCK').length
    const dryRunMatches = dryRun?.results.reduce((sum, item) => sum + item.matched, 0) ?? 0
    return { strategyCount, safeGateCount, blockedGateCount, dryRunMatches }
  }, [dryRun, researchGates, specs])

  const modelUpgradeRowByExperimentId = useMemo(() => {
    const entries = (modelUpgradeStatus?.candidates ?? [])
      .filter((row) => row.latest_experiment_id)
      .map((row) => [row.latest_experiment_id as string, row] as const)
    return new Map(entries)
  }, [modelUpgradeStatus])

  async function previewExperiment() {
    try {
      setDraftSaving(true)
      setDraftError(null)
      const res = await strategyLabApi.createExperiment({
        hypothesis: draftHypothesis,
        strategySpecIds: splitCsv(draftSpecIds),
        metrics: splitCsv(draftMetrics),
        followUp: splitCsv(draftFollowUp),
        sourceRefs: ['strategy-lab-ui'],
        dry_run: true,
      })
      setDraftResult(res.review_packet)
    } catch (e: unknown) {
      setDraftError(getErrorMessage(e, 'review packet preview failed'))
    } finally {
      setDraftSaving(false)
    }
  }

  async function persistDraftExperiment() {
    try {
      setDraftPersisting(true)
      setDraftError(null)
      const res = await strategyLabApi.createExperiment({
        hypothesis: draftHypothesis,
        strategySpecIds: splitCsv(draftSpecIds),
        metrics: splitCsv(draftMetrics),
        followUp: splitCsv(draftFollowUp),
        sourceRefs: ['strategy-lab-ui'],
        status: 'queued',
        dry_run: false,
        confirm: true,
      })
      setDraftResult(res.review_packet)
      setMetaActionResult(`研究實驗已寫入 registry：${res.experiment.id}，狀態 ${res.experiment.status}。`)
      await load()
    } catch (e: unknown) {
      setDraftError(getErrorMessage(e, 'experiment registry write failed'))
    } finally {
      setDraftPersisting(false)
    }
  }

  async function createModelBenchmarkExperiment() {
    try {
      setDraftPersisting(true)
      setDraftError(null)
      const today = new Date().toISOString().slice(0, 10)
      const res = await strategyLabApi.createExperiment({
        id: `model-family-benchmark-${today.replace(/-/g, '')}`,
        hypothesis: 'model_benchmark：評估 TabM、iTransformer、TimesFM 是否值得從 benchmark-only 升級成 shadow challenger，並比較 OOS IC、CPCV/PBO、成本敏感度與資料切片穩定性。',
        strategySpecIds: ['model_family_benchmark_v1'],
        metrics: ['oos_ic', 'cpcv_pbo', 'cost_sensitivity', 'data_slice_report', 'latency_cost'],
        followUp: ['run model_benchmark dry-run', 'inspect benchmark report', 'decide promote to shadow challenger or reject'],
        sourceRefs: ['strategy-lab-ui', 'model-upgrade-track'],
        dataSlice: {
          benchmark_candidates: ['TabM', 'iTransformer', 'TimesFM'],
          start_date: '2026-04-01',
          end_date: today,
          market_lanes: ['listed', 'otc', 'emerging'],
        },
        status: 'queued',
        dry_run: false,
        confirm: true,
      })
      setDraftResult(res.review_packet)
      setMetaActionResult(`Model Benchmark 已寫入 registry：${res.experiment.id}，狀態 ${res.experiment.status}。`)
      await load()
    } catch (e: unknown) {
      setDraftError(getErrorMessage(e, 'model benchmark experiment write failed'))
    } finally {
      setDraftPersisting(false)
    }
  }

  async function seedModelUpgradeRegistry() {
    try {
      setMetaActionBusy('model-upgrade-seed')
      setDraftError(null)
      setModelUpgradeActionError(null)
      setModelUpgradeActionResult('正在建立 Strategy Lab experiment registry metadata...')
      const res = await strategyLabApi.seedModelUpgradeRegistry({ dry_run: false, confirm: true })
      const seededIds = [...(res.created ?? []), ...(res.existing ?? [])].filter((id): id is string => typeof id === 'string')
      const message = `Model upgrade registry 已建立：created=${res.created?.length ?? 0}，existing=${res.existing?.length ?? 0}；下一步跑各 experiment 的 dry-run evaluation plan。KV list 可能短暫延遲，畫面已先標為 evaluation_pending。`
      setMetaActionResult(message)
      setModelUpgradeActionResult(message)
      setModelUpgradeStatus((prev) => applyModelUpgradeSeedFeedback(prev, seededIds))
      await load()
      setModelUpgradeStatus((prev) => applyModelUpgradeSeedFeedback(prev, seededIds))
    } catch (e: unknown) {
      const message = getErrorMessage(e, 'model upgrade registry seed failed')
      setDraftError(message)
      setModelUpgradeActionError(message)
      setModelUpgradeActionResult(null)
    } finally {
      setMetaActionBusy(null)
    }
  }

  async function runModelUpgradeEvaluations() {
    try {
      const nextTarget = modelUpgradeStatus?.candidates.find((row) => row.requires_experiment_registry && row.registry_status === 'evaluation_pending')
        ?? modelUpgradeStatus?.candidates.find((row) => row.requires_experiment_registry && row.registry_status === 'needs_attention')
      if (!nextTarget) {
        setModelUpgradeActionError(null)
        setModelUpgradeActionResult('目前沒有 pending / needs_attention 的 model upgrade experiment 可跑。')
        return
      }
      setMetaActionBusy('model-upgrade-evaluation')
      setDraftError(null)
      setModelUpgradeActionError(null)
      setModelUpgradeActionResult(`正在執行下一個 model upgrade dry-run evaluation：${nextTarget.candidate_id}`)
      const res = await strategyLabApi.runModelUpgradeEvaluations({
        candidate_ids: [nextTarget.candidate_id],
        dry_run: true,
        seed_missing: true,
        include_ready: false,
        limit: 1,
        confirm: true,
      })
      const ready = res.runs.filter((run) => run.verdict === 'ready_for_review').length
      const attention = res.runs.filter((run) => run.verdict !== 'ready_for_review').length
      const message = `Model upgrade dry-run 完成：target=${nextTarget.candidate_id}，runs=${res.runs.length}，review_ready=${ready}，needs_attention=${attention}，production_effect=false。若仍有 pending，請再按一次跑下一筆。`
      setMetaActionResult(message)
      setModelUpgradeActionResult(message)
      if (res.status) setModelUpgradeStatus(res.status)
      await load()
    } catch (e: unknown) {
      const message = getErrorMessage(e, 'model upgrade dry-run evaluation failed')
      setDraftError(message)
      setModelUpgradeActionError(message)
      setModelUpgradeActionResult(null)
    } finally {
      setMetaActionBusy(null)
    }
  }

  async function createMetaLearningExperiment(track: MetaLearningTrack) {
    try {
      setMetaActionBusy(`experiment:${track.id}`)
      setDraftError(null)
      const today = new Date().toISOString().slice(0, 10)
      const id = `${track.id.toLowerCase()}-${today.replace(/-/g, '')}`
      const template = track.experiment_template
      const res = await strategyLabApi.createExperiment({
        id,
        hypothesis: template.hypothesis,
        strategySpecIds: template.strategySpecIds,
        metrics: template.metrics,
        followUp: template.followUp,
        sourceRefs: [...template.sourceRefs, 'strategy-lab-meta-learning-desk'],
        dataSlice: {
          track_id: track.id,
          stage: track.stage,
          learning_targets: track.learning_targets,
          start_date: '2026-04-01',
          end_date: today,
        },
        status: 'queued',
        dry_run: false,
        confirm: true,
      })
      setDraftResult(res.review_packet)
      await load()
    } catch (e: unknown) {
      setDraftError(getErrorMessage(e, `${track.id} experiment write failed`))
    } finally {
      setMetaActionBusy(null)
    }
  }

  async function refreshLinucbLedger() {
    try {
      setMetaActionBusy('linucb-ledger')
      setDraftError(null)
      const res = await strategyLabApi.refreshLinucbRewardLedger({ limit: 5000, dry_run: false, confirm: true })
      setMetaActionResult(`LinUCB reward ledger 已刷新：samples=${res.samples ?? res.source_rows ?? '-'}，arms=${res.arms ?? '-'}。`)
      await load()
    } catch (e: unknown) {
      setDraftError(getErrorMessage(e, 'LinUCB reward ledger refresh failed'))
    } finally {
      setMetaActionBusy(null)
    }
  }

  async function runNeuralShadow(policyId: 'NeuralUCB' | 'NeuralTS') {
    try {
      setMetaActionBusy(`shadow:${policyId}`)
      setDraftError(null)
      const res = await strategyLabApi.runNeuralShadow({ policy_id: policyId, limit: 5000, dry_run: false, confirm: true })
      setMetaActionResult(`${policyId} shadow 驗證完成：mode=${res.mode ?? '-'}，success=${String(res.success)}，source_rows=${res.source_rows ?? 0}，training_samples=${res.training_samples ?? 0}，persisted_rows=${res.persisted_rows ?? 0}。`)
      await load()
    } catch (e: unknown) {
      setDraftError(getErrorMessage(e, `${policyId} shadow run failed`))
    } finally {
      setMetaActionBusy(null)
    }
  }

  async function materializeStrategyDecisionLog() {
    try {
      setMetaActionBusy('strategy-decision-log')
      setDraftError(null)
      const res = await strategyLabApi.materializeDecisionLog({ limit: 500, dry_run: false, confirm: true })
      setMetaActionResult(`Strategy decision log 已寫入：candidates=${res.candidate_count ?? 0}，decision_rows=${res.persisted_rows ?? 0}。`)
      await load()
    } catch (e: unknown) {
      setDraftError(getErrorMessage(e, 'strategy decision log materialization failed'))
    } finally {
      setMetaActionBusy(null)
    }
  }

  async function refreshStrategyRewardLedger() {
    try {
      setMetaActionBusy('strategy-reward-ledger')
      setDraftError(null)
      const res = await strategyLabApi.refreshStrategyRewardLedger({ limit: 5000, dry_run: false, confirm: true })
      setMetaActionResult(`Strategy reward ledger 已刷新：source_rows=${res.source_rows ?? 0}，ledger_rows=${res.persisted_rows ?? 0}。`)
      await load()
    } catch (e: unknown) {
      setDraftError(getErrorMessage(e, 'strategy reward ledger refresh failed'))
    } finally {
      setMetaActionBusy(null)
    }
  }

  async function refreshStrategyPolicyState() {
    try {
      setMetaActionBusy('strategy-policy-state')
      setDraftError(null)
      const res = await strategyLabApi.refreshStrategyPolicyState({ dry_run: false, confirm: true })
      setMetaActionResult(`Adaptive strategy policy shadow 已更新：eligible=${res.policy_state?.evidence?.eligible_strategy_count ?? 0}，persisted=${res.persisted_rows ?? 0}，production_effect=false。`)
      await load()
    } catch (e: unknown) {
      setDraftError(getErrorMessage(e, 'strategy adaptive policy refresh failed'))
    } finally {
      setMetaActionBusy(null)
    }
  }

  async function runEvaluationPlan(id: string) {
    try {
      setRunningExperimentId(id)
      setRunErrors((prev) => ({ ...prev, [id]: '' }))
      const result = await strategyLabApi.runEvaluationPlan(id)
      setRunResults((prev) => ({ ...prev, [id]: result }))
      const history = await strategyLabApi.evaluationRuns(id)
      setRunHistory((prev) => ({ ...prev, [id]: history }))
      await load()
    } catch (e: unknown) {
      setRunErrors((prev) => ({ ...prev, [id]: getErrorMessage(e, 'evaluation dry-run failed') }))
    } finally {
      setRunningExperimentId(null)
    }
  }

  async function updateExperimentStatus(id: string, status: 'approved_for_patch' | 'rejected') {
    try {
      setMetaActionBusy(`experiment-status:${id}:${status}`)
      setDraftError(null)
      const res = await strategyLabApi.updateExperimentStatus(id, {
        status,
        reason: 'strategy-lab-ui-review',
        confirm: true,
      })
      setMetaActionResult(`Experiment ${id} 已更新為 ${res.experiment.status}；production_effect=false。`)
      await load()
    } catch (e: unknown) {
      setDraftError(getErrorMessage(e, 'experiment status update failed'))
    } finally {
      setMetaActionBusy(null)
    }
  }

  async function createPatchHandoff(id: string) {
    try {
      setMetaActionBusy(`patch-handoff:${id}`)
      setDraftError(null)
      const res = await strategyLabApi.createPatchHandoff(id, {
        reviewer: 'Wei',
        reason: 'strategy-lab-approved-for-patch',
        dry_run: true,
        confirm: true,
      })
      const bridge = res.handoff.artifact_bridge
      setMetaActionResult(`Patch handoff 已建立：${bridge.candidate_type} -> ${bridge.target_registry}，candidate=${bridge.candidate_ids.join(', ') || '-'}；production_effect=false。`)
      await load()
    } catch (e: unknown) {
      setDraftError(getErrorMessage(e, 'patch handoff generation failed'))
    } finally {
      setMetaActionBusy(null)
    }
  }

  async function createArtifactIntent(id: string) {
    try {
      setMetaActionBusy(`artifact-intent:${id}`)
      setDraftError(null)
      const draft = trimDraft(artifactIntentDraftFor(id))
      const res = await strategyLabApi.createArtifactIntent(id, {
        ...draft,
        reviewer: 'Wei',
        reason: 'strategy-lab-artifact-registration-preflight',
        dry_run: true,
        confirm: true,
      })
      const candidate = res.intent.registry_candidate
      const missing = res.intent.preflight.missing_fields.join(', ') || 'none'
      setMetaActionResult(`Artifact intent 已建立：${candidate.artifact_id}，status=${res.intent.status}，missing=${missing}；model_artifact_registry 未寫入。`)
      await load()
    } catch (e: unknown) {
      setDraftError(getErrorMessage(e, 'artifact intent generation failed'))
    } finally {
      setMetaActionBusy(null)
    }
  }

  if (loading) {
    return (
      <AppShell>
        <div className="flex items-center gap-2 p-6 text-sm text-slate-400">
          <Loader2 className="h-4 w-4 animate-spin" /> Strategy Lab 載入中...
        </div>
      </AppShell>
    )
  }

  return (
    <AppShell>
      <div className="space-y-5 p-4 lg:p-6">
        <div className="rounded-3xl border border-amber-500/20 bg-[radial-gradient(circle_at_18%_20%,rgba(245,158,11,0.18),transparent_28%),linear-gradient(135deg,#151714,#0b0f14_62%,#17110a)] p-5 shadow-[0_24px_90px_rgba(0,0,0,0.28)]">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-amber-300">Research Mission Control</p>
              <h1 className="mt-2 flex items-center gap-2 text-2xl font-bold text-amber-50">
                <FlaskConical className="h-5 w-5 text-amber-300" /> 策略研究室
              </h1>
              <p className="mt-2 max-w-4xl text-sm leading-relaxed text-slate-300">
                研究室只產生假說、dry-run review packet 與 evidence，不直接 retrain、promote 或 deploy。所有候選策略都要先通過 gate。
              </p>
            </div>
            <Button size="sm" variant="outline" className="rounded-full border-amber-400/30 text-amber-200" onClick={() => { setRefreshing(true); load() }}>
              <RefreshCw className={`mr-1 h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} /> 重新整理
            </Button>
          </div>
        </div>

        <StrategyExperimentTimeline
          specs={specs?.specs ?? []}
          dryRun={dryRun}
          experiments={experiments?.experiments ?? []}
        />

        {error && (
          <Card className="border-red-500/30">
            <CardContent className="p-4 text-sm text-red-300">{error}</CardContent>
          </Card>
        )}

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          {[
            ['策略規格', stats.strategyCount, specs?.version ?? 'strategy-spec-v1'],
            ['Dry-run 命中', stats.dryRunMatches, dryRun?.source ?? '-'],
            ['研究實驗', experiments?.experiments.length ?? 0, experiments?.mode ?? 'read_only'],
            ['允許 Gate', stats.safeGateCount, 'hypothesis / dry-run'],
            ['阻擋 Gate', stats.blockedGateCount, 'deploy / trade'],
          ].map(([label, value, hint]) => (
            <Card key={label as string} className="border-slate-800 bg-slate-950/70">
              <CardContent className="p-4">
                <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">{label}</div>
                <div className="mt-2 text-2xl font-bold text-slate-100">{value}</div>
                <div className="mt-1 truncate text-xs text-slate-500">{hint}</div>
              </CardContent>
            </Card>
          ))}
        </div>

        <MetaLearningDecisionDesk
          tracks={experiments?.meta_learning_tracks ?? []}
          matrix={experiments?.meta_learning_evidence_matrix ?? []}
          actionBusy={metaActionBusy}
          onCreateTrackExperiment={createMetaLearningExperiment}
          onRefreshLinucb={refreshLinucbLedger}
          onRunNeuralShadow={runNeuralShadow}
          actionResult={metaActionResult}
        />

        <ModelUpgradeLaunchpad
          status={modelUpgradeStatus}
          busy={metaActionBusy}
          actionResult={modelUpgradeActionResult}
          actionError={modelUpgradeActionError}
          onSeedRegistry={seedModelUpgradeRegistry}
          onRunEvaluations={runModelUpgradeEvaluations}
        />

        <StrategyLearningPanel
          learning={strategyLearning}
          busy={metaActionBusy}
          onMaterialize={materializeStrategyDecisionLog}
          onRefreshRewards={refreshStrategyRewardLedger}
          onRefreshPolicy={refreshStrategyPolicyState}
        />

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.35fr_0.65fr]">
          <Card className="border-slate-800 bg-slate-950/70">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <GitBranch className="h-4 w-4 text-cyan-300" /> 策略規格與 dry-run
              </CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-3 2xl:grid-cols-2">
              {(specs?.specs ?? []).map((spec) => (
                <StrategySpecCard key={spec.id} spec={spec} dryRun={dryRunBySpec.get(spec.id)} />
              ))}
            </CardContent>
          </Card>

          <div className="space-y-4">
            <Card className="border-slate-800 bg-slate-950/70">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <ShieldCheck className="h-4 w-4 text-emerald-300" /> Research Intern Gate
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {researchGates.map(({ gate }) => (
                  <div key={gate.action} className="rounded-xl border border-slate-800 bg-black/20 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-slate-100">{gate.action}</span>
                      <Badge variant="outline" className={gateClass(gate.decision)}>{gate.decision}</Badge>
                    </div>
                    <div className="mt-2 text-xs leading-relaxed text-slate-400">{gate.reason}</div>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card className="border-slate-800 bg-slate-950/70">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <TestTube2 className="h-4 w-4 text-amber-300" /> 建立研究假說
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <textarea
                  value={draftHypothesis}
                  onChange={(event) => setDraftHypothesis(event.target.value)}
                  placeholder="描述假說，例如：breakout bucket 在 bull + liquidity normal regime 是否能提升 T+5 hit rate，且不增加 MDD?"
                  className="min-h-24 w-full rounded-xl border border-slate-800 bg-black/30 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-400/50"
                />
                <input value={draftSpecIds} onChange={(event) => setDraftSpecIds(event.target.value)} className="w-full rounded-xl border border-slate-800 bg-black/30 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-400/50" placeholder="strategy spec ids" />
                <input value={draftMetrics} onChange={(event) => setDraftMetrics(event.target.value)} className="w-full rounded-xl border border-slate-800 bg-black/30 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-400/50" placeholder="metrics" />
                <input value={draftFollowUp} onChange={(event) => setDraftFollowUp(event.target.value)} className="w-full rounded-xl border border-slate-800 bg-black/30 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-400/50" placeholder="follow-up" />
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" disabled={draftSaving || draftHypothesis.trim().length < 12} onClick={previewExperiment}>
                    {draftSaving ? 'Previewing...' : '產生 Dry-run Review Packet'}
                  </Button>
                  <Button size="sm" variant="outline" disabled={draftPersisting || draftHypothesis.trim().length < 12} onClick={persistDraftExperiment}>
                    {draftPersisting ? 'Saving...' : '寫入 Registry'}
                  </Button>
                  <Button size="sm" className="bg-amber-400 text-slate-950 hover:bg-amber-300" disabled={draftPersisting} onClick={createModelBenchmarkExperiment}>
                    建立 Model Benchmark
                  </Button>
                </div>
                <div className="rounded-xl border border-slate-800 bg-black/20 p-3 text-xs leading-5 text-slate-400">
                  觸發順序：先寫入 experiment registry，下面卡片會出現 evaluation plan，再按 Run dry-run plan；model_benchmark step 會呼叫 /research/model-benchmark/dry-run，不是 Scheduler job。
                </div>
                {draftError && <div className="text-xs text-red-300">{draftError}</div>}
                {draftResult && (
                  <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-xl border border-slate-800 bg-black/25 p-3 text-[11px] leading-relaxed text-slate-400">
                    {draftResult}
                  </pre>
                )}
              </CardContent>
            </Card>
          </div>
        </div>

        <Card className="border-slate-800 bg-slate-950/70">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <PlayCircle className="h-4 w-4 text-emerald-300" /> Experiment Registry
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {(experiments?.experiments ?? []).length === 0 && (
              <div className="rounded-xl border border-dashed border-slate-700 p-4 text-sm text-slate-400">
                尚未建立研究實驗。請先產生 dry-run review packet，通過 research gate 後再安排 backtest / walk-forward / PBO。
              </div>
            )}
            {(experiments?.experiments ?? []).map((experiment) => {
              const modelUpgradeRow = modelUpgradeRowByExperimentId.get(experiment.id)
              const isModelUpgradeExperiment = Boolean(modelUpgradeRow)
              const showModelArtifactIntent = experiment.status === 'approved_for_patch' && isModelUpgradeExperiment
              const showStrategyPatchOnly = experiment.status === 'approved_for_patch' && !isModelUpgradeExperiment
              return (
              <div key={experiment.id} className="rounded-2xl border border-slate-800 bg-black/20 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-semibold text-slate-100">{experiment.id}</div>
                    <div className="mt-1 text-xs text-slate-500">updated {experiment.updated_at}</div>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <Badge variant="outline" className={statusClass(experiment.status)}>{experiment.status}</Badge>
                    {experiment.status === 'review_ready' && (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={metaActionBusy?.startsWith(`experiment-status:${experiment.id}`)}
                          onClick={() => updateExperimentStatus(experiment.id, 'approved_for_patch')}
                        >
                          Approve for patch
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={metaActionBusy?.startsWith(`experiment-status:${experiment.id}`)}
                          onClick={() => updateExperimentStatus(experiment.id, 'rejected')}
                        >
                          Reject
                        </Button>
                      </>
                    )}
                    {experiment.status === 'approved_for_patch' && (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={metaActionBusy === `patch-handoff:${experiment.id}`}
                          onClick={() => createPatchHandoff(experiment.id)}
                        >
                          {metaActionBusy === `patch-handoff:${experiment.id}` ? 'Generating...' : 'Generate patch handoff'}
                        </Button>
                        {isModelUpgradeExperiment && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={metaActionBusy === `artifact-intent:${experiment.id}`}
                            onClick={() => createArtifactIntent(experiment.id)}
                          >
                            {metaActionBusy === `artifact-intent:${experiment.id}` ? 'Checking...' : 'Artifact intent'}
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                </div>
                <p className="mt-3 text-sm leading-relaxed text-slate-300">{experiment.hypothesis}</p>
                {showStrategyPatchOnly && (
                  <div className="mt-3 rounded-2xl border border-sky-500/20 bg-sky-500/[0.04] p-3 text-xs leading-5 text-sky-100">
                    <div className="font-semibold">Strategy patch handoff only</div>
                    <div className="mt-1 text-sky-100/80">
                      這不是 Model Upgrade experiment，所以不會建立 model_artifact_registry intent。下一步是產生 patch handoff，進 strategy spec / runtime patch review。
                    </div>
                  </div>
                )}
                {showModelArtifactIntent && (
                  <div className="mt-3 rounded-2xl border border-violet-500/20 bg-violet-500/[0.04] p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="text-xs font-semibold text-violet-100">Artifact preflight metadata</div>
                        <div className="mt-1 text-[11px] leading-5 text-slate-400">
                          填入 artifact_path、manifest、feature policy、checksum 後，Artifact intent 會轉成 registry preflight ready；仍不會寫 model_artifact_registry。
                        </div>
                        <div className="mt-1 text-[11px] leading-5 text-violet-200/80">
                          {modelUpgradeRow?.candidate_id ?? 'model-upgrade'} / {modelUpgradeRow?.latest_artifact_intent_status ?? 'intent none'} / next {modelUpgradeRow?.next_action ?? '-'}
                        </div>
                      </div>
                      <Badge variant="outline" className="border-violet-500/25 bg-violet-500/10 text-violet-200">
                        metadata-only
                      </Badge>
                    </div>
                    <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-4">
                      {ARTIFACT_INTENT_FIELDS.map((field) => (
                        <label key={`${experiment.id}-${field.key}`} className="text-[11px] text-slate-500">
                          <span className="mb-1 block uppercase tracking-[0.12em]">
                            {field.label}{field.required ? ' *' : ''}
                          </span>
                          <input
                            value={artifactIntentDraftFor(experiment.id)[field.key]}
                            onChange={(event) => updateArtifactIntentDraft(experiment.id, field.key, event.target.value)}
                            className="w-full rounded-xl border border-slate-800 bg-black/30 px-3 py-2 text-xs text-slate-100 outline-none focus:border-violet-400/50"
                            placeholder={field.placeholder}
                          />
                        </label>
                      ))}
                    </div>
                  </div>
                )}
                <div className="mt-3 grid grid-cols-1 gap-2 text-xs md:grid-cols-3">
                  <div className="rounded-xl border border-slate-800 p-3">Specs: {experiment.strategy_spec_ids.join(' / ') || 'none'}</div>
                  <div className="rounded-xl border border-slate-800 p-3">Metrics: {experiment.metrics.join(' / ') || 'none'}</div>
                  <div className="rounded-xl border border-slate-800 p-3">Can deploy: {String(experiment.approval_gate.can_deploy)}</div>
                </div>
                {experiment.evaluation_plan && (
                  <div className="mt-3 rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-xs font-semibold text-cyan-200">Evaluation plan: {experiment.evaluation_plan.mode}</div>
                      <Button size="sm" variant="outline" disabled={runningExperimentId === experiment.id} onClick={() => runEvaluationPlan(experiment.id)}>
                        {runningExperimentId === experiment.id ? 'Running...' : 'Run dry-run plan'}
                      </Button>
                    </div>
                    <div className="mt-2 grid grid-cols-1 gap-2 lg:grid-cols-3">
                      {experiment.evaluation_plan.steps.map((step: any) => (
                        <div key={step.id} className="rounded-lg border border-slate-800 bg-black/20 p-2 text-[11px]">
                          <div className="font-semibold text-slate-200">{step.kind}</div>
                          <div className="mt-1 text-slate-500">{step.controller_endpoint ?? 'blocked: no safe endpoint'}</div>
                          <div className={step.execution_ready ? 'mt-1 text-emerald-300' : 'mt-1 text-amber-300'}>
                            {step.execution_ready ? 'safe dry-run endpoint' : 'blocked until dry-run endpoint exists'}
                          </div>
                        </div>
                      ))}
                    </div>
                    {runErrors[experiment.id] && <div className="mt-2 text-xs text-red-300">{runErrors[experiment.id]}</div>}
                    {runResults[experiment.id] && (
                      <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-xl border border-slate-800 bg-black/25 p-3 text-[11px] leading-relaxed text-slate-400">
                        {runResults[experiment.id].report.review_packet}
                      </pre>
                    )}
                    {runHistory[experiment.id]?.runs?.[0] && (
                      <div className="mt-2 text-xs text-slate-500">
                        latest dry-run: {runHistory[experiment.id].runs[0].created_at} / {runHistory[experiment.id].runs[0].verdict}
                      </div>
                    )}
                  </div>
                )}
              </div>
              )
            })}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  )
}
