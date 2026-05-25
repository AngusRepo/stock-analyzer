from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml-controller"))

from services.score_v2_prod_readiness import build_score_v2_prod_readiness_report  # noqa: E402


def _replay_gate(failed: list[str] | None = None) -> dict:
    return {
        "schema_version": "score-v2-readonly-replay-audit-v1",
        "rollout_gate": {
            "decision": "PASS" if not failed else "BLOCK",
            "failed_gates": failed or [],
        },
    }


def _contribution(root_causes: list[str] | None = None) -> dict:
    return {
        "decision": "PASS" if not root_causes else "BLOCK",
        "root_causes": root_causes or [],
        "latest_daily_date": "2026-05-22",
        "component_nonzero": {"fundamentalQuality": 0, "newsTheme": 0},
    }


def _fundamental_migration(decision: str, rows: int = 0) -> dict:
    return {
        "decision": decision,
        "apply_command_hint": "cd worker; npx wrangler@4 d1 execute stockvision-db --remote --file=./migration_score_v2_fundamental_quality.sql",
        "readback_sql": ["SELECT COUNT(*) FROM canonical_fundamental_features;"],
        "live_schema": {"fundamental_total": rows},
    }


def _news(decision: str) -> dict:
    return {
        "decision": decision,
        "live_snapshot": {"latest_daily_rows": 64, "latest_news_nonzero": 0},
    }


def test_prod_readiness_blocks_until_fundamental_and_news_are_live() -> None:
    report = build_score_v2_prod_readiness_report(
        roadmap_status={},
        replay_gate_report=_replay_gate(["component_nonzero_fundamentalQuality", "component_nonzero_newsTheme"]),
        contribution_readiness_report=_contribution([
            "canonical_fundamental_features_missing",
            "fundamental_quality_live_zero",
            "news_theme_handoff_missing",
        ]),
        fundamental_migration_preflight_report=_fundamental_migration("READY_TO_APPLY"),
        news_theme_handoff_report=_news("WAITING_DEPLOY"),
    )

    assert report["schema_version"] == "score-v2-prod-readiness-v1"
    assert report["decision"] == "NOT_PROD_READY"
    assert report["prod_ready"] is False
    assert "score_v2_rollout_gate_not_passed" in report["hard_blockers"]
    assert "fundamental_migration_requires_approval" in report["approvals_required"]
    assert "news_theme_waiting_deploy" in report["approvals_required"]
    assert report["phase_status"]["phase_5"] == "blocked"
    assert report["phase_status"]["phase_6"] == "blocked"
    assert report["phase_status"]["phase_8"] == "blocked"


def test_prod_readiness_passes_when_rollout_and_required_roadmap_flags_are_done() -> None:
    report = build_score_v2_prod_readiness_report(
        roadmap_status={
            "source_of_truth_baseline_complete": True,
            "finlab_daily_incremental_live": True,
            "optuna_modal_live": True,
            "technical_factor_validation_complete": True,
            "trading_plan_real_data_qa_complete": True,
            "dual_write_enabled": True,
            "ranking_owner_cutover_complete": True,
            "observation_window_complete": True,
        },
        replay_gate_report=_replay_gate(),
        contribution_readiness_report=_contribution(),
        fundamental_migration_preflight_report=_fundamental_migration("ALREADY_APPLIED"),
        news_theme_handoff_report=_news("PASS"),
    )

    assert report["decision"] == "PROD_READY"
    assert report["prod_ready"] is True
    assert report["blockers"] == []


def test_fundamental_live_zero_points_to_deploy_rerun_after_seed_is_applied() -> None:
    report = build_score_v2_prod_readiness_report(
        roadmap_status={},
        replay_gate_report=_replay_gate(["component_nonzero_fundamentalQuality"]),
        contribution_readiness_report=_contribution(["fundamental_quality_live_zero"]),
        fundamental_migration_preflight_report=_fundamental_migration("ALREADY_APPLIED", rows=1066),
        news_theme_handoff_report=_news("PASS"),
    )

    blocker = next(item for item in report["blockers"] if item["id"] == "fundamental_quality_live_zero")
    assert blocker["next_action"] == "deploy_controller_score_v2_path_and_rerun_daily_recommendations_after_wei_approval"
    assert "fundamental_migration_requires_approval" not in report["approvals_required"]


def test_prod_readiness_cli_aggregates_existing_json_files() -> None:
    tmp = ROOT / ".tmp" / "score_v2_prod_readiness_test"
    tmp.mkdir(parents=True, exist_ok=True)
    roadmap = tmp / "roadmap.md"
    replay = tmp / "replay.json"
    contribution = tmp / "contribution.json"
    migration = tmp / "migration.json"
    news = tmp / "news.json"
    output = tmp / "out.json"

    roadmap.write_text(
        "| Phase 0 - source-of-truth baseline | 處理到一半 | x | R2 mirror inventory and a single exported score-path baseline are not complete. |\n"
        "| Phase 8 - rollout and observation | 處理到一半 | x | dual-write flag, ranking owner switch, and 3-5 trading-day observation are still not done. |\n",
        encoding="utf-8",
    )
    replay.write_text(json.dumps(_replay_gate(["component_nonzero_newsTheme"])), encoding="utf-8")
    contribution.write_text(json.dumps(_contribution(["news_theme_handoff_missing"])), encoding="utf-8")
    migration.write_text(json.dumps(_fundamental_migration("ALREADY_APPLIED")), encoding="utf-8")
    news.write_text(json.dumps(_news("WAITING_DEPLOY")), encoding="utf-8")

    completed = subprocess.run(
        [
            sys.executable,
            str(ROOT / "ml-controller" / "scripts" / "score_v2_prod_readiness_report.py"),
            "--roadmap-md",
            str(roadmap),
            "--replay-gate-json",
            str(replay),
            "--contribution-readiness-json",
            str(contribution),
            "--fundamental-migration-preflight-json",
            str(migration),
            "--news-theme-handoff-json",
            str(news),
            "--output-json",
            str(output),
            "--fail-unless-prod-ready",
        ],
        cwd=str(ROOT),
        check=False,
        text=True,
        capture_output=True,
    )

    report = json.loads(completed.stdout)
    assert completed.returncode == 2
    assert output.exists()
    assert report["decision"] == "NOT_PROD_READY"
    assert "news_theme_waiting_deploy" in report["approvals_required"]


def test_prod_readiness_cli_is_read_only() -> None:
    source = (ROOT / "ml-controller" / "scripts" / "score_v2_prod_readiness_report.py").read_text(encoding="utf-8")

    assert "d1_client" not in source
    assert "subprocess.run" not in source
    assert "execute" not in source
    assert "batch_execute" not in source
    assert "INSERT INTO" not in source
    assert "UPDATE " not in source
    assert "DELETE " not in source
