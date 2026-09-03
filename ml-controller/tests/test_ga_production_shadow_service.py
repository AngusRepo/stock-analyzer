from __future__ import annotations

import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from services import ga_production_shadow_service as service  # noqa: E402


class FakeLearningClient:
    def __init__(self, active: dict | None):
        self.active = active
        self.executions: list[tuple[str, list]] = []
        self.atomic_batches: list[list[tuple[str, list]]] = []
        self.evidence: dict | None = None

    def query(self, sql, params=None, **_kwargs):
        normalized = " ".join(str(sql).split())
        if "FROM ga_optimizer_shadow_candidates_v1" in normalized and "status='ACTIVE'" in normalized:
            return [self.active] if self.active else []
        if "WHERE shadow_id=? AND business_date=?" in normalized:
            return []
        if "WHERE shadow_id=? AND snapshot_business_date=?" in normalized:
            return []
        if "WHERE evidence_id=?" in normalized:
            return [{"evidence_checksum": self.evidence["checksum"]}] if self.evidence else []
        if "COUNT(*) AS n" in normalized:
            return [{"n": 1 if self.evidence else 0}]
        raise AssertionError(normalized)

    def execute(self, sql, params=None, **_kwargs):
        values = list(params or [])
        assert str(sql).count("?") == len(values)
        self.executions.append((sql, values))
        return {"success": True}

    def atomic_batch_execute(self, statements, **_kwargs):
        for sql, params in statements:
            assert str(sql).count("?") == len(params)
        self.atomic_batches.append(statements)
        evidence_params = statements[0][1]
        self.evidence = {
            "id": evidence_params[0],
            "checksum": evidence_params[-2],
        }
        return {"success": True, "atomic": True}


def _active_candidate() -> dict:
    candidate = {"alphaFramework": {"scoring": {"momentum": 0.55}}}
    baseline = {"alphaFramework": {"scoring": {"momentum": 0.40}}}
    return {
        "shadow_id": "ga-shadow-v1:test",
        "candidate_registry_id": "parameter:ga:test",
        "ga_candidate_id": "ga_optimizer:g3:c7",
        "status": "ACTIVE",
        "candidate_config_json": service._stable_json(candidate),
        "candidate_config_checksum": service._checksum_json(candidate),
        "baseline_config_json": service._stable_json(baseline),
        "baseline_config_checksum": service._checksum_json(baseline),
        "evaluator_version": service.EVALUATOR_VERSION,
        "enrolled_business_date": "2026-09-01",
        "enrollment_snapshot_id": "snapshot-enroll",
        "enrollment_snapshot_checksum": "sha256:enroll",
        "source_run_id": "weekly-ga-1",
        "source_cadence": "weekly",
    }


def _evidence_runner(candidate, **kwargs):
    assert candidate["id"] == "ga_optimizer:g3:c7"
    assert kwargs["mode"] == "A"
    assert kwargs["start_date"] == "2026-09-02"
    assert kwargs["end_date"] == "2026-09-02"
    assert kwargs["parity_audit"]["worker_parity"]["decision"] == "MISSING"
    return {
        "comparison": {
            "schema_version": "paired-candidate-champion-comparison-v1",
            "same_dataset": True,
            "costs_included": True,
            "champion": {
                "total_return": 0.01,
                "total_trades": 7,
                "sharpe": 0.6,
                "max_drawdown": 0.04,
                "profit_factor": 1.1,
                "win_rate": 0.51,
                "fill_rate": 0.8,
                "trade_return_series": [0.01, -0.005],
                "partition_returns": [0.01, 0.0, 0.02],
            },
            "candidate": {
                "total_return": 0.03,
                "total_trades": 8,
                "sharpe": 0.9,
                "max_drawdown": 0.03,
                "profit_factor": 1.3,
                "win_rate": 0.56,
                "fill_rate": 0.82,
                "trade_return_series": [0.02, 0.01],
                "partition_returns": [0.02, 0.01, 0.03],
            },
            "delta": {"total_return": 0.02, "total_trades": 1, "fill_rate": 0.02},
        },
        "walk_forward": {"passed": True, "windows": 3},
        "pbo": {"pbo": 0.2},
        "monte_carlo": {"mdd_95th": 0.1},
        "gate": {"decision": "PASS"},
        "provenance": {"candidate_specific": True},
    }


def _snapshot_resolver(_run_date):
    return (
        {
            "snapshot_id": "snapshot-2026-09-02",
            "checksum": "sha256:snapshot",
            "business_date": "2026-09-02",
            "created_at": "2026-09-02T22:00:00+08:00",
            "producer_run_id": "evening-2026-09-02",
        },
        "2025-01-01",
        "2026-09-02",
    )


def test_daily_shadow_persists_one_candidate_bound_paired_snapshot(monkeypatch):
    client = FakeLearningClient(_active_candidate())
    monkeypatch.setattr(service, "LEARNING_D1_CLIENT", client)

    result = service.run_ga_production_shadow(
        run_date="2026-09-02",
        run_id="evening-2026-09-02",
        evidence_runner=_evidence_runner,
        snapshot_resolver=_snapshot_resolver,
    )

    assert result["status"] == "COMPLETED"
    assert result["evidence_business_date"] == "2026-09-02"
    assert result["paired_return_delta"] == 0.02
    assert result["production_effect"] is False
    assert len(client.atomic_batches) == 1
    evidence_sql, evidence_params = client.atomic_batches[0][0]
    assert "INSERT INTO ga_optimizer_shadow_daily_evidence_v1" in evidence_sql
    assert evidence_params[1] == "ga-shadow-v1:test"
    assert evidence_params[2] == "2026-09-02"
    assert evidence_params[-1] == "evening-2026-09-02"


def test_daily_shadow_skips_without_active_candidate(monkeypatch):
    client = FakeLearningClient(None)
    monkeypatch.setattr(service, "LEARNING_D1_CLIENT", client)

    result = service.run_ga_production_shadow(
        run_date="2026-09-02",
        run_id="evening-2026-09-02",
    )

    assert result == {
        "status": "NO_ACTIVE",
        "run_date": "2026-09-02",
        "production_effect": False,
    }
    assert client.atomic_batches == []
    assert client.executions
