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


def _node_inputs(monkeypatch, *, ensemble, fees=FEES, holdings=("H7",), payload_days=None):
    from graphs import daily_pipeline_v2 as pipeline
    from services import paired_nav_collection, r33_rank_pool
    from services.r33_calibration_job import POOL_SOURCE
    from test_r33_l4_equal7 import IDENTITY, POOL, _prediction
    receipt = {"source": POOL_SOURCE, "signal_date": DAY, "screener_run_id": "run-1", "membership_sha256": "p" * 64}
    queried = []
    monkeypatch.setattr(r33_rank_pool, "load_serving_pool",
                        lambda query, **kw: queried.append(kw) or (list(POOL), receipt))
    monkeypatch.setattr(paired_nav_collection, "baseline_model_identity", lambda manifest: dict(IDENTITY))
    symbols = [*POOL, *holdings]
    predictions = {s: _prediction(0.1 * i) for i, s in enumerate(symbols)}
    days = payload_days or {}
    payloads = [{"symbol": s, "prices": [{"date": days.get(s, DAY)}]} for s in symbols]
    state = {"screener_run_id": "run-1", "r33_holdings": list(holdings), "trading_config": {"fees": fees}}
    out = pipeline._r33_serving_inputs(state, payloads=payloads, predictions=predictions, ensemble=ensemble,
                                       serving_manifest={}, run_date=DAY, evidence_only=False, ops_query=None)
    return out, predictions, queried


def test_node_r33_inputs_bind_pool_holdings_stale_and_the_fees_owner(monkeypatch):
    from services.r33_ensemble import round_trip_cost
    from test_r33_l4_equal7 import _ensemble
    (r33, staleness, pool, cost), predictions, queried = _node_inputs(
        monkeypatch, ensemble=_ensemble(), payload_days={"P2": "2026-11-07"})
    assert r33 is True and queried == [{"signal_date": DAY, "screener_run_id": "run-1"}]
    assert staleness["effect"] == "unscored_z0_for_the_day" and staleness["stale"] == {"P2": "last_bar=2026-11-07"}
    assert pool["coverage"]["unscored"] == {"P2": "stale:last_bar=2026-11-07"}
    assert {r["symbol"]: (r["role"], r["held"]) for r in pool["rows"]}["H7"] == ("holding_outside_pool", True)
    assert predictions["H7"]["r33_rank_evidence"]["held"] is True
    assert cost == round_trip_cost(FEES)
    (_r, _s, _p, other), _pred, _q = _node_inputs(monkeypatch, ensemble=_ensemble(),
                                                  fees={"commission": 0.001, "tax": 0.0015})
    assert other == pytest.approx(0.0035)          # read from the owner, not a constant


def test_node_inputs_only_report_stale_bars_outside_r33(monkeypatch):
    (r33, staleness, pool, cost), predictions, queried = _node_inputs(
        monkeypatch, ensemble={"kind": "active8"}, payload_days={"P2": "2026-11-07"})
    assert (r33, pool, cost, queried) == (False, None, None, [])
    assert staleness["effect"] == "report_only" and staleness["stale"] == {"P2": "last_bar=2026-11-07"}
    assert all("r33_rank_evidence" not in p for p in predictions.values())


def test_stale_report_survives_a_malformed_bar_date():
    assert stale_inputs([{"symbol": "A", "prices": [{"date": "not-a-date"}]}], DAY) == {"A": "bad_bar_date"}


def test_node_attaches_r33_rows_through_the_r33_view(monkeypatch):
    from graphs import daily_pipeline_v2 as pipeline
    from services.r33_ensemble import RUNTIME_SCHEMA
    from test_r33_l4_equal7 import _ensemble
    from test_r33_serving_chain import COST, POOL_MODELS, _chain
    predictions, _snapshot = _chain()
    row = predictions["P5"]
    monkeypatch.setattr(pipeline, "_attach_ensemble_v2", lambda *a, **k: pytest.fail("legacy attach"))
    pipeline._attach_formal_ensemble(row, _ensemble(), POOL_MODELS, r33=True, r33_cost=COST, nav_authority=None)
    assert row["ensemble_v2"]["schema_version"] == RUNTIME_SCHEMA
    assert row["ensemble_v2"]["signal_policy"]["round_trip_cost"] == COST
    assert "adoption_basis" not in row["ensemble_v2"]


def test_node_r33_attach_carries_the_paper_grant(monkeypatch):
    from graphs import daily_pipeline_v2 as pipeline
    from test_r33_l4_equal7 import _ensemble
    from test_r33_serving_chain import COST, POOL_MODELS, _chain, _grant
    predictions, _snapshot = _chain()
    row = predictions["P5"]
    pipeline._attach_formal_ensemble(row, _ensemble(), POOL_MODELS, r33=True, r33_cost=COST,
                                     nav_authority=_grant(_ensemble()))
    assert row["ensemble_v2"]["adoption_basis"] == "committed_paired_nav"
    assert row["ensemble_v2"]["nav_inference_context_checksum"] == "g" * 64
