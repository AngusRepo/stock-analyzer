from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml-controller"))

from services.score_v2_replay_audit import (  # noqa: E402
    build_score_v2_readonly_replay_report,
    evaluate_score_v2_rollout_gate,
)


def _score_v2(
    final_score: float,
    *,
    chip: float = 10,
    tech: float = 10,
    fundamental: float = 5,
    news: float = 2,
    risk_flags: list[str] | None = None,
) -> str:
    return json.dumps({
        "version": "score_v2",
        "components": {
            "mlEdge": 10,
            "chipFlow": chip,
            "technicalStructure": tech,
            "fundamentalQuality": fundamental,
            "newsTheme": news,
        },
        "total": final_score,
        "finalScore": final_score,
        "riskFlags": risk_flags or [],
        "reasons": [],
    })


def test_score_v2_readonly_replay_report_compares_legacy_and_v2_rankings() -> None:
    report = build_score_v2_readonly_replay_report(
        [
            {"date": "2026-05-22", "symbol": "2330", "rank": 1, "score": 80, "score_components": _score_v2(60, risk_flags=["official_negative_risk"])},
            {"date": "2026-05-22", "symbol": "2454", "rank": 2, "score": 70, "score_components": _score_v2(90, chip=20, tech=20)},
            {"date": "2026-05-22", "symbol": "2308", "rank": 3, "score": 65, "score_components": _score_v2(66)},
            {"date": "2026-05-22", "symbol": "9999", "rank": 4, "score": 50, "score_components": None},
        ],
        top_n=2,
    )

    assert report["mode"] == "read_only"
    assert report["row_count"] == 4
    assert report["valid_comparison_rows"] == 3
    assert report["missing_score_v2_count"] == 1
    assert report["score_v2_coverage"] == 0.75
    assert report["date_reports"][0]["top_overlap_ratio"] == 0.5
    assert report["risk_flag_counts"] == {"official_negative_risk": 1}
    assert report["component_summary"]["chipFlow"]["avg"] > 0
    assert any(row["symbol"] == "2330" and row["rank_delta"] > 0 for row in report["drift_rows"])


def test_score_v2_rollout_gate_passes_when_replay_and_components_are_ready() -> None:
    report = build_score_v2_readonly_replay_report(
        [
            {"date": "2026-05-22", "symbol": "2330", "rank": 1, "score": 80, "score_components": _score_v2(80, fundamental=8, news=1)},
            {"date": "2026-05-22", "symbol": "2454", "rank": 2, "score": 75, "score_components": _score_v2(75, fundamental=6, news=3)},
            {"date": "2026-05-22", "symbol": "2308", "rank": 3, "score": 70, "score_components": _score_v2(70, fundamental=4, news=1)},
        ],
        top_n=2,
    )

    gate = evaluate_score_v2_rollout_gate(report)

    assert gate["schema_version"] == "score-v2-rollout-gate-v1"
    assert gate["mode"] == "read_only"
    assert gate["decision"] == "PASS"
    assert gate["passed"] is True
    assert gate["failed_gates"] == []
    assert gate["allowed_next_action"] == "cutover_candidate"


def test_score_v2_rollout_gate_blocks_zero_fundamental_and_news_components() -> None:
    report = build_score_v2_readonly_replay_report(
        [
            {"date": "2026-05-22", "symbol": "2330", "rank": 1, "score": 80, "score_components": _score_v2(80, fundamental=0, news=0)},
            {"date": "2026-05-22", "symbol": "2454", "rank": 2, "score": 75, "score_components": _score_v2(75, fundamental=0, news=0)},
            {"date": "2026-05-22", "symbol": "2308", "rank": 3, "score": 70, "score_components": _score_v2(70, fundamental=0, news=0)},
        ],
        top_n=2,
    )

    gate = evaluate_score_v2_rollout_gate(report)

    assert gate["decision"] == "BLOCK"
    assert "component_nonzero_fundamentalQuality" in gate["failed_gates"]
    assert "component_nonzero_newsTheme" in gate["failed_gates"]
    assert gate["allowed_next_action"] == "read_only_repair_before_cutover"


def test_score_v2_readonly_replay_cli_accepts_offline_json() -> None:
    input_path = ROOT / ".tmp" / "score_v2_readonly_replay_rows.json"
    input_path.parent.mkdir(parents=True, exist_ok=True)
    input_path.write_text(json.dumps([{
        "results": [
            {"date": "2026-05-22", "symbol": "2330", "rank": 1, "score": 80, "score_components": _score_v2(80)},
        ],
        "success": True,
        "meta": {"changed_db": False, "rows_written": 0},
    }]), encoding="utf-8")

    completed = subprocess.run(
        [
            sys.executable,
            str(ROOT / "ml-controller" / "scripts" / "score_v2_readonly_replay_report.py"),
            "--input-json",
            str(input_path),
        ],
        cwd=str(ROOT),
        check=True,
        text=True,
        capture_output=True,
    )

    report = json.loads(completed.stdout)
    assert report["schema_version"] == "score-v2-readonly-replay-audit-v1"
    assert report["mode"] == "read_only"
    assert report["valid_comparison_rows"] == 1


def test_score_v2_readonly_replay_cli_gate_fail_on_block_exits_two() -> None:
    input_path = ROOT / ".tmp" / "score_v2_readonly_replay_gate_block_rows.json"
    input_path.parent.mkdir(parents=True, exist_ok=True)
    input_path.write_text(json.dumps([
        {"date": "2026-05-22", "symbol": "2330", "rank": 1, "score": 80, "score_components": _score_v2(80, fundamental=0, news=0)},
        {"date": "2026-05-22", "symbol": "2454", "rank": 2, "score": 70, "score_components": _score_v2(70, fundamental=0, news=0)},
    ]), encoding="utf-8")

    completed = subprocess.run(
        [
            sys.executable,
            str(ROOT / "ml-controller" / "scripts" / "score_v2_readonly_replay_report.py"),
            "--input-json",
            str(input_path),
            "--gate",
            "--fail-on-block",
        ],
        cwd=str(ROOT),
        check=False,
        text=True,
        capture_output=True,
    )

    report = json.loads(completed.stdout)
    assert completed.returncode == 2
    assert report["rollout_gate"]["decision"] == "BLOCK"
    assert "component_nonzero_fundamentalQuality" in report["rollout_gate"]["failed_gates"]
    assert "component_nonzero_newsTheme" in report["rollout_gate"]["failed_gates"]


def test_score_v2_readonly_replay_cli_is_read_only() -> None:
    source = (ROOT / "ml-controller" / "scripts" / "score_v2_readonly_replay_report.py").read_text(encoding="utf-8")

    assert "d1_client.query" in source
    assert "d1_client.execute" not in source
    assert "batch_execute" not in source
    assert "INSERT INTO" not in source
    assert "UPDATE " not in source
    assert "DELETE " not in source
