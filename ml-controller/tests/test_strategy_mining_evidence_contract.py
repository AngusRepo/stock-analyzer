from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import strategy_mining_job_main
from strategy_mining_job_main import _persist_promotion_packets


def _promotion_report(status: str, failed_gates: list[str] | None = None):
    return {
        "adaptive_strategy_families": {
            "families": [{
                "family_id": "family-1",
                "members": ["candidate-1"],
                "representative": {"candidate_id": "candidate-1"},
            }],
        },
        "strategy_research_evidence": {
            "common_candidate_matrix": {"candidate_count": 3, "partition_count": 8},
            "pbo": {"status": "pass", "pbo": 0.2},
            "walk_forward": {"status": "pass"},
            "candidate_evidence": {
                "candidate-1": {
                    "status": status,
                    "failed_gates": failed_gates or [],
                },
            },
        },
    }


def test_promotion_packet_does_not_mark_missing_evidence_as_pass(monkeypatch):
    captured = []
    monkeypatch.setattr(
        strategy_mining_job_main.d1_client,
        "batch_execute",
        lambda statements, **_kwargs: captured.extend(statements) or {"error_count": 0},
    )
    report = _promotion_report("pending")
    report["strategy_research_evidence"]["candidate_evidence"] = {}

    _persist_promotion_packets("run-1", report)

    params = captured[0][1]
    assert params[3] == "research_candidate"
    assert params[4] == "auto_research_evidence_pending"
    assert json.loads(params[5]) == ["research_evidence_pending"]


def test_promotion_packet_persists_failed_evidence(monkeypatch):
    captured = []
    monkeypatch.setattr(
        strategy_mining_job_main.d1_client,
        "batch_execute",
        lambda statements, **_kwargs: captured.extend(statements) or {"error_count": 0},
    )

    _persist_promotion_packets(
        "run-1",
        _promotion_report("failed", ["common_cscv_rank_logit_pbo"]),
    )

    params = captured[0][1]
    assert params[3] == "research_candidate"
    assert params[4] == "auto_research_gate_failed"
    assert json.loads(params[5]) == ["common_cscv_rank_logit_pbo"]


def test_miner_search_objective_does_not_use_holdout():
    source = (
        Path(__file__).resolve().parents[2] / "tools" / "finlab_alpha_miner_bakeoff.py"
    ).read_text(encoding="utf-8")
    fitness = source.split("fitness = (", 1)[1].split("return {", 1)[0]
    assert "holdout_metrics" not in fitness
    assert "full_metrics" not in fitness
    assert '"fitness_contract": "validation_only_v2_holdout_untouched"' in source
