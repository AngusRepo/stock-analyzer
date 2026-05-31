"""
optuna_screener.py — Sprint 5.2: Screener factor-weights Optuna search via backtest_engine

搜尋空間（15 dim）：score_multi_factor 內部的評分公式權重 + 流動性過濾帶

  Liquidity filters (2):
    minAvgVolume             [200k, 800k]   20 日均量下限
    minDailyTurnover         [3M, 15M]      日均週轉金額下限

  Chip score (0-40, 4 dims):
    chipScoreTiers[0]        [28, 42]       Tier 0 籌碼強度最高分
    chipScoreTiers[1]        [20, 32]       Tier 1
    chipIntensityThresholds[0] [0.12, 0.30] Tier 0 threshold
    chipIntensityThresholds[1] [0.06, 0.14] Tier 1 threshold
    consecBuyBonusTiers[0]   [2, 8]         ≥5 天連買 bonus

  Technical score (0-30, 5 dims):
    rsiScoreTiers[0]         [8, 16]        RSI 55-75 sweet spot 給分
    rsiScoreTiers[3]         [4, 12]        RSI >75 過熱給分
    macdNegativeFactor       [0.2, 1.0]     MACD 容忍度
    keltnerMultiplier        [1.0, 2.5]     Keltner 突破寬度
    natrThreshold            [2.0, 5.0]     低波動定義

  Momentum score (0-20, 2 dims):
    excessReturnRangeHi      [0.03, 0.10]   超額報酬 normalize 上界
    volRatioRangeHi          [2.0, 4.0]     量比 normalize 上界

Objective (Sprint 3 P0-3 pattern)：NSGA-II Multi-Objective
  Obj 1: BacktestMetrics.sharpe       (maximize)
  Obj 2: BacktestMetrics.max_drawdown (minimize)

Mode A hardcode overrides（見 memory/project_sprint_5_2_hardcode_overrides.md）:
  Override #1: ranking.alpha=1.0 / beta=0.0 / gamma=0.0
    — Mode A 用 placeholder constants，rank 數學上只看 screener_norm。
       Alpha=1.0 讓 screener 權重變化 100% 反映到 top-K。Sprint 6b revert。
  Override #2: MIN_FILL_RATE=0.30 hardcoded reject threshold
    — Sprint 6b 改讀 KV。

Realism caveat: backtest_engine Mode A 有 15 個 documented deviation (Sharpe ±0.3~0.8)，
  Optuna 結果「只能做相對比較」，不能當 absolute production prediction。
  詳見 memory/project_backtest_engine_design_rationale.md
"""
from __future__ import annotations
import logging
import sys
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from typing import Optional

try:
    import optuna
    from optuna.samplers import NSGAIISampler
    optuna.logging.set_verbosity(optuna.logging.WARNING)
except ImportError:
    print("ERROR: pip install optuna")
    sys.exit(1)

from services.backtest_engine import replay_period, BacktestDataset  # noqa: E402
from services.research_data_access import ResearchDataMode, latest_snapshot_business_end_date  # noqa: E402
from services.stratified_subset import select_stratified_subset  # noqa: E402

logger = logging.getLogger(__name__)

# Sprint 3 P0-3: PENALTY tuple for infeasible trials (Pareto "worst corner")
PENALTY = (-1e9, 1.0)

# Sanity flag substrings that trigger trial rejection (inherited from Sprint 5.1)
_REJECT_FLAG_KEYWORDS = ("overfit", "unrealistically", "No trading days")

# Sprint 6b: these are now defaults, overridable via KV trading:config.optuna.*
# create_objective reads from baseline dict (populated from KV by router).
_DEFAULT_MIN_FILL_RATE = 0.30
_DEFAULT_MIN_N_TRADES = 30


def _default_baseline_params() -> dict:
    """Fallback baseline matching tradingConfig.ts defaults."""
    return {
        "screener": {
            "minPrice": 15,
            "maxPrice": 2000,
            "minAvgVolume": 300_000,
            "minDailyTurnover": 5_000_000,
            "maxPerIndustry": 5,
            "maxCandidates": 25,
            "chipScoreTiers": [36, 28, 20, 12, 5],
            "chipIntensityThresholds": [0.20, 0.10, 0.05, 0, -0.05],
            "consecBuyBonusTiers": [4, 2],
            "consecBuyDayThresholds": [5, 3],
            "rsiScoreTiers": [12, 8, 6, 8, 3],
            "macdNegativeFactor": 0.5,
            "keltnerMultiplier": 1.5,
            "natrThreshold": 3.0,
            "excessReturnRange": [-0.03, 0.05],
            "volRatioRange": [0.7, 2.5],
        },
        "ranking": {
            "enabled": True,
            "alpha": 0.40,
            "beta": 0.40,
            "gamma": 0.20,
            "screenerDenominator": 60.0,
            "promoteMinConf": 0.60,
        },
        "alphaFramework": {
            "allocation": {
                "engine": "sparse_tangent_inverse_risk",
                "controller": "OnlinePortfolioBandit",
                "buySignalCount": 3,
                "slateSize": 10,
            },
        },
    }


def _build_trial_params(trial: optuna.Trial, baseline: dict) -> dict:
    """Build a params override dict matching trading:config shape for this trial."""
    # ── Liquidity filters (2) ───────────────────────────────────────────────
    min_avg_vol      = trial.suggest_int("minAvgVolume",    200_000, 800_000, step=50_000)
    min_daily_to     = trial.suggest_int("minDailyTurnover", 3_000_000, 15_000_000, step=1_000_000)

    # ── Chip score weights (5 dims, tiers [0] and [1] free, [2-4] scaled linearly) ──
    chip_tier0       = trial.suggest_int("chipScoreTier0", 28, 42, step=2)
    chip_tier1       = trial.suggest_int("chipScoreTier1", 20, 32, step=2)
    chip_th0         = trial.suggest_float("chipIntensityTh0", 0.12, 0.30, step=0.02)
    chip_th1         = trial.suggest_float("chipIntensityTh1", 0.06, 0.14, step=0.01)
    consec_bonus0    = trial.suggest_int("consecBuyBonus0", 2, 8, step=1)

    # ── Technical score weights (5 dims) ────────────────────────────────────
    rsi_tier0        = trial.suggest_int("rsiScoreTier0", 8, 16, step=1)    # RSI 55-75
    rsi_tier3        = trial.suggest_int("rsiScoreTier3", 4, 12, step=1)    # RSI >75
    macd_neg_factor  = trial.suggest_float("macdNegativeFactor", 0.2, 1.0, step=0.1)
    keltner_mult     = trial.suggest_float("keltnerMultiplier",  1.0, 2.5, step=0.25)
    natr_threshold   = trial.suggest_float("natrThreshold",      2.0, 5.0, step=0.5)

    # ── Momentum score ranges (2 dims) ──────────────────────────────────────
    excess_ret_hi    = trial.suggest_float("excessReturnRangeHi", 0.03, 0.10, step=0.01)
    vol_ratio_hi     = trial.suggest_float("volRatioRangeHi",     2.0, 4.0, step=0.25)

    params = deepcopy(baseline)
    base_screener = params.setdefault("screener", {})
    base_chip_tiers = list(base_screener.get("chipScoreTiers", [36, 28, 20, 12, 5]))
    base_chip_ths   = list(base_screener.get("chipIntensityThresholds", [0.20, 0.10, 0.05, 0, -0.05]))
    base_cb_bonus   = list(base_screener.get("consecBuyBonusTiers", [4, 2]))
    base_rsi_tiers  = list(base_screener.get("rsiScoreTiers", [12, 8, 6, 8, 3]))
    base_excess     = list(base_screener.get("excessReturnRange", [-0.03, 0.05]))
    base_vol_ratio  = list(base_screener.get("volRatioRange", [0.7, 2.5]))

    # Scale lower tiers linearly to preserve monotonic decrease shape
    # chipScoreTiers[2,3,4] = tier1 * [0.7, 0.43, 0.18] ≈ original proportions [20/28, 12/28, 5/28]
    chip_tier2 = round(chip_tier1 * 0.70)
    chip_tier3 = round(chip_tier1 * 0.43)
    chip_tier4 = round(chip_tier1 * 0.18)

    base_screener.update({
        "minAvgVolume": min_avg_vol,
        "minDailyTurnover": min_daily_to,
        "chipScoreTiers": [chip_tier0, chip_tier1, chip_tier2, chip_tier3, chip_tier4],
        # thresholds: keep [2,3,4] at defaults, only tune [0,1] top tiers
        "chipIntensityThresholds": [chip_th0, chip_th1, base_chip_ths[2], base_chip_ths[3], base_chip_ths[4]],
        # consecBuyBonusTiers: tier1 scales to tier0/2
        "consecBuyBonusTiers": [consec_bonus0, max(1, round(consec_bonus0 / 2))],
        # rsiScoreTiers: tiers [1,2,4] scale from tier0 proportionally
        "rsiScoreTiers": [
            rsi_tier0,
            round(rsi_tier0 * 0.67),      # [1] 45-55
            round(rsi_tier0 * 0.50),      # [2] 40-45
            rsi_tier3,                    # [3] >75
            round(rsi_tier0 * 0.25),      # [4] 30-40
        ],
        "macdNegativeFactor": macd_neg_factor,
        "keltnerMultiplier": keltner_mult,
        "natrThreshold": natr_threshold,
        # excessReturnRange: keep lo, only tune hi
        "excessReturnRange": [base_excess[0], excess_ret_hi],
        # volRatioRange: keep lo, only tune hi
        "volRatioRange": [base_vol_ratio[0], vol_ratio_hi],
    })

    # Sprint 6b: ranking weights are now searchable (reverted from Mode A alpha=1.0 hardcode).
    # Mode B has real ML confidence plugged into replay_screener_for_date,
    # so alpha/beta/gamma genuinely affect ranking composition.
    base_ranking = params.setdefault("ranking", {})
    params["ranking"] = {
        "enabled": True,
        "alpha": trial.suggest_float("ranking_alpha", 0.3, 0.6),   # screener_norm weight
        "beta":  trial.suggest_float("ranking_beta",  0.2, 0.5),   # ml_confidence weight
        "gamma": trial.suggest_float("ranking_gamma", 0.1, 0.3),   # signal_tier weight
        "screenerDenominator": base_ranking.get("screenerDenominator", 60.0),
        "promoteMinConf": base_ranking.get("promoteMinConf", 0.60),
    }

    return params


def _check_constraints(trial_params: dict) -> Optional[str]:
    """Hard constraints (return reason if violated, else None)."""
    sc = trial_params.get("screener", {})
    chip_tiers = sc.get("chipScoreTiers", [])
    chip_ths = sc.get("chipIntensityThresholds", [])
    rsi_tiers = sc.get("rsiScoreTiers", [])

    # chipScoreTiers must be strictly monotonic decreasing
    if len(chip_tiers) >= 2 and chip_tiers[0] <= chip_tiers[1]:
        return "chipScoreTiers[0] <= chipScoreTiers[1]"

    # chipIntensityThresholds[0] must exceed [1] (search dims)
    if len(chip_ths) >= 2 and chip_ths[0] <= chip_ths[1]:
        return "chipIntensityThresholds[0] <= [1]"

    # RSI sweet spot (55-75) must score higher than mid-band (45-55)
    if len(rsi_tiers) >= 2 and rsi_tiers[0] <= rsi_tiers[1]:
        return "rsiScoreTiers[0] <= rsiScoreTiers[1]"

    # Removed: minAvgVolume * minPrice > minDailyTurnover cross-constraint.
    # Reason: minPrice=15 is the hard floor, not the avg price (median ~208 TWD).
    # Using 15 falsely rejects 23% of trials. minAvgVolume and minDailyTurnover
    # are independent liquidity filters — no industry precedent for cross-checking.
    # See Sprint 5.2 reject diagnostics (2026-04-09).

    return None


def create_objective(
    dataset: BacktestDataset,
    start_date: str,
    end_date: str,
    baseline: dict,
    reject_counter: Optional[dict] = None,
):
    """
    Build Optuna objective fn closured over a pre-loaded BacktestDataset.
    Dataset is loaded once in run_search; each trial just calls replay_period.

    reject_counter: optional dict to accumulate rejection reasons across trials
      Keys written: 'constraint', 'replay_error', 'sanity_flag', 'n_trades',
                    'fill_rate', 'valid', plus per-constraint subkeys for
                    diagnostic purposes.
    """
    if reject_counter is None:
        reject_counter = {}

    # Sprint 6b: read sanity thresholds from baseline (KV-driven) with defaults
    optuna_cfg = baseline.get("optuna", {})
    min_fill_rate = float(optuna_cfg.get("min_fill_rate", _DEFAULT_MIN_FILL_RATE))
    min_n_trades = int(optuna_cfg.get("min_n_trades", _DEFAULT_MIN_N_TRADES))

    def _bump(key: str) -> None:
        reject_counter[key] = reject_counter.get(key, 0) + 1

    def objective(trial: optuna.Trial):
        params = _build_trial_params(trial, baseline)

        constraint_violation = _check_constraints(params)
        if constraint_violation:
            logger.debug(f"[optuna_screener] trial {trial.number} rejected: {constraint_violation}")
            _bump("constraint")
            _bump(f"constraint:{constraint_violation}")
            trial.set_user_attr("reject_reason", f"constraint:{constraint_violation}")
            return PENALTY

        try:
            metrics = replay_period(
                dataset,
                start_date,
                end_date,
                params,
                initial_capital=1_000_000,
                mode="A",
                verbose=False,
            )
        except Exception as e:
            logger.warning(f"[optuna_screener] trial {trial.number} replay error: {e}")
            _bump("replay_error")
            trial.set_user_attr("reject_reason", f"replay_error:{type(e).__name__}")
            return PENALTY

        # Sanity reject: overfit / unrealistic / no-trades flags
        for flag in metrics.sanity_flags:
            for kw in _REJECT_FLAG_KEYWORDS:
                if kw in flag:
                    logger.debug(
                        f"[optuna_screener] trial {trial.number} rejected (sanity): {flag}"
                    )
                    _bump("sanity_flag")
                    _bump(f"sanity_flag:{kw}")
                    trial.set_user_attr("reject_reason", f"sanity:{flag}")
                    return PENALTY

        # Hard reject tiny sample (KV-driven threshold)
        if metrics.total_trades < min_n_trades:
            logger.debug(
                f"[optuna_screener] trial {trial.number} n_trades={metrics.total_trades} < {min_n_trades}, rejected"
            )
            _bump("n_trades")
            trial.set_user_attr("reject_reason", f"n_trades<{min_n_trades}:{metrics.total_trades}")
            trial.set_user_attr("n_trades_observed", metrics.total_trades)
            trial.set_user_attr("fill_rate_observed", float(metrics.fill_rate or 0.0))
            return PENALTY

        # Fill rate reject (KV-driven threshold, Sprint 6b reverted from hardcode)
        if metrics.fill_rate < min_fill_rate:
            logger.debug(
                f"[optuna_screener] trial {trial.number} fill_rate={metrics.fill_rate:.2f} < {min_fill_rate}, rejected"
            )
            _bump("fill_rate")
            trial.set_user_attr("reject_reason", f"fill_rate<{min_fill_rate}:{metrics.fill_rate:.3f}")
            trial.set_user_attr("n_trades_observed", metrics.total_trades)
            trial.set_user_attr("fill_rate_observed", float(metrics.fill_rate or 0.0))
            return PENALTY

        # Valid trial — report to Optuna
        _bump("valid")
        sharpe = float(metrics.sharpe or 0.0)
        max_dd = float(metrics.max_drawdown or 1.0)
        trial.set_user_attr("n_trades", metrics.total_trades)
        trial.set_user_attr("win_rate", float(metrics.win_rate or 0.0))
        trial.set_user_attr("profit_factor", float(metrics.profit_factor or 0.0))
        trial.set_user_attr("fill_rate", float(metrics.fill_rate or 0.0))
        return sharpe, max_dd

    return objective


def run_search(
    n_trials: int = 100,
    subset_size: int = 250,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    baseline_params: Optional[dict] = None,
    data_mode: ResearchDataMode | None = None,
) -> dict:
    """
    Sprint 5.2 entry point. Loads stratified subset + BacktestDataset, runs NSGA-II
    Pareto optimization over screener factor weights, returns best-sharpe trial.
    """
    # ── Date defaults: 90 day window ending today (TW) ──────────────────────
    if end_date is None:
        tw_today = (datetime.now(timezone.utc) + timedelta(hours=8)).date().isoformat()
        snapshot_end_date = latest_snapshot_business_end_date(
            kind="backtest_dataset",
            as_of_business_date=tw_today,
        ) if data_mode == "snapshot" else None
        end_date = snapshot_end_date or tw_today
    if start_date is None:
        start_date = (
            datetime.fromisoformat(end_date) - timedelta(days=90)
        ).date().isoformat()

    if baseline_params is None:
        baseline_params = _default_baseline_params()

    logger.info(
        f"[optuna_screener] Sprint 5.2 search: n_trials={n_trials} "
        f"subset_size={subset_size} window={start_date}~{end_date}"
    )

    # ── Step 1: stratified subset (M12 fix: tradable universe, not in_current_watchlist) ──
    symbols = select_stratified_subset(
        target_size=subset_size,
        end_date=end_date,
        lookback_days=30,
    )
    if not symbols:
        raise RuntimeError(
            "stratified_subset returned empty — check D1 stocks/stock_prices state"
        )
    logger.info(f"[optuna_screener] subset picked: {len(symbols)} symbols")

    # ── Step 2: pre-load dataset once ───────────────────────────────────────
    dataset, data_access = BacktestDataset.load_for_research(
        lane="optuna.screener",
        start_date=start_date,
        end_date=end_date,
        symbols=symbols,
        business_date=end_date,
        mode=data_mode,
    )

    # ── Step 3: Optuna NSGA-II Pareto search ────────────────────────────────
    study = optuna.create_study(
        directions=["maximize", "minimize"],  # sharpe↑, max_dd↓
        sampler=NSGAIISampler(seed=42),
        study_name="screener_factor_weights_pareto_s52",
    )
    reject_counter: dict = {}
    study.optimize(
        create_objective(dataset, start_date, end_date, baseline_params, reject_counter),
        n_trials=n_trials,
    )

    # Rejection breakdown diagnostics (top-level categories + detailed subkeys)
    top_level_keys = ("valid", "constraint", "replay_error", "sanity_flag", "n_trades", "fill_rate")
    reject_summary = {k: reject_counter.get(k, 0) for k in top_level_keys}
    reject_details = {k: v for k, v in reject_counter.items() if k not in top_level_keys}
    logger.info(f"[optuna_screener] reject breakdown (top-level): {reject_summary}")
    logger.info(f"[optuna_screener] reject breakdown (details): {reject_details}")

    # ── Step 4: extract Pareto front ────────────────────────────────────────
    pareto_trials = [t for t in study.best_trials if t.values and t.values[0] > -1e8]
    if not pareto_trials:
        raise RuntimeError(
            f"Optuna screener: no feasible Pareto trials out of {n_trials}; "
            "check dataset quality / sanity constraints / search space bounds"
        )

    chosen = max(pareto_trials, key=lambda t: t.values[0])
    best_sharpe, best_max_dd = chosen.values

    logger.info("=" * 60)
    logger.info(f"[optuna_screener] Pareto front size: {len(pareto_trials)}/{n_trials}")
    logger.info(
        f"[optuna_screener] chosen trial #{chosen.number}: "
        f"sharpe={best_sharpe:.3f} max_dd={best_max_dd:.3%} "
        f"n_trades={chosen.user_attrs.get('n_trades')} "
        f"win_rate={chosen.user_attrs.get('win_rate', 0):.1%} "
        f"fill_rate={chosen.user_attrs.get('fill_rate', 0):.1%} "
        f"pf={chosen.user_attrs.get('profit_factor', 0):.2f}"
    )
    for k, v in chosen.params.items():
        logger.info(f"  {k}: {v}")
    logger.info("=" * 60)

    pareto_front = sorted(
        [
            {
                "trial_number": t.number,
                "sharpe": float(t.values[0]),
                "max_dd": float(t.values[1]),
                "n_trades": t.user_attrs.get("n_trades"),
                "win_rate": t.user_attrs.get("win_rate"),
                "fill_rate": t.user_attrs.get("fill_rate"),
                "profit_factor": t.user_attrs.get("profit_factor"),
                "params": t.params,
            }
            for t in pareto_trials
        ],
        key=lambda x: x["sharpe"],
        reverse=True,
    )

    # Build the resolved screener-section dict from chosen trial (what worker will merge)
    resolved_screener = _build_trial_params(chosen, baseline_params)["screener"]

    return {
        "best_params": chosen.params,             # raw Optuna suggest_* values
        "resolved_screener": resolved_screener,    # full screener-section dict for push
        "best_sharpe": float(best_sharpe),
        "best_max_dd": float(best_max_dd),
        "best_n_trades": chosen.user_attrs.get("n_trades"),
        "best_win_rate": chosen.user_attrs.get("win_rate"),
        "best_fill_rate": chosen.user_attrs.get("fill_rate"),
        "best_profit_factor": chosen.user_attrs.get("profit_factor"),
        "pareto_front": pareto_front,
        "pareto_size": len(pareto_trials),
        "reject_summary": reject_summary,
        "reject_details": reject_details,
        "mode": "A",
        "data_source": "backtest_engine.replay_period",
        "data_access": data_access,
        "subset_size": len(symbols),
        "date_window": f"{start_date}~{end_date}",
        "realism_note": (
            "Mode A has 15 documented deviations from production (Sharpe ±0.3~0.8). "
            "Use results for RELATIVE parameter ranking only, not absolute prediction. "
            "Ranking alpha/beta/gamma hardcoded to 1/0/0 (Sprint 6b will revert). "
            "See memory/project_sprint_5_2_hardcode_overrides.md"
        ),
    }
