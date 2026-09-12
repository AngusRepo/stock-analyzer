import type { PairedNavShadowReadModel } from '@/lib/pipelineMaturityContract'

const STATUS: Record<PairedNavShadowReadModel['status'], string> = {
  awaiting_allocation_context: '尚無配置封存',
  awaiting_execution_pairs: '配置已封存，尚缺完整配對執行',
  observing: '配對 NAV 累積中',
  valuation_incomplete: '帳務持續記錄，績效區間尚未完整驗證',
  terminal_zero_nav: '已記錄淨值歸零，並非缺少資料',
  historical_comparisons: '歷史比較已封存，等待新配對執行證據',
  unavailable: '資料無法驗證',
}

const REASONS: Record<string, string> = {
  paired_nav_migration_0040_missing: 'Learning 資料表尚未建立（migration 0040）。',
  paired_nav_migration_0043_missing: '候選生命週期資料表尚未建立（migration 0043）。',
  paired_nav_read_or_identity_failed: '讀取失敗或配對版本不一致；不是零筆資料。',
  paired_execution_evidence_missing: '尚未收到候選與基準兩邊的完整執行紀錄。',
  paired_nav_sequential_inference_not_validated: '舊版統計實驗狀態；不是正式策略停用或權重歸零的指令。',
  paired_nav_valuation_interval_unverified: '認購權估值或前期報酬區間尚未驗證；缺值日保留，不跳過重算績效。',
}

export default function PairedNavShadow({ data }: { data?: PairedNavShadowReadModel }) {
  return <section aria-label="配對組合 NAV" className="min-w-0 rounded-xl border border-slate-700/70 bg-slate-950/30 p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-sm font-semibold text-slate-100">配對組合 NAV · 成本後持倉績效</h3>
      <span className="text-sm text-amber-200">{data ? STATUS[data.status] : 'API 尚未提供 NAV 資料'}</span>
    </div>
    <p className="mt-2 text-sm leading-6 text-slate-300">候選與基準使用相同風控及執行規則，比較各自配置後的持倉、現金與實際成本。各配對的比較對象列於下方；這裡的交易日數不併入既有 EV 預測成熟日。</p>
    <dl className="mt-3 grid gap-3 sm:grid-cols-2">
      <div><dt className="text-xs text-slate-400">配置封存日期數（不是 NAV 成熟日）</dt><dd className="mt-1 text-base text-slate-100">{data?.allocation_context_dates ?? '無法確認'}</dd></div>
      <div><dt className="text-xs text-slate-400">最新配置日期</dt><dd className="mt-1 text-base text-slate-100">{data?.latest_allocation_context_date ?? '尚無'}</dd></div>
    </dl>
    {data?.pairs.length ? <div className="mt-4 grid gap-3 md:grid-cols-2">
      {data.pairs.map(pair => <article key={pair.pair_id} className="min-w-0 rounded-lg border border-slate-700 p-3">
        <p className="mb-2 text-sm leading-6 text-sky-200">{pair.comparison?.kind === 'incremental_layer'
          ? 'L4+ 對同一凍結 L4 候選：觀察多加殘差調整的效果，不代表勝過現行正式配置。'
          : pair.comparison?.kind === 'incumbent_replacement'
            ? `${pair.comparison.owner === 'ensemble' ? 'L3 ML' : 'L4'} 候選對當時凍結的現行配置：觀察替換後的整體效果。`
            : pair.comparison?.kind === 'route_policy_contrast'
              ? 'L1.5 候選路由對原路由：比較派送順序經實際配置與交易後的 NAV，不以路由分數差代替投資績效。'
              : pair.comparison?.kind === 'allocator_policy_contrast'
                ? 'OPB 候選配置對原配置：比較同一凍結基準下，資金分配經實際交易與成本後的 NAV。'
                : pair.comparison?.kind === 'atomic_strategy_replacement'
                  ? 'Atomic 候選策略對原策略：比較替換策略後，經完整配置與交易產生的 NAV，不以單筆命中率代替組合績效。'
                  : '舊紀錄尚未附完整比較對象；不推定為候選勝過正式配置。'}</p>
        {pair.comparison && pair.comparison.metadata_sessions < pair.accounted_sessions
          ? <p className="mb-2 text-xs leading-5 text-slate-400">比較類型已標記 {pair.comparison.metadata_sessions}/{pair.accounted_sessions} 日；未補寫舊紀錄，帳務日期完整保留。</p>
          : null}
        <p className="text-sm text-slate-200">有效 NAV 報酬 {pair.sessions} 日 · 最新 {pair.latest_session ?? '尚無'}</p>
        <p className="mt-1 text-sm text-slate-400">帳務已記錄 {pair.accounted_sessions} 日 · 最新 {pair.latest_accounting_session}</p>
        {pair.lifecycle ? <p className="mt-2 text-sm leading-6 text-sky-200">比較已於 {pair.lifecycle.transition_signal_date} 結束：{pair.lifecycle.changed_fields.includes('baseline_checksum') ? '比較基準' : '配置'}已更新。歷史 {pair.accounted_sessions} 日完整保留，不混入新基準的成熟日，也不代表績效不合格。</p> : null}
        {(pair.zero_nav_sessions ?? 0) > 0 ? <p className="mt-1 text-sm text-red-300">配對中有帳戶淨值歸零；損失照實保留，不以資料錯誤隱藏。</p> : null}
        {(pair.undefined_return_sessions ?? 0) > 0 ? <p className="mt-1 text-sm text-amber-200">{pair.undefined_return_sessions} 日期初淨值為零，報酬無法定義（0/0）；不填成 0%，不計晉級。</p> : null}
        {pair.unverified_sessions > (pair.undefined_return_sessions ?? 0) ? <p className="mt-1 text-sm text-amber-200">{pair.unverified_sessions - (pair.undefined_return_sessions ?? 0)} 日未取得完整績效證據，不計晉級。</p> : null}
        <details className="mt-2 text-xs leading-5 text-slate-400"><summary className="cursor-pointer">比較版本</summary>
          <p className="break-all">配對：{pair.pair_id}</p><p className="break-all">候選：{pair.candidate_checksum}</p><p className="break-all">基準：{pair.baseline_checksum}</p>
          {pair.lifecycle ? <p className="break-all">後續配對：{pair.lifecycle.successor_pair_id}</p> : null}
        </details>
      </article>)}
    </div> : <p className="mt-3 text-sm text-slate-400">尚無完整配對 NAV；不以配置封存或 EV 報酬代填。</p>}
    {data?.blockers.length ? <ul className="mt-3 space-y-1 text-sm text-amber-200">
      {data.blockers.map(reason => <li key={reason} className="break-words">{REASONS[reason] ?? reason}</li>)}
    </ul> : null}
    <p className="mt-3 text-xs leading-5 text-slate-400">有賺有賠都照實記錄；虧損日不是帳務失敗。各配對獨立計數，不將不同候選相加。NAV 是成本後績效證據，不是保證獲利或晉級指令；此區塊不更動正式權重，正式策略仍依自己的訊號與風控運作。</p>
  </section>
}
