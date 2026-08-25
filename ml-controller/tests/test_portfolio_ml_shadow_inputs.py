from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import portfolio_ml_shadow_inputs as inputs  # noqa: E402
from services.rfs_implementable_frontier_shadow import (  # noqa: E402
    build_rfs_implementable_frontier_shadow,
)


class _QueryStub:
    def __init__(self, rows):
        self.rows = rows

    def query(self, _sql, _params=None, timeout=60.0):
        del timeout
        return list(self.rows)


def _training_rows():
    rows = []
    for date_idx in range(6):
        for symbol_idx in range(6):
            expected = 0.004 + symbol_idx * 0.001
            for horizon in (3, 5, 10):
                rows.append({
                    "snapshot_date": f"2026-07-{date_idx + 1:02d}",
                    "symbol": f"S{symbol_idx}",
                    "score": 55 + symbol_idx,
                    "alpha_allocation": json.dumps({
                        "expected_return": expected,
                        "allocation_weight": 1 / 6,
                    }),
                    "market_heat_expected_return": 0.001,
                    "market_segment": "LISTED",
                    "horizon_days": horizon,
                    "residual_return_net": expected * horizon / 5,
                    "outcome_known_date": "2026-08-01",
                })
    return rows


def test_portfolio_ml_inputs_learn_all_components_without_top_k(monkeypatch):
    monkeypatch.setattr(inputs, "LEARNING_D1_CLIENT", _QueryStub(_training_rows()))
    candidates = [
        {
            "symbol": f"S{idx}",
            "score": 60 + idx,
            "expected_return": 0.006 + idx * 0.001,
            "alpha_allocation": {},
            "market_heat_expected_return": 0.001,
        }
        for idx in range(6)
    ]
    inherited = {
        "status": "ready",
        "weights": {"S0": 0.20, "S1": 0.10},
        "portfolio_value_twd": 1_000_000.0,
    }
    packet = inputs.build_portfolio_ml_shadow_inputs(
        candidates,
        as_of_date="2026-08-24",
        inherited_state=inherited,
    )

    assert packet["status"] == "shadow_ready"
    assert packet["training_date_count"] == 6
    assert set(packet["multi_horizon_expected_return_path"]) == {f"S{i}" for i in range(6)}
    assert set(packet["direct_weight_targets"]) == {f"S{i}" for i in range(6)}
    assert set(packet["dynamic_trading_speeds"]) == {f"S{i}" for i in range(6)}
    assert packet["production_effect"] is False


def test_portfolio_ml_shadow_uses_full_pool_and_keeps_production_firewall(monkeypatch):
    monkeypatch.setattr(inputs, "LEARNING_D1_CLIENT", _QueryStub(_training_rows()))
    symbols = [f"S{i}" for i in range(6)]
    candidates = [
        {
            "symbol": symbol,
            "score": 60 + idx,
            "expected_return": 0.006 + idx * 0.001,
            "expected_return_owner": "l4_alpha_ev",
            "avg_daily_turnover_twd": 200_000_000.0,
            "market_heat_expected_return": 0.001,
        }
        for idx, symbol in enumerate(symbols)
    ]
    inherited = {
        "status": "ready",
        "weights": {"S0": 0.20, "S1": 0.10},
        "portfolio_value_twd": 1_000_000.0,
    }
    portfolio_inputs = inputs.build_portfolio_ml_shadow_inputs(
        candidates,
        as_of_date="2026-08-24",
        inherited_state=inherited,
    )
    packet = build_rfs_implementable_frontier_shadow(
        candidates,
        {symbol: [0.001 * ((idx % 5) - 2) for idx in range(40)] for symbol in symbols},
        incumbent_weights={symbol: 1 / 6 for symbol in symbols},
        inherited_weights=inherited["weights"],
        portfolio_ml_inputs=portfolio_inputs,
        max_weight=0.25,
    )

    assert packet["candidate_pool_policy"] == "full_formal_expected_return_pool_no_hard_top_k"
    assert packet["metrics"]["portfolio_ml_applied"] is True
    assert packet["research_components_not_yet_implemented"] == []
    assert packet["production_effect"] is False
    assert packet["promotion_eligible"] is False

def test_training_lineage_joins_reference_carrier_before_canonical_outcome(monkeypatch):
    captured: dict[str, object] = {}

    class _CaptureQuery:
        def query(self, sql, params=None, timeout=60.0):
            captured["sql"] = sql
            captured["params"] = params
            captured["timeout"] = timeout
            return []

    monkeypatch.setattr(inputs, "LEARNING_D1_CLIENT", _CaptureQuery())
    inputs._load_training_rows("2026-08-24", 365)

    sql = str(captured["sql"])
    assert "JOIN selection_reference_snapshots_v1 r" in sql
    assert "o.producer_run_id = r.producer_run_id" in sql
    assert "o.producer_run_id = a.lineage_cohort_id" not in sql
    assert "date(o.outcome_known_date) <= date(?)" in sql
    assert "a.generation_mode = 'native'" in sql
