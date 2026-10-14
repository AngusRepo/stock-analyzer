import type { ExitDecision } from './paperExitPolicy'
/** Read legacy receipts without inferring a stop from negative PnL. */
export function sellReceiptExitCategory(note:Record<string,unknown>):string {
  if(typeof note.exit_category==='string') return note.exit_category
  const reason=String(note.reason ?? '').replace(/^\[intraday\] /,'')
  // Exact historical codes, optionally followed by the recorded fill annotation.
  const code=reason.split(' (mkt=')[0]
  if(code==='swing_hard_stop_8') return 'hard_stop'
  if(code==='swing_daily_orl' || code==='s12_position_structural_stop_full_exit') return 'structural_stop'
  if(reason.startsWith('[L4Target] ')) return 'model_rotation'
  return 'unknown'
}
export function exitCategory(decision:ExitDecision) {
  if(decision.reason.startsWith('[PortfolioRisk]')) return 'portfolio_derisk'
  if(decision.reason==='swing_daily_orl') return 'structural_stop'
  if(decision.exitIntentKind==='risk_stop') return 'hard_stop'
  if(decision.exitIntentKind==='model_exit') return 'model_rotation'
  if(decision.exitIntentKind==='time_stop') return 'time_stop'
  if(decision.exitIntentKind==='take_profit') return 'take_profit'
  if(decision.exitIntentKind==='forced_close') return 'forced_close'
  return 'unknown'
}
