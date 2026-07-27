from __future__ import annotations

from types import SimpleNamespace

from services import s12_formal_ev_continuation as service


def test_ready_structure_can_only_materialize_potential_buy(monkeypatch):
    watch = [{
        "id": 9,
        "trade_date": "2026-07-27",
        "symbol": "2441",
        "state": "reaction_ready",
        "ready": 1,
        "invalidated": 0,
        "raw_json": '{"runtimeMetadata":{"source_trade_date":"2026-07-24"}}',
    }]

    def query(sql, params=None):
        if "source='s12_intraday_setup_watch'" in sql:
            return watch
        if "FROM daily_recommendations" in sql:
            return [{
                "symbol": "2441",
                "date": "2026-07-24",
                "score": 65,
                "score_components": '{"version":"score_v2","mlEdge":0.3}',
                "alpha_context": "{}",
                "alpha_allocation": '{"l4_alpha_ev":{"status":"loaded","expected_return":0.02,"expected_return_source":"l4_alpha_ev","expected_return_owner":"l4_alpha_ev"}}',
                "forecast_data": '{"ensemble_v2":{}}',
                "prediction_generated_at": "2026-07-24T12:00:00Z",
            }]
        return []

    monkeypatch.setattr(
        service,
        "load_merged_trading_config_with_contract",
        lambda: SimpleNamespace(
            config={
                "ranking": {"enabled": True, "promoteMinForecastPct": 0, "promoteMinMlEdge": 0},
                "alphaFramework": {},
            },
            contract=SimpleNamespace(to_dict=lambda: {"source": "test"}),
        ),
    )
    monkeypatch.setattr(
        service.S12TradeEvBootstrapProvider,
        "for_run_date",
        lambda *args, **kwargs: SimpleNamespace(build_for_row=lambda *args, **kwargs: {
            "status": "loaded",
            "trade_expected_return_net_pct": 0.01,
            "trade_expected_return_source": "s12_replay_trade_outcomes:symbol",
            "bootstrap_scope": "symbol",
            "sample_policy": "verified_s12_symbol",
        }),
    )
    monkeypatch.setattr(service, "_row_expected_return_with_source", lambda row, alpha_policy=None: (
        row.update({"_allocator_edge_resolver": {"expected_return_owner": "l4_alpha_ev"}}) or (0.02, "l4_alpha_ev")
    ))
    monkeypatch.setattr(service, "_can_promote_ranking_candidate", lambda *args, **kwargs: True)
    writes = []
    summary = service.materialize_s12_formal_ev_decisions(
        observation_date="2026-07-27",
        producer_run_id="formal-1",
        query_fn=query,
        write_fn=lambda statements: writes.extend(statements) or {
            "success_count": len(statements), "error_count": 0,
        },
    )
    assert summary["action_counts"]["potential_buy"] == 1
    assert summary["direct_execution_allowed"] is False
    assert writes[0][1][11] == "potential_buy"


def test_bearish_risk_never_promotes(monkeypatch):
    monkeypatch.setattr(
        service,
        "_load_watch_rows",
        lambda *_: [{
            "id": 1,
            "symbol": "1785",
            "state": "waiting_session_60m_bearish_risk",
            "ready": 0,
            "invalidated": 0,
            "raw_json": '{"runtimeMetadata":{"source_trade_date":"2026-07-24"}}',
        }],
    )
    monkeypatch.setattr(service, "_load_frozen_candidates", lambda *args: {})
    monkeypatch.setattr(
        service,
        "load_merged_trading_config_with_contract",
        lambda: SimpleNamespace(
            config={"ranking": {}, "alphaFramework": {}},
            contract=SimpleNamespace(to_dict=lambda: {}),
        ),
    )
    writes = []
    summary = service.materialize_s12_formal_ev_decisions(
        observation_date="2026-07-27",
        producer_run_id="formal-2",
        query_fn=lambda *args: [],
        write_fn=lambda statements: writes.extend(statements) or {
            "success_count": len(statements), "error_count": 0,
        },
    )
    assert summary["action_counts"]["abstain"] == 1
    assert writes[0][1][6] == "risk_blocked"
