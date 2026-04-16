"""
test_wfe.py — Per-fold WFE metric and acceptance gate tests.

Covers:
  - compute_wfe_score edge cases (zero DD, negative CAGR, threshold boundaries)
  - compute_fold_wfe trade simulation (stop hit, target hit, no trades)
  - apply_wfe_gate min-aggregation logic (worst fold dominates)
"""
import numpy as np
import pytest

from app.wfe import (
    FoldWFE,
    WFEGateResult,
    compute_fold_wfe,
    compute_wfe_score,
    apply_wfe_gate,
    DEFAULT_CONFIG,
)


# ═══════════════════════════════════════════════════════════════════════════
# compute_wfe_score — edge cases
# ═══════════════════════════════════════════════════════════════════════════
class TestWfeScore:
    def test_both_thresholds_met_returns_ge_1(self):
        # CAGR 20% vs target 15%, DD -10% vs target -20% → both pass
        score = compute_wfe_score(0.20, -0.10, target_cagr=0.15, target_max_dd=-0.20)
        assert score >= 1.0

    def test_cagr_fail_dominates(self):
        # CAGR 5% vs target 15% (ratio 0.33), DD -5% vs -20% (ratio 4.0) → min = 0.33
        score = compute_wfe_score(0.05, -0.05, target_cagr=0.15, target_max_dd=-0.20)
        assert score == pytest.approx(0.05 / 0.15, abs=0.01)

    def test_dd_fail_dominates(self):
        # CAGR 30% vs target 15% (ratio 2.0), DD -40% vs -20% (ratio 0.5) → min = 0.5
        score = compute_wfe_score(0.30, -0.40, target_cagr=0.15, target_max_dd=-0.20)
        assert score == pytest.approx(0.5, abs=0.01)

    def test_zero_drawdown_caps_at_10(self):
        # No DD → dd_ratio = 10.0 (cap); CAGR 15% → 1.0; min = 1.0
        score = compute_wfe_score(0.15, 0.0, target_cagr=0.15, target_max_dd=-0.20)
        assert score == pytest.approx(1.0, abs=0.01)

    def test_negative_cagr_yields_negative_score(self):
        score = compute_wfe_score(-0.10, -0.10, target_cagr=0.15, target_max_dd=-0.20)
        assert score < 0

    def test_invalid_target_cagr_falls_back(self):
        # target_cagr <= 0 should fall back to 0.15 silently
        score = compute_wfe_score(0.15, -0.20, target_cagr=-1.0, target_max_dd=-0.20)
        assert score == pytest.approx(1.0, abs=0.01)


# ═══════════════════════════════════════════════════════════════════════════
# compute_fold_wfe — trade simulation
# ═══════════════════════════════════════════════════════════════════════════
def _bars(closes, highs=None, lows=None):
    n = len(closes)
    if highs is None:
        highs = [c * 1.01 for c in closes]
    if lows is None:
        lows = [c * 0.99 for c in closes]
    return [
        {"close": float(c), "high": float(h), "low": float(l)}
        for c, h, l in zip(closes, highs, lows)
    ]


class TestComputeFoldWfe:
    def test_empty_fold_returns_zero_metrics(self):
        fold = compute_fold_wfe(0, np.array([]), np.array([]), [], np.array([]))
        assert fold.n_trades == 0
        assert fold.cagr == 0.0
        assert fold.max_dd == 0.0
        assert fold.wfe_score == 0.0

    def test_mismatched_lengths_return_zero(self):
        fold = compute_fold_wfe(
            0, np.array([1, 0]), np.array([0.6, 0.4]), [{"close": 100, "high": 101, "low": 99}],
            np.array([1.0, 1.0]),
        )
        assert fold.n_trades == 0

    def test_low_confidence_skips_trades(self):
        # All predictions below 0.55 threshold → no trades opened
        preds = np.array([1, 1, 1, 1, 1, 1, 1])
        proba = np.array([0.50, 0.50, 0.50, 0.50, 0.50, 0.50, 0.50])
        bars = _bars([100, 101, 102, 103, 104, 105, 106])
        atr = np.array([2.0] * 7)
        fold = compute_fold_wfe(0, preds, proba, bars, atr)
        assert fold.n_trades == 0

    def test_trending_up_profitable_trade(self):
        # Price rallies 100 → 120; entry @ 100, target1 @ 104, target2 @ 108 (ATR=2)
        # With high confidence → should open trade, hit target2, positive PnL
        preds = np.array([1, 0, 0, 0, 0, 0, 0, 0])
        proba = np.array([0.85, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5])
        bars = _bars([100, 105, 110, 115, 120, 125, 130, 135])
        atr = np.array([2.0] * 8)
        fold = compute_fold_wfe(0, preds, proba, bars, atr)
        assert fold.n_trades == 1
        assert fold.avg_trade_pnl_pct > 0
        assert fold.win_rate == 1.0

    def test_trending_down_triggers_stop(self):
        # Price crashes 100 → 80; entry @ 100 long, stop @ 96 (ATR=2)
        # Should hit stop on bar 2 or 3 → negative PnL
        preds = np.array([1, 0, 0, 0, 0, 0, 0, 0])
        proba = np.array([0.85, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5])
        bars = _bars([100, 95, 90, 85, 80, 75, 70, 65])
        atr = np.array([2.0] * 8)
        fold = compute_fold_wfe(0, preds, proba, bars, atr)
        assert fold.n_trades == 1
        assert fold.avg_trade_pnl_pct < 0
        assert fold.win_rate == 0.0
        assert fold.max_dd < 0

    def test_cooldown_prevents_concurrent_trades(self):
        # High confidence every bar; default hold_days=5 → should open only 1 trade
        # in the first 5 bars
        preds = np.array([1] * 8)
        proba = np.array([0.85] * 8)
        bars = _bars([100, 101, 102, 103, 104, 105, 106, 107])
        atr = np.array([2.0] * 8)
        fold = compute_fold_wfe(0, preds, proba, bars, atr)
        # With 8 bars and hold=5, max 2 trades (bar 0 cooldown to 5, bar 5-7 = 1 more possible
        # but bar 7 has no future bars so skipped)
        assert fold.n_trades <= 2

    def test_zero_atr_skips_trade(self):
        # ATR=0 cannot size stop/target → skip
        preds = np.array([1])
        proba = np.array([0.85])
        bars = _bars([100, 101])
        atr = np.array([0.0, 0.0])
        fold = compute_fold_wfe(0, preds, proba, bars, atr)
        assert fold.n_trades == 0


# ═══════════════════════════════════════════════════════════════════════════
# apply_wfe_gate — min-aggregation logic
# ═══════════════════════════════════════════════════════════════════════════
def _fold(window=0, cagr=0.15, max_dd=-0.10, n_trades=10, wfe_score=1.0) -> FoldWFE:
    return FoldWFE(
        window=window,
        n_trades=n_trades,
        cagr=cagr,
        max_dd=max_dd,
        sharpe=1.0,
        win_rate=0.55,
        avg_trade_pnl_pct=0.02,
        wfe_score=wfe_score,
    )


class TestApplyWfeGate:
    def test_all_folds_pass_accepts(self):
        folds = [_fold(i, cagr=0.15, max_dd=-0.10, wfe_score=1.0) for i in range(12)]
        result = apply_wfe_gate(folds)
        assert result.gate_pass is True
        assert result.n_folds == 12
        assert result.fail_reasons == []

    def test_single_bad_fold_rejects_entire_model(self):
        # 11 good folds + 1 catastrophic → rejected (min-aggregation)
        folds = [_fold(i, cagr=0.15, max_dd=-0.10, wfe_score=1.0) for i in range(11)]
        folds.append(_fold(11, cagr=-0.35, max_dd=-0.40, wfe_score=-2.3))
        result = apply_wfe_gate(folds)
        assert result.gate_pass is False
        assert result.worst_fold_cagr == pytest.approx(-0.35, abs=0.01)
        assert result.worst_fold_dd == pytest.approx(-0.40, abs=0.01)
        assert len(result.fail_reasons) > 0

    def test_empty_folds_rejected(self):
        result = apply_wfe_gate([])
        assert result.gate_pass is False
        assert "no_valid_folds" in result.fail_reasons

    def test_all_zero_trade_folds_rejected(self):
        folds = [_fold(i, n_trades=0) for i in range(5)]
        result = apply_wfe_gate(folds)
        assert result.gate_pass is False
        assert "no_valid_folds" in result.fail_reasons

    def test_median_cagr_ignores_outliers(self):
        # One outlier should not drag median (unlike mean)
        folds = [_fold(i, cagr=0.10, max_dd=-0.05, wfe_score=0.67) for i in range(10)]
        folds.append(_fold(10, cagr=0.50, max_dd=-0.05, wfe_score=3.3))
        result = apply_wfe_gate(folds)
        assert result.median_fold_cagr == pytest.approx(0.10, abs=0.01)

    def test_custom_thresholds_override_defaults(self):
        # Relax gate: target_cagr 5%, max_fold_dd -50%
        folds = [_fold(i, cagr=0.06, max_dd=-0.25, wfe_score=1.2) for i in range(10)]
        cfg = {
            "min_wfe_score": 1.0,
            "min_fold_cagr": 0.05,
            "max_fold_dd": -0.50,
            "target_cagr": 0.05,
            "target_max_dd": -0.30,
        }
        result = apply_wfe_gate(folds, cfg=cfg)
        assert result.gate_pass is True

    def test_accepts_dict_folds(self):
        # Gate should accept dict input (e.g. from deserialized JSON)
        folds = [
            {
                "window": 0, "n_trades": 5, "cagr": 0.20, "max_dd": -0.10,
                "sharpe": 1.5, "win_rate": 0.6, "avg_trade_pnl_pct": 0.03,
                "wfe_score": 1.33,
            }
        ]
        result = apply_wfe_gate(folds)
        assert result.gate_pass is True
