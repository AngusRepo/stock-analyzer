from __future__ import annotations

import sqlite3
import sys
from datetime import date, timedelta
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from services.allocator_ev_feature_snapshot_backfill import (
    _recorded_serving_fusion_projection,
)
from services.allocator_ev_fusion import materialize_allocator_ev_fusion
from services.evidence_contracts import (
    ALLOCATOR_EV_ARTIFACT_CONTRACT_VERSION,
    ALLOCATOR_EV_FEATURE_SEMANTIC_VERSION,
    LABEL_SCHEMA_VERSION,
)
from services.expected_return_artifact_identity import (
    attach_expected_return_artifact_identity,
    expected_return_artifact_identity,
)
from services.expected_return_serving_forward_guard import (
    _serving_observation,
    build_serving_forward_evaluations,
    derive_forward_guard_state,
    load_allocator_ev_fusion_forward_guard,
    load_serving_forward_rows,
)


def _artifact() -> dict:
    artifact = {
        "schema_version": "allocator-ev-fusion-artifact-v14",
        "artifact_contract_version": ALLOCATOR_EV_ARTIFACT_CONTRACT_VERSION,
        "feature_semantic_version": ALLOCATOR_EV_FEATURE_SEMANTIC_VERSION,
        "label_schema_version": LABEL_SCHEMA_VERSION,
        "expected_return_owner": "allocator_ev_fusion",
        "promotion_state": "production_primary",
        "promotion_tier": "primary",
        "primary_expected_return_allowed": True,
        "validation_packet": {"decision": "PASS", "failed_gates": []},
        "resolver_method": "day_t_causal_l4_residual_overlay",
        "model_version": "allocator-ev-fusion-residual-v14-forward-test",
        "feature_snapshot_version": "allocator-ev-fusion-feature-snapshot-v14-day-t-causal",
        "expected_return_semantic": "l4_base_expected_return_plus_validated_residual_adjustment",
        "base_expected_return_owner": "l4_alpha_ev",
        "trained_until": "2026-08-01",
        "horizon_days": 5,
        "cost_model_bps": 18.0,
        "output_is_net_of_costs": True,
        "policy_value_head_count": 1,
        "policy_value_heads": ["residual_adjustment_model"],
        "residual_adjustment_model": {
            "status": "fitted",
            "decision": "PASS",
            "intercept": 0.02,
            "coefficients": {
                "l4_expected_return": 0.0,
                "market_heat_expected_return": 0.0,
            },
        },
        "residual_output_clip": {"min": -0.08, "max": 0.08},
    }
    return attach_expected_return_artifact_identity(artifact)


def _evaluation(day: str, quality: str, artifact: dict | None = None) -> dict:
    artifact = artifact or _artifact()
    return {
        "prediction_date": day,
        "quality_decision": quality,
        "artifact_id": artifact["artifact_id"],
        "model_fingerprint": artifact["model_fingerprint"],
        "model_version": artifact["model_version"],
    }


def test_identity_ignores_runtime_monitoring_telemetry() -> None:
    artifact = _artifact()
    before = expected_return_artifact_identity(artifact)
    artifact["runtime_forward_guard"] = {"action": "monitor", "degraded_streak": 2}
    assert expected_return_artifact_identity(artifact) == before


def test_snapshot_projection_preserves_exact_serving_payload_with_checksum() -> None:
    serving_payload = {
        **_artifact(),
        "status": "loaded",
        "overlay_status": "applied",
        "final_expected_return": 0.025,
        "base_expected_return": 0.020,
    }
    projection = _recorded_serving_fusion_projection({
        "allocator_ev_fusion": serving_payload,
    })

    assert projection["recorded_serving_allocator_ev_fusion"] == serving_payload
    assert len(projection["recorded_serving_allocator_ev_fusion_checksum"]) == 64
    assert projection["recorded_serving_allocator_ev_fusion_source"] == (
        "daily_recommendations.alpha_allocation"
    )


def test_forward_observation_deducts_roundtrip_cost_exactly_once() -> None:
    artifact = _artifact()
    serving_payload = {
        **artifact,
        "status": "loaded",
        "overlay_status": "applied",
        "final_expected_return": 0.025,
        "base_expected_return": 0.020,
    }
    row = {
        "prediction_date": "2026-08-01",
        "label_known_date": "2026-08-08",
        "symbol": "2330",
        "canonical_gross_return": 0.0318,
        "alpha_allocation": _recorded_serving_fusion_projection({
            "allocator_ev_fusion": serving_payload,
        }),
    }

    observation = _serving_observation(row)

    assert observation is not None
    assert observation["actual_net_return"] == pytest.approx(0.03)
    assert observation["artifact_id"] == artifact["artifact_id"]
    assert observation["model_fingerprint"] == artifact["model_fingerprint"]


def test_forward_observation_rejects_tampered_snapshot_payload() -> None:
    serving_payload = {
        **_artifact(),
        "status": "loaded",
        "overlay_status": "applied",
        "final_expected_return": 0.025,
        "base_expected_return": 0.020,
    }
    allocation = _recorded_serving_fusion_projection({
        "allocator_ev_fusion": serving_payload,
    })
    allocation["recorded_serving_allocator_ev_fusion"]["final_expected_return"] = 0.99

    assert _serving_observation({
        "prediction_date": "2026-08-01",
        "label_known_date": "2026-08-08",
        "symbol": "2330",
        "canonical_gross_return": 0.0318,
        "alpha_allocation": allocation,
    }) is None


def test_forward_loader_is_learning_domain_local_and_requires_recorded_payload() -> None:
    captured: dict[str, object] = {}

    def query(sql: str, params: list[object]) -> list[dict]:
        captured["sql"] = sql
        captured["params"] = params
        return []

    assert load_serving_forward_rows(query, as_of_date="2026-08-08") == []
    sql = str(captured["sql"])
    assert "FROM allocator_ev_feature_snapshots fs" in sql
    assert "recorded_serving_allocator_ev_fusion" in sql
    assert "daily_recommendations" not in sql


def test_uniform_market_crash_does_not_degrade_a_better_fusion_ranking() -> None:
    artifact = _artifact()

    def evaluation_for_market_shift(market_shift: float) -> dict:
        rows = []
        for index in range(20):
            target_net_return = market_shift + index * 0.002
            serving_payload = {
                **artifact,
                "status": "loaded",
                "overlay_status": "applied",
                "final_expected_return": index * 0.001,
                "base_expected_return": -index * 0.001,
            }
            rows.append({
                "prediction_date": "2026-08-01",
                "label_known_date": "2026-08-08",
                "symbol": f"{index:04d}",
                # The evaluator subtracts 18 bps once, yielding target_net_return.
                "canonical_gross_return": target_net_return + 0.0018,
                "alpha_allocation": _recorded_serving_fusion_projection({
                    "allocator_ev_fusion": serving_payload,
                }),
            })
        evaluations = build_serving_forward_evaluations(rows)
        assert len(evaluations) == 1
        return evaluations[0]

    crash = evaluation_for_market_shift(-0.30)
    rally = evaluation_for_market_shift(0.10)

    assert crash["quality_decision"] == "PASS"
    assert crash["final_corr"] == pytest.approx(rally["final_corr"])
    assert crash["l4_corr"] == pytest.approx(rally["l4_corr"])
    assert crash["corr_delta"] == pytest.approx(rally["corr_delta"])
    assert crash["final_spread"] == pytest.approx(rally["final_spread"])
    assert crash["l4_spread"] == pytest.approx(rally["l4_spread"])
    assert crash["spread_delta"] == pytest.approx(rally["spread_delta"])


def test_three_jointly_inferior_dates_activate_only_after_five_evaluable_dates() -> None:
    days = [(date(2026, 7, 27) + timedelta(days=index)).isoformat() for index in range(5)]
    state = derive_forward_guard_state([
        _evaluation(days[0], "PASS"),
        _evaluation(days[1], "PASS"),
        _evaluation(days[2], "DEGRADED"),
        _evaluation(days[3], "DEGRADED"),
        _evaluation(days[4], "DEGRADED"),
    ])

    assert state is not None
    assert state["state"] == "residual_bypass"
    assert state["evaluable_date_count"] == 5
    assert state["degraded_streak"] == 3


def test_active_guard_recovers_only_after_three_consecutive_pass_dates() -> None:
    artifact = _artifact()
    previous = {
        "state": "residual_bypass",
        "artifact_id": artifact["artifact_id"],
        "model_fingerprint": artifact["model_fingerprint"],
    }
    two_passes = derive_forward_guard_state([
        _evaluation("2026-08-03", "DEGRADED", artifact),
        _evaluation("2026-08-04", "PASS", artifact),
        _evaluation("2026-08-05", "PASS", artifact),
    ], previous)
    three_passes = derive_forward_guard_state([
        _evaluation("2026-08-03", "DEGRADED", artifact),
        _evaluation("2026-08-04", "PASS", artifact),
        _evaluation("2026-08-05", "PASS", artifact),
        _evaluation("2026-08-06", "PASS", artifact),
    ], previous)

    assert two_passes and two_passes["state"] == "residual_bypass"
    assert three_passes and three_passes["state"] == "monitoring"


def test_guard_loader_requires_exact_artifact_id_and_fingerprint() -> None:
    artifact = _artifact()

    def exact_query(_sql, _params):
        return [{
            "artifact_id": artifact["artifact_id"],
            "model_fingerprint": artifact["model_fingerprint"],
            "state": "residual_bypass",
            "evaluable_date_count": 5,
            "degraded_streak": 3,
            "recovery_streak": 0,
            "last_prediction_date": "2026-08-06",
        }]

    exact = load_allocator_ev_fusion_forward_guard(artifact, query_fn=exact_query)
    mismatch = load_allocator_ev_fusion_forward_guard(
        {**artifact, "model_version": "allocator-ev-fusion-residual-v14-other"},
        query_fn=exact_query,
    )

    assert exact["action"] == "residual_bypass"
    assert exact["lineage_bound"] is True
    assert mismatch["action"] == "monitor"
    assert mismatch["lineage_bound"] is False


def test_materializer_bypasses_only_exact_active_guard() -> None:
    artifact = _artifact()
    guarded = {
        **artifact,
        "runtime_forward_guard": {
            "action": "residual_bypass",
            "lineage_bound": True,
            "artifact_id": artifact["artifact_id"],
            "model_fingerprint": artifact["model_fingerprint"],
        },
    }
    payload = materialize_allocator_ev_fusion(
        {},
        l4_value=0.01,
        l4_source="l4:test",
        l4_payload={"status": "loaded"},
        market_heat_expected_return=0.0,
        policy={"allocatorEvFusion": guarded},
    )

    assert payload is not None
    assert payload["status"] == "rejected"
    assert "serving_forward_guard_residual_bypass_active" in payload["blockers"]
    assert payload["fusion_residual_adjustment"] == 0.0


def test_forward_guard_migrations_are_executable_and_domain_complete() -> None:
    migration_paths = [
        ROOT.parent / "worker" / "migrations" / "0105_expected_return_serving_forward_guard.sql",
        ROOT.parent / "worker" / "domain-migrations" / "learning" / "0004_expected_return_serving_forward_guard.sql",
    ]
    for path in migration_paths:
        connection = sqlite3.connect(":memory:")
        connection.executescript(path.read_text(encoding="utf-8"))
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
        assert "expected_return_serving_forward_evaluations" in tables
        assert "expected_return_forward_guard_state" in tables
