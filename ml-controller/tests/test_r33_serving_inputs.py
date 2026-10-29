"""R33-NEW-03 inference scope (L2 pool + holdings) and HL2-1#a / C28-16 S3 stale bars."""
from types import SimpleNamespace

import pytest

from services.r33_serving_inputs import holding_stocks, stale_inputs, staleness_report
from test_r33_l4_equal7 import DAY

FEES = {"commission": 0.001425, "tax": 0.003}


def test_stale_inputs_and_report():
    payloads = [{"symbol": "A", "prices": [{"date": "2026-11-09"}, {"date": "2026-11-10"}]},
                {"symbol": "B", "prices": [{"date": "2026-11-07"}]}, {"symbol": "C", "prices": []}]
    stale = stale_inputs(payloads, DAY)
    assert stale == {"B": "last_bar=2026-11-07", "C": "no_bars"}
    assert staleness_report(stale, payload_count=3, run_date=DAY, applied=False)["effect"] == "report_only"
    assert staleness_report(stale, payload_count=3, run_date=DAY, applied=True)["stale_count"] == 2


def test_holdings_join_the_inference_scope_but_never_as_buy_candidates():
    active = [{"id": 1, "symbol": "P1", "market": "TWSE"}]
    account = {"signal_date": DAY, "holdings": [{"symbol": "P1"}, {"symbol": "H7"}]}
    queries = []

    def core_query(sql, params):
        queries.append(params)
        return [{"id": 7, "symbol": "H7", "name": "H", "market": "TWSE"}]

    added, held = holding_stocks(signal_date=DAY, active_stocks=active, account_reader=lambda d: account,
                                 core_query=core_query)
    assert held == ["H7", "P1"] and queries == [["H7"]]
    assert [s["symbol"] for s in added] == ["H7"] and added[0]["eligible_for_pending_buy"] is False
    with pytest.raises(ValueError, match="r33_holdings_unavailable"):
        holding_stocks(signal_date=DAY, active_stocks=active, account_reader=lambda d: {**account, "signal_date": "x"},
                       core_query=core_query)
    with pytest.raises(ValueError, match="r33_holding_stock_identity_missing"):
        holding_stocks(signal_date=DAY, active_stocks=active, account_reader=lambda d: account,
                       core_query=lambda sql, params: [])


@pytest.mark.parametrize("equal7", [True, False])
def test_market_env_adds_holdings_only_with_the_equal7_bundle(monkeypatch, equal7):
    import asyncio

    from graphs import daily_pipeline_v2 as pipeline
    from services import l4_distribution_context, premarket_pipeline
    from test_r33_l4_equal7 import _bundle
    artifact = _bundle() if equal7 else {"model": {"schema_version": "l4-distribution-model-v1"}}
    cfg = {"fees": FEES, "l4Distribution": {"artifact": artifact}}

    async def env(_day):
        return {}, {}, {}, {}, cfg
    monkeypatch.setattr(pipeline, "_load_market_env_with_backoff", env)
    monkeypatch.setattr(pipeline, "_resolve_runtime_regime_contract", lambda *a, **k: {})
    monkeypatch.setattr(pipeline, "load_effective_adaptive_params", lambda **k: {})
    monkeypatch.setattr(premarket_pipeline, "enabled", lambda: False)
    calls = []

    def worker_request(path, body):
        calls.append((path, body))
        return {"signal_date": DAY, "holdings": [{"symbol": "H7"}]}
    monkeypatch.setattr(l4_distribution_context, "worker_request", worker_request)
    monkeypatch.setattr(pipeline, "CORE_D1_CLIENT", SimpleNamespace(
        query=lambda sql, params: [{"id": 7, "symbol": "H7", "name": "H", "market": "TWSE"}]))
    active = [{"id": 1, "symbol": "P1", "market": "TWSE"}]
    out = asyncio.run(pipeline.node_load_market_env({"run_date": DAY, "active_stocks": active}))
    if equal7:
        assert calls == [("/api/internal/l4-distribution/account", {"signal_date": DAY})]
        assert out["r33_holdings"] == ["H7"]
        assert [s["symbol"] for s in out["active_stocks"]] == ["P1", "H7"]
        assert out["active_stocks"][1]["eligible_for_pending_buy"] is False
    else:
        assert calls == [] and "r33_holdings" not in out and "active_stocks" not in out
