from __future__ import annotations

import importlib.util
from pathlib import Path

import polars as pl


REPO_ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "reliable_post_exit",
    REPO_ROOT / "tools/run_s12_state_space_post_exit_validation_reliable.py",
)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def test_selector_only_takes_exit_and_next_session() -> None:
    exit_ms = 1785805200000  # 2026-08-04 in Asia/Taipei
    outcomes = pl.DataFrame([{"symbol": "2330", "exit_ms": exit_ms}])
    manifests = [
        {"producer_run_id": "x:2330", "business_date": "2026-08-04", "r2_key": "exit"},
        {"producer_run_id": "x:2330", "business_date": "2026-08-05", "r2_key": "next"},
        {"producer_run_id": "x:2330", "business_date": "2026-08-06", "r2_key": "later"},
        {"producer_run_id": "x:2317", "business_date": "2026-08-04", "r2_key": "wrong"},
    ]
    selected = MODULE.select_exit_session_manifests(outcomes, manifests)
    assert [row["r2_key"] for row in selected] == ["exit", "next"]
