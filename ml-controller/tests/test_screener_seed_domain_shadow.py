from __future__ import annotations

import json

from services.screener_seed_domain_shadow import (
    D1_QUERY_SYMBOL_CHUNK,
    load_screener_seed_domain_rows,
    run_screener_seed_domain_shadow_comparison,
)


class FakeClient:
    def __init__(self, responder):
        self.responder = responder
        self.calls = []

    def query(self, sql, params=None, timeout=60.0):
        self.calls.append((sql, params or [], timeout))
        return self.responder(sql, params or [])


def test_shadow_comparison_reads_ops_and_core_without_mutating_legacy_output():
    legacy = [{
        "id": 9,
        "screener_run_id": "run-1",
        "decision_universe_frozen_at": "2026-08-16T10:00:00Z",
        "date": "2026-08-16",
        "stock_id": 1,
        "symbol": "2330",
        "name": "TSMC",
        "sector": "Semis",
        "industry": "Semiconductor",
        "rank": 1,
        "score": 88,
        "reason": "L1 reason",
        "watch_points": '["screener_seed:l1_candidate_seed_after_overlay","screener_run:run-1"]',
        "has_buy_signal": 0,
        "market_segment": "LISTED",
        "recommendation_lane": "tradable",
        "eligible_for_ml": 1,
        "eligible_for_pending_buy": 0,
        "score_components": '{"quality":0.8}',
    }]
    original = json.loads(json.dumps(legacy))
    ops = FakeClient(lambda _sql, _params: [{
        "screener_run_id": "run-1",
        "decision_universe_frozen_at": "2026-08-16T10:00:00Z",
        "symbol": "2330",
        "seed_name": "TSMC",
        "seed_stage": "l1_candidate_seed_after_overlay",
        "seed_reason_code": "seed",
        "seed_rank": 1,
        "seed_score": 88,
        "seed_evidence": '{"market_segment":"LISTED"}',
        "scoring_evidence": '{"taxonomy":{"industry":"Semiconductor"},"score_components":{"quality":0.8}}',
        "l1_evidence": '{"strategy_pool_reason":"L1 reason"}',
    }])

    def core_responder(sql, _params):
        if "FROM daily_recommendations" in sql:
            return [{
                "id": 9, "stock_id": 1, "symbol": "2330", "name": "TSMC",
                "sector": "Semis", "industry": None, "recommendation_lane": "tradable",
                "eligible_for_ml": 1, "eligible_for_pending_buy": 0,
            }]
        return [{"stock_id": 1, "symbol": "2330", "name": "TSMC", "sector": "Semis", "market": "TWSE"}]

    report = run_screener_seed_domain_shadow_comparison(
        run_date="2026-08-16",
        legacy_rows=legacy,
        ops_client=ops,
        core_client=FakeClient(core_responder),
    )

    assert report["status"] == "pass"
    assert report["authoritative_output"] == "legacy_unchanged"
    assert legacy == original


def test_production_loader_reads_formal_ops_core_owners():
    ops = FakeClient(lambda _sql, _params: [{
        "screener_run_id": "run-1",
        "decision_universe_frozen_at": "2026-08-21T10:00:00Z",
        "symbol": "2330",
        "seed_stage": "l1_candidate_seed_after_overlay",
        "seed_rank": 1,
        "seed_score": 88,
    }])

    def core_responder(sql, _params):
        if "FROM daily_recommendations" in sql:
            return [{"stock_id": 1, "symbol": "2330", "recommendation_lane": "tradable"}]
        return [{"stock_id": 1, "symbol": "2330", "name": "TSMC", "market": "TWSE"}]

    rows = load_screener_seed_domain_rows(
        run_date="2026-08-21",
        ops_client=ops,
        core_client=FakeClient(core_responder),
    )

    assert len(rows) == 1
    assert rows[0]["symbol"] == "2330"
    assert rows[0]["screener_run_id"] == "run-1"
    assert rows[0]["recommendation_lane"] == "tradable"


def test_core_reads_chunk_symbols_below_d1_parameter_limit():
    symbols = [f"S{index:03d}" for index in range(D1_QUERY_SYMBOL_CHUNK + 1)]
    ops = FakeClient(lambda _sql, _params: [
        {"symbol": symbol, "seed_rank": index}
        for index, symbol in enumerate(symbols)
    ])
    core = FakeClient(lambda sql, params: (
        [] if "daily_recommendations" in sql else [
            {"stock_id": index + 1, "symbol": symbol, "market": "TWSE"}
            for index, symbol in enumerate(params)
        ]
    ))

    report = run_screener_seed_domain_shadow_comparison(
        run_date="2026-08-16",
        legacy_rows=[],
        ops_client=ops,
        core_client=core,
    )

    assert report["core_stock_count"] == len(symbols)
    assert len(core.calls) == 4
    assert max(len(params) for _sql, params, _timeout in core.calls) <= D1_QUERY_SYMBOL_CHUNK + 1
