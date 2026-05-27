from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "ml-controller"))

from tools.finlab_v4_remote_backfill import d1_required_env_missing, parse_lanes  # noqa: E402


def test_finlab_remote_backfill_accepts_worker_d1_binding_without_cf_rest_token(monkeypatch) -> None:
    for key in [
        "FINLAB_API_KEY",
        "CF_API_TOKEN",
        "CF_ACCOUNT_ID",
        "CF_D1_DB_ID",
        "STOCKVISION_WORKER_URL",
        "STOCKVISION_AUTH_TOKEN",
    ]:
        monkeypatch.delenv(key, raising=False)

    monkeypatch.setenv("FINLAB_API_KEY", "finlab-test")
    monkeypatch.setenv("STOCKVISION_WORKER_URL", "https://worker.example")
    monkeypatch.setenv("STOCKVISION_AUTH_TOKEN", "worker-token")

    assert d1_required_env_missing() == []


def test_finlab_remote_backfill_requires_cf_rest_when_worker_binding_missing(monkeypatch) -> None:
    for key in [
        "FINLAB_API_KEY",
        "CF_API_TOKEN",
        "CF_ACCOUNT_ID",
        "CF_D1_DB_ID",
        "STOCKVISION_WORKER_URL",
        "STOCKVISION_AUTH_TOKEN",
    ]:
        monkeypatch.delenv(key, raising=False)

    monkeypatch.setenv("FINLAB_API_KEY", "finlab-test")

    assert d1_required_env_missing() == ["CF_API_TOKEN", "CF_ACCOUNT_ID", "CF_D1_DB_ID"]


def test_finlab_remote_backfill_parses_daily_price_fast_lanes() -> None:
    assert parse_lanes("daily_price, emerging_price_diversity,,") == {
        "daily_price",
        "emerging_price_diversity",
    }
