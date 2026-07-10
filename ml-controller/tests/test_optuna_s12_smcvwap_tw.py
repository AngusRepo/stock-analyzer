from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "optuna_scripts"))

from optuna_s12_smcvwap_tw import normalize_s12_replay_rows, search_s12_smcvwap_tw  # noqa: E402


def test_normalize_s12_replay_rows_extracts_policy_features():
    rows = [
        {
            "trade_pnl_r": 1.2,
            "detail_json": json.dumps(
                {
                    "assessment_detail": (
                        "equity_mutation_score=5;"
                        "vwap_fast_reasons=session_vwap_above|rolling15m_7_above;"
                        "equity_mutation_stop_risk_pct=0.031;"
                        "equity_mutation_stop_risk_atr=1.8"
                    )
                }
            ),
        }
    ]

    normalized = normalize_s12_replay_rows(rows)

    assert normalized == [
        {
            "pnl_r": 1.2,
            "mutation_score": 5.0,
            "fast_vwap_signals": 2.0,
            "stop_risk_pct": 0.031,
            "stop_risk_atr": 1.8,
        }
    ]


def test_s12_optuna_fails_closed_when_replay_is_sparse():
    result = search_s12_smcvwap_tw([{"trade_pnl_r": 0.5, "detail_json": "{}"}] * 10, n_trials=10)

    assert result["status"] == "insufficient_data"
    assert result["reason"] == "s12_replay_samples_lt_40"
