from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml-controller"))

from services.score_v2_news_theme_handoff import (  # noqa: E402
    REQUIRED_REPO_CONTRACTS,
    build_score_v2_news_theme_handoff_report,
)


def _contracts(value: bool = True) -> dict[str, bool]:
    return {contract: value for contract in REQUIRED_REPO_CONTRACTS}


def _contribution_report(news_nonzero: int = 0) -> dict:
    return {
        "schema_version": "score-v2-contribution-readiness-v1",
        "decision": "BLOCK" if news_nonzero == 0 else "PASS",
        "latest_daily_date": "2026-05-22",
        "latest_daily_rows": 64,
        "component_nonzero": {
            "fundamentalQuality": 0,
            "newsTheme": news_nonzero,
        },
        "checks": [
            {
                "id": "news_theme_inputs",
                "passed": True,
                "value": {
                    "theme_signals": 1655,
                    "stock_theme_features": 39295,
                    "external_evidence_items": 74,
                    "news_7d": 2381,
                    "buzz_evidence_rows": 735,
                },
            },
        ],
        "input_summary": {"buzz_evidence_rows": 735},
    }


def test_news_theme_handoff_waits_for_deploy_when_repo_contracts_pass_but_live_component_zero() -> None:
    report = build_score_v2_news_theme_handoff_report(
        repo_contracts=_contracts(),
        contribution_readiness_report=_contribution_report(news_nonzero=0),
    )

    assert report["schema_version"] == "score-v2-news-theme-handoff-v1"
    assert report["mode"] == "read_only"
    assert report["decision"] == "WAITING_DEPLOY"
    assert report["passed"] is False
    assert report["root_causes"] == ["production_handoff_not_live", "news_theme_live_zero"]
    assert report["allowed_next_action"] == "deploy_worker_and_rerun_screener_after_approval"
    assert report["live_snapshot"]["latest_news_nonzero"] == 0
    assert report["live_snapshot"]["buzz_evidence_rows"] == 735


def test_news_theme_handoff_blocks_when_repo_contract_is_missing() -> None:
    contracts = _contracts()
    contracts["worker_persists_news_theme_score_components"] = False

    report = build_score_v2_news_theme_handoff_report(
        repo_contracts=contracts,
        contribution_readiness_report=_contribution_report(news_nonzero=0),
    )

    assert report["decision"] == "BLOCK"
    assert report["root_causes"] == ["repo_news_theme_contract_missing"]
    assert report["contract_failures"] == ["worker_persists_news_theme_score_components"]
    assert report["allowed_next_action"] == "repair_repo_contract"


def test_news_theme_handoff_passes_when_live_daily_news_theme_is_nonzero() -> None:
    report = build_score_v2_news_theme_handoff_report(
        repo_contracts=_contracts(),
        contribution_readiness_report=_contribution_report(news_nonzero=18),
    )

    assert report["decision"] == "PASS"
    assert report["passed"] is True
    assert report["root_causes"] == []
    assert report["allowed_next_action"] == "run_score_v2_rollout_gate"


def test_news_theme_handoff_cli_reads_contribution_report_and_repo_contracts() -> None:
    contribution_path = ROOT / ".tmp" / "score_v2_news_theme_handoff_contribution_input.json"
    contribution_path.parent.mkdir(parents=True, exist_ok=True)
    contribution_path.write_text(json.dumps(_contribution_report(news_nonzero=0)), encoding="utf-8")

    completed = subprocess.run(
        [
            sys.executable,
            str(ROOT / "ml-controller" / "scripts" / "score_v2_news_theme_handoff_report.py"),
            "--contribution-readiness-json",
            str(contribution_path),
        ],
        cwd=str(ROOT),
        check=True,
        text=True,
        capture_output=True,
    )

    report = json.loads(completed.stdout)
    assert report["decision"] == "WAITING_DEPLOY"
    assert report["contract_failures"] == []
    assert report["allowed_next_action"] == "deploy_worker_and_rerun_screener_after_approval"


def test_news_theme_handoff_cli_is_read_only() -> None:
    source = (ROOT / "ml-controller" / "scripts" / "score_v2_news_theme_handoff_report.py").read_text(encoding="utf-8")

    assert "d1_client" not in source
    assert "subprocess.run" not in source
    assert "execute" not in source
    assert "batch_execute" not in source
    assert "INSERT INTO" not in source
    assert "UPDATE " not in source
    assert "DELETE " not in source
