from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import weekly_evidence_service as service
from services import kv_client


def test_canonical_historical_rerun_fails_before_any_runtime_read(monkeypatch):
    monkeypatch.setattr(service, "taiwan_today", lambda: "2026-08-18")

    result = service.run_canonical_weekly_backtest("2026-08-16")

    assert result["status"] == "failed"
    assert result["error"] == "historical_canonical_weekly_rerun_forbidden"
    assert result["production_effect"] is False


def test_snapshot_clock_rejects_future_data(monkeypatch):
    monkeypatch.setattr(
        service,
        "latest_dataset_snapshot",
        lambda **_: {
            "snapshot_id": "future",
            "business_date": "2026-08-17",
            "checksum": "abc",
            "created_at": "2026-08-15T12:00:00Z",
            "metadata_json": '{"start_date":"2025-01-01","end_date":"2026-08-17"}',
        },
    )
    monkeypatch.setattr(service, "validate_dataset_snapshot_manifest", lambda _: [])

    with pytest.raises(RuntimeError, match="snapshot_lookahead_detected"):
        service._resolve_snapshot("2026-08-16")


def test_historical_bundle_is_comparison_only_and_not_promotion_eligible(monkeypatch):
    metrics = SimpleNamespace(
        start_date="2026-01-01",
        end_date="2026-08-14",
        initial_capital=100.0,
        final_equity=105.0,
        total_return=0.05,
        cagr=0.1,
        sharpe=0.5,
        sortino=0.6,
        calmar=0.7,
        max_drawdown=0.1,
        total_trades=1,
        win_rate=1.0,
        profit_factor=2.0,
        expectancy=0.05,
        equity_curve=[
            ("2026-08-10", 101.0),
            ("2026-08-11", 102.0),
            ("2026-08-12", 101.5),
            ("2026-08-13", 103.0),
            ("2026-08-14", 105.0),
        ],
        trades=[],
    )
    monkeypatch.setattr(
        service,
        "_replay",
        lambda **_: (metrics, {"as_of_date": "2026-08-16", "config_checksum": "abc"}),
    )

    params = {"screener": {"min_score": 1}}
    result = service.run_historical_weekly_comparison(
        as_of_date="2026-08-16",
        params=params,
        config_version="trading-config-2026-08-16",
        config_checksum=service._stable_checksum(params),
        config_effective_at="2026-08-16",
        mc_simulations=100,
    )

    assert result["status"] == "success"
    assert result["evidence_scope"] == "comparison_only"
    assert result["production_effect"] is False
    assert result["persisted"] is False
    assert result["promotion_gate_eligible"] is False
    assert result["monte_carlo"]["n_returns"] == 5


def test_formal_position_risk_is_frozen_into_replay_config(monkeypatch):
    risk_config = {
        'position': {
            'maxPerSector': 3,
            'maxSingleNamePct': 0.18,
            'correlationThreshold': 0.65,
            'correlationWindow': 60,
        },
    }
    monkeypatch.setattr(kv_client, 'get_json', lambda *_, **__: risk_config)
    merged = service._with_formal_position_risk({'position': {'maxPositions': 5}})
    formal = merged['positionRiskDistribution']
    assert formal['contractVersion'] == 'position-risk-distribution-v1'
    assert formal['maxPerSector'] == 3
    assert formal['maxSingleNamePct'] == 0.18
    assert formal['correlationThreshold'] == 0.65
    assert formal['sourceRiskConfigChecksum'] == service._stable_checksum(risk_config)


def test_replay_fails_before_dataset_read_when_formal_risk_contract_missing():
    with pytest.raises(RuntimeError, match='weekly_position_risk_contract_missing'):
        service._replay(
            as_of_date='2026-08-16',
            params={'position': {}},
            initial_capital=1_000_000,
            symbols=None,
        )


def test_historical_bundle_rejects_config_lookahead(monkeypatch):
    params = {"screener": {"min_score": 1}}
    with pytest.raises(ValueError, match="config_lookahead_detected"):
        service.run_historical_weekly_comparison(
            as_of_date="2026-08-16",
            params=params,
            config_version="future-config",
            config_checksum=service._stable_checksum(params),
            config_effective_at="2026-08-17",
        )
