from __future__ import annotations

from pathlib import Path

import sys
import types

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

if "httpx" not in sys.modules:
    httpx_stub = types.ModuleType("httpx")
    httpx_stub.RequestError = RuntimeError

    class AsyncClient:  # pragma: no cover - contract tests do not use real HTTP.
        pass

    httpx_stub.AsyncClient = AsyncClient
    sys.modules["httpx"] = httpx_stub

from services.payload_builder import build_ml_universe  # noqa: E402
from services.screener_sizing_policy import resolve_controller_screener_sizing  # noqa: E402


def test_daily_pipeline_refuses_watchlist_screener_fallback():
    source = Path(__file__).resolve().parent.parent.joinpath("graphs", "daily_pipeline_v2.py").read_text(encoding="utf-8")
    payload_builder = Path(__file__).resolve().parent.parent.joinpath("services", "payload_builder.py").read_text(encoding="utf-8")

    assert "screener_recs_missing" in source
    assert "final_selection ownership" in source
    assert "refusing watchlist fallback" in source
    assert "build_screener_seed_recommendations(" not in source
    assert "load_active_stocks" not in source
    assert "build_ml_universe([], screener_recs)" in source
    assert "DAILY_RECOMMENDATION_PIPELINE_COLUMNS" in source
    assert "_daily_recommendation_select(\"dr\")" in source
    assert "FROM daily_recommendations dr" in source
    assert "JOIN screener_funnel_items sfi" in source
    assert "sfi.stage = 'final_selection'" in source
    assert "sfi.decision = 'selected'" in source
    assert "SELECT * FROM daily_recommendations" not in source
    assert "score_components" in payload_builder
    pipeline_columns_start = payload_builder.index("DAILY_RECOMMENDATION_PIPELINE_COLUMNS = (")
    pipeline_columns_end = payload_builder.index(")", pipeline_columns_start)
    pipeline_columns_block = payload_builder[pipeline_columns_start:pipeline_columns_end]
    assert "industry" in pipeline_columns_block
    assert "score_components" in pipeline_columns_block
    for legacy_field in ["chip_score", "tech_score", "momentum_score", "ml_score"]:
        assert legacy_field not in pipeline_columns_block


def test_pipeline_keeps_sector_flow_out_of_market_env_fanout():
    source = Path(__file__).resolve().parent.parent.joinpath("graphs", "daily_pipeline_v2.py").read_text(encoding="utf-8")

    assert 'g.add_edge("load_inputs",         "compute_sector_flow")' not in source
    assert 'g.add_edge("compute_sector_flow", "build_payloads")' not in source
    assert source.index('g.add_edge("write_d1",            "compute_sector_flow")') < source.index(
        'g.add_edge("compute_sector_flow", "export_dataset_snapshot")'
    )
    assert "_load_market_env_with_backoff" in source
    assert "D1_RETRYABLE_MARKERS" in source


def test_daily_pipeline_runs_coarse_feature_gate_before_heavy_sequence_models():
    source = Path(__file__).resolve().parent.parent.joinpath("graphs", "daily_pipeline_v2.py").read_text(encoding="utf-8")

    feature_call = source.index("results = await batch_predict(payloads)")
    core_gate = source.index("Layer2 coarse ML gate selected")
    sequence_call = source.index("modal_client.dlinear_batch_predict(sequence_series")
    assert feature_call < core_gate < sequence_call
    assert "core_ml_gate_by_symbol" in source
    assert "LightGBM+XGBoost+ExtraTrees" in source
    assert "resolve_controller_screener_sizing(" in source
    assert 'core_target_size = screener_sizing["coarse_ml_queue_size"]' in source
    assert "apply_core_ml_gate(" in source
    assert "apply_core_family_rank(" in source
    assert 'core_family_target_size = screener_sizing["core_family_rank_size"]' in source
    assert "core_family_vote" in source
    assert "topKOverrideEnabled" not in source
    assert "ensemble_v2_topk_policy" not in source
    assert "topk_forced" not in source
    assert "build_return_history_from_payloads(state[\"payloads\"])" in source


def test_controller_screener_sizing_matches_worker_layer_contract():
    policy = resolve_controller_screener_sizing(
        {
            "screener": {
                "candidatePoolSize": 200,
                "coarseMlQueueSize": 80,
                "mlShortlistSize": 40,
                "emergingResearchSize": 24,
            },
        },
        {
            "screener": {
                "candidate_pool_delta": -20,
                "coarse_ml_queue_delta": -10,
                "ml_shortlist_delta": 5,
                "emerging_research_delta": 6,
            },
        },
    )

    assert policy["candidate_pool_size"] == 180
    assert policy["coarse_ml_queue_size"] == 70
    assert policy["ml_shortlist_size"] == 45
    assert policy["core_family_rank_size"] == 45
    assert policy["emerging_research_size"] == 30


def test_controller_explicit_core_family_rank_size_is_bounded_by_coarse_queue():
    policy = resolve_controller_screener_sizing(
        {
            "screener": {
                "coarseMlQueueSize": 50,
                "mlShortlistSize": 35,
                "coreFamilyRankSize": 70,
            },
        },
        {"screener": {"ml_shortlist_delta": 20}},
    )

    assert policy["coarse_ml_queue_size"] == 50
    assert policy["ml_shortlist_size"] == 50
    assert policy["core_family_rank_size"] == 50


def test_build_ml_universe_uses_tradable_screener_rows_without_watchlist():
    universe = build_ml_universe([], [{
        "stock_id": 1,
        "symbol": "2330",
        "name": "TSMC",
        "sector": "Semis",
        "market_segment": "LISTED",
        "recommendation_lane": "tradable",
        "eligible_for_ml": 1,
        "eligible_for_pending_buy": 1,
    }])

    assert len(universe) == 1
    assert universe[0]["symbol"] == "2330"
    assert universe[0]["source"] == "daily_recommendations"
    assert universe[0]["recommendation_lane"] == "tradable"
    assert universe[0]["eligible_for_execution"] is True
