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



def test_missing_holdout_signal_days_never_promote_a_passing_fake_packet(monkeypatch):
    from types import SimpleNamespace
    from services.ga_candidate_validator import validate_ga_top_candidate
    context=SimpleNamespace(snapshot={'snapshot_id':'s','checksum':'sealed'},
        split={'validation_start':'2026-09-01','validation_end':'2026-09-03'},baseline={},
        dataset=SimpleNamespace(replay_frames={},trading_days=['2026-09-01','2026-09-02','2026-09-03']))
    monkeypatch.setattr('services.backtest_snapshot_state.frozen_mode_b',
        lambda ds:(SimpleNamespace(_dates={'2026-09-01'}),None,None))
    search=evaluate_ga_population([build_ga_candidate(None,generation=0,candidate_index=0)])
    out=validate_ga_top_candidate(search,as_of_date='2026-10-03',search_context=context,
        evidence_runner=lambda *a,**kw:_completed_evidence())
    assert out['validation']['status']=='completed'
    assert 'frozen_prediction_calendar_incomplete' in out['validation']['failed_gates']
    assert out['best']['gate']['passed'] is False
    assert out['frozen_prediction_coverage']['missing_decision_dates']==['2026-09-02']



def test_validator_passes_daily_nav_sharpe_to_evidence_not_trade_sharpe():
    from types import SimpleNamespace
    from services.ga_candidate_validator import validate_ga_top_candidate
    context=SimpleNamespace(snapshot={'snapshot_id':'s','checksum':'sealed'},
        split={'validation_start':'2026-09-01','validation_end':'2026-09-03'},baseline={},
        dataset=SimpleNamespace(replay_frames=None),replay=lambda **kw:SimpleNamespace(
            initial_capital=100.,final_equity=95.,sharpe=9.,max_drawdown=.1,
            equity_curve=[('2026-09-01',100.),('2026-09-02',90.),('2026-09-03',95.)]))
    def evidence(candidate,**kwargs):
        metric=kwargs['replay_fn']()
        assert metric.sharpe<0 and metric.trade_sharpe_diagnostic==9.
        return _completed_evidence()
    search=evaluate_ga_population([build_ga_candidate(None,generation=0,candidate_index=0)])
    validate_ga_top_candidate(search,search_context=context,evidence_runner=evidence)
