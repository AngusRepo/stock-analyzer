import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Cpu, Database, Fingerprint, ShieldCheck } from 'lucide-react'
import AppShell from '@/components/AppShell'
import { AnalysisButton } from '@/components/strategy-discovery/AnalysisButton'
import { AnalysisProgress } from '@/components/strategy-discovery/AnalysisProgress'
import { CodexConclusionButton } from '@/components/strategy-discovery/CodexConclusionButton'
import { CodexPanel } from '@/components/strategy-discovery/CodexPanel'
import { FinalConclusionView } from '@/components/strategy-discovery/FinalConclusionView'
import { strategyDiscoveryApi } from '@/lib/strategyDiscoveryApi'
import type { DashboardState, FinalConclusion } from '@/lib/strategyDiscoveryViewModel'
import { isRunPolling } from '@/lib/strategyDiscoveryViewModel'

export default function StrategyDiscoveryPage() {
  const [state, setState] = useState<DashboardState | null>(null)
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const [conclusion, setConclusion] = useState<FinalConclusion | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try { setState(await strategyDiscoveryApi.dashboard()); setError(null) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    if (!isRunPolling(state)) return
    const timer = window.setInterval(() => void refresh(), 5_000)
    return () => window.clearInterval(timer)
  }, [state?.analysis_button.state, state?.latest_run?.run_id, refresh])

  const start = async () => {
    setStarting(true)
    setError(null)
    try { await strategyDiscoveryApi.start(`analysis:${crypto.randomUUID()}`); await refresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setStarting(false) }
  }

  const openCodex = async () => {
    if (!state?.latest_run) return
    if (state.codex_button.state !== 'RESULT_READY') { setPanelOpen((current) => !current); return }
    setLoading(true)
    setError(null)
    try { setConclusion(await strategyDiscoveryApi.conclusion(state.latest_run.run_id)); setPanelOpen(false) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setLoading(false) }
  }

  const importResult = async (file: File) => {
    if (!state?.codex_handoff) return
    setImporting(true)
    setImportError(null)
    try {
      await strategyDiscoveryApi.importCodexResult(state.codex_handoff.run_id, file, `codex-import:${crypto.randomUUID()}`)
      await refresh()
      setConclusion(await strategyDiscoveryApi.conclusion(state.codex_handoff.run_id))
      setPanelOpen(false)
    } catch (cause) { setImportError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setImporting(false) }
  }

  const snapshot = state?.current_snapshot
  const run = state?.latest_run
  return (
    <AppShell>
      <div className="relative min-h-screen bg-[#090a0d] pb-24 pt-24">
        <div className="pointer-events-none absolute inset-x-0 top-20 h-px bg-amber-300/30" />
        <main className="relative mx-auto w-full max-w-[1480px] px-4 sm:px-7 lg:px-10">
          <header className="grid gap-8 border-b border-white/10 py-10 lg:grid-cols-[1fr_420px] lg:items-end">
            <div><div className="flex items-center gap-3"><span className="h-2 w-2 bg-amber-300 shadow-[0_0_16px_rgba(252,211,77,0.8)]" /><p className="font-mono text-[10px] uppercase tracking-[0.28em] text-amber-200">Adversarial audit control room</p></div><h1 className="mt-5 max-w-4xl font-['Outfit'] text-4xl font-semibold tracking-[-0.04em] text-white sm:text-6xl">Strategy Discovery<br /><span className="text-slate-500">Evidence before confidence.</span></h1><p className="mt-5 max-w-2xl text-sm leading-7 text-slate-400">以 formal137 與目前 Active13 快照驅動持久化 Multi-LLM workflow；所有結論在 Codex repository evidence 審判前都不是 Alpha 證明。</p></div>
            <div className="grid grid-cols-2 gap-px border border-white/10 bg-white/10 text-xs"><div className="bg-[#101116] p-4"><Database className="h-4 w-4 text-amber-200" /><p className="mt-4 text-slate-500">Feature pool</p><p className="mt-1 font-mono text-lg text-slate-100">{snapshot?.feature_count ?? '—'}</p></div><div className="bg-[#101116] p-4"><ShieldCheck className="h-4 w-4 text-cyan-200" /><p className="mt-4 text-slate-500">Active strategies</p><p className="mt-1 font-mono text-lg text-slate-100">{snapshot?.strategy_count ?? '—'}</p></div><div className="bg-[#101116] p-4"><Cpu className="h-4 w-4 text-emerald-200" /><p className="mt-4 text-slate-500">Safe neurons</p><p className="mt-1 font-mono text-lg text-slate-100">{state?.workers_ai.safe_remaining_neurons ?? '—'}</p></div><div className="bg-[#101116] p-4"><Fingerprint className="h-4 w-4 text-violet-200" /><p className="mt-4 text-slate-500">Snapshot</p><p className="mt-1 truncate font-mono text-[11px] text-slate-300">{snapshot?.snapshot_hash ?? 'UNKNOWN'}</p></div></div>
          </header>

          <section className="py-8" aria-label="主要操作">
            <div className="flex flex-col gap-3 sm:flex-row">
              <AnalysisButton enabled={state?.analysis_button.enabled ?? false} state={state?.analysis_button.state ?? 'BLOCKED'} pending={starting} onClick={() => void start()} />
              <CodexConclusionButton enabled={state?.codex_button.enabled ?? false} state={state?.codex_button.state ?? 'NOT_READY'} pending={loading && Boolean(state)} onClick={() => void openCodex()} />
            </div>
            <div className="mt-3 grid gap-2 text-xs text-slate-500 sm:grid-cols-2"><p>{loading && !state ? '讀取後端真實狀態…' : state?.analysis_button.message ?? '狀態不可用'}</p><p>{state?.codex_button.message ?? '請先完成完整分析'}</p></div>
          </section>

          {run && state?.analysis_button.state === 'RUNNING' && <AnalysisProgress run={run} />}
          {(error || state?.blockers.length || state?.warnings.length) ? <section className="my-7 grid gap-3 lg:grid-cols-2">{(error ? [error] : state?.blockers ?? []).map((item) => <p key={item} className="border-l-2 border-red-400 bg-red-400/5 px-4 py-3 text-sm text-red-200"><AlertTriangle className="mr-2 inline h-4 w-4" />{item}</p>)}{state?.warnings.map((item) => <p key={item} className="border-l-2 border-amber-300/60 bg-amber-300/5 px-4 py-3 text-sm text-amber-100">{item}</p>)}</section> : null}

          {panelOpen && state?.codex_handoff && <CodexPanel handoff={state.codex_handoff} importing={importing} error={importError} onImport={(file) => void importResult(file)} />}
          {conclusion && <FinalConclusionView conclusion={conclusion} />}

          <footer className="mt-12 grid gap-4 border-t border-white/10 py-6 font-mono text-[10px] uppercase tracking-[0.12em] text-slate-600 sm:grid-cols-3"><span>Run {run?.run_id ?? 'NONE'}</span><span>State {run?.status ?? 'READY'}</span><span className="sm:text-right">No deploy · No trading · Fail closed</span></footer>
        </main>
      </div>
    </AppShell>
  )
}
