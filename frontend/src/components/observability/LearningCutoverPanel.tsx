import { ShieldAlert } from 'lucide-react'
import { WorkstationPanel, WorkstationPill } from '@/components/workstation/WorkstationChrome'
import type { DataDomainCutoverReadinessReport } from '@/lib/api'

const BLOCKER_LABELS: Record<string, string> = {
  aggregate_parity_stale_after_evening_chain: '整體 parity 快照早於最近一次正式晚間資料鏈，需重新驗證。',
  initial_copy_incomplete: '初始搬移尚未涵蓋全部 Learning 資料表。',
  full_table_parity_incomplete_or_mismatch: '尚未逐表證明來源與 Learning D1 的筆數及 checksum 完全一致。',
  aggregate_parity_snapshot_missing_or_mismatch: '全部逐表 parity 通過後，仍需產生整體一致性快照。',
  shadow_state_not_ready: 'Learning D1 尚未進入可執行讀寫 probe 的 shadow 狀態。',
  domain_access_router_not_closed: '仍有程式直接讀寫 legacy DB，尚未全部收斂到資料域 router。',
  projection_contract_not_closed: '跨資料域 outbox / inbox、重播與 freshness SLA 尚未 closure。',
  active_read_write_readback_probe_missing: '尚未完成 Learning D1 寫入後立即讀回的正式 probe。',
  rollback_restore_probe_missing: '尚未完成切換失敗後可還原的正式 probe。',
  writer_quiescence_epoch_receipt_stale_or_missing: 'writer epoch fence 已安裝，但需在最新 parity 後留下同 epoch probe receipt。',
}

function explainBlocker(blocker: string) {
  if (blocker.startsWith('control_table_revision_fence:')) {
    const table = blocker.split(':')[1] || 'control table'
    return `${table} 的來源/目標 revision 尚未綁入最新 parity receipt。`
  }
  return BLOCKER_LABELS[blocker] ?? blocker
}

export default function LearningCutoverPanel({ report }: { report?: DataDomainCutoverReadinessReport }) {
  const domain = report?.domains.find((item) => item.domain === 'learning')
  const routingGates = Object.values(report?.routing_contract_gates ?? {})
  const projectionGates = Object.values(report?.projection_contract_gates ?? {})
  const completed = Number(domain?.completed_tables ?? 0)
  const owned = Number(domain?.owned_tables ?? 0)
  const parity = Number(domain?.parity_tables ?? 0)
  const copyPct = owned ? Math.round((completed / owned) * 100) : 0
  const parityPct = owned ? Math.round((parity / owned) * 100) : 0
  const progress = [
    { label: '初始搬移', value: completed, total: owned, pct: copyPct },
    { label: '逐表 parity', value: parity, total: owned, pct: parityPct },
  ]

  return (
    <WorkstationPanel title="D1 十年架構切換里程碑" kicker="production strict readiness">
      <div className="grid gap-3 p-3 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1.45fr)]">
        <div className="space-y-3 rounded-lg border border-[#263247] bg-[#070a10] p-3">
          <div className="flex flex-wrap items-center gap-2">
            <WorkstationPill tone={domain?.cutover_ready ? 'ok' : 'warn'}>
              {domain?.cutover_ready ? '可切換正式' : '禁止切換'}
            </WorkstationPill>
            <WorkstationPill tone={domain?.cutover_status === 'legacy' ? 'info' : 'warn'}>
              正式 owner：{domain?.cutover_status || 'unknown'}
            </WorkstationPill>
            <WorkstationPill tone={domain?.current_writer_state === 'open' ? 'ok' : 'error'}>
              writer fence：{domain?.current_writer_state || '未安裝'}
            </WorkstationPill>
          </div>
          <p className="text-xs leading-5 text-slate-400">
            今晚 jobs 仍由 legacy 單一 owner 寫入；初始搬移、逐表 parity、跨域 contract 與 rollback probe 全部通過後，才允許把 Learning D1 切成正式 owner。
          </p>
          {progress.map((item) => (
            <div key={item.label}>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="text-slate-300">{item.label}</span>
                <span className="sv-num text-slate-400">{item.value}/{item.total} · {item.pct}%</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">
                <div className="h-full rounded-full bg-sky-400" style={{ width: `${Math.min(100, item.pct)}%` }} />
              </div>
            </div>
          ))}
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="rounded border border-[#263247] p-2 text-slate-400">Routing contract <span className="float-right sv-num text-slate-200">{routingGates.filter(Boolean).length}/{routingGates.length}</span></div>
            <div className="rounded border border-[#263247] p-2 text-slate-400">Projection contract <span className="float-right sv-num text-slate-200">{projectionGates.filter(Boolean).length}/{projectionGates.length}</span></div>
            <div className="rounded border border-[#263247] p-2 text-slate-400">Writer epoch <span className="float-right sv-num text-slate-200">{domain?.current_writer_epoch ?? 'N/A'}</span></div>
            <div className="rounded border border-[#263247] p-2 text-slate-400">Projection errors <span className="float-right sv-num text-slate-200">{domain?.projection_error_events ?? 'N/A'}</span></div>
          </div>
        </div>
        <div className="rounded-lg border border-[#263247] bg-[#070a10] p-3">
          <p className="mb-2 sv-num text-xs normal-case text-slate-300">尚未 closure 的原因</p>
          <div className="space-y-2">
            {(domain?.blockers ?? ['cutover readiness 尚未載入']).map((blocker, index) => (
              <div key={`${blocker}-${index}`} className="flex gap-2 text-xs leading-5 text-slate-400">
                <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" />
                <span>{explainBlocker(blocker)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </WorkstationPanel>
  )
}
