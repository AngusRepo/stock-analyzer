import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { researchValidationApi } from '@/lib/api'
import { Button } from '@/components/ui/button'

function metric(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(3) : '缺少證據'
}

const inputClass = 'rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200'

export default function ResearchValidationWorkbench() {
  // 管理員端點：進頁不自動打，按「載入驗證報告」才讀（區塊本身一直顯示，不是收合）。
  const [loaded, setLoaded] = useState(false)
  const [runKey, setRunKey] = useState('')
  const [candidateId, setCandidateId] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [symbols, setSymbols] = useState('2330,0050')
  const [busy, setBusy] = useState(false)
  const [audit, setAudit] = useState<any>(null)
  const [error, setError] = useState('')
  const canonical = useQuery({ queryKey: ['research-canonical-serving-bundle'], queryFn: researchValidationApi.productionBundle, enabled: loaded })
  const runs = useQuery({ queryKey: ['research-trial-runs'], queryFn: researchValidationApi.runs, enabled: loaded })
  const report = useQuery({ queryKey: ['research-trial-run', runKey], queryFn: () => researchValidationApi.run(runKey), enabled: loaded && !!runKey })
  const drift = useQuery({ queryKey: ['research-bundle-drift', audit?.run_key], queryFn: () => researchValidationApi.bundle(audit.run_key), enabled: !!audit?.run_key })
  const trials: any[] = report.data?.trials ?? []
  const robust = report.data?.robustness
  async function runAudit() {
    setBusy(true); setError(''); setAudit(null)
    try {
      setAudit(await researchValidationApi.causal({ candidate_id: candidateId, start_date: start, end_date: end, symbols: symbols.split(',').map(s => s.trim()).filter(Boolean) }))
      void runs.refetch()
    } catch (e) { setError(e instanceof Error ? e.message : '檢查未完成') }
    finally { setBusy(false) }
  }
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-950/70 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5"><span className="font-semibold text-slate-100">研究驗證工作台</span><span className="text-xs text-slate-400">搜尋歷史 · 參數穩健區域 · 前視檢查 · 版本漂移</span></h2>
        <Button size="sm" variant="outline" disabled={loaded && (canonical.isFetching || runs.isFetching)} onClick={() => { if (loaded) { void canonical.refetch(); void runs.refetch() } else setLoaded(true) }}>
          {!loaded ? '載入驗證報告' : canonical.isFetching || runs.isFetching ? '讀取中…' : '重新讀取'}
        </Button>
      </div>
      <div className="mt-5 space-y-5">
        <p className="text-sm leading-6 text-amber-200">歷史紀錄只證明已保留的候選。缺少 trial、日期、樣本或成本壓力測試時，會顯示不足；工作台不直接批准策略或下單。</p>
        {runs.isError && <p role="alert" className="text-sm text-fail">研究帳本無法讀取，請確認管理員權限與服務狀態。</p>}
        <div className="rounded-xl border border-slate-800 p-4">
          <h3 className="font-medium text-slate-200">正式完整策略 / 模型 bundle</h3>
          <p className="mt-2 text-sm text-slate-400">來源為既有不可變 Active-8 authority，核對實際模型 artifact、ensemble 係數、策略、參數、資料語意、費用與 native 執行指紋。</p>
          <p className="mt-2 text-sm text-slate-300">{!loaded ? '尚未載入；按右上「載入驗證報告」讀取。' : canonical.isError ? '無法驗證正式來源' : `${canonical.data?.status ?? '讀取中…'} · ${canonical.data?.adoption_basis ?? ''} · ${canonical.data?.efficacy_status ?? ''}`}</p>
          <ul className="mt-2 text-xs text-fail">{(canonical.data?.drift_fields ?? []).map((f: any) => <li key={f.field}>{f.field}</li>)}</ul>
          {canonical.data && <div className="mt-2 border-t border-slate-800 pt-2 text-xs text-slate-400"><p className="font-medium text-slate-300">模型、係數與版本來源</p><pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(canonical.data, null, 2)}</pre></div>}
          <p className="mt-2 text-xs text-amber-200">版本一致不代表已證實獲利；升級與退出仍由原有 NAV / 風控流程決定。</p>
        </div>
        <label className="block text-sm text-slate-300">研究 run
          <select className={`${inputClass} mt-2 w-full`} value={runKey} onChange={e => setRunKey(e.target.value)} disabled={!loaded}>
            <option value="">{loaded ? '選擇研究紀錄' : '先載入驗證報告'}</option>
            {(runs.data?.runs ?? []).map((r: any) => <option key={r.run_key} value={r.run_key}>{r.run_key} · {r.states.join(' / ')}</option>)}
          </select>
        </label>
        {report.isLoading && <p className="text-sm text-slate-400">讀取不可變來源與 trial…</p>}
        {report.isError && <p role="alert" className="text-sm text-fail">來源驗證失敗或帳本不可用；未產生判定。</p>}
        {report.data && <>
          <div className="flex flex-wrap gap-5 text-sm text-slate-300">
            <span>已知候選 <strong>{report.data.known_trial_count}</strong></span>
            <span>來源觀察 <strong>{report.data.observation_count}</strong></span>
            <span>搜尋覆蓋 <strong className="text-amber-200">{report.data.coverage}</strong></span>
            <span>參數衝突 <strong>{report.data.parameter_conflicts.length}</strong></span>
          </div>
          <div className="rounded-xl border border-slate-800 p-4">
            <h3 className="font-medium text-slate-200">最佳點附近是否也有好結果</h3>
            <p className="mt-2 text-sm text-slate-400">以驗證期鄰域的較差四分位評估平台。Holdout 只供查看，不參與選參數。至少需要 {robust?.minimum_neighbors ?? 5} 個同資料、同成本、同窗口鄰居。</p>
            <p className="mt-2 text-sm text-amber-200">{robust?.recommended_for_review ? `可優先審閱：${robust.recommended_for_review}（仍是診斷）` : '尚無可驗證的穩健平台，需補鄰域評估。'}</p>
            <pre className="mt-2 whitespace-pre-wrap break-all text-xs text-slate-400">目前參數位置：{JSON.stringify(robust?.current_parameters ?? {})}</pre>
          </div>
          <div>
            <table className="sv-stack-table w-full text-left text-xs">
              <thead className="bg-slate-950 text-slate-400"><tr>{['Trial / 狀態', '參數', '驗證 Sharpe', 'Holdout Sharpe', '鄰域 / 現行距離', '成本 / 樣本 / 缺件'].map(h => <th key={h} className="p-2">{h}</th>)}</tr></thead>
              <tbody>{trials.map(t => {
                const neighbor = robust?.rows?.find((r: any) => r.trial_id === t.trial_id)
                return <tr key={t.trial_id} className="border-t border-slate-800 text-slate-300">
                  <td data-label="Trial / 狀態" className="p-2 align-top"><div>{t.trial_id}</div><div className="text-muted-foreground">{t.state}</div><div className="mt-1 text-[11px] text-muted-foreground [overflow-wrap:anywhere]">來源 {t.source.pointer}<br />收據 {t.receipt_id}</div></td>
                  <td data-label="參數" className="sv-stack-wide p-2 align-top md:max-w-60"><code className="break-all">{JSON.stringify(t.parameters ?? '原始參數缺失')}</code></td>
                  <td data-label="驗證 Sharpe" className="p-2 align-top">{metric(t.validation?.sharpe)}</td><td data-label="Holdout Sharpe" className="p-2 align-top">{metric(t.holdout?.sharpe)}</td>
                  <td data-label="鄰域 / 現行距離" className="p-2 align-top">{neighbor?.neighbor_count ?? 0} / {metric(neighbor?.current_distance)}<br />較差四分位 {metric(neighbor?.neighbor_lower_quartile)}</td>
                  <td data-label="成本 / 樣本 / 缺件" className="sv-stack-wide p-2 align-top md:max-w-64">{JSON.stringify(t.cost)}<br />樣本 {t.sample_count ?? '未保留'}<br />成本壓力測試 {neighbor?.cost_stress ? '有紀錄' : '缺少證據'}<br /><span className="text-amber-200">{t.gaps.join(', ')}</span></td>
                </tr>
              })}</tbody>
            </table>
          </div>
        </>}
        <div className="rounded-xl border border-slate-800 p-4">
          <h3 className="font-medium text-slate-200">固定快照的前視檢查</h3>
          <p className="mt-2 text-sm leading-6 text-slate-400">重跑、截斷未來、擾動未來資料，檢查較早的決策是否改變。目前支援 Mode A 的執行邏輯；上游已算好的指標與 Mode B 模型輸入仍需獨立驗證。</p>
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            <input aria-label="候選 ID" placeholder="parameter candidate ID" value={candidateId} onChange={e => setCandidateId(e.target.value)} className={inputClass} />
            <input aria-label="股票代號" placeholder="股票代號，逗號分隔（最多 50）" value={symbols} onChange={e => setSymbols(e.target.value)} className={inputClass} />
            <label className="text-xs text-slate-400">開始日期<input type="date" value={start} onChange={e => setStart(e.target.value)} className={`${inputClass} ml-2`} /></label>
            <label className="text-xs text-slate-400">結束日期<input type="date" value={end} onChange={e => setEnd(e.target.value)} className={`${inputClass} ml-2`} /></label>
          </div>
          <Button className="mt-3" variant="outline" disabled={busy || !candidateId || !start || !end} onClick={() => void runAudit()}>{busy ? '固定快照重播中…' : '執行檢查並封存證據'}</Button>
          {error && <p role="alert" className="mt-2 text-sm text-fail">{error}</p>}
          {audit && <div className="mt-3 space-y-3 text-sm text-slate-300">
            <p>前視檢查：<strong>{audit.causal_audit.status}</strong> · {audit.causal_audit.reason}</p>
            <p>過去決策樣本 {audit.causal_audit.decision_samples ?? 0}；尚未驗證上游指標重算。</p>
            <table className="sv-stack-table w-full text-left text-xs"><thead><tr><th>檢查</th><th>截止日期</th><th>過去決策一致</th></tr></thead><tbody>{(audit.causal_audit.checks ?? []).map((c: any) => <tr key={`${c.kind}:${c.cutoff}`}><td data-label="檢查" className="py-1">{c.kind}</td><td data-label="截止日期">{c.cutoff}</td><td data-label="過去決策一致">{c.passed ? '是' : '否'}</td></tr>)}</tbody></table>
            <div className="border-t border-slate-800 pt-3"><h4>整份驗證 bundle 的版本漂移</h4><p className="mt-1 text-slate-400">策略、模型、參數、資料語意、成本、執行版本逐項比對。每日新增資料不會單獨判定為漂移。</p>
              <p className="mt-2">{drift.isError ? '無法驗證現行版本' : drift.data?.drift?.status ?? '讀取現行版本中…'}</p>
              <ul className="mt-1">{(drift.data?.drift?.fields ?? []).map((f: any) => <li key={f.component} className="text-fail">{f.component} 已改變</li>)}</ul>
              <div className="mt-2 border-t border-slate-800 pt-2"><p className="font-medium text-slate-300">不可變證據與全部版本</p><pre className="mt-1 whitespace-pre-wrap break-all text-xs text-slate-400">{JSON.stringify({ receipt_id: audit.receipt_id, bundle: audit.validation_bundle, drift: drift.data?.drift }, null, 2)}</pre></div>
            </div>
          </div>}
        </div>
      </div>
    </section>
  )
}
