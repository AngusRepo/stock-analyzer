from __future__ import annotations

import json
import sys
import asyncio
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from routers import config_pool  # noqa: E402
from services.alpha_quality import evaluate_alpha_quality  # noqa: E402


def _row(
    regime: str,
    bucket: str,
    pnl_r: float,
    *,
    selected: bool = True,
    skipped: bool = False,
    volatility_level: str = "normal",
    liquidity_level: str = "normal",
) -> dict:
    return {
        "forecast_data": json.dumps({
            "alpha_context": {
                "regime": regime,
                "edge_bucket": bucket,
                "risk_overlay": {
                    "skip": skipped,
                    "volatility_level": volatility_level,
                    "liquidity_level": liquidity_level,
                },
            },
            "alpha_allocation": {
                "selected": selected,
                "regime": regime,
                "bucket": bucket,
            },
        }),
        "trade_pnl_r": pnl_r,
    }


def test_evaluate_alpha_quality_reports_bucket_and_regime_health():
    rows = []
    rows.extend(_row("bull", "trend_following", 0.6) for _ in range(8))
    rows.extend(_row("bull", "mean_reversion", -0.5) for _ in range(6))
    rows.extend(_row("bear", "defensive_accumulation", 0.3, skipped=True) for _ in range(4))

    report = evaluate_alpha_quality(rows, min_samples=5, min_bucket_samples=5)

    assert report["status"] == "completed"
    assert report["sample_count"] == 18
    assert report["bucket_stats"]["trend_following"]["hit_rate"] == 1.0
    assert report["bucket_stats"]["mean_reversion"]["avg_pnl_r"] == -0.5
    assert report["regime_bucket_stats"]["bull:mean_reversion"]["count"] == 6
    assert any(alert["key"] == "mean_reversion" for alert in report["alerts"])


def test_evaluate_alpha_quality_skips_without_enough_verified_outcomes():
    report = evaluate_alpha_quality([_row("bull", "trend_following", 0.6)], min_samples=3)

    assert report["status"] == "skipped"
    assert report["reason"] == "insufficient_alpha_outcomes"


def test_alpha_quality_report_loads_verified_rows(monkeypatch):
    async def fake_worker_fetch(path: str, method: str = "GET", json_body=None, headers=None):
        assert path == "/api/admin/config"
        return {"alphaFramework": {"quality": {"outcomeLimit": 1000, "minSamples": 30, "minBucketSamples": 8}}}

    monkeypatch.setattr(config_pool, "worker_fetch", fake_worker_fetch)
    monkeypatch.setattr(
        config_pool,
        "load_alpha_outcome_rows",
        lambda limit=1000: [_row("bull", "trend_following", 0.5) for _ in range(6)],
    )

    report = asyncio.run(config_pool.alpha_quality_report(limit=500, min_samples=5, min_bucket_samples=3))

    assert report["status"] == "completed"
    assert report["source"] == "alpha_quality"
    assert report["sample_count"] == 6
    assert report["limit"] == 500
    assert report["query_overrides"] == {
        "limit": True,
        "min_samples": True,
        "min_bucket_samples": True,
    }


def test_alpha_quality_report_defaults_to_trading_config_quality(monkeypatch):
    captured = {}

    async def fake_worker_fetch(path: str, method: str = "GET", json_body=None, headers=None):
        assert path == "/api/admin/config"
        return {"alphaFramework": {"quality": {"outcomeLimit": 700, "minSamples": 4, "minBucketSamples": 2}}}

    def fake_load(limit=1000):
        captured["limit"] = limit
        return [_row("bull", "trend_following", 0.5) for _ in range(4)]

    monkeypatch.setattr(config_pool, "worker_fetch", fake_worker_fetch)
    monkeypatch.setattr(config_pool, "load_alpha_outcome_rows", fake_load)

    report = asyncio.run(config_pool.alpha_quality_report(limit=None, min_samples=None, min_bucket_samples=None))

    assert report["status"] == "completed"
    assert report["sample_count"] == 4
    assert report["limit"] == 700
    assert captured["limit"] == 700
    assert report["query_overrides"] == {
        "limit": False,
        "min_samples": False,
        "min_bucket_samples": False,
    }
