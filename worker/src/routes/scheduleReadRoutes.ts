import { Hono } from 'hono'
import type { Bindings, Variables } from '../types'

export const scheduleReadRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

type ParameterMode = 'hard_boundary' | 'adaptive_learning' | 'research_sweep' | 'queue' | 'reporting'

interface ScheduleRow {
  task: string
  tw_time: string
  owner: 'gcp_scheduler' | 'worker_chain' | 'controller_callback' | 'manual'
  parameter_mode: ParameterMode
  layer: 'L0/L1 ops' | 'L2/L3 model evidence' | 'L4 allocation' | 'meta policy' | 'governance'
  description: string
}

const schedule: ScheduleRow[] = [
  { task: 'us-leading', tw_time: '06:30', owner: 'gcp_scheduler', parameter_mode: 'reporting', layer: 'L0/L1 ops', description: 'Pre-market US leading signal readout.' },
  { task: 'news-analyst', tw_time: '06:45', owner: 'gcp_scheduler', parameter_mode: 'reporting', layer: 'L0/L1 ops', description: 'Pre-market news analyst context.' },
  { task: 'morning-setup', tw_time: '07:15', owner: 'gcp_scheduler', parameter_mode: 'hard_boundary', layer: 'governance', description: 'Morning debate and pending-buy preparation.' },
  { task: 'morning-briefing', tw_time: '07:50', owner: 'gcp_scheduler', parameter_mode: 'reporting', layer: 'L0/L1 ops', description: 'Morning briefing delivery.' },
  { task: 'pre-market-warmup', tw_time: '08:50', owner: 'gcp_scheduler', parameter_mode: 'hard_boundary', layer: 'governance', description: 'Control-plane warmup before market open.' },
  { task: 'intraday-check', tw_time: '09:00-13:30', owner: 'gcp_scheduler', parameter_mode: 'hard_boundary', layer: 'governance', description: 'Market-hours quote sanity and execution guard.' },
  { task: 'eod-exit', tw_time: '13:25', owner: 'gcp_scheduler', parameter_mode: 'hard_boundary', layer: 'governance', description: 'Market close exit workflow.' },
  { task: 'daily-snapshot', tw_time: '14:20', owner: 'gcp_scheduler', parameter_mode: 'reporting', layer: 'L0/L1 ops', description: 'Paper account, position, and PnL snapshot.' },
  { task: 'market-close-refresh', tw_time: '18:10', owner: 'gcp_scheduler', parameter_mode: 'reporting', layer: 'L0/L1 ops', description: 'Early post-close refresh for official prices, market breadth, futures snapshot, and close-data cache.' },
  { task: 'evening-chain', tw_time: '21:00', owner: 'gcp_scheduler', parameter_mode: 'hard_boundary', layer: 'governance', description: 'Primary post-market root for FinLab refresh, market data, indicators, screener, ML, recommendation, verify, and reporting.' },
  { task: 'finlab-backfill-watchdog', tw_time: '21:20-23:50 / 10m', owner: 'gcp_scheduler', parameter_mode: 'hard_boundary', layer: 'governance', description: 'Retries FinLab Modal calls that never emitted a start heartbeat.' },
  { task: 'allocator-ev-lifecycle-watchdog', tw_time: '21:00-01:50 / 10m', owner: 'gcp_scheduler', parameter_mode: 'hard_boundary', layer: 'governance', description: 'Recovers interrupted native lineage, allocator snapshot, verify callback, and delayed replay stages.' },
  { task: 'active8-oof-daily', tw_time: '01:55', owner: 'gcp_scheduler', parameter_mode: 'hard_boundary', layer: 'L4 allocation', description: 'Materializes the latest ready immutable purged-OOF cohort through L4/Fusion quality, parity, and automatic promotion gates.' },
  { task: 'active8-oof-weekly', tw_time: 'Sunday 07:05', owner: 'gcp_scheduler', parameter_mode: 'hard_boundary', layer: 'L4 allocation', description: 'Creates one deterministic 60/10 three-fold Active-8 purged-OOF cohort.' },
  { task: 'active8-oof-monthly', tw_time: 'monthly retrain callback', owner: 'controller_callback', parameter_mode: 'hard_boundary', layer: 'L4 allocation', description: 'Starts the same purged-OOF lifecycle only after monthly universal retrain completion.' },
  { task: 'external-evidence', tw_time: '23:15', owner: 'gcp_scheduler', parameter_mode: 'reporting', layer: 'L0/L1 ops', description: 'Materializes formal-shadow GDELT/official external evidence for the latest available recommendation date.' },
  { task: 'update', tw_time: 'after source readiness', owner: 'worker_chain', parameter_mode: 'hard_boundary', layer: 'L0/L1 ops', description: 'Market data update and readiness manifest.' },
  { task: 'screener', tw_time: '22:00 chain', owner: 'controller_callback', parameter_mode: 'hard_boundary', layer: 'L0/L1 ops', description: 'Daily screener seed and candidate pool preparation.' },
  { task: 'regime-compute', tw_time: 'before pipeline', owner: 'worker_chain', parameter_mode: 'adaptive_learning', layer: 'L4 allocation', description: 'Market-regime context for sizing, thresholds, and allocation.' },
  { task: 'pipeline', tw_time: 'after readiness', owner: 'controller_callback', parameter_mode: 'hard_boundary', layer: 'governance', description: 'LangGraph pipeline v2 after data, screener, and regime readiness.' },
  { task: 'ml-predict', tw_time: 'inside pipeline', owner: 'controller_callback', parameter_mode: 'adaptive_learning', layer: 'L2/L3 model evidence', description: 'TimesFM L2 sidecar enrichment, active-8 L3 ML prediction, and ensemble merge.' },
  { task: 'recommendation', tw_time: 'inside pipeline', owner: 'controller_callback', parameter_mode: 'hard_boundary', layer: 'governance', description: 'Daily recommendation materialization after ML predict.' },
  { task: 'verify-v2', tw_time: 'post-pipeline callback', owner: 'controller_callback', parameter_mode: 'hard_boundary', layer: 'L2/L3 model evidence', description: 'Verify predictions against realized bars before IC/adaptive updates.' },
  { task: 'model-ic-tracker', tw_time: 'post-verify chain', owner: 'worker_chain', parameter_mode: 'adaptive_learning', layer: 'L2/L3 model evidence', description: 'Rolling IC and live-gate evidence for active-8 direct-alpha models.' },
  { task: 'linucb-reward-ledger', tw_time: 'post-IC chain', owner: 'worker_chain', parameter_mode: 'adaptive_learning', layer: 'meta policy', description: 'LinUCB delayed reward ledger refresh before adaptive params.' },
  { task: 'adapt', tw_time: 'post-ledger chain', owner: 'worker_chain', parameter_mode: 'adaptive_learning', layer: 'meta policy', description: 'Adaptive params refresh from verified evidence and reward ledger.' },
  { task: 'meta-learning-shadow', tw_time: 'post-adapt chain', owner: 'worker_chain', parameter_mode: 'adaptive_learning', layer: 'meta policy', description: 'NeuralUCB, NeuralTS, and NeuCB evidence-only shadow closure.' },
  { task: 'strategy-learning', tw_time: 'post-verify chain', owner: 'worker_chain', parameter_mode: 'adaptive_learning', layer: 'L4 allocation', description: 'Strategy decision-log learning and family ownership evidence.' },
  { task: 'daily-report', tw_time: 'post-adapt chain', owner: 'worker_chain', parameter_mode: 'reporting', layer: 'governance', description: 'Daily report after verify, IC, ledger, and adaptive closure.' },
  { task: 'obsidian-daily', tw_time: 'post-report chain', owner: 'worker_chain', parameter_mode: 'reporting', layer: 'governance', description: 'Obsidian daily notes and progress sync.' },
  { task: 'weekly-audit', tw_time: 'Friday 18:30', owner: 'gcp_scheduler', parameter_mode: 'reporting', layer: 'governance', description: 'Weekly audit report.' },
  { task: 'weekly-cleanup', tw_time: 'Sunday 04:00', owner: 'gcp_scheduler', parameter_mode: 'hard_boundary', layer: 'governance', description: 'D1/KV/runtime cleanup and lifecycle check; no retrain.' },
  { task: 'weekly-backtest', tw_time: 'Sunday 06:00', owner: 'gcp_scheduler', parameter_mode: 'research_sweep', layer: 'L2/L3 model evidence', description: 'Lightweight validation, backtest, Monte Carlo, and PBO.' },
  { task: 'alpha-quality', tw_time: 'Sunday 06:00', owner: 'gcp_scheduler', parameter_mode: 'adaptive_learning', layer: 'L2/L3 model evidence', description: 'Alpha bucket and regime quality monitor.' },
  { task: 'weekly-optuna', tw_time: 'Sunday 06:30', owner: 'gcp_scheduler', parameter_mode: 'research_sweep', layer: 'meta policy', description: 'Controller-owned weekly Optuna/GA calibration; Worker triggers but does not fan out.' },
  { task: 's12-smcvwap-calibration', tw_time: 'Sunday 06:45 / first Saturday 16:20', owner: 'gcp_scheduler', parameter_mode: 'adaptive_learning', layer: 'meta policy', description: 'Walk-forward S12 Taiwan-equity policy calibration with automatic guarded promotion and last-known-good fallback.' },
  { task: 'l4-alpha-ev-refresh', tw_time: 'Sunday 07:05', owner: 'gcp_scheduler', parameter_mode: 'adaptive_learning', layer: 'L4 allocation', description: 'Production-gated L4 alpha EV artifact rebuild and config snapshot promotion.' },
  { task: 'allocator-ev-fusion-refresh', tw_time: 'Sunday 07:10', owner: 'gcp_scheduler', parameter_mode: 'adaptive_learning', layer: 'L4 allocation', description: 'Production-gated allocator EV fusion artifact rebuild and config snapshot promotion.' },
  { task: 'opb-arm-prior-refresh', tw_time: 'Sunday 07:15 + daily chain', owner: 'gcp_scheduler', parameter_mode: 'adaptive_learning', layer: 'meta policy', description: 'Counterfactual fixed-arm replay with canonical net outcomes; promotes only after owner and date gates pass.' },
  { task: 'adaptive-meta-policy-replay', tw_time: 'Sunday 06:40', owner: 'gcp_scheduler', parameter_mode: 'adaptive_learning', layer: 'meta policy', description: 'Persisted evidence-only active-8 walk-forward replay comparing LinUCB, NeuralUCB, NeuralTS, and NeuCB.' },
  { task: 'linucb-multiplier-replay', tw_time: 'Sunday 06:50', owner: 'gcp_scheduler', parameter_mode: 'research_sweep', layer: 'meta policy', description: 'Persisted evidence-only active-8 LinUCB weight-multiplier replay for bandit_* L2 constants.' },
  { task: 'monthly-strategy-mining', tw_time: 'first Saturday 10:00', owner: 'gcp_scheduler', parameter_mode: 'research_sweep', layer: 'governance', description: 'Monthly pymoo NSGA-III + novelty strategy mining preflight, FinLab validation contract, and promotion ledger evidence.' },
  { task: 'monthly-optuna', tw_time: 'first Saturday 16:00', owner: 'gcp_scheduler', parameter_mode: 'research_sweep', layer: 'meta policy', description: 'Heavier 10-source research sweep including S12 Taiwan-equity calibration research.' },
  { task: 'monthly-l4-alpha-ev-refresh', tw_time: 'first Sunday 01:30', owner: 'gcp_scheduler', parameter_mode: 'adaptive_learning', layer: 'L4 allocation', description: 'Monthly wider-window L4 alpha EV artifact rebuild before universal retrain window.' },
  { task: 'monthly-allocator-ev-fusion-refresh', tw_time: 'first Sunday 01:40', owner: 'gcp_scheduler', parameter_mode: 'adaptive_learning', layer: 'L4 allocation', description: 'Monthly wider-window allocator EV fusion artifact rebuild before universal retrain window.' },
  { task: 'monthly-opb-arm-prior-refresh', tw_time: 'first Sunday 01:50', owner: 'gcp_scheduler', parameter_mode: 'adaptive_learning', layer: 'meta policy', description: 'Monthly wider-window OPB counterfactual arm-prior refresh after the expected-return owner refresh.' },
  { task: 'weekly-drift-retrain', tw_time: 'manual approval-gated', owner: 'manual', parameter_mode: 'research_sweep', layer: 'L2/L3 model evidence', description: 'Approval-gated shadow candidate path, not automatic weekly retrain.' },
  { task: 'optuna-queue', tw_time: 'every 6h', owner: 'gcp_scheduler', parameter_mode: 'queue', layer: 'meta policy', description: 'Bounded queue processor for Optuna items.' },
]

scheduleReadRoutes.get('/api/cron/schedule', (c) => c.json({ schedule }))
