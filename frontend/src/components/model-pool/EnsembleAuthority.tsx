import type { Active8ServingBundleReadModel } from '@/lib/api'

/** Read-only projection. Diagnostic verdicts cannot grant or revoke serving. */
export default function EnsembleAuthority({ bundle }: { bundle?: Active8ServingBundleReadModel }) {
  const serving = bundle?.status === 'production' && bundle.production_effect
  const nav = serving && bundle.adoption_basis === 'committed_paired_nav' && Boolean(bundle.nav_decision_checksum)
  const q = bundle?.qualifications
  return <section aria-label="組合採用與診斷" className="rounded-2xl border border-[#2d3a49] bg-[#111821] p-4 text-sm leading-6 text-[#a7b5c8]">
    <h3 className="text-base font-semibold text-[#eef4fb]">組合採用與診斷</h3>
    <p>正式採用：{nav ? '原始配對 NAV 已核對' : serving ? '既有正式 bundle；非 NAV 採用' : '尚無有效正式 bundle'}</p>
    {nav ? <p className="break-all">NAV 決策憑證：{bundle.nav_decision_checksum}</p> : null}
    <p>離線排名診斷：{q?.ranking.decision ?? '尚無資料'}</p>
    <p>區間校準診斷：{q?.calibration.decision ?? '尚無資料'}</p>
    <p>ML 方向建議：{q ? q.directional.allowed_signals.join('、') || '證據不足，保留原始預測供參考' : '尚無資料'}</p>
    <p>ML 提供預測與建議；通過正式採用檢核的 L4 EV 交由 sparse 配置，OPB 僅在授權範圍內調整。</p>
    <p>離線診斷不是第二套 NAV 晉級門檻；缺少有效 EV 不會退回直接使用 ML BUY 下單。</p>
  </section>
}
