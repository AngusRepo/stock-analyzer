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
                "ml_score": 12,
                "score_components": '{"version":"score_v2","seedComponents":{"chipFlowSeed40":20,"technicalSeed30":15,"screenerMomentumSeed20":5,"mlEdgeSeed30":12}}',
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
    def resolve(row, alpha_policy=None):
        assert row["score_seed_inputs"] == {
            "chipFlowSeed40": 20.0,
            "technicalSeed30": 15.0,
            "screenerMomentumSeed20": 5.0,
            "mlEdgeSeed30": 12.0,
            "personaAlphaSeed": 0.0,
        }
        row["_allocator_edge_resolver"] = {"expected_return_owner": "l4_alpha_ev"}
        return 0.02, "l4_alpha_ev"

    monkeypatch.setattr(service, "_row_expected_return_with_source", resolve)
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


def test_missing_frozen_score_seed_abstains_without_aborting_batch(monkeypatch):
    monkeypatch.setattr(
        service,
        "_load_watch_rows",
        lambda *_: [{
            "id": 3,
            "symbol": "9999",
            "state": "reaction_ready",
            "ready": 1,
            "invalidated": 0,
            "raw_json": '{"runtimeMetadata":{"source_trade_date":"2026-07-24"}}',
        }],
    )
    monkeypatch.setattr(
        service,
        "_load_frozen_candidates",
        lambda *args: {"9999": {"symbol": "9999", "score_seed_inputs": None, "forecast_data": {}}},
    )
    monkeypatch.setattr(
        service,
        "load_merged_trading_config_with_contract",
        lambda: SimpleNamespace(
            config={"ranking": {}, "alphaFramework": {}},
            contract=SimpleNamespace(to_dict=lambda: {}),
        ),
    )
    monkeypatch.setattr(
        service.S12TradeEvBootstrapProvider,
        "for_run_date",
        lambda *args, **kwargs: SimpleNamespace(build_for_row=lambda *args, **kwargs: {"status": "loaded"}),
    )
    writes = []
    summary = service.materialize_s12_formal_ev_decisions(
        observation_date="2026-07-27",
        producer_run_id="formal-missing-seed",
        query_fn=lambda *args: [],
        write_fn=lambda statements: writes.extend(statements) or {
            "success_count": len(statements), "error_count": 0,
        },
    )
    assert summary["action_counts"]["abstain"] == 1
    assert summary["reason_counts"] == {"frozen_source_score_v2_seed_missing": 1}
    assert writes[0][1][11] == "abstain"


def test_formal_ml_filtered_candidate_has_explicit_abstention_reason(monkeypatch):
    monkeypatch.setattr(
        service,
        "_load_watch_rows",
        lambda *_: [{
            "id": 4,
            "symbol": "2395",
            "state": "limited_takeover_ready",
            "ready": 1,
            "invalidated": 0,
            "raw_json": '{"runtimeMetadata":{"source_trade_date":"2026-07-24"}}',
        }],
    )
    monkeypatch.setattr(
        service,
        "_load_frozen_candidates",
        lambda *args: {
            "2395": {
                "symbol": "2395",
                "score_seed_inputs": None,
                "score_components": {
                    "version": "score_v2_filtered_v1",
                    "reason": "formal_ml_gate_filtered",
                    "eligibleForAllocation": 0,
                },
                "forecast_data": {},
            },
        },
    )
    monkeypatch.setattr(
        service,
        "load_merged_trading_config_with_contract",
        lambda: SimpleNamespace(
            config={"ranking": {}, "alphaFramework": {}},
            contract=SimpleNamespace(to_dict=lambda: {}),
        ),
    )
    monkeypatch.setattr(
        service.S12TradeEvBootstrapProvider,
        "for_run_date",
        lambda *args, **kwargs: SimpleNamespace(build_for_row=lambda *args, **kwargs: {"status": "loaded"}),
    )
    writes = []
    summary = service.materialize_s12_formal_ev_decisions(
        observation_date="2026-07-27",
        producer_run_id="formal-filtered",
        query_fn=lambda *args: [],
        write_fn=lambda statements: writes.extend(statements) or {
            "success_count": len(statements), "error_count": 0,
        },
    )
    assert summary["action_counts"]["abstain"] == 1
    assert summary["reason_counts"] == {"frozen_source_formal_ml_gate_filtered": 1}
    assert writes[0][1][11] == "abstain"


def test_watch_loader_enforces_frozen_decision_universe():
    captured = {}

    def query(sql, params=None):
        captured["sql"] = sql
        captured["params"] = params
        return []

    assert service._load_watch_rows(query, "2026-07-24") == []
    assert "FROM daily_recommendations dr" in captured["sql"]
    assert "$.runtimeMetadata.source_trade_date" in captured["sql"]
    assert "$.eligibleForAllocation" in captured["sql"]
    assert "formal_ml_gate_filtered" in captured["sql"]
    assert captured["params"] == ["2026-07-24"]
