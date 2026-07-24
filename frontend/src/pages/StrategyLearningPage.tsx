import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import AppShell from '@/components/AppShell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { strategyLabApi, type StrategyLearningResponse, type StrategyPromotionGate } from '@/lib/api'

type LearningRow = StrategyLearningResponse['specs'][number]

function pct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(Number(value))) return '-'
  return `${(Number(value) * 100).toFixed(1)}%`
}

function statusClass(status: string): string {
  if (status === 'active' || status === 'active_monitor' || status === 'learning') return 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200'
  if (status === 'shadow' || status === 'candidate' || status === 'candidate_ready') return 'border-cyan-400/30 bg-cyan-400/10 text-cyan-200'
  if (status === 'research' || status === 'not_ready' || status === 'no_reward') return 'border-amber-400/30 bg-amber-400/10 text-amber-200'
  return 'border-slate-600 bg-slate-800/50 text-slate-300'
}

function StrategyLedgerGroup({
  title,
  description,
  rows,
  gateById,
  policyWeights,
  empty,
}: {
  title: string
  description: string
  rows: LearningRow[]
  gateById: Map<string, StrategyPromotionGate>
  policyWeights: Record<string, number>
  empty: string
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950/70">
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-800 px-4 py-4 lg:px-5">
        <div>
          <h2 className="font-['Space_Grotesk'] text-lg font-semibold text-slate-100">{title}</h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-500">{description}</p>
        </div>
        <Badge variant="outline" className="border-slate-700 bg-slate-900 text-slate-300">{rows.length} strategies</Badge>
      </header>

      <div className="divide-y divide-slate-900">
        {rows.map((row) => {
          const gate = gateById.get(`${row.id}:${row.version}`)
          const weight = Number(policyWeights[row.id] ?? 0)
          const evidence = gate?.missing_evidence ?? []
          return (
            <article key={`${row.id}:${row.version}`} className="grid gap-4 px-4 py-4 lg:px-5 xl:grid-cols-[minmax(220px,1.25fr)_150px_210px_minmax(190px,0.85fr)_minmax(230px,1fr)] xl:items-center">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="truncate text-sm font-semibold text-slate-100">{row.name}</h3>
                  <Badge variant="outline" className={statusClass(row.status)}>{row.status}</Badge>
                  <Badge variant="outline" className={statusClass(row.learning.status)}>{row.learning.status}</Badge>
                </div>
                <p className="mt-1 truncate font-mono text-xs text-slate-500">{row.id} · {row.alphaBucket}</p>
              </div>

              <dl className="grid grid-cols-2 gap-2 text-xs xl:grid-cols-1">
                <div><dt className="text-slate-500">Decisions</dt><dd className="mt-1 font-mono text-sm text-slate-200">{row.learning.decisions}</dd></div>
                <div><dt className="text-slate-500">Reward samples</dt><dd className="mt-1 font-mono text-sm text-slate-200">{row.learning.samples}</dd></div>
              </dl>

              <dl className="grid grid-cols-3 gap-3 text-xs">
                <div><dt className="text-slate-500">Hit rate</dt><dd className="mt-1 font-mono text-sm text-cyan-200">{pct(row.learning.hit_rate)}</dd></div>
                <div><dt className="text-slate-500">Avg return</dt><dd className={`mt-1 font-mono text-sm ${Number(row.learning.avg_return_pct ?? 0) >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{pct(row.learning.avg_return_pct)}</dd></div>
                <div><dt className="text-slate-500">MDD</dt><dd className="mt-1 font-mono text-sm text-amber-200">{pct(row.learning.max_drawdown_pct)}</dd></div>
              </dl>

              <div>
                <div className="flex justify-between gap-3 text-xs text-slate-500"><span>Policy weight</span><span className="font-mono text-slate-300">{pct(weight)}</span></div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-800">
                  <div className="h-full bg-emerald-300" style={{ width: `${Math.max(0, Math.min(100, weight * 100))}%` }} />
                </div>
              </div>

              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className={statusClass(gate?.decision ?? 'not_ready')}>{gate?.decision ?? 'not_ready'}</Badge>
                  <span className="text-xs text-slate-500">{gate?.current_stage ?? 'L0_hypothesis'} → {gate?.recommended_stage ?? gate?.recommended_next_status ?? 'shadow'}</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {(evidence.length ? evidence : ['evidence ready']).slice(0, 3).map((item) => (
                    <span key={item} className={`rounded-md border px-2 py-1 text-xs ${evidence.length ? 'border-amber-400/20 bg-amber-400/[0.06] text-amber-200' : 'border-emerald-400/20 bg-emerald-400/[0.06] text-emerald-200'}`}>{item.replace(/_/g, ' ')}</span>
                  ))}
                </div>
              </div>
            </article>
          )
        })}
        {!rows.length && <div className="px-5 py-8 text-sm text-slate-500">{empty}</div>}
      </div>
    </section>
  )
}

export default function StrategyLearningPage() {
  const [learning, setLearning] = useState<StrategyLearningResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setError(null)
      setLearning(await strategyLabApi.learning())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Strategy reward ledger 載入失敗')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const visibleRows = useMemo(() => (learning?.specs ?? []).filter((row) => row.status !== 'retired'), [learning])
  const activeRows = useMemo(() => visibleRows.filter((row) => row.status === 'active'), [visibleRows])
  const learningRows = useMemo(() => visibleRows.filter((row) => row.status === 'research' || row.status === 'shadow' || row.status === 'candidate'), [visibleRows])
  const gateById = useMemo(() => new Map((learning?.promotion_gate ?? []).map((gate) => [`${gate.strategy_id}:${gate.strategy_version}`, gate])), [learning])
  const totals = useMemo(() => visibleRows.reduce((acc, row) => ({ decisions: acc.decisions + row.learning.decisions, samples: acc.samples + row.learning.samples }), { decisions: 0, samples: 0 }), [visibleRows])
  const policy = learning?.policy_state_preview

  async function runAction(key: string, action: () => Promise<unknown>, success: string) {
    try {
      setBusy(key)
      setError(null)
      setResult(null)
      await action()
      setResult(success)
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `${key} failed`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <AppShell>
      <main className="space-y-5 p-4 lg:p-6">
        <header className="flex flex-col gap-4 rounded-3xl border border-emerald-400/15 bg-[radial-gradient(circle_at_14%_15%,rgba(52,211,153,0.12),transparent_30%),linear-gradient(135deg,#101714,#0b0f14_68%)] p-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-semibold tracking-[0.14em] text-emerald-300">STRATEGY LEARNING</p>
            <h1 className="mt-2 flex items-center gap-2 font-['Space_Grotesk'] text-2xl font-semibold tracking-tight text-slate-50"><Activity className="h-5 w-5 text-emerald-300" /> Learning + Reward Ledger</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">只保留後驗學習、reward evidence、shadow policy weight 與 promotion readiness；不在此頁重複實驗、模型或 dry-run 操作。</p>
          </div>
          <Button size="sm" variant="outline" className="rounded-full border-emerald-400/25 text-emerald-200" disabled={refreshing} onClick={() => { setRefreshing(true); void load() }}>
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} /> Refresh ledger
          </Button>
        </header>

        {loading ? (
          <div className="flex items-center gap-2 rounded-2xl border border-slate-800 bg-slate-950/70 p-5 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" /> Loading reward ledger...</div>
        ) : (
          <>
            <section className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4"><div className="text-xs text-slate-500">Active strategies</div><div className="mt-2 font-mono text-2xl text-emerald-200">{activeRows.length}</div></div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4"><div className="text-xs text-slate-500">Learning + shadowing</div><div className="mt-2 font-mono text-2xl text-cyan-200">{learningRows.length}</div></div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4"><div className="text-xs text-slate-500">Decision / reward rows</div><div className="mt-2 font-mono text-2xl text-slate-100">{totals.decisions} / {totals.samples}</div></div>
              <div className="rounded-xl border border-emerald-400/20 bg-emerald-400/[0.06] p-4"><div className="text-xs text-slate-400">Adaptive policy</div><div className="mt-2 flex items-center gap-2 font-mono text-lg text-emerald-100"><ShieldCheck className="h-4 w-4" /> {policy?.status ?? 'shadow'}</div><div className="mt-1 text-xs text-slate-500">production effect false</div></div>
            </section>

            {error && <div className="rounded-xl border border-rose-400/25 bg-rose-400/[0.06] p-4 text-sm text-rose-200">{error}</div>}
            {result && <div className="rounded-xl border border-emerald-400/25 bg-emerald-400/[0.06] p-4 text-sm text-emerald-200">{result}</div>}

            <StrategyLedgerGroup
              title="Active strategies"
              description="目前 production active 的策略。Reward ledger 用來監控已上線策略，不在此頁改變 production allocation。"
              rows={activeRows}
              gateById={gateById}
              policyWeights={policy?.strategy_weights ?? {}}
              empty="目前沒有 active strategy reward rows。"
            />
            <StrategyLedgerGroup
              title="Learning + shadowing strategies"
              description="Research、shadow 與 candidate 策略集中在這裡，依 reward samples 與 evidence gap 決定是否繼續學習。"
              rows={learningRows}
              gateById={gateById}
              policyWeights={policy?.strategy_weights ?? {}}
              empty="目前沒有 learning、shadow 或 candidate strategy rows。"
            />

            <footer className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
              <p className="max-w-2xl text-xs leading-5 text-slate-500">Decision log → verify/paper outcome → reward ledger → adaptive shadow policy。這些操作不直接下單，也不改模型 vote。</p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" disabled={busy != null} onClick={() => void runAction('decision log', () => strategyLabApi.materializeDecisionLog({ limit: 500, dry_run: false, confirm: true }), 'Decision log 已更新。')}>Materialize decision log</Button>
                <Button size="sm" variant="outline" disabled={busy != null} onClick={() => void runAction('reward ledger', () => strategyLabApi.refreshStrategyRewardLedger({ limit: 5000, dry_run: false, confirm: true }), 'Reward ledger 已更新。')}>Refresh reward ledger</Button>
                <Button size="sm" variant="outline" disabled={busy != null} onClick={() => void runAction('shadow policy', () => strategyLabApi.refreshStrategyPolicyState({ dry_run: false, confirm: true }), 'Adaptive shadow policy 已更新。')}>Refresh shadow policy</Button>
              </div>
            </footer>
          </>
        )}
      </main>
    </AppShell>
  )
}
