"""Build a local/read-only Score V2 production-readiness report."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml-controller"))

from services.score_v2_prod_readiness import build_score_v2_prod_readiness_report  # noqa: E402


def _read_json(path: str) -> dict[str, Any]:
    if not path:
        return {}
    payload = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    if not isinstance(payload, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return payload


def _write_json(path: str, payload: dict[str, Any]) -> None:
    if not path:
        return
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True, default=str), encoding="utf-8")


def _extract_phase_line(markdown: str, phase: int) -> str | None:
    pattern = re.compile(rf"^\|\s*Phase {phase}\b.*$", re.MULTILINE)
    match = pattern.search(markdown)
    return match.group(0) if match else None


def _roadmap_status(path: str) -> dict[str, Any]:
    if not path:
        return {}
    markdown = Path(path).read_text(encoding="utf-8-sig")
    return {
        "phase_0": _extract_phase_line(markdown, 0),
        "phase_1": _extract_phase_line(markdown, 1),
        "phase_2": _extract_phase_line(markdown, 2),
        "phase_3": _extract_phase_line(markdown, 3),
        "phase_7": _extract_phase_line(markdown, 7),
        "source_of_truth_baseline_complete": "R2 mirror inventory and a single exported score-path baseline are not complete" not in markdown,
        "finlab_daily_incremental_live": "Live job/scheduler was not changed" not in markdown,
        "optuna_modal_live": "production env is not flipped to Modal" not in markdown,
        "technical_factor_validation_complete": "IC, forward return, and MAE/MFE validation still require" not in markdown,
        "trading_plan_real_data_qa_complete": "Real-data rendered QA" not in markdown,
        "dual_write_enabled": "dual-write flag" not in markdown,
        "ranking_owner_cutover_complete": "ranking owner switch" not in markdown,
        "observation_window_complete": "3-5 trading-day observation" not in markdown,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only Score V2 production-readiness aggregation.")
    parser.add_argument("--roadmap-md", default=str(ROOT / "SCORE_V2_COMPUTE_ROADMAP_STATUS_2026_05_23.md"))
    parser.add_argument("--replay-gate-json", default=str(ROOT / ".tmp" / "score_v2_latest_replay_gate.json"))
    parser.add_argument("--contribution-readiness-json", default=str(ROOT / ".tmp" / "score_v2_contribution_readiness.json"))
    parser.add_argument("--fundamental-migration-preflight-json", default=str(ROOT / ".tmp" / "score_v2_fundamental_migration_preflight.json"))
    parser.add_argument("--news-theme-handoff-json", default=str(ROOT / ".tmp" / "score_v2_news_theme_handoff.json"))
    parser.add_argument("--deploy-gate-json", default="")
    parser.add_argument("--output-json", default="")
    parser.add_argument("--fail-unless-prod-ready", action="store_true")
    args = parser.parse_args()

    report = build_score_v2_prod_readiness_report(
        roadmap_status=_roadmap_status(args.roadmap_md),
        replay_gate_report=_read_json(args.replay_gate_json),
        contribution_readiness_report=_read_json(args.contribution_readiness_json),
        fundamental_migration_preflight_report=_read_json(args.fundamental_migration_preflight_json),
        news_theme_handoff_report=_read_json(args.news_theme_handoff_json),
        deploy_gate_report=_read_json(args.deploy_gate_json),
    )
    _write_json(args.output_json, report)
    print(json.dumps(report, ensure_ascii=False, sort_keys=True, default=str))
    if args.fail_unless_prod_ready and not report["prod_ready"]:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
