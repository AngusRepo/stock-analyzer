import { scopeById, scopeExecutionStageIds } from './executionChainDag'
import { CHAIN_SPECS, type ChainId } from './chainCatalog'

export type ChainPhase = { id: string; title: string; caption: string; stages: readonly string[]; main: readonly string[] }

/** Presentation groups of the three chains other than daily_readiness, in DAILY_READINESS_PHASES' shape (`main`
 * = the lane, the rest of `stages` = side work that does not gate it), for /v1/chain/state's `phase` and the
 * Grafana Canvas export. Grouped from the panel's columns and branches; the scheduler triggers every stage
 * itself, so a lane is schedule order, not a dependency. */
export const OTHER_CHAIN_PHASES: Record<Exclude<ChainId, 'daily_readiness'>, readonly ChainPhase[]> = {
  intraday_guard: [
    { id: 'session', title: '盤中守門與收盤帳務', caption: '09:00–13:30 每分鐘 intraday-check → 收盤出場 → 收盤價 → 帳務快照；重新評分 10:00／11:00／12:00／12:30 為獨立排程',
      stages: ['intraday-check', 'eod-exit', 'post-close-price-refresh', 'daily-snapshot', 'rescore-10', 'rescore-11', 'rescore-12', 'rescore-1230'],
      main: ['intraday-check', 'eod-exit', 'post-close-price-refresh', 'daily-snapshot'] },
  ],
  weekly_research: [
    { id: 'audit', title: '週五稽核', caption: '週五 18:30 起：weekly audit、Model IC、週日 04:00 storage integrity（同欄並行）',
      stages: ['weekly-audit', 'storage-integrity-audit', 'model-ic-full-check'], main: ['weekly-audit', 'storage-integrity-audit', 'model-ic-full-check'] },
    { id: 'validation', title: '驗證與研究', caption: '週日清晨：Validation／MC、alpha quality、Active-8 weekly；drift research 與 sector leaders 為選配',
      stages: ['weekly-backtest', 'alpha-quality', 'active8-oof-weekly', 'weekly-optuna', 'sector-leaders'], main: ['weekly-backtest', 'alpha-quality', 'active8-oof-weekly'] },
    { id: 'closure', title: '回放與收尾', caption: 'replay／calibration 為選配；weekly cleanup → 週日 12:00 weekly root 收尾',
      stages: ['adaptive-meta-policy-replay', 's12-smcvwap-calibration', 'linucb-multiplier-replay', 'weekly-cleanup', 'weekly-readiness'], main: ['weekly-cleanup', 'weekly-readiness'] },
  ],
  monthly_artifact: [
    { id: 'monthly', title: '每月 artifact', caption: '每月第一個週六 strategy mining → monthly search；第一個週日 Active-8 monthly → monthly root 收尾',
      stages: ['monthly-strategy-mining', 'monthly-optuna', 'active8-oof-monthly', 'monthly-readiness'], main: ['monthly-strategy-mining', 'monthly-optuna', 'active8-oof-monthly', 'monthly-readiness'] },
  ],
}

/** A chain's catalog stages in panel order: columns, branches, then the orchestrator root (the period's closure). */
export function chainStageIds(chainId: Exclude<ChainId, 'daily_readiness'>): string[] {
  const scope = scopeById(CHAIN_SPECS[chainId].scope)
  return [...scopeExecutionStageIds(scope), ...(scope.orchestratorId ? [scope.orchestratorId] : [])]
}

export function chainPhaseForStage(chainId: Exclude<ChainId, 'daily_readiness'>, stageId: string): string | undefined {
  return OTHER_CHAIN_PHASES[chainId].find((phase) => phase.stages.includes(stageId))?.id
}
