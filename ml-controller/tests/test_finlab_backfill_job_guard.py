from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from tools.finlab_backfill_job_guard import extract_job_args, validate_finlab_backfill_job_args


def test_finlab_backfill_job_guard_fails_summary_only_d1_job() -> None:
    job = {
        "spec": {
            "template": {
                "spec": {
                    "template": {
                        "spec": {
                            "containers": [
                                {
                                    "args": [
                                        "/app/tools/finlab_v4_remote_backfill.py",
                                        "--years",
                                        "3",
                                        "--run-id",
                                        "auto",
                                        "--write-d1",
                                    ],
                                }
                            ]
                        }
                    }
                }
            }
        }
    }

    result = validate_finlab_backfill_job_args(extract_job_args(job))

    assert result["status"] == "failed"
    assert result["has_write_d1"] is True
    assert result["has_apply_canonical_d1"] is False
    assert "--apply-canonical-d1" in result["required_args"]
    assert "canonical_chip_daily stays stale" in result["impact"]


def test_finlab_backfill_job_guard_accepts_canonical_apply_job() -> None:
    args = [
        "/app/tools/finlab_v4_remote_backfill.py",
        "--years",
        "3",
        "--run-id",
        "auto",
        "--write-d1",
        "--apply-canonical-d1",
        "--canonical-window-days",
        "7",
    ]

    result = validate_finlab_backfill_job_args(args)

    assert result == {
        "status": "ok",
        "has_write_d1": True,
        "has_apply_canonical_d1": True,
        "has_canonical_window_days": True,
        "args": args,
    }
