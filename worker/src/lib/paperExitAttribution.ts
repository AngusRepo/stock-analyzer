import type { ExitDecision } from './paperExitPolicy'
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
