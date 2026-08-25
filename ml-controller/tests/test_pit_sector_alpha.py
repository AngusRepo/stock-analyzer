from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.evidence_contracts import (  # noqa: E402
    L4_ARTIFACT_CONTRACT_VERSION,
    L4_FEATURE_SEMANTIC_VERSION,
    LABEL_SCHEMA_VERSION,
)
from services.l4_alpha_ev_producer import (  # noqa: E402
    CANONICAL_FEATURE_NAMES,
    assess_l4_artifact_cutover,
    materialize_l4_alpha_ev,
)
from services.pit_sector_alpha import (  # noqa: E402
    SECTOR_ALPHA_FEATURE_NAMES,
    SECTOR_FLOW_PIT_LINEAGE_VERSION,
    load_pit_sector_alpha_experts,
    load_pit_sector_alpha_experts_by_key,
    sector_alpha_feature_values,
)
from services.portfolio_allocation import apply_categorical_exposure_cap  # noqa: E402


DECISION_CUTOFF = "2026-07-24T13:30:00+00:00"
SOURCE_AVAILABLE_AT = "2026-07-23T13:00:00+00:00"


def _query(sql: str, params: list[object]) -> list[dict]:
    if "MAX(COALESCE(updated_at, created_at))" in sql:
        signal_date = str(params[0])
        cutoff = str(params[2])
        if signal_date in {"2026-07-24", "2026-07-25"} and cutoff >= SOURCE_AVAILABLE_AT:
            return [{
                "date": "2026-07-23",
                "source_available_at": SOURCE_AVAILABLE_AT,
                "source_row_count": 8,
                "source_layer_count": 4,
            }]
        return []
    if "FROM market_risk" in sql:
        source_date, signal_date = map(str, params)
        lag = 1 if (source_date, signal_date) == ("2026-07-23", "2026-07-24") else 2
        return [{"source_session_lag": lag}]
    if "SELECT date, sector, classification" in sql and "FROM sector_flow" in sql:
        if str(params[0]) != "2026-07-23":
            return []
        rows = []
        definitions = {
            "industry": [("SEMICONDUCTOR", 1.2), ("STEEL", -0.7)],
            "industry_theme": [("AI", 1.0), ("RETAIL", -0.5)],
            "subindustry": [("IC_DESIGN", 0.8), ("FOOD", -0.3)],
            "theme": [("CPO", 1.4), ("SHIPPING", -0.8)],
        }
        for classification, sectors in definitions.items():
            for sector, value in sectors:
                rows.append({
                    "date": "2026-07-23",
                    "sector": sector,
                    "classification": classification,
                    "rs_ratio": value,
                    "rs_momentum": value * 0.8,
                    "rotation_score": value * 0.7,
                    "rotation_regime": "leading" if value > 0 else "lagging",
                    "total_net": value * 1_000_000,
                    "stock_count": 10,
                    "up_count": 8 if value > 0 else 2,
                    "turnover_share_delta": value / 10,
                    "source_available_at": SOURCE_AVAILABLE_AT,
                    "pit_lineage_version": SECTOR_FLOW_PIT_LINEAGE_VERSION,
                })
        return rows
    if "FROM finlab_taxonomy_tags" in sql:
        signal_date = str(params[-1])
        rows = [
            {"symbol": "2330", "tag": "SEMICONDUCTOR", "tag_type": "industry", "source": "finlab", "weight": 1, "as_of_date": "2026-07-01"},
            {"symbol": "2330", "tag": "AI", "tag_type": "industry_theme", "source": "finlab", "weight": 1, "as_of_date": "2026-07-01"},
            {"symbol": "2330", "tag": "IC_DESIGN", "tag_type": "subindustry", "source": "finlab", "weight": 1, "as_of_date": "2026-07-01"},
            {"symbol": "9999", "tag": "SEMICONDUCTOR", "tag_type": "industry", "source": "future", "weight": 1, "as_of_date": "2026-07-25"},
        ]
        return [row for row in rows if row["as_of_date"] <= signal_date]
    if "FROM stock_tags" in sql:
        return [{
            "symbol": "2330",
            "tag": "CPO",
            "tag_type": "concept",
            "source": "stock_tags",
            "weight": 1,
            "as_of_date": "2026-07-01",
        }]
    raise AssertionError(sql)


def test_pit_sector_expert_uses_prior_completed_snapshot_and_asof_memberships() -> None:
    experts = load_pit_sector_alpha_experts(
        _query,
        signal_date="2026-07-24",
        symbols=["2330", "9999"],
        knowledge_cutoff=DECISION_CUTOFF,
    )

    expert = experts["2330"]
    assert expert["status"] == "loaded"
    assert expert["source_date"] == "2026-07-23"
    assert expert["source_session_lag"] == 1
    assert expert["source_available_at"] == SOURCE_AVAILABLE_AT
    assert expert["point_in_time"] is True
    assert expert["producer_position"] == "post_recommendation_for_next_decision_session"
    assert expert["candidate_set_mutation_allowed"] is False
    assert expert["features"]["sector_membership_coverage"] == 1.0
    assert expert["features"]["sector_rs_consensus"] == pytest.approx(1.0)
    assert all(item["as_of_date"] <= "2026-07-24" for item in expert["memberships"])
    assert expert["checksum"].startswith("sha256:")
    assert experts["9999"]["status"] == "unavailable"


def test_same_signal_date_sector_flow_is_never_consumed() -> None:
    experts = load_pit_sector_alpha_experts(
        _query,
        signal_date="2026-07-23",
        symbols=["2330"],
        knowledge_cutoff=DECISION_CUTOFF,
    )
    assert experts["2330"]["status"] == "unavailable"
    assert experts["2330"]["blockers"] == ["prior_completed_sector_flow_missing"]


def test_prior_snapshot_must_be_exactly_one_trading_session_old() -> None:
    experts = load_pit_sector_alpha_experts(
        _query,
        signal_date="2026-07-25",
        symbols=["2330"],
        knowledge_cutoff=DECISION_CUTOFF,
    )
    assert experts["2330"]["status"] == "unavailable"
    assert experts["2330"]["blockers"] == ["source_session_lag_exceeded:2"]


def test_missing_knowledge_cutoff_fails_closed() -> None:
    expert = load_pit_sector_alpha_experts(
        _query,
        signal_date="2026-07-24",
        symbols=["2330"],
    )["2330"]
    assert expert["status"] == "unavailable"
    assert expert["blockers"] == ["knowledge_cutoff_missing_or_invalid"]


def test_multi_date_loader_keeps_signal_dates_and_cutoffs_isolated() -> None:
    experts = load_pit_sector_alpha_experts_by_key(_query, [
        {"prediction_date": "2026-07-23", "symbol": "2330", "prediction_generated_at": DECISION_CUTOFF},
        {"prediction_date": "2026-07-24", "symbol": "2330", "prediction_generated_at": DECISION_CUTOFF},
    ])
    assert experts[("2026-07-23", "2330")]["status"] == "unavailable"
    assert experts[("2026-07-24", "2330")]["status"] == "loaded"


def test_market_risk_session_calendar_uses_core_domain_query() -> None:
    market_queries: list[str] = []
    core_queries: list[str] = []

    def market_query(sql: str, params: list[object]) -> list[dict]:
        assert "FROM market_risk" not in sql
        market_queries.append(sql)
        return _query(sql, params)

    def core_query(sql: str, params: list[object]) -> list[dict]:
        assert "FROM market_risk" in sql
        core_queries.append(sql)
        return _query(sql, params)

    experts = load_pit_sector_alpha_experts_by_key(
        market_query,
        [{
            "prediction_date": "2026-07-24",
            "symbol": "2330",
            "prediction_generated_at": DECISION_CUTOFF,
        }],
        core_query_fn=core_query,
    )

    assert experts[("2026-07-24", "2330")]["status"] == "loaded"
    assert market_queries
    assert len(core_queries) == 1


def test_production_oof_and_allocator_replay_route_market_risk_to_core_d1() -> None:
    walk_forward_source = Path("ml-controller/routers/walk_forward.py").read_text(encoding="utf-8")
    allocator_source = Path(
        "ml-controller/services/allocator_ev_feature_snapshot_backfill.py"
    ).read_text(encoding="utf-8")

    assert walk_forward_source.count("core_query_fn=CORE_D1_CLIENT.query") >= 4
    assert "market_query if production_domain_routing else query_fn" in allocator_source
    assert "core_query_fn=core_query if production_domain_routing else query_fn" in allocator_source


def test_sector_defensive_interaction_is_derived_from_pit_market_context() -> None:
    expert = load_pit_sector_alpha_experts(
        _query,
        signal_date="2026-07-24",
        symbols=["2330"],
        knowledge_cutoff=DECISION_CUTOFF,
    )["2330"]
    values = sector_alpha_feature_values({
        "prediction_date": "2026-07-24",
        "alpha_context": {
            "pit_sector_alpha_expert": expert,
            "market_regime_context": {
                "source_date": "2026-07-24",
                "source": "test",
                "regime_surface": {"bear": 0.6, "volatile": 0.2, "bull": 0.2},
            },
        },
    })
    assert values["sector_defensive_rs_interaction"] == pytest.approx(0.8)


def test_sector_exposure_cap_reduces_to_cash_without_forced_redistribution() -> None:
    weights, applied, evidence = apply_categorical_exposure_cap(
        {"2330": 0.40, "2454": 0.35, "2603": 0.25},
        {"2330": "Semiconductor", "2454": "SEMICONDUCTOR", "2603": "SHIPPING"},
        max_category_weight=0.50,
    )
    assert applied is True
    assert weights["2330"] + weights["2454"] == pytest.approx(0.50)
    assert weights["2603"] == pytest.approx(0.25)
    assert sum(weights.values()) == pytest.approx(0.75)
    assert evidence["unallocated_increment"] == pytest.approx(0.25)


def test_l4_v5_can_learn_sector_alpha_while_v4_remains_a_separate_contract() -> None:
    feature_names = sorted(CANONICAL_FEATURE_NAMES)
    coefficients = {name: 0.0 for name in feature_names}
    coefficients["sector_rs_consensus"] = 0.02
    artifact = {
        "schema_version": "l4-alpha-ev-artifact-v2",
        "artifact_contract_version": L4_ARTIFACT_CONTRACT_VERSION,
        "feature_semantic_version": L4_FEATURE_SEMANTIC_VERSION,
        "label_schema_version": LABEL_SCHEMA_VERSION,
        "promotion_state": "production_approved",
        "validation_packet": {"decision": "PASS", "failed_gates": []},
        "resolver_method": "ridge_meta_calibrator",
        "model_version": "l4-alpha-ev-ridge-v5-sector-test",
        "feature_snapshot_version": "l4-alpha-feature-snapshot-v5-pit-sector-components",
        "trained_until": "2026-07-23",
        "horizon_days": 5,
        "cost_model_bps": 18.0,
        "output_is_net_of_costs": True,
        "feature_families": ["score_v2_components", "formal_ml_direction", "pit_sector_alpha"],
        "feature_names": feature_names,
        "intercept": 0.0,
        "coefficients": coefficients,
        "output_clip": {"min": -0.08, "max": 0.08},
    }
    expert = load_pit_sector_alpha_experts(
        _query,
        signal_date="2026-07-24",
        symbols=["2330"],
        knowledge_cutoff=DECISION_CUTOFF,
    )["2330"]
    row = {
        "prediction_date": "2026-07-24",
        "score_components": {
            "version": "score_v2",
            "finalScore": 75,
            "components": {
                "mlEdge": 18,
                "fundamentalQuality": 19,
                "chipFlow": 20,
                "technicalStructure": 18,
            },
        },
        "alpha_context": {"pit_sector_alpha_expert": expert},
    }
    prediction = {"ensemble_v2": {"avg_rank": 0.7}}

    assert assess_l4_artifact_cutover(artifact)["ready"] is True
    payload = materialize_l4_alpha_ev(
        row,
        prediction=prediction,
        policy={"l4_alpha_ev": artifact},
    )
    assert payload is not None
    assert payload["status"] == "loaded"
    assert payload["expected_return"] == pytest.approx(0.02)
    assert set(SECTOR_ALPHA_FEATURE_NAMES).issubset(payload["feature_names"])


def test_sector_flow_lineage_schema_is_consistent_and_does_not_relabel_legacy_rows() -> None:
    repo = Path(__file__).resolve().parents[2]
    migration = repo.joinpath("worker", "migrations", "0086_sector_flow_pit_lineage.sql").read_text(encoding="utf-8")
    primary_schema = repo.joinpath("worker", "schema.sql").read_text(encoding="utf-8")
    market_schema = repo.joinpath("worker", "domain-schemas", "market.sql").read_text(encoding="utf-8")

    assert "ADD COLUMN updated_at TEXT" in migration
    assert "ADD COLUMN pit_lineage_version TEXT" in migration
    assert "UPDATE sector_flow" not in migration
    for schema in (primary_schema, market_schema):
        assert "updated_at" in schema
        assert "pit_lineage_version" in schema
        assert "idx_sector_flow_pit_lineage" in schema
