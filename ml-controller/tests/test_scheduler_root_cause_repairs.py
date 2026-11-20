from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import recommendation_service  # noqa: E402
from services.recommendation_service import write_predictions_to_d1  # noqa: E402
def test_prediction_writer_routes_learning_domain():
    assert recommendation_service.PREDICTIONS_D1_CLIENT.domain.value == "learning"




def test_prediction_writer_requires_feature_version(monkeypatch):

    def _fake_batch_execute(_statements):
        raise AssertionError("writer must fail before D1 write when feature_version is missing")

    monkeypatch.setattr(recommendation_service, "_predictions_batch_execute", _fake_batch_execute)

    with pytest.raises(ValueError, match="missing_feature_version_contract"):
        write_predictions_to_d1(
            {
                "2330": {
                    "signal": "BUY",
                    "confidence": 0.74,
                    "entry_price": 106.0,
                    "stop_loss": 100.0,
                    "target1": 114.0,
                    "target2": 120.0,
                    "ensemble_v2": {"signal": "BUY", "signal_source": "ensemble_v2"},
                }
            },
            {"2330": 1},
            run_date="2026-06-08",
        )


def test_filtered_recommendations_preserve_screener_seed_rows(monkeypatch):
    captured = {}

    def _fake_batch_execute(statements):
        captured["statements"] = statements
        return {"success_count": len(statements)}

    monkeypatch.setattr(recommendation_service.CORE_D1_CLIENT, "batch_execute", _fake_batch_execute)

    written = recommendation_service.delete_filtered_recommendations(
        ["2330", "2317"],
        "2026-06-08",
        filtered_diagnostics={
            "2330": {
                "filtered_signal": "SELL",
                "sparse_decision_coverage": False,
            }
        },
    )

    assert written == 2
    for sql, params in captured["statements"]:
        assert "UPDATE daily_recommendations" in sql
        assert "DELETE FROM daily_recommendations" not in sql
        assert "has_buy_signal = 0" in sql
        assert "json_object(" in sql
        assert "alpha_allocation = json(?)" in sql
        assert "json_set(" not in sql
        assert "'s12_trade_ev'" not in sql
        assert "ml_filter:preserved_screener_seed_not_buy" in sql
        allocation = json.loads(params[0])
        diagnostic = allocation["allocator_ev_fusion_diagnostic"]
        assert allocation["selection_reason"] == "preserved_screener_seed_non_buy"
        assert allocation["expected_return_source"] == "ml_filtered_sell_or_no_signal_preserved_seed"
        assert allocation["expected_return_owner"] == "risk_abstention"
        assert allocation["allocator_edge_resolver"]["abstention"] is True
        assert allocation["expected_return_abstention"]["candidate_contract"] == "explicit_no_trade_abstention"
        rfs = allocation["rfs_shadow_challenger"]
        assert rfs["status"] == "insufficient_evidence"
        assert rfs["source_expected_return_candidate_count"] == 0
        assert rfs["as_of_date"] == "2026-06-08"
        assert rfs["packet_checksum"]
        assert rfs["production_effect"] is False
        assert diagnostic["status"] == "not_evaluated"
        assert diagnostic["reason"] == "ml_filter_preserved_non_buy"
        if params[2] == "2330":
            assert diagnostic["filtered_signal"] == "SELL"
            assert diagnostic["sparse_decision_coverage"] is False
        assert params[1] == "2026-06-08"


def test_filtered_recommendations_reuse_same_run_rfs_packet(monkeypatch):
    captured = {}

    def _fake_batch_execute(statements):
        captured["statements"] = statements
        return {"success_count": len(statements)}

    monkeypatch.setattr(recommendation_service.CORE_D1_CLIENT, "batch_execute", _fake_batch_execute)
    packet = {
        "schema_version": "portfolio-ml-implementable-frontier-shadow-v2",
        "method": "portfolio_ml_inspired_direct_weight_cost_aware_shadow",
        "as_of_date": "2026-06-08",
        "status": "shadow_observation_only",
        "packet_checksum": "same-run-checksum",
        "validation_blockers": ["return_history_coverage_below_80pct"],
        "candidate_pool_policy": "full_formal_expected_return_pool_no_hard_top_k",
        "source_expected_return_candidate_count": 7,
        "excluded_missing_adv_symbols": ["9999"],
        "metrics": {"challenger_net_utility": 0.1},
    }

    recommendation_service.delete_filtered_recommendations(
        ["2330"],
        "2026-06-08",
        rfs_shadow_packet=packet,
    )

    allocation = json.loads(captured["statements"][0][1][0])
    rfs = allocation["rfs_shadow_challenger"]
    assert rfs["packet_checksum"] == "same-run-checksum"
    assert rfs["source_expected_return_candidate_count"] == 7
    assert rfs["excluded_missing_adv_symbols"] == ["9999"]
    assert rfs["production_effect"] is False

    graph_source = (
        Path(__file__).resolve().parent.parent / "graphs" / "daily_pipeline_v2.py"
    ).read_text(encoding="utf-8")
    assert "rfs_shadow_packet=run_rfs_shadow_packet" in graph_source


def _core_daily_recommendations(tmp_db):
    import re
    import sqlite3

    schema = (Path(__file__).resolve().parents[2] / "worker" / "domain-schemas" / "core.sql").read_text(encoding="utf-8")
    ddl = re.search(r"CREATE TABLE IF NOT EXISTS daily_recommendations \(.*?\n\);", schema, re.S).group(0)
    db = sqlite3.connect(tmp_db)
    db.execute(ddl)
    return db


def test_filtered_recommendations_store_no_signal_not_hold(tmp_path):
    # NEW-1030-15: a seed without usable formal inference is NO_SIGNAL with no
    # confidence, never HOLD / 0.
    import re

    db = _core_daily_recommendations(str(tmp_path / "core.db"))
    db.execute(
        "INSERT INTO daily_recommendations (date, symbol, name, rank, score, reason, score_components, ml_score)"
        " VALUES ('2026-06-08', '2330', 'TSMC', 1, 61.5, 'seed', '{\"version\":\"score_v2_seed\"}', 0)"
    )
    for sql, params in recommendation_service.build_filtered_recommendation_update_statements(["2330"], "2026-06-08"):
        db.execute(sql, params)
    signal, confidence, vote = db.execute(
        "SELECT signal, confidence, json_extract(ml_vote_summary, '$.status') FROM daily_recommendations"
    ).fetchone()
    assert (signal, confidence, vote) == ("NO_SIGNAL", None, "filtered")

    # Worker readers: excluded from final recommendations, still not an untouched seed.
    other_ts = (Path(__file__).resolve().parents[2] / "worker" / "src" / "routes" / "other.ts").read_text(encoding="utf-8")
    final_where = re.search(r'const FINAL_RECOMMENDATION_WHERE = "([^"]+)"', other_ts).group(1)
    assert db.execute(f"SELECT COUNT(*) FROM daily_recommendations WHERE {final_where}").fetchone()[0] == 0
    untouched_seed = "signal IS NULL AND confidence IS NULL AND COALESCE(ml_score, 0) = 0"
    assert db.execute(f"SELECT COUNT(*) FROM daily_recommendations WHERE {untouched_seed}").fetchone()[0] == 0


def test_ensemble_prediction_row_does_not_persist_placeholder_confidence(monkeypatch):
    # NEW-1030-16: base evidence carries confidence 0.0 as a placeholder; the
    # ensemble row's direction_accuracy must be NULL, not a measured 0.
    from services._predictions_schema import INSERT_PREDICTIONS_SQL

    captured = {}

    def _fake_batch_execute(statements):
        captured["statements"] = statements
        return {"success_count": len(statements)}

    monkeypatch.setattr(recommendation_service, "_predictions_batch_execute", _fake_batch_execute)
    write_predictions_to_d1(
        {
            "2330": {
                "signal": "HOLD",
                "confidence": 0.0,
                "entry_price": 106.0,
                "feature_version": "v2",
                "ensemble_v2": {"signal": "HOLD", "signal_source": "ensemble_v2"},
            }
        },
        {"2330": 1},
        run_date="2026-10-28",
    )
    ensemble_rows = [params for sql, params in captured["statements"] if sql == INSERT_PREDICTIONS_SQL]
    assert len(ensemble_rows) == 1
    assert ensemble_rows[0][3] is None
