from __future__ import annotations

import sys
from itertools import combinations
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.pbo_service import (  # noqa: E402
    DEFAULT_EMBARGO_DAYS,
    _resolve_dynamic_embargo_days,
    _run_cpcv,
    _run_cscv_rank_logit_pbo,
)


def test_cscv_rank_logit_pbo_passes_when_is_winner_also_ranks_high_oos():
    result = _run_cscv_rank_logit_pbo({
        "stable_alpha": [0.03, 0.025, 0.028, 0.026, 0.031, 0.027],
        "weak_alpha": [0.01, 0.008, 0.009, 0.007, 0.011, 0.006],
        "bad_alpha": [-0.01, -0.008, -0.009, -0.006, -0.012, -0.007],
    })

    assert result.method == "cscv_rank_logit"
    assert result.go_live_verdict == "PASS"
    assert result.pbo == 0.0
    assert min(result.oos_rank_percentiles) > 0.5


def test_cscv_rank_logit_pbo_fails_when_is_winner_collapses_oos():
    candidates = {"robust": [0.02, 0.02, 0.02, 0.02, 0.02, 0.02]}
    for combo in combinations(range(6), 3):
        candidates[f"curve_fit_{combo}"] = [
            0.10 if idx in combo else -0.08
            for idx in range(6)
        ]

    result = _run_cscv_rank_logit_pbo(candidates)

    assert result.method == "cscv_rank_logit"
    assert result.go_live_verdict == "FAIL"
    assert result.pbo > 0.5
    assert min(result.logit_values) < 0.0


def test_dynamic_embargo_uses_trade_label_horizon():
    days, source = _resolve_dynamic_embargo_days([
        {"label_horizon_days": 3},
        {"barrier_horizon_days": 8},
        {"holding_period_days": 5},
    ])

    assert days == 8
    assert source == "trade_horizon"


def test_dynamic_embargo_uses_default_when_horizon_missing():
    days, source = _resolve_dynamic_embargo_days([{"symbol": "2330"}])

    assert days == DEFAULT_EMBARGO_DAYS
    assert source == "default"


def test_cpcv_records_dynamic_embargo_metadata():
    trades = []
    for i in range(40):
        day = i + 1
        trades.append({
            "entry_date": f"2026-01-{day:02d}" if day <= 28 else f"2026-02-{day - 28:02d}",
            "exit_date": f"2026-01-{day:02d}" if day <= 28 else f"2026-02-{day - 28:02d}",
            "profit_ratio": 0.01 if i % 3 else -0.005,
            "label_horizon_days": 7,
        })

    result = _run_cpcv(trades, n_partitions=5)

    assert result.embargo_days == 7
    assert result.embargo_source == "trade_horizon"
    assert result.n_partitions == 5
