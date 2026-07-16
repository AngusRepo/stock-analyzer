from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from routers import finlab  # noqa: E402
from services import modal_client  # noqa: E402


def test_successful_daily_3y_callback_spawns_long_sequence_refresh(monkeypatch):
    captured: dict = {}

    async def fake_build_finlab_long_sequence_prep(payload: dict, fire_and_forget: bool = False) -> dict:
        captured["payload"] = payload
        captured["fire_and_forget"] = fire_and_forget
        return {"status": "spawned"}

    monkeypatch.setenv("GCS_BUCKET_NAME", "stockvision-models")
    monkeypatch.setenv("FINLAB_LONG_SEQUENCE_REFRESH_ENABLED", "1")
    monkeypatch.setenv("FINLAB_LONG_SEQUENCE_5Y_BASE_RUN_ID", "finlab-v4-5y-base")
    monkeypatch.setenv("FINLAB_LONG_SEQUENCE_OUTPUT_PREFIX", "universal/sequence_long/latest")
    monkeypatch.setattr(finlab, "_gcs_object_exists", lambda uri: True)
    monkeypatch.setattr(modal_client, "build_finlab_long_sequence_prep", fake_build_finlab_long_sequence_prep)

    result = asyncio.run(
        finlab._maybe_spawn_long_sequence_refresh(
            {
                "status": "success",
                "run_date": "2026-06-11",
                "result": {"run_id": "finlab-v4-3y-20260611-1781186403489"},
            }
        )
    )

    assert result["status"] == "spawned"
    assert result["function"] == "build_finlab_long_sequence_prep"
    assert result["output_gcs_prefix"] == "universal/sequence_long/latest"
    assert result["trigger_run_id"] == "finlab-v4-3y-20260611-1781186403489"
    assert captured["fire_and_forget"] is True
    assert captured["payload"] == {
        "source_gcs_prefixes": [
            "gs://stockvision-models/finlab/v4/backfill/finlab-v4-5y-base",
            "gs://stockvision-models/finlab/v4/backfill/finlab-v4-3y-20260611-1781186403489",
        ],
        "output_gcs_prefix": "universal/sequence_long/latest",
        "lanes": ["daily_price"],
        "min_len": 65,
        "batch_size": 512,
        "trigger_source": "finlab_backfill_controller_callback",
        "trigger_run_id": "finlab-v4-3y-20260611-1781186403489",
        "run_date": "2026-06-11",
    }


def test_successful_daily_incremental_callback_spawns_long_sequence_refresh(monkeypatch):
    captured: dict = {}

    async def fake_build_finlab_long_sequence_prep(payload: dict, fire_and_forget: bool = False) -> dict:
        captured["payload"] = payload
        captured["fire_and_forget"] = fire_and_forget
        return {"status": "spawned"}

    monkeypatch.setenv("GCS_BUCKET_NAME", "stockvision-models")
    monkeypatch.setenv("FINLAB_LONG_SEQUENCE_REFRESH_ENABLED", "1")
    monkeypatch.setenv("FINLAB_LONG_SEQUENCE_5Y_BASE_RUN_ID", "finlab-v4-5y-base")
    monkeypatch.setenv("FINLAB_LONG_SEQUENCE_OUTPUT_PREFIX", "universal/sequence_long/latest")
    monkeypatch.setattr(finlab, "_gcs_object_exists", lambda uri: True)
    monkeypatch.setattr(modal_client, "build_finlab_long_sequence_prep", fake_build_finlab_long_sequence_prep)

    result = asyncio.run(
        finlab._maybe_spawn_long_sequence_refresh(
            {
                "status": "success",
                "run_date": "2026-07-02",
                "result": {"run_id": "finlab-v4-daily-20260702-178298215995"},
            }
        )
    )

    assert result["status"] == "spawned"
    assert result["function"] == "build_finlab_long_sequence_prep"
    assert result["output_gcs_prefix"] == "universal/sequence_long/latest"
    assert result["trigger_run_id"] == "finlab-v4-daily-20260702-178298215995"
    assert captured["fire_and_forget"] is True
    assert captured["payload"] == {
        "source_gcs_prefixes": [
            "gs://stockvision-models/finlab/v4/backfill/finlab-v4-5y-base",
            "gs://stockvision-models/finlab/v4/backfill/finlab-v4-daily-20260702-178298215995",
        ],
        "output_gcs_prefix": "universal/sequence_long/latest",
        "lanes": ["daily_price"],
        "min_len": 65,
        "batch_size": 512,
        "trigger_source": "finlab_backfill_controller_callback",
        "trigger_run_id": "finlab-v4-daily-20260702-178298215995",
        "run_date": "2026-07-02",
    }


def test_long_sequence_refresh_skips_non_tail_backfill(monkeypatch):
    async def fake_build_finlab_long_sequence_prep(payload: dict, fire_and_forget: bool = False) -> dict:
        raise AssertionError("long sequence refresh should not spawn")

    monkeypatch.setenv("GCS_BUCKET_NAME", "stockvision-models")
    monkeypatch.setenv("FINLAB_LONG_SEQUENCE_REFRESH_ENABLED", "1")
    monkeypatch.setattr(modal_client, "build_finlab_long_sequence_prep", fake_build_finlab_long_sequence_prep)

    result = asyncio.run(
        finlab._maybe_spawn_long_sequence_refresh(
            {
                "status": "success",
                "run_date": "2026-06-11",
                "result": {"run_id": "finlab-v4-5y-20260611-1781186403489"},
            }
        )
    )

    assert result == {
        "status": "skipped",
        "reason": "not_daily_tail_backfill",
        "run_id": "finlab-v4-5y-20260611-1781186403489",
    }


def test_long_sequence_refresh_skips_daily_run_without_price_tail(monkeypatch):
    async def fake_build_finlab_long_sequence_prep(payload: dict, fire_and_forget: bool = False) -> dict:
        raise AssertionError("long sequence refresh should not spawn without adjusted OHLC label fields")

    monkeypatch.setenv("GCS_BUCKET_NAME", "stockvision-models")
    monkeypatch.setenv("FINLAB_LONG_SEQUENCE_REFRESH_ENABLED", "1")
    monkeypatch.setattr(finlab, "_gcs_object_exists", lambda uri: False)
    monkeypatch.setattr(modal_client, "build_finlab_long_sequence_prep", fake_build_finlab_long_sequence_prep)

    result = asyncio.run(
        finlab._maybe_spawn_long_sequence_refresh(
            {
                "status": "success",
                "run_date": "2026-07-02",
                "result": {"run_id": "finlab-v4-daily-20260702-chip-only"},
            }
        )
    )

    assert result == {
        "status": "skipped",
        "reason": "tail_daily_price_adjusted_ohlc_label_contract_missing",
        "run_id": "finlab-v4-daily-20260702-chip-only",
        "required_uris": [
            "gs://stockvision-models/finlab/v4/backfill/finlab-v4-daily-20260702-chip-only/raw/daily_price/adj_close.parquet",
            "gs://stockvision-models/finlab/v4/backfill/finlab-v4-daily-20260702-chip-only/raw/daily_price/adj_open.parquet",
        ],
        "missing_uris": [
            "gs://stockvision-models/finlab/v4/backfill/finlab-v4-daily-20260702-chip-only/raw/daily_price/adj_close.parquet",
            "gs://stockvision-models/finlab/v4/backfill/finlab-v4-daily-20260702-chip-only/raw/daily_price/adj_open.parquet",
        ],
    }


def test_long_sequence_refresh_excludes_legacy_base_without_adjusted_ohlc(monkeypatch):
    captured: dict = {}

    async def fake_build_finlab_long_sequence_prep(payload: dict, fire_and_forget: bool = False) -> dict:
        captured["payload"] = payload
        return {"status": "spawned"}

    monkeypatch.setenv("GCS_BUCKET_NAME", "stockvision-models")
    monkeypatch.setenv("FINLAB_LONG_SEQUENCE_REFRESH_ENABLED", "1")
    monkeypatch.setenv("FINLAB_LONG_SEQUENCE_5Y_BASE_RUN_ID", "finlab-v4-5y-base")
    monkeypatch.setattr(
        finlab,
        "_gcs_object_exists",
        lambda uri: "finlab-v4-5y-base" not in uri,
    )
    monkeypatch.setattr(modal_client, "build_finlab_long_sequence_prep", fake_build_finlab_long_sequence_prep)

    result = asyncio.run(finlab._maybe_spawn_long_sequence_refresh({
        "status": "success",
        "run_date": "2026-07-15",
        "result": {"run_id": "finlab-v4-daily-20260715-tail"},
    }))

    tail_prefix = "gs://stockvision-models/finlab/v4/backfill/finlab-v4-daily-20260715-tail"
    assert captured["payload"]["source_gcs_prefixes"] == [tail_prefix]
    assert result["base_source_status"] == "excluded_missing_adjusted_ohlc"
    assert len(result["base_missing_uris"]) == 2


def test_long_sequence_refresh_can_be_disabled(monkeypatch):
    async def fake_build_finlab_long_sequence_prep(payload: dict, fire_and_forget: bool = False) -> dict:
        raise AssertionError("long sequence refresh should not spawn")

    monkeypatch.setenv("GCS_BUCKET_NAME", "stockvision-models")
    monkeypatch.setenv("FINLAB_LONG_SEQUENCE_REFRESH_ENABLED", "0")
    monkeypatch.setattr(modal_client, "build_finlab_long_sequence_prep", fake_build_finlab_long_sequence_prep)

    result = asyncio.run(
        finlab._maybe_spawn_long_sequence_refresh(
            {
                "status": "success",
                "run_date": "2026-06-11",
                "result": {"run_id": "finlab-v4-3y-20260611-1781186403489"},
            }
        )
    )

    assert result == {"status": "skipped", "reason": "disabled"}
