from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml-controller"))

from services.score_v2_fundamental_migration_preflight import (  # noqa: E402
    REQUIRED_COLUMNS,
    build_fundamental_migration_preflight_report,
)


MIGRATION_SQL = (ROOT / "worker" / "migration_score_v2_fundamental_quality.sql").read_text(encoding="utf-8")


def test_fundamental_migration_preflight_ready_to_apply_when_live_table_missing() -> None:
    report = build_fundamental_migration_preflight_report(
        migration_sql=MIGRATION_SQL,
        table_names=[],
        inventory={},
    )

    assert report["schema_version"] == "score-v2-fundamental-migration-preflight-v1"
    assert report["mode"] == "read_only"
    assert report["decision"] == "READY_TO_APPLY"
    assert report["passed"] is True
    assert report["failed_checks"] == []
    assert report["live_schema"]["table_exists"] is False
    assert "request_wei_approval_before_apply" == report["allowed_next_action"]
    assert "wrangler@4 d1 execute stockvision-db --remote" in report["apply_command_hint"]


def test_fundamental_migration_preflight_schema_applied_waiting_data() -> None:
    report = build_fundamental_migration_preflight_report(
        migration_sql=MIGRATION_SQL,
        table_names=["canonical_fundamental_features"],
        inventory={"fundamental_total": 0},
    )

    assert report["decision"] == "SCHEMA_APPLIED_WAITING_DATA"
    assert report["allowed_next_action"] == "materialize_canonical_fundamental_features"


def test_fundamental_migration_preflight_already_applied_with_rows() -> None:
    report = build_fundamental_migration_preflight_report(
        migration_sql=MIGRATION_SQL,
        table_names=["canonical_fundamental_features"],
        inventory={"fundamental_total": 1200, "fundamental_latest_available_date": "2026-05-22"},
    )

    assert report["decision"] == "ALREADY_APPLIED"
    assert report["live_schema"]["fundamental_total"] == 1200
    assert report["allowed_next_action"] == "run_contribution_readiness_gate"


def test_fundamental_migration_preflight_blocks_missing_columns_or_destructive_sql() -> None:
    unsafe_sql = "CREATE TABLE IF NOT EXISTS canonical_fundamental_features (stock_id TEXT); DROP TABLE x;"

    report = build_fundamental_migration_preflight_report(
        migration_sql=unsafe_sql,
        table_names=[],
        inventory={},
    )

    assert report["decision"] == "BLOCK"
    assert "migration_file_has_required_columns" in report["failed_checks"]
    assert "migration_file_has_no_destructive_sql" in report["failed_checks"]
    assert set(REQUIRED_COLUMNS) - {"stock_id"}


def test_fundamental_migration_preflight_cli_accepts_offline_input() -> None:
    input_path = ROOT / ".tmp" / "score_v2_fundamental_migration_preflight_input.json"
    input_path.parent.mkdir(parents=True, exist_ok=True)
    input_path.write_text(json.dumps({
        "table_names": [],
        "inventory": {},
    }), encoding="utf-8")

    completed = subprocess.run(
        [
            sys.executable,
            str(ROOT / "ml-controller" / "scripts" / "score_v2_fundamental_migration_preflight.py"),
            "--input-json",
            str(input_path),
        ],
        cwd=str(ROOT),
        check=True,
        text=True,
        capture_output=True,
    )

    report = json.loads(completed.stdout)
    assert report["decision"] == "READY_TO_APPLY"
    assert report["mode"] == "read_only"


def test_fundamental_migration_preflight_cli_is_read_only() -> None:
    source = (ROOT / "ml-controller" / "scripts" / "score_v2_fundamental_migration_preflight.py").read_text(encoding="utf-8")

    assert "d1_client.query" in source
    assert "d1_client.execute" not in source
    assert "batch_execute" not in source
    assert "subprocess.run" in source
    assert "--file=./migration_score_v2_fundamental_quality.sql" not in source
