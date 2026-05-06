from __future__ import annotations

import sys
from itertools import combinations
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.pbo_service import _run_cscv_rank_logit_pbo  # noqa: E402


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
