"""
wfe.py — Walk-Forward Efficiency (per-fold financial metrics + acceptance gate)

Replaces accuracy-only walk-forward aggregation with per-fold CAGR/MaxDD/Sharpe
and a min-aggregated acceptance gate. Prevents tail-risk models (good average,
one catastrophic fold) from reaching production.

References:
  - Pardo, R. (2008). "The Evaluation and Optimization of Trading Strategies."
    Original WFE definition: OOS Return / IS Return, threshold 0.5–0.6.
  - López de Prado, M. (2018). "Advances in Financial Machine Learning" Ch.7, 14.
    Per-fold metrics required to detect overfitting (PBO, deflated Sharpe).
  - Bailey, Borwein, López de Prado, Zhu (2014). "Pseudo-Mathematics and
    Financial Charlatanism." Notices AMS. Single-fold aggregation inflates Sharpe.
  - Harvey, Liu, Zhu (2016). "…and the Cross-Section of Expected Returns." RFS.
    Multiple-testing adjustment under repeated folds.

Gate logic is min-aggregation (robust statistics): the worst fold is the bound,
not the mean. A model with 12 folds averaging 15% but one fold at −30% is
rejected; a model averaging 12% with worst fold at +3% is accepted.
"""
from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Sequence

import numpy as np


# ── Defaults (tunable via config) ────────────────────────────────────────────
DEFAULT_CONFIG = {
    # Trade execution
    "hold_days": 5,              # bars held after entry (unless stop/target hit first)
    "confidence_threshold": 0.55,  # proba required to open a position
    "atr_stop_mult": 2.0,        # stop = entry ∓ ATR × mult
    "atr_target1_mult": 2.0,     # partial TP
    "atr_target2_mult": 4.0,     # full TP
    "enable_shorts": False,      # long-only by default (Taiwan constraint)
    # Gate thresholds (annualized)
    "target_cagr": 0.15,         # 15% annualized
    "target_max_dd": -0.20,      # tolerate −20% drawdown per fold
    "min_wfe_score": 1.0,        # KFlux-style score ≥ 1 means both thresholds pass
    "min_fold_cagr": 0.0,        # hard floor: worst fold must be non-negative
    "max_fold_dd": -0.30,        # hard ceiling: worst fold DD must be > −30%
}


@dataclass
class FoldWFE:
    """Per-fold financial metrics + WFE score."""
    window: int
    n_trades: int
    cagr: float
    max_dd: float
    sharpe: float | None
    win_rate: float
    avg_trade_pnl_pct: float
    wfe_score: float  # min(cagr/target_cagr, |target_dd|/|max_dd|)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class WFEGateResult:
    """Aggregated gate decision for model acceptance."""
    gate_pass: bool
    n_folds: int
    min_wfe_score: float
    worst_fold_cagr: float
    worst_fold_dd: float
    median_fold_cagr: float
    fail_reasons: list[str]

    def to_dict(self) -> dict:
        return asdict(self)


# ── Trade simulation (minimal, long-first) ───────────────────────────────────
def _simulate_single_trade(
    direction: str,
    entry: float,
    stop: float,
    target1: float,
    target2: float,
    future_bars: Sequence[dict],
) -> float:
    """
    Simulate one trade bar-by-bar; return raw PnL pct (exit/entry − 1 for long).

    Mirrors ml-controller._trade_simulator semantics: hit_target2 → full TP,
    hit_target1 → partial TP (stop disabled after), hit_stop → stop loss,
    expired → exit at last close.
    """
    is_long = direction == "up"
    exit_price = entry
    hit_t1 = False

    for bar in future_bars:
        high = bar.get("high")
        low = bar.get("low")
        close = bar.get("close")
        if high is None or low is None:
            continue
        exit_price = close if close is not None else exit_price

        if is_long:
            if high >= target2:
                exit_price = target2
                break
            if high >= target1 and not hit_t1:
                exit_price = target1
                hit_t1 = True
            if not hit_t1 and low <= stop:
                exit_price = stop
                break
        else:
            if low <= target2:
                exit_price = target2
                break
            if low <= target1 and not hit_t1:
                exit_price = target1
                hit_t1 = True
            if not hit_t1 and high >= stop:
                exit_price = stop
                break

    pnl_pct = (exit_price - entry) / entry if is_long else (entry - exit_price) / entry
    return float(pnl_pct)


def compute_fold_wfe(
    window: int,
    preds: np.ndarray,
    proba_up: np.ndarray,
    bars: list[dict],
    atr: np.ndarray,
    cfg: dict | None = None,
) -> FoldWFE:
    """
    Simulate trades on a single OOS fold using ML signals, compute per-fold metrics.

    Args:
        window: fold index
        preds: binary predictions aligned with bars (1=up, 0=down)
        proba_up: P(up) aligned with bars; used for confidence filter
        bars: OHLC dicts aligned with preds (same length, same order)
        atr: ATR values aligned with bars (for stop/target sizing)
        cfg: override DEFAULT_CONFIG

    Returns:
        FoldWFE with cagr/max_dd/sharpe/wfe_score. Empty folds return zeros.
    """
    c = {**DEFAULT_CONFIG, **(cfg or {})}
    n = len(bars)
    if n == 0 or len(preds) != n or len(atr) != n:
        return FoldWFE(window, 0, 0.0, 0.0, None, 0.0, 0.0, 0.0)

    equity = [1.0]
    trade_pnls: list[float] = []
    cooldown_until = -1  # next index where a new trade may be opened

    for i in range(n):
        if i < cooldown_until:
            continue

        prob_up = float(proba_up[i])
        confident_up = prob_up >= c["confidence_threshold"]
        confident_dn = (1.0 - prob_up) >= c["confidence_threshold"]

        if confident_up:
            direction = "up"
        elif confident_dn and c["enable_shorts"]:
            direction = "down"
        else:
            continue

        entry = bars[i].get("close")
        atr_val = float(atr[i]) if not np.isnan(atr[i]) else 0.0
        if entry is None or entry <= 0 or atr_val <= 0:
            continue

        if direction == "up":
            stop = entry - c["atr_stop_mult"] * atr_val
            target1 = entry + c["atr_target1_mult"] * atr_val
            target2 = entry + c["atr_target2_mult"] * atr_val
        else:
            stop = entry + c["atr_stop_mult"] * atr_val
            target1 = entry - c["atr_target1_mult"] * atr_val
            target2 = entry - c["atr_target2_mult"] * atr_val

        future = bars[i + 1 : i + 1 + c["hold_days"]]
        if not future:
            continue

        pnl_pct = _simulate_single_trade(direction, entry, stop, target1, target2, future)
        trade_pnls.append(pnl_pct)
        equity.append(equity[-1] * (1.0 + pnl_pct))
        cooldown_until = i + c["hold_days"]

    if not trade_pnls:
        return FoldWFE(window, 0, 0.0, 0.0, None, 0.0, 0.0, 0.0)

    equity_arr = np.asarray(equity, dtype=np.float64)
    total_return = float(equity_arr[-1] - 1.0)

    # Annualize using trading-day span
    cagr = (
        (1.0 + total_return) ** (252.0 / max(n, 1)) - 1.0
        if 1.0 + total_return > 0.0
        else -1.0
    )

    running_max = np.maximum.accumulate(equity_arr)
    drawdown = equity_arr / running_max - 1.0
    max_dd = float(drawdown.min())

    if len(equity_arr) > 2:
        rets = np.diff(equity_arr) / equity_arr[:-1]
        std = float(np.std(rets, ddof=1))
        sharpe: float | None = (
            float(np.mean(rets)) / std * np.sqrt(252.0) if std > 1e-12 else None
        )
    else:
        sharpe = None

    win_rate = float(sum(1 for t in trade_pnls if t > 0) / len(trade_pnls))
    avg_pnl = float(np.mean(trade_pnls))

    wfe_score = compute_wfe_score(cagr, max_dd, c["target_cagr"], c["target_max_dd"])

    return FoldWFE(
        window=window,
        n_trades=len(trade_pnls),
        cagr=round(cagr, 4),
        max_dd=round(max_dd, 4),
        sharpe=round(sharpe, 4) if sharpe is not None else None,
        win_rate=round(win_rate, 4),
        avg_trade_pnl_pct=round(avg_pnl, 4),
        wfe_score=round(wfe_score, 4),
    )


def compute_wfe_score(
    fold_cagr: float,
    fold_max_dd: float,
    target_cagr: float = 0.15,
    target_max_dd: float = -0.20,
) -> float:
    """
    KFlux-style min-aggregated score: min(cagr/target, |target_dd|/|actual_dd|).

    Score ≥ 1.0 ⇔ both CAGR and DD meet their thresholds.
    Score < 1.0 ⇔ at least one metric fails (which one = tighter of two ratios).

    Edge cases:
      - fold_max_dd == 0 and fold_cagr ≥ 0   → perfect fold, score = +∞ capped at 10
      - fold_max_dd == 0 and fold_cagr < 0   → score = −∞ capped at −10 (loss without DD is impossible but guard)
      - target_cagr <= 0                     → treat as 0.15 fallback
    """
    if target_cagr <= 0:
        target_cagr = 0.15

    cagr_ratio = fold_cagr / target_cagr

    if fold_max_dd >= 0:
        # No drawdown at all: cap to 10x to avoid inf; return the CAGR ratio
        dd_ratio = 10.0
    else:
        dd_ratio = abs(target_max_dd) / abs(fold_max_dd)

    score = min(cagr_ratio, dd_ratio)
    # Cap to avoid extreme values dominating downstream visualization
    return float(max(-10.0, min(10.0, score)))


def apply_wfe_gate(
    fold_metrics: Sequence[FoldWFE | dict],
    cfg: dict | None = None,
) -> WFEGateResult:
    """
    Model acceptance gate. All three conditions must pass:

        1. min(wfe_score)        ≥ cfg['min_wfe_score']     (≥ 1.0 default)
        2. min(fold_cagr)        ≥ cfg['min_fold_cagr']     (≥ 0 default)
        3. min(fold_max_dd)      ≥ cfg['max_fold_dd']       (≥ −0.30 default; larger is better for negatives)

    min-aggregation is the robust statistic of choice: the worst fold bounds
    live behavior. A model with a catastrophic fold is rejected even if the
    mean looks good.
    """
    c = {**DEFAULT_CONFIG, **(cfg or {})}

    folds = [f if isinstance(f, FoldWFE) else FoldWFE(**f) for f in fold_metrics]
    valid = [f for f in folds if f.n_trades > 0]

    if not valid:
        return WFEGateResult(
            gate_pass=False,
            n_folds=0,
            min_wfe_score=0.0,
            worst_fold_cagr=0.0,
            worst_fold_dd=0.0,
            median_fold_cagr=0.0,
            fail_reasons=["no_valid_folds"],
        )

    cagrs = [f.cagr for f in valid]
    dds = [f.max_dd for f in valid]
    scores = [f.wfe_score for f in valid]

    min_score = float(min(scores))
    worst_cagr = float(min(cagrs))
    worst_dd = float(min(dds))
    median_cagr = float(np.median(cagrs))

    reasons: list[str] = []
    if min_score < c["min_wfe_score"]:
        reasons.append(
            f"min_wfe_score={min_score:.2f} < threshold={c['min_wfe_score']:.2f}"
        )
    if worst_cagr < c["min_fold_cagr"]:
        reasons.append(
            f"worst_fold_cagr={worst_cagr:.2%} < min={c['min_fold_cagr']:.2%}"
        )
    if worst_dd < c["max_fold_dd"]:
        reasons.append(
            f"worst_fold_dd={worst_dd:.2%} < min={c['max_fold_dd']:.2%}"
        )

    return WFEGateResult(
        gate_pass=(len(reasons) == 0),
        n_folds=len(valid),
        min_wfe_score=round(min_score, 4),
        worst_fold_cagr=round(worst_cagr, 4),
        worst_fold_dd=round(worst_dd, 4),
        median_fold_cagr=round(median_cagr, 4),
        fail_reasons=reasons,
    )
