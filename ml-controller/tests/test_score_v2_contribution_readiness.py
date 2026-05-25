from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml-controller"))

from services.score_v2_contribution_readiness import build_score_v2_contribution_readiness_report  # noqa: E402


def test_contribution_readiness_blocks_missing_fundamental_table_and_news_handoff_gap() -> None:
    report = build_score_v2_contribution_readiness_report(
        table_names=[
            "canonical_revenue_monthly",
            "financials",
            "theme_signals",
            "stock_theme_features",
            "external_evidence_items",
            "news",
        ],
        inventory={
            "revenue_total": 38536,
            "financials_total": 3074,
            "theme_total": 1655,
            "stock_theme_total": 39295,
            "evidence_total": 74,
            "news_7d_total": 2381,
            "theme_latest_date": "2026-05-22",
            "stock_theme_latest_date": "2026-05-22",
        },
        daily_component_rows=[
            {"date": "2026-05-22", "n": 64, "fundamental_nonzero": 0, "news_nonzero": 0},
        ],
        theme_signal_rows=[
            {"source": "finlab_taxonomy", "date": "2026-05-22", "n": 145, "avg_score": 1.0148},
        ],
        funnel_stage_rows=[
            {"date": "2026-05-22", "stage": "buzz_evidence", "reason_code": "weighted_keyword_evidence", "n": 74},
        ],
    )

    assert report["schema_version"] == "score-v2-contribution-readiness-v1"
    assert report["mode"] == "read_only"
    assert report["decision"] == "BLOCK"
    assert "canonical_fundamental_features_missing" in report["root_causes"]
    assert "fundamental_quality_live_zero" in report["root_causes"]
    assert "news_theme_handoff_missing" in report["root_causes"]
    assert report["component_nonzero"] == {"fundamentalQuality": 0, "newsTheme": 0}
    assert report["allowed_next_action"] == "repair_inputs_or_handoff"


def test_contribution_readiness_passes_when_live_components_are_nonzero() -> None:
    report = build_score_v2_contribution_readiness_report(
        table_names=[
            "canonical_fundamental_features",
            "canonical_revenue_monthly",
            "financials",
            "theme_signals",
            "stock_theme_features",
            "external_evidence_items",
            "news",
        ],
        inventory={
            "revenue_total": 100,
            "financials_total": 100,
            "fundamental_total": 100,
            "theme_total": 20,
            "stock_theme_total": 20,
            "evidence_total": 5,
            "news_7d_total": 30,
        },
        daily_component_rows=[
            {"date": "2026-05-22", "n": 64, "fundamental_nonzero": 40, "news_nonzero": 18},
        ],
        theme_signal_rows=[
            {"source": "finlab_taxonomy", "date": "2026-05-22", "n": 20, "avg_score": 1.1},
        ],
        funnel_stage_rows=[
            {"date": "2026-05-22", "stage": "buzz_evidence", "reason_code": "weighted_keyword_evidence", "n": 12},
        ],
    )

    assert report["decision"] == "PASS"
    assert report["root_causes"] == []
    assert report["readiness_ratio"]["fundamentalQuality"] == 0.625
    assert report["readiness_ratio"]["newsTheme"] == 0.2812


def test_contribution_readiness_cli_accepts_offline_input_and_fails_closed() -> None:
    input_path = ROOT / ".tmp" / "score_v2_contribution_readiness_input.json"
    input_path.parent.mkdir(parents=True, exist_ok=True)
    input_path.write_text(json.dumps({
        "table_names": ["canonical_revenue_monthly", "theme_signals", "news"],
        "inventory": {"revenue_total": 10, "theme_total": 5, "news_7d_total": 3},
        "daily_component_rows": [
            {"date": "2026-05-22", "n": 2, "fundamental_nonzero": 0, "news_nonzero": 0},
        ],
        "theme_signal_rows": [
            {"source": "finlab_taxonomy", "date": "2026-05-22", "n": 5},
        ],
        "funnel_stage_rows": [
            {"date": "2026-05-22", "stage": "buzz_evidence", "n": 2},
        ],
    }), encoding="utf-8")

    completed = subprocess.run(
        [
            sys.executable,
            str(ROOT / "ml-controller" / "scripts" / "score_v2_contribution_readiness_report.py"),
            "--input-json",
            str(input_path),
            "--fail-on-block",
        ],
        cwd=str(ROOT),
        check=False,
        text=True,
        capture_output=True,
    )

    report = json.loads(completed.stdout)
    assert completed.returncode == 2
    assert report["decision"] == "BLOCK"
    assert "canonical_fundamental_features_missing" in report["root_causes"]
    assert "news_theme_handoff_missing" in report["root_causes"]


def test_contribution_readiness_cli_is_read_only() -> None:
    source = (ROOT / "ml-controller" / "scripts" / "score_v2_contribution_readiness_report.py").read_text(encoding="utf-8")

    assert "d1_client.query" in source
    assert "d1_client.execute" not in source
    assert "batch_execute" not in source
    assert "INSERT INTO" not in source
    assert "UPDATE " not in source
    assert "DELETE " not in source
