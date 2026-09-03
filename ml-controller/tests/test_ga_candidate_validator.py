from __future__ import annotations

import pytest

from services import ga_candidate_validator
from services.ga_optimizer_service import build_ga_candidate, evaluate_ga_population


def _completed_evidence() -> dict:
    return {
        "backtest": {
            "mode": "B",
            "total_trades": 90,
            "sharpe": 1.0,
            "profit_factor": 1.2,
            "max_drawdown": 0.1,
        },
        "monte_carlo": {
            "simulation_method": "regime_block_bootstrap",
            "mdd_95th": 0.15,
        },
        "pbo": {
            "method": "cscv_rank_logit",
            "pbo": 0.2,
            "oos_mean_return": 0.01,
        },
        "gate": {
            "decision": "PASS",
            "failed_gates": [],
            "validation_packet": {"decision": "PASS", "failed_gates": []},
        },
    }


def test_validator_maps_ga_params_into_exact_snapshot_mode_b_replay(monkeypatch):
    snapshot = {
        "snapshot_id": "snapshot-2026-09-01",
        "checksum": "abc123",
        "business_date": "2026-09-01",
        "created_at": "2026-09-01T14:00:00+08:00",
        "producer_run_id": "evening-2026-09-01",
    }
    monkeypatch.setattr(
        ga_candidate_validator,
        "_resolve_snapshot",
        lambda _as_of: (snapshot, "2025-09-01", "2026-09-01"),
    )
    monkeypatch.setattr(
        ga_candidate_validator.BacktestDataset,
        "load_from_snapshot_manifest",
        lambda **kwargs: {"loaded": kwargs},
    )
    captured: dict = {}

    def fake_evidence_runner(candidate, **kwargs):
        captured["candidate"] = candidate
        captured["kwargs"] = kwargs
        dataset, access = kwargs["dataset_loader"](
            start_date=kwargs["start_date"],
            end_date=kwargs["end_date"],
            symbols=None,
        )
        captured["dataset"] = dataset
        captured["access"] = access
        return _completed_evidence()

    candidate = build_ga_candidate(None, generation=0, candidate_index=0)
    search = evaluate_ga_population([candidate])
    result = ga_candidate_validator.validate_ga_top_candidate(
        search,
        as_of_date="2026-09-01",
        baseline_config={"alphaFramework": {"riskOverlay": {"highVolThreshold": 0.05}}},
        evidence_runner=fake_evidence_runner,
    )

    assert captured["candidate"]["config"]["alphaFramework"] == candidate["params"]["alphaFramework"]
    assert captured["kwargs"]["mode"] == "B"
    assert captured["access"]["snapshot_id"] == snapshot["snapshot_id"]
    assert captured["access"]["look_ahead_check"] == "PASS"
    assert result["validation"]["status"] == "completed"
    assert result["best"]["evidence_clock"]["data_end_date"] == "2026-09-01"
    assert result["best"]["gate"]["passed"] is True


def test_validator_rejects_candidate_without_alpha_framework(monkeypatch):
    monkeypatch.setattr(
        ga_candidate_validator,
        "_resolve_snapshot",
        lambda _as_of: ({"snapshot_id": "s1"}, "2025-09-01", "2026-09-01"),
    )
    search = {
        "best": {
            "candidate": {"id": "ga-missing", "params": {}},
            "score": 1.0,
            "metrics": {},
        }
    }

    with pytest.raises(RuntimeError, match="ga_top_candidate_alpha_framework_missing"):
        ga_candidate_validator.validate_ga_top_candidate(
            search,
            as_of_date="2026-09-01",
            baseline_config={},
            evidence_runner=lambda *_args, **_kwargs: _completed_evidence(),
        )
