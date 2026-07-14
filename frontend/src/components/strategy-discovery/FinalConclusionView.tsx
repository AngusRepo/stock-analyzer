import type { FinalConclusion } from '@/lib/strategyDiscoveryViewModel'

function value(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'UNKNOWN'
  if (typeof value === 'boolean') return value ? 'YES' : 'NO'
  if (typeof value === 'object') return 'STRUCTURED'
  return String(value)
}

function DisplayValue({ item, depth = 0 }: { item: unknown; depth?: number }) {
  if (Array.isArray(item)) {
    if (!item.length) return <span className="text-slate-600">NONE</span>
    return <ul className="space-y-1.5">{item.map((child, index) => <li key={index} className={depth ? 'border-l border-white/10 pl-2' : ''}><DisplayValue item={child} depth={depth + 1} /></li>)}</ul>
  }
  if (item && typeof item === 'object') {
    return <dl className="grid gap-1.5">{Object.entries(item as Record<string, unknown>).map(([key, child]) => <div key={key} className="grid grid-cols-[minmax(90px,0.35fr)_1fr] gap-2"><dt className="font-mono text-[9px] uppercase tracking-[0.1em] text-slate-600">{key.split('_').join(' ')}</dt><dd className="min-w-0 break-words"><DisplayValue item={child} depth={depth + 1} /></dd></div>)}</dl>
  }
  return <span>{value(item)}</span>
}

function RecordRows({ rows, empty = '尚無資料' }: { rows: Array<Record<string, unknown>>; empty?: string }) {
  if (!rows.length) return <p className="text-sm text-slate-500">{empty}</p>
  return <div className="divide-y divide-white/[0.07]">{rows.map((row, index) => (
    <article key={String(row.strategy_id ?? row.candidate_id ?? row.model_id ?? row.command ?? index)} className="py-4 [content-visibility:auto]">
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2 xl:grid-cols-3">
        {Object.entries(row).map(([key, item]) => <div key={key} className="min-w-0"><dt className="font-mono text-[9px] uppercase tracking-[0.14em] text-slate-600">{key.split('_').join(' ')}</dt><dd className="mt-1 break-words text-xs leading-5 text-slate-300"><DisplayValue item={item} /></dd></div>)}
      </dl>
    </article>
  ))}</div>
}

function Section({ index, title, children }: { index: string; title: string; children: React.ReactNode }) {
  return <section className="border-t border-white/10 py-8"><div className="grid gap-5 lg:grid-cols-[180px_1fr]"><div><span className="font-mono text-[10px] tracking-[0.22em] text-cyan-300">{index}</span><h3 className="mt-2 font-['Outfit'] text-xl font-semibold">{title}</h3></div><div>{children}</div></div></section>
}

export function FinalConclusionView({ conclusion }: { conclusion: FinalConclusion }) {
  const executive = conclusion.executive_conclusion
  const remaining = conclusion.remaining_uncertainty
  return (
    <section aria-labelledby="final-conclusion-title" className="border border-cyan-300/20 bg-[#0d1015] px-5 sm:px-8">
      <header className="py-8"><p className="font-mono text-[10px] uppercase tracking-[0.26em] text-cyan-300">Repository-backed verdict</p><h2 id="final-conclusion-title" className="mt-2 font-['Outfit'] text-3xl font-semibold">Codex 最終結論</h2><p className="mt-3 break-all font-mono text-[10px] text-slate-600">RUN {conclusion.run_id} · BUNDLE {conclusion.bundle_hash}</p></header>
      <Section index="01" title="Executive Conclusion"><div className="grid gap-px bg-white/10 sm:grid-cols-2 xl:grid-cols-4"><div className="bg-[#11151b] p-4"><p className="text-[10px] text-slate-500">整體健康度</p><p className="mt-2 text-sm text-slate-100">{value(executive.overall_health)}</p></div><div className="bg-[#11151b] p-4"><p className="text-[10px] text-slate-500">Confirmed leakage</p><p className="mt-2 text-sm text-slate-100">{value(executive.confirmed_leakage)}</p></div><div className="bg-[#11151b] p-4"><p className="text-[10px] text-slate-500">INVALID</p><p className="mt-2 font-mono text-xl text-red-200">{executive.invalid_strategy_count}</p></div><div className="bg-[#11151b] p-4"><p className="text-[10px] text-slate-500">Locked Test</p><p className="mt-2 font-mono text-xl text-emerald-200">{executive.locked_test_candidate_count}</p></div></div><p className="mt-5 text-sm leading-7 text-slate-300">{value(executive.summary)}</p><p className="mt-3 border-l-2 border-red-400/60 pl-4 text-sm text-red-200">最嚴重問題：{value(executive.most_severe_issue)}</p></Section>
      <Section index="02" title="現有策略"><RecordRows rows={conclusion.existing_strategies} /></Section>
      <Section index="03" title="新候選"><RecordRows rows={conclusion.new_candidates} /></Section>
      <Section index="04" title="Red Team Accuracy"><RecordRows rows={conclusion.red_team_accuracy} /></Section>
      <Section index="05" title="Tests"><RecordRows rows={conclusion.tests} /></Section>
      <Section index="06" title="Remaining Uncertainty"><div className="grid gap-5 md:grid-cols-2">{Object.entries(remaining).map(([key, items]) => <div key={key} className="border-l border-white/10 pl-4"><p className="font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">{key.split('_').join(' ')}</p><div className="mt-3 text-sm text-slate-300"><DisplayValue item={items} /></div></div>)}</div></Section>
    </section>
  )
}
