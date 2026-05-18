from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.market_regime_evidence import build_regime_evidence_pack  # noqa: E402


def test_bear_label_is_downgraded_when_only_price_weakness_supports_it():
    pack = build_regime_evidence_pack(
        {
            "twii_return_1d": -0.012,
            "twii_return_5d": -0.024,
            "twii_bias_20d": -0.018,
            "history": {
                "2026-05-14": {"market_return_1d": -0.011},
                "2026-05-15": {"market_return_1d": -0.013},
            },
            "advance_ratio": 0.52,
            "bull_alignment_pct": 0.58,
            "us_vix": 18.0,
            "us_gspc_return": 0.003,
            "us_sox_return": 0.002,
        },
        raw_label="bear_market",
    )

    assert pack["raw_label"] == "bear_market"
    assert pack["effective_label"] == "volatile"
    assert pack["transition_guard"]["status"] == "blocked"
    assert pack["transition_guard"]["reason"] == "insufficient_cross_evidence_for_bear"
    assert pack["support_counts"]["bearish"] < 3


def test_bear_label_is_confirmed_when_breadth_volatility_and_global_evidence_agree():
    pack = build_regime_evidence_pack(
        {
            "twii_return_1d": -0.018,
            "twii_return_5d": -0.061,
            "twii_bias_20d": -0.082,
            "history": {
                "2026-05-11": {"market_return_1d": -0.015, "limit_down_pct": 0.001},
                "2026-05-12": {"market_return_1d": -0.018, "limit_down_pct": 0.003},
                "2026-05-13": {"market_return_1d": -0.012, "limit_down_pct": 0.004},
                "2026-05-14": {"market_return_1d": -0.021, "limit_down_pct": 0.009},
                "2026-05-15": {"market_return_1d": -0.010, "limit_down_pct": 0.011},
            },
            "advance_ratio": 0.31,
            "bull_alignment_pct": 0.22,
            "us_vix": 34.0,
            "us_gspc_return": -0.022,
            "us_sox_return": -0.038,
            "us_hy_spread_chg": 0.35,
            "margin_change_5d": 0.082,
        },
        raw_label="bear_market",
    )

    assert pack["effective_label"] == "bear_market"
    assert pack["transition_guard"]["status"] == "confirmed"
    assert pack["support_counts"]["bearish"] >= 3
    assert pack["evidence"]["breadth"]["stance"] == "bearish"
    assert pack["evidence"]["atr_vturn"]["stance"] == "bearish"
    assert pack["monitors"]["hawkes_contagion"]["decision_effect"] == "context_only"
    assert pack["monitors"]["lppls_weekly_bubble"]["decision_effect"] == "context_only"
