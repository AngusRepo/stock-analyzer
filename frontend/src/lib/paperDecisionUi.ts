/** Debate is an observation attached to the execution pool, never a display admission filter. */
export function visiblePendingBuys(payload: { pendingBuys?: unknown } | null | undefined): any[] {
  return Array.isArray(payload?.pendingBuys) ? payload.pendingBuys : []
}

export function debateObservationLabel(row: { debate_status?: string; debate_verdict?: string }): string {
  const status = String(row.debate_status ?? '').toLowerCase()
  if (status !== 'completed') return status === 'failed' ? '辯論觀察失敗' : status === 'skipped' ? '辯論觀察略過' : '辯論觀察待完成'
  const verdict = String(row.debate_verdict ?? '').toUpperCase()
  return ({ APPROVE: '辯論觀察：贊成', DOWNGRADE: '辯論觀察：保守', REJECT: '辯論觀察：反對' } as Record<string, string>)[verdict] ?? '辯論觀察已完成'
}

export function positionL4View(raw: any): { label: string; weights: string | null; detail: string } {
  if (raw?.status !== 'ready') return { label: '暫無判斷', weights: null,
    detail: raw?.reason === 'plan_not_finalized' ? '今日 L4 計畫尚未發布；保護性出場仍有效' : '尚無通過驗證的當日持倉判斷；保護性出場仍有效' }
  const labels: Record<string, string> = { hold: '續抱', reduce: '減碼目標', exit: '出清目標',
    increase: '目標提高', locked: '保留持倉（未重新評估）' }
  const finiteWeights = typeof raw.decision_weight === 'number' && Number.isFinite(raw.decision_weight)
    && typeof raw.target_weight === 'number' && Number.isFinite(raw.target_weight)
  return { label: labels[raw.action] ?? '暫無判斷',
    weights: finiteWeights ? `${raw.held_at_decision ? '決策時' : '原配置'} ${(raw.decision_weight * 100).toFixed(4)}% → 目標 ${(raw.target_weight * 100).toFixed(4)}%` : null,
    detail: `${raw.trade_date} 盤前計畫 · ` + (raw.action === 'locked' ? '資料或限制鎖定，不代表模型看多'
      : raw.action === 'increase' ? '既有持倉不自動加碼'
      : raw.action === 'hold' ? '維持配置；停損與帳戶風控仍可觸發出場'
      : '目標調整，實際成交依盤中出場檢查') }
}
