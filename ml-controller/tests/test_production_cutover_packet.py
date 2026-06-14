from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.production_cutover_packet import build_production_cutover_packet


def _write(path: Path, payload: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(payload, encoding="utf-8")


def _seed_ready_evidence(root: Path, audit_payload: dict[str, object] | None = None) -> None:
    audit = audit_payload or {
        "local_closure": "done",
        "local_prod_ready": "done",
        "failed_checks": [],
        "promotion_allowed": False,
        "production_mutation_allowed": False,
    }
    _write(
        root / "ml-service/benchmark_results/local_prod_ready_audit_20260614.json",
        json.dumps(audit),
    )
    _write(
        root / "ml-service/benchmark_results/adaptive_meta_policy_replay_20260605_20260611.json",
        json.dumps({"status": "fail", "production_effect": False}),
    )
    _write(
        root / "ml-service/benchmark_results/linucb_multiplier_replay_20260605_20260611.json",
        json.dumps({"status": "fail", "production_effect": False}),
    )


def test_production_cutover_packet_is_ready_for_review_but_non_mutating(tmp_path):
    _seed_ready_evidence(tmp_path)

    packet = build_production_cutover_packet(tmp_path)

    assert packet["cutover_ready_for_review"] is True
    assert packet["production_mutation_allowed"] is False
    assert packet["actions_allowed_without_wei_approval"] == []
    assert packet["local_gate"]["passed"] is True
    assert packet["blocked_reason"] is None
    action_ids = {row["id"] for row in packet["approval_required_actions"]}
    assert "sync_gcp_scheduler_manifest" in action_ids
    assert "update_model_pool_champion_pointers" in action_ids


def test_production_cutover_packet_blocks_when_local_gate_is_not_done(tmp_path):
    _seed_ready_evidence(tmp_path, {
        "local_closure": "done",
        "local_prod_ready": "blocked",
        "failed_checks": [{"id": "runtime_pin:xgboost==3.2.0"}],
        "promotion_allowed": False,
        "production_mutation_allowed": False,
    })

    packet = build_production_cutover_packet(tmp_path)

    assert packet["cutover_ready_for_review"] is False
    assert packet["production_mutation_allowed"] is False
    assert packet["local_gate"]["passed"] is False
    assert packet["blocked_reason"]["local_gate_passed"] is False


def test_production_cutover_packet_blocks_when_evidence_is_missing(tmp_path):
    _write(
        tmp_path / "ml-service/benchmark_results/local_prod_ready_audit_20260614.json",
        json.dumps({
            "local_closure": "done",
            "local_prod_ready": "done",
            "failed_checks": [],
            "promotion_allowed": False,
            "production_mutation_allowed": False,
        }),
    )

    packet = build_production_cutover_packet(tmp_path)

    assert packet["cutover_ready_for_review"] is False
    assert packet["blocked_reason"]["evidence_ready"] is False
