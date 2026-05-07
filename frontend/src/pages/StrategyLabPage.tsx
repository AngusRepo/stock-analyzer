import { useEffect, useMemo, useState } from 'react'
import AppShell from '@/components/AppShell'
import {
  strategyLabApi,
  type ResearchEvaluationRunResponse,
  type ResearchEvaluationRunsResponse,
  type ResearchExperimentsResponse,
  type ResearchGateResponse,
  type StrategyDryRunResponse,
  type StrategySpec,
  type StrategySpecsResponse,
} from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { FlaskConical, GitBranch, Loader2, PlayCircle, RefreshCw, ShieldCheck, TestTube2 } from 'lucide-react'

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
          <div className="mt-1 text-[11px] text-slate-500">{spec.id} · {spec.version}</div>
        </div>
        <Badge variant="outline" className={spec.validation.ok ? 'border-emerald-500/25 text-emerald-300' : 'border-red-500/30 text-red-300'}>
          {spec.validation.ok ? 'contract ok' : 'contract fail'}
        </Badge>
      </div>

      <p className="mt-3 text-sm leading-relaxed text-slate-300">{spec.thesis}</p>

      <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
        <div className="rounded-xl border border-slate-800 bg-black/20 p-3">
          <div className="text-slate-500">Dry-run 命中</div>
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
                <FlaskConical className="h-5 w-5 text-amber-300" /> 策略實驗室
              </h1>
              <p className="mt-2 max-w-4xl text-sm leading-relaxed text-slate-300">
                這裡不是 production 控制台，而是把假說、策略規格、乾跑證據、review packet 與安全 gate 串成一條研究流水線。
                研究可以產出 evidence，但不能直接 retrain、promote、deploy 或下單。
              </p>
            </div>
            <Button size="sm" variant="outline" className="rounded-full border-amber-400/30 text-amber-200" onClick={() => { setRefreshing(true); load() }}>
              <RefreshCw className={`mr-1 h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} /> 重新整理
            </Button>
          </div>
        </div>

        {error && (
          <Card className="border-red-500/30">
            <CardContent className="p-4 text-sm text-red-300">{error}</CardContent>
          </Card>
        )}

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          {[
            ['策略規格', stats.strategyCount, specs?.version ?? 'strategy-spec-v1'],
            ['乾跑命中', stats.dryRunMatches, dryRun?.source ?? '-'],
            ['研究案例', experiments?.experiments.length ?? 0, experiments?.mode ?? 'read_only'],
            ['允許動作', stats.safeGateCount, 'hypothesis / dry-run'],
            ['禁止動作', stats.blockedGateCount, 'deploy / trade'],
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

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.35fr_0.65fr]">
          <Card className="border-slate-800 bg-slate-950/70">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <GitBranch className="h-4 w-4 text-cyan-300" /> 策略規格與乾跑證據
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
                  <TestTube2 className="h-4 w-4 text-amber-300" /> 新增研究假說
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <textarea
                  value={draftHypothesis}
                  onChange={(event) => setDraftHypothesis(event.target.value)}
                  placeholder="例：突破 / 波動擴張 bucket 在 bull + liquidity normal regime 是否能提高 T+5 hit rate，同時不提高 MDD?"
                  className="min-h-24 w-full rounded-xl border border-slate-800 bg-black/30 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-400/50"
                />
                <input value={draftSpecIds} onChange={(event) => setDraftSpecIds(event.target.value)} className="w-full rounded-xl border border-slate-800 bg-black/30 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-400/50" placeholder="strategy spec ids" />
                <input value={draftMetrics} onChange={(event) => setDraftMetrics(event.target.value)} className="w-full rounded-xl border border-slate-800 bg-black/30 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-400/50" placeholder="metrics" />
                <input value={draftFollowUp} onChange={(event) => setDraftFollowUp(event.target.value)} className="w-full rounded-xl border border-slate-800 bg-black/30 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-400/50" placeholder="follow-up" />
                <Button size="sm" variant="outline" disabled={draftSaving || draftHypothesis.trim().length < 12} onClick={previewExperiment}>
                  {draftSaving ? 'Previewing...' : '產生 Dry-run Review Packet'}
                </Button>
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
                目前沒有研究實驗紀錄。先用上方假說產生 dry-run review packet，通過 gate 後才進 backtest / walk-forward / PBO。
              </div>
            )}
            {(experiments?.experiments ?? []).map((experiment) => (
              <div key={experiment.id} className="rounded-2xl border border-slate-800 bg-black/20 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-semibold text-slate-100">{experiment.id}</div>
                    <div className="mt-1 text-xs text-slate-500">updated {experiment.updated_at}</div>
                  </div>
                  <Badge variant="outline" className={statusClass(experiment.status)}>{experiment.status}</Badge>
                </div>
                <p className="mt-3 text-sm leading-relaxed text-slate-300">{experiment.hypothesis}</p>
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
                        latest dry-run: {runHistory[experiment.id].runs[0].created_at} · {runHistory[experiment.id].runs[0].verdict}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  )
}
