from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import opb_counterfactual_prior


def test_opb_prior_loader_passes_learning_core_and_market_owners_separately(monkeypatch) -> None:
    observed: dict[str, object] = {}

    def learning_query(_sql, _params):
        raise AssertionError("learning_query_is_consumed_by_fusion_loader")

    def core_query(_sql, _params):
        raise AssertionError("core_query_is_consumed_by_fusion_loader")

    def market_query(sql, params):
        observed["market_sql"] = sql
        observed["market_params"] = params
        return [{"stock_id": 1, "price_date": "2026-08-18", "close": 100.0}]

    def fake_fusion_loader(query_fn, **kwargs):
        observed["learning_query"] = query_fn
        observed["core_query"] = kwargs.get("core_query_fn")
        return [{
            "stock_id": 1,
            "symbol": "2330",
            "prediction_date": "2026-08-18",
            "l4_executable_return_pct": 0.02,
        }]

    monkeypatch.setattr(
        opb_counterfactual_prior,
        "load_allocator_ev_fusion_training_rows",
        fake_fusion_loader,
    )
    rows, prices = opb_counterfactual_prior.load_opb_counterfactual_inputs(
        end_date="2026-08-25",
        learning_query_fn=learning_query,
        core_query_fn=core_query,
        market_query_fn=market_query,
    )

    assert observed["learning_query"] is learning_query
    assert observed["core_query"] is core_query
    assert "FROM stock_prices" in str(observed["market_sql"])
    assert rows[0]["actual_return_pct"] == 0.02
    assert prices[0]["symbol"] == "2330"
