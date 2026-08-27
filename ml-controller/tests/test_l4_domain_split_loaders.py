from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))

from services.allocator_ev_fusion_artifact_builder import load_allocator_ev_fusion_training_rows
from services.l4_alpha_ev_artifact_builder import load_l4_alpha_ev_training_rows
from services.l4_alpha_ev_resolver import SNAPSHOT_BACKFILL_AS_OF_GUARD, SNAPSHOT_BACKFILL_SOURCE


def test_snapshot_l4_asof_builder_forwards_core_domain_client() -> None:
    source = (
        Path(__file__).resolve().parents[1]
        / "services"
        / "allocator_ev_feature_snapshot_backfill.py"
    ).read_text(encoding="utf-8")
    assert "core_query_fn: QueryFn | None = None" in source
    assert "core_query_fn=core_query_fn" in source
    assert (
        "core_query_fn=core_query if production_domain_routing else None"
        in source
    )



def test_l4_loader_splits_learning_evidence_from_core_identity_and_scores() -> None:
    learning_sql: list[str] = []
    core_sql: list[str] = []

    def learning_query(sql: str, _params: list[object]) -> list[dict]:
        learning_sql.append(sql)
        if "FROM predictions p INDEXED" in sql:
            return [{
                "stock_id": 7,
                "prediction_date": "2026-08-18",
                "prediction_generated_at": "2026-08-18T05:00:00Z",
                "next_session_open_at": "2026-08-19T01:00:00Z",
                "forecast_data": json.dumps({"ensemble_v2": {"avg_rank": 0.8}}),
                "label_adjustment_source": "stock_prices:finlab_primary_canonical_mirror",
                "l4_executable_return_pct": 0.03,
                "l4_entry_date": "2026-08-19",
                "l4_exit_date": "2026-08-25",
                "l4_entry_raw_open": 100.0,
                "l4_exit_raw_close": 103.0,
                "l4_entry_adjustment_factor": 1.0,
                "l4_exit_adjustment_factor": 1.0,
            }]
        return []

    def core_query(sql: str, _params: list[object]) -> list[dict]:
        core_sql.append(sql)
        if "FROM stocks" in sql:
            return [{"id": 7, "symbol": "2330"}]
        if "FROM daily_recommendations" in sql:
            return [{
                "stock_id": 7,
                "date": "2026-08-18",
                "score": 81.0,
                "score_components": json.dumps({"version": "score_v2"}),
                "alpha_context": "{}",
                "market_segment": "listed",
                "recommendation_lane": "BUY",
            }]
        return []

    rows = load_l4_alpha_ev_training_rows(
        learning_query,
        core_query_fn=core_query,
        end_date="2026-08-18",
        knowledge_cutoff_date="2026-08-25",
    )

    assert len(rows) == 1
    assert rows[0]["symbol"] == "2330"
    assert rows[0]["score"] == 81.0
    primary_sql = learning_sql[0]
    assert "daily_recommendations" not in primary_sql
    assert "JOIN stocks" not in primary_sql
    assert "\n                p.forecast_data," not in primary_sql
    assert "json_object(" in primary_sql
    assert "$.ensemble_v2.avg_rank" in primary_sql
    assert any("FROM stocks" in sql for sql in core_sql)
    assert any("FROM daily_recommendations" in sql for sql in core_sql)


def test_fusion_loader_hydrates_sector_from_core_without_cross_d1_join() -> None:
    learning_sql: list[str] = []

    def learning_query(sql: str, _params: list[object]) -> list[dict]:
        learning_sql.append(sql)
        return [{
            "stock_id": 7,
            "symbol": "2330",
            "prediction_date": "2026-08-18",
            "forecast_data": "{}",
            "label_adjustment_source": "stock_prices:finlab_primary_canonical_mirror",
            "l4_executable_return_pct": 0.03,
            "trade_pnl_pct": None,
            "s12_replay_pnl_pct": None,
            "s12_replay_status": None,
            "s12_replay_archetype": None,
            "score": 81.0,
            "score_components": "{}",
            "alpha_context": "{}",
            "alpha_allocation": "{}",
            "market_heat_expected_return": None,
            "market_segment": "listed",
            "sector": None,
            "recommendation_lane": "BUY",
            "allocator_ev_feature_snapshot_source": SNAPSHOT_BACKFILL_SOURCE,
            "allocator_ev_feature_snapshot_guard": SNAPSHOT_BACKFILL_AS_OF_GUARD,
        }]

    rows = load_allocator_ev_fusion_training_rows(
        learning_query,
        core_query_fn=lambda sql, _params: [{"id": 7, "sector": "半導體"}] if "FROM stocks" in sql else [],
        end_date="2026-08-18",
    )

    assert rows[0]["sector"] == "半導體"
    assert "JOIN stocks" not in learning_sql[0]
