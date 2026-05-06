import { useEffect, useMemo, useState } from 'react'
import AppShell from '@/components/AppShell'
import {
  strategyLabApi,
  type StrategyDryRunResponse,
  type StrategySpecsResponse,
  type StrategySpec,
  type ResearchExperimentsResponse,
  type ResearchGateResponse,
  type ResearchEvaluationRunResponse,
  type ResearchEvaluationRunsResponse,
} from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { FlaskConical, GitBranch, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'

function statusClass(status?: string) {
  if (status === 'active' || status === 'candidate') return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/20'
  if (status === 'shadow' || status === 'research') return 'bg-sky-500/15 text-sky-300 border-sky-500/20'
  if (status === 'retired') return 'bg-zinc-700/40 text-zinc-300 border-zinc-600/40'
  return 'bg-amber-500/15 text-amber-300 border-amber-500/20'
}

function percent(value: number) {
  return `${Math.round(value * 1000) / 10}%`
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

function SpecCard({ spec, dryRun }: { spec: StrategySpec; dryRun?: StrategyDryRunResponse['results'][number] }) {
  const thresholdText = Object.entries(spec.thresholds ?? {})
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(',') : String(value)}`)
    .join(' / ')

  return (
    <Card className="border-border/80 bg-card/95">
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{spec.name}</span>
              <Badge variant="outline" className={statusClass(spec.status)}>{spec.status}</Badge>
              <Badge variant="outline" className="border-cyan-500/20 bg-cyan-500/10 text-cyan-200">{spec.alphaBucket}</Badge>
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">{spec.id} · {spec.version}</div>
          </div>
          <Badge variant="outline" className={spec.validation.ok ? 'border-emerald-500/20 text-emerald-300' : 'border-red-500/30 text-red-300'}>
            {spec.validation.ok ? 'contract ok' : 'contract fail'}
          </Badge>
        </div>

        <p className="text-sm leading-relaxed text-muted-foreground">{spec.thesis}</p>
        <div className="rounded-lg border border-border bg-background/60 p-3 text-xs text-muted-foreground">
          <div className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70">Thresholds</div>
          <div className="mt-1 break-words">{thresholdText || '未設定'}</div>
        </div>

        <div className="grid grid-cols-1 gap-2 text-xs md:grid-cols-3">
          <div className="rounded-lg border border-border/80 p-3">
            <div className="text-muted-foreground">Regimes</div>
            <div className="mt-1 font-medium">{spec.supportedRegimes.join(' / ')}</div>
          </div>
          <div className="rounded-lg border border-border/80 p-3">
            <div className="text-muted-foreground">Dry-run 命中</div>
            <div className="mt-1 font-medium">{dryRun ? `${dryRun.matched}/${dryRun.sampleSize}` : '-'}</div>
          </div>
          <div className="rounded-lg border border-border/80 p-3">
            <div className="text-muted-foreground">命中率</div>
            <div className="mt-1 font-medium">{dryRun ? percent(dryRun.matchRate) : '-'}</div>
          </div>
        </div>

        <div className="space-y-1 text-xs text-muted-foreground">
          {spec.riskNotes.map((note) => <div key={note}>風險註記：{note}</div>)}
          {!spec.validation.ok && <div className="text-red-300">Contract errors: {spec.validation.errors.join(', ')}</div>}
        </div>
      </CardContent>
    </Card>
  )
}

export default function StrategyLabPage() {
  const [specs, setSpecs] = useState<StrategySpecsResponse | null>(null)
  const [dryRun, setDryRun] = useState<StrategyDryRunResponse | null>(null)
  const [experiments, setExperiments] = useState<ResearchExperimentsResponse | null>(null)
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
  const [runningExperimentId, setRunningExperimentId] = useState<string | null>(null)
  const [runResults, setRunResults] = useState<Record<string, ResearchEvaluationRunResponse>>({})
  const [runHistory, setRunHistory] = useState<Record<string, ResearchEvaluationRunsResponse>>({})
  const [runErrors, setRunErrors] = useState<Record<string, string>>({})

  async function load() {
    try {
      setError(null)
      const [specResponse, dryRunResponse, experimentResponse, ...gateResponses] = await Promise.all([
        strategyLabApi.specs(),
        strategyLabApi.dryRun(),
        strategyLabApi.experiments(),
        strategyLabApi.gate('generate_hypothesis'),
        strategyLabApi.gate('request_backtest_dry_run', { dryRun: true }),
        strategyLabApi.gate('generate_patch'),
        strategyLabApi.gate('deploy_prod'),
        strategyLabApi.gate('place_trade'),
      ])
      setSpecs(specResponse)
      setDryRun(dryRunResponse)
      setExperiments(experimentResponse)
      setResearchGates(gateResponses)
    } catch (e: unknown) {
      setError(getErrorMessage(e, '策略實驗室載入失敗'))
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

  function splitCsv(value: string) {
    return value.split(',').map((part) => part.trim()).filter(Boolean)
  }

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
      setDraftError(getErrorMessage(e, 'preview failed'))
    } finally {
      setDraftSaving(false)
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
    } catch (e: unknown) {
      setRunErrors((prev) => ({ ...prev, [id]: getErrorMessage(e, 'evaluation dry-run failed') }))
    } finally {
      setRunningExperimentId(null)
    }
  }

  if (loading) {
    return (
      <AppShell>
        <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> 載入策略實驗室...
        </div>
      </AppShell>
    )
  }

  return (
    <AppShell>
      <div className="space-y-6 p-4 lg:p-6">
        <div className="rounded-2xl border border-[#3a3125] bg-[linear-gradient(135deg,#1f211c,#171714_58%,#241a11)] p-4 shadow-[0_18px_70px_rgba(0,0,0,0.18)]">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#d6a85f]">Research room</p>
            <h1 className="mt-1 flex items-center gap-2 text-xl font-bold text-[#fff7e8]">
              <FlaskConical className="h-5 w-5 text-[#d6a85f]" /> 策略實驗室
            </h1>
            <p className="mt-2 max-w-3xl text-xs leading-relaxed text-[#b9b1a1]">
              在這裡先把策略假設、門檻與風險寫清楚；它只能產生研究證據，不會直接觸發 pending buy、成交或模型 promote。
            </p>
          </div>
          <Button size="sm" variant="outline" className="rounded-full border-[#d6a85f]/30 text-[#f1c16f]" onClick={() => { setRefreshing(true); load() }}>
            <RefreshCw className={`mr-1 h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} /> 重新整理
          </Button>
          </div>
        </div>

        {error && (
          <Card className="border-red-500/30">
            <CardContent className="p-4 text-sm text-red-300">策略實驗室 API 載入失敗：{error}</CardContent>
          </Card>
        )}

        <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
          <Card>
            <CardContent className="p-4">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Mode</div>
              <div className="mt-2"><Badge variant="outline" className="border-sky-500/20 text-sky-300">{specs?.mode ?? 'read_only'}</Badge></div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Specs</div>
              <div className="mt-2 text-lg font-bold">{specs?.specs.length ?? 0}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Dry-run Sample</div>
              <div className="mt-2 text-lg font-bold">{dryRun?.candidate_count ?? 0}</div>
              <div className="text-xs text-muted-foreground">{dryRun?.source ?? '-'}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Owner Freeze</div>
              <div className="mt-2 flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-emerald-300" />
                <span className="text-lg font-bold">{specs?.owner_boundaries.length ?? 0}</span>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Research Registry</div>
              <div className="mt-2 text-lg font-bold">{experiments?.experiments.length ?? 0}</div>
              <div className="text-xs text-muted-foreground">{experiments?.mode ?? 'read_only'}</div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <GitBranch className="h-4 w-4 text-emerald-300" /> Owner Freeze 邊界
            </CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            {(specs?.owner_boundaries ?? []).map((boundary) => (
              <div key={boundary.owner} className="rounded-lg border border-border bg-background/50 p-3 text-xs">
                <div className="font-semibold">{boundary.owner}</div>
                <div className="mt-2 text-emerald-300">Owns: {boundary.owns.join(' / ')}</div>
                <div className="mt-1 text-red-300/80">Forbidden: {boundary.forbidden.join(' / ')}</div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <ShieldCheck className="h-4 w-4 text-emerald-300" /> Research Intern Gate
            </CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            {researchGates.map(({ gate }) => (
              <div key={gate.action} className="rounded-lg border border-border bg-background/50 p-3 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold">{gate.action}</span>
                  <Badge
                    variant="outline"
                    className={
                      gate.decision === 'ALLOW'
                        ? 'border-emerald-500/20 text-emerald-300'
                        : gate.decision === 'REQUIRE_APPROVAL'
                          ? 'border-amber-500/20 text-amber-300'
                          : 'border-red-500/30 text-red-300'
                    }
                  >
                    {gate.decision}
                  </Badge>
                </div>
                <div className="mt-2 text-muted-foreground">{gate.reason}</div>
                <div className="mt-2 text-emerald-300/80">Next: {gate.allowed_next_steps.join(' / ')}</div>
                <div className="mt-1 text-red-300/70">Blocked: {gate.blocked_capabilities.join(' / ')}</div>
              </div>
            ))}
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {(specs?.specs ?? []).map((spec) => (
            <SpecCard key={spec.id} spec={spec} dryRun={dryRunBySpec.get(spec.id)} />
          ))}
        </div>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <FlaskConical className="h-4 w-4 text-cyan-300" /> Research Experiments
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/5 p-4">
              <div className="text-sm font-semibold">Create Research Experiment</div>
              <div className="mt-1 text-xs text-muted-foreground">
                這裡只建立 dry-run review packet，不會 retrain、promote、deploy 或交易；正式登錄仍需後端 confirm header。
              </div>
              <div className="mt-3 grid grid-cols-1 gap-3">
                <textarea
                  value={draftHypothesis}
                  onChange={(event) => setDraftHypothesis(event.target.value)}
                  placeholder="例如：突破/波動擴張 bucket 在多頭 regime 是否能提高 walk-forward Sharpe 並降低 PBO?"
                  className="min-h-20 rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan-500/50"
                />
                <input
                  value={draftSpecIds}
                  onChange={(event) => setDraftSpecIds(event.target.value)}
                  className="rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan-500/50"
                  placeholder="strategy spec ids, comma-separated"
                />
                <input
                  value={draftMetrics}
                  onChange={(event) => setDraftMetrics(event.target.value)}
                  className="rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan-500/50"
                  placeholder="metrics, comma-separated"
                />
                <input
                  value={draftFollowUp}
                  onChange={(event) => setDraftFollowUp(event.target.value)}
                  className="rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan-500/50"
                  placeholder="follow-up, comma-separated"
                />
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" disabled={draftSaving || draftHypothesis.trim().length < 12} onClick={previewExperiment}>
                  {draftSaving ? 'Previewing...' : 'Dry-run Review Packet'}
                </Button>
                {draftError && <span className="text-xs text-red-300">{draftError}</span>}
              </div>
              {draftResult && (
                <pre className="mt-3 whitespace-pre-wrap rounded-lg border border-border bg-black/20 p-3 text-[11px] leading-relaxed text-muted-foreground">
                  {draftResult}
                </pre>
              )}
            </div>

            {(experiments?.experiments ?? []).length > 0 ? (
              experiments!.experiments.map((experiment) => (
                <div key={experiment.id} className="rounded-lg border border-border bg-background/50 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="font-semibold">{experiment.id}</div>
                      <div className="mt-1 text-xs text-muted-foreground">{experiment.updated_at}</div>
                    </div>
                    <Badge variant="outline" className={statusClass(experiment.status)}>{experiment.status}</Badge>
                  </div>
                  <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{experiment.hypothesis}</p>
                  <div className="mt-3 grid grid-cols-1 gap-2 text-xs md:grid-cols-3">
                    <div className="rounded-md border border-border/80 p-2">Specs: {experiment.strategy_spec_ids.join(' / ') || 'none'}</div>
                    <div className="rounded-md border border-border/80 p-2">Metrics: {experiment.metrics.join(' / ') || 'none'}</div>
                    <div className="rounded-md border border-border/80 p-2">Can deploy: {String(experiment.approval_gate.can_deploy)}</div>
                  </div>
                  {experiment.review_packet && (
                    <pre className="mt-3 whitespace-pre-wrap rounded-lg border border-border bg-black/20 p-3 text-[11px] leading-relaxed text-muted-foreground">
                      {experiment.review_packet}
                    </pre>
                  )}
                  {experiment.evaluation_plan && (
                    <div className="mt-3 rounded-lg border border-cyan-500/20 bg-cyan-500/5 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-xs font-semibold text-cyan-200">Evaluation Plan: {experiment.evaluation_plan.mode}</div>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={runningExperimentId === experiment.id}
                          onClick={() => runEvaluationPlan(experiment.id)}
                        >
                          {runningExperimentId === experiment.id ? 'Running...' : 'Run Dry-run Plan'}
                        </Button>
                      </div>
                      {experiment.evaluation_plan.warnings.length > 0 && (
                        <div className="mt-1 text-xs text-amber-300">Warnings: {experiment.evaluation_plan.warnings.join(' / ')}</div>
                      )}
                      <div className="mt-2 grid grid-cols-1 gap-2 lg:grid-cols-3">
                        {experiment.evaluation_plan.steps.map((step) => (
                          <div key={step.id} className="rounded-md border border-border/80 bg-background/50 p-2 text-[11px]">
                            <div className="font-semibold">{step.kind}</div>
                            <div className="mt-1 text-muted-foreground">{step.controller_endpoint ?? 'blocked: no safe endpoint'}</div>
                            <div className={step.execution_ready ? 'mt-1 text-emerald-300' : 'mt-1 text-amber-300'}>
                              {step.execution_ready ? 'safe dry-run endpoint' : 'blocked until dry-run endpoint exists'}
                            </div>
                            <div className="mt-1 text-red-300/80">mutation_allowed={String(step.mutation_allowed)}</div>
                            {step.block_reason && <div className="mt-1 text-amber-300/80">{step.block_reason}</div>}
                          </div>
                        ))}
                      </div>
                      {runErrors[experiment.id] && (
                        <div className="mt-2 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-300">
                          {runErrors[experiment.id]}
                        </div>
                      )}
                      {runResults[experiment.id] && (
                        <div className="mt-3 rounded-md border border-border/80 bg-background/50 p-2 text-xs">
                          <div className="font-semibold text-emerald-300">
                            Dry-run result: {runResults[experiment.id].report.verdict}
                          </div>
                          <pre className="mt-2 whitespace-pre-wrap rounded border border-border/70 bg-black/20 p-2 text-[11px] leading-relaxed text-muted-foreground">
                            {runResults[experiment.id].report.review_packet}
                          </pre>
                          <div className="mt-2 grid grid-cols-1 gap-2 lg:grid-cols-3">
                            {runResults[experiment.id].report.results.map((result) => (
                              <div key={result.step_id} className="rounded border border-border/70 p-2">
                                <div className="font-medium">{result.kind}: {result.status}</div>
                                <div className="mt-1 text-muted-foreground">{result.endpoint ?? '-'}</div>
                                {result.reason && <div className="mt-1 text-amber-300">{result.reason}</div>}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {runHistory[experiment.id]?.runs?.[0] && (
                        <div className="mt-3 rounded-md border border-border/80 bg-background/40 p-2 text-xs text-muted-foreground">
                          最近一次 dry-run history：{runHistory[experiment.id].runs[0].created_at} ·
                          {runHistory[experiment.id].runs[0].results.map((result) => `${result.kind}:${result.status}`).join(' / ')}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))
            ) : (
              <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
                目前沒有登錄的 research experiment。P5 的設計是先沉澱 hypothesis / metrics / review packet，再決定是否產生 patch 或 backtest，不直接碰 production。
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  )
}
