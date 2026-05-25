from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml-controller"))

from routers.finlab import (  # noqa: E402
    FinLabBackfillRunRequest,
    build_finlab_backfill_modal_payload,
)


def test_finlab_backfill_modal_payload_preserves_full_quality_defaults() -> None:
    payload = build_finlab_backfill_modal_payload(
        FinLabBackfillRunRequest(
            years=3,
            run_id="finlab-v4-test",
            trigger_source="unit-test",
        )
    )

    assert payload["executor"] == "modal"
    assert payload["source"] == "finlab_v4_backfill"
    assert payload["years"] == 3
    assert payload["write_d1"] is True
    assert payload["apply_canonical_d1"] is True
    assert payload["canonical_window_days"] == 7
    assert payload["callback_task"] == "finlab-v4-backfill"


def test_finlab_backfill_modal_payload_rejects_non_archive_years() -> None:
    with pytest.raises(ValueError, match="years must be 3 or 5"):
        build_finlab_backfill_modal_payload(FinLabBackfillRunRequest(years=1))


def test_modal_app_exposes_finlab_backfill_function_with_same_cloud_run_spec() -> None:
    source = (ROOT / "ml-service" / "modal_app.py").read_text(encoding="utf-8")

    assert '_LOCAL_TOOLS_DIR = Path(__file__).parent.parent / "tools"' in source
    assert 'finlab_image = (' in source
    assert '.pip_install("finlab==2.0.7")' in source
    assert 'def finlab_v4_backfill(payload: dict) -> dict:' in source
    assert "cpu=4" in source
    assert "memory=16384" in source
    assert "timeout=7200" in source
    assert '"--apply-canonical-d1"' in source
    assert '"task": callback_task' in source


def test_controller_route_and_modal_client_have_spawn_boundary() -> None:
    main_source = (ROOT / "ml-controller" / "main.py").read_text(encoding="utf-8")
    modal_client_source = (ROOT / "ml-controller" / "services" / "modal_client.py").read_text(encoding="utf-8")

    assert "app.include_router(finlab.router" in main_source
    assert '"finlab_v4_backfill": {"cpu": 4.0, "memory_mb": 16384' in modal_client_source
    assert "async def spawn_finlab_v4_backfill" in modal_client_source
    assert "FINLAB_BACKFILL_EXECUTOR=modal" in (ROOT / "ml-controller" / "routers" / "finlab.py").read_text(encoding="utf-8")
