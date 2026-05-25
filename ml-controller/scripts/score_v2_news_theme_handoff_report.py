"""Export a read-only Score V2 news/theme handoff readiness report."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml-controller"))

from services.score_v2_news_theme_handoff import (  # noqa: E402
    build_score_v2_news_theme_handoff_report,
)


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True, default=str), encoding="utf-8")


def _read_source(repo_root: Path, relative_path: str) -> str:
    path = repo_root / relative_path
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return path.read_text(encoding="utf-8-sig")


def inspect_repo_news_theme_contracts(repo_root: Path) -> dict[str, bool]:
    market_screener = _read_source(repo_root, "worker/src/lib/marketScreener.ts")
    seed_test = _read_source(repo_root, "worker/src/lib/screenerSeedQuality.test.ts")
    seed_quality = _read_source(repo_root, "worker/src/lib/screenerSeedQuality.ts")
    recommendation_service = _read_source(repo_root, "ml-controller/services/recommendation_service.py")

    return {
        "worker_applies_news_theme_adjustment": all(token in market_screener for token in [
            "applyScoreV2NewsThemeAdjustment",
            "positive_news_sentiment",
            "negative_news_sentiment",
            "buzz_evidence:",
            "loadExternalEvidenceRiskOverlays",
        ]),
        "worker_persists_news_theme_score_components": all(token in market_screener for token in [
            "newsTheme: round1(snapshot.components.newsTheme + appliedNewsDelta)",
            "candidate.score_components = JSON.stringify",
            "const finalScore = clampScore(round1(payload.total + alphaAdjustment), 0, 100)",
        ]),
        "worker_seed_preserves_news_theme": all(token in seed_test + seed_quality for token in [
            "seed row must preserve canonical Score V2 newsTheme",
            "seed row must preserve news/theme reasons",
            "score_components = COALESCE(excluded.score_components, daily_recommendations.score_components)",
        ]),
        "python_projection_preserves_news_theme": all(token in recommendation_service for token in [
            '"newsTheme": _clamp_score(components.get("newsTheme"), SCORE_V2_WEIGHTS["newsTheme"])',
            '"newsTheme": 0.0',
            "existing_score_components",
        ]),
    }


def _report_from_input_json(payload: Any, *, repo_root: Path) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("--input-json must contain an object")
    repo_contracts = payload.get("repo_contracts")
    if not isinstance(repo_contracts, dict):
        repo_contracts = inspect_repo_news_theme_contracts(repo_root)
    return build_score_v2_news_theme_handoff_report(
        repo_contracts=dict(repo_contracts),
        contribution_readiness_report=(
            dict(payload.get("contribution_readiness_report"))
            if isinstance(payload.get("contribution_readiness_report"), dict)
            else None
        ),
        live_snapshot=(
            dict(payload.get("live_snapshot"))
            if isinstance(payload.get("live_snapshot"), dict)
            else None
        ),
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only Score V2 news/theme handoff readiness report.")
    parser.add_argument("--repo-root", default=str(ROOT), help="Repository root used for source-contract inspection.")
    parser.add_argument("--input-json", default="", help="Optional offline handoff input JSON.")
    parser.add_argument(
        "--contribution-readiness-json",
        default="",
        help="Optional existing read-only score_v2_contribution_readiness_report output.",
    )
    parser.add_argument("--output-json", default="", help="Optional output report path.")
    parser.add_argument("--fail-on-block", action="store_true", help="Exit 2 when handoff blocks.")
    args = parser.parse_args()

    repo_root = Path(args.repo_root)
    if args.input_json:
        report = _report_from_input_json(_read_json(Path(args.input_json)), repo_root=repo_root)
    else:
        contribution_report = (
            _read_json(Path(args.contribution_readiness_json))
            if args.contribution_readiness_json
            else None
        )
        report = build_score_v2_news_theme_handoff_report(
            repo_contracts=inspect_repo_news_theme_contracts(repo_root),
            contribution_readiness_report=contribution_report if isinstance(contribution_report, dict) else None,
        )

    if args.output_json:
        _write_json(Path(args.output_json), report)
    print(json.dumps(report, ensure_ascii=False, sort_keys=True, default=str))
    if args.fail_on_block and report["decision"] == "BLOCK":
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
