from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools import production_cutover_remote_preflight as remote_preflight


def _stub_checks(*_args, **_kwargs):
    return (
        [
            {
                "id": "gcp_scheduler_monthly_strategy_mining",
                "status": "present",
                "evidence": {},
            }
        ],
        {"scheduler": {"cmd": ["stub"], "returncode": 0, "stderr": ""}},
    )


def _write_packet(root: Path, payload: dict[str, object]) -> None:
    path = root / remote_preflight.LOCAL_CUTOVER_PACKET_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


def test_remote_preflight_does_not_hardcode_local_packet_ready(monkeypatch, tmp_path):
    monkeypatch.setattr(remote_preflight, "_build_checks", _stub_checks)

    result = remote_preflight.build_remote_preflight(tmp_path, "asia-east1", "asia-east1")

    assert result["summary"]["remote_cutover_complete"] is True
    assert result["summary"]["local_cutover_packet_ready_for_review"] is False
    assert result["summary"]["local_cutover_packet_blocked_reason"] == "local_cutover_packet_missing"


def test_remote_preflight_reports_blocked_local_packet(monkeypatch, tmp_path):
    monkeypatch.setattr(remote_preflight, "_build_checks", _stub_checks)
    _write_packet(
        tmp_path,
        {
            "cutover_ready_for_review": False,
            "production_mutation_allowed": False,
            "blocked_reason": {"local_gate_passed": False},
        },
    )

    result = remote_preflight.build_remote_preflight(tmp_path, "asia-east1", "asia-east1")

    assert result["summary"]["local_cutover_packet_ready_for_review"] is False
    assert result["summary"]["local_cutover_packet_blocked_reason"] == {"local_gate_passed": False}


def test_remote_preflight_reports_ready_local_packet(monkeypatch, tmp_path):
    monkeypatch.setattr(remote_preflight, "_build_checks", _stub_checks)
    _write_packet(
        tmp_path,
        {
            "cutover_ready_for_review": True,
            "production_mutation_allowed": False,
            "blocked_reason": None,
        },
    )

    result = remote_preflight.build_remote_preflight(tmp_path, "asia-east1", "asia-east1")

    assert result["summary"]["local_cutover_packet_ready_for_review"] is True
    assert result["summary"]["local_cutover_packet_blocked_reason"] is None
