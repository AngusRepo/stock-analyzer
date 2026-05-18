from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scripts.compute_efficiency_report import main  # noqa: E402


def _write_json(path: Path, payload: object) -> None:
    path.write_text(json.dumps(payload), encoding="utf-8")


def _case_dir(name: str) -> Path:
    path = Path(__file__).resolve().parent.parent / ".tmp" / "compute_efficiency_report_script" / name
    path.mkdir(parents=True, exist_ok=True)
    return path


def test_compute_efficiency_report_cli_can_fail_on_needs_review_decision(capsys):
    case_dir = _case_dir("needs_review")
    baseline = case_dir / "baseline.json"
    optimized = case_dir / "optimized.json"
    quality = case_dir / "quality.json"
    _write_json(baseline, {"wall_sec": 8103.5, "est_usd": 1.2, "features": 106})
    _write_json(optimized, {"wall_sec": 5400.0, "est_usd": 0.8, "features": 106})
    _write_json(quality, {})

    exit_code = main([
        "--job-name",
        "monthly-universal-retrain",
        "--baseline",
        str(baseline),
        "--optimized",
        str(optimized),
        "--quality",
        str(quality),
        "--fail-on-decision",
    ])

    out = json.loads(capsys.readouterr().out)
    assert exit_code == 3
    assert out["decision"] == "NEEDS_REVIEW"


def test_compute_efficiency_report_cli_preserves_report_only_exit_zero_by_default(capsys):
    case_dir = _case_dir("report_only")
    baseline = case_dir / "baseline.json"
    optimized = case_dir / "optimized.json"
    quality = case_dir / "quality.json"
    _write_json(baseline, {"wall_sec": 8103.5, "est_usd": 1.2, "features": 106})
    _write_json(optimized, {"wall_sec": 5400.0, "est_usd": 0.8, "features": 106})
    _write_json(quality, {})

    exit_code = main([
        "--job-name",
        "monthly-universal-retrain",
        "--baseline",
        str(baseline),
        "--optimized",
        str(optimized),
        "--quality",
        str(quality),
    ])

    out = json.loads(capsys.readouterr().out)
    assert exit_code == 0
    assert out["decision"] == "NEEDS_REVIEW"


def test_compute_efficiency_report_cli_can_fail_on_spec_regression_decision(capsys):
    case_dir = _case_dir("spec_regression")
    baseline = case_dir / "baseline.json"
    optimized = case_dir / "optimized.json"
    quality = case_dir / "quality.json"
    _write_json(
        baseline,
        {
            "wall_sec": 8103.5,
            "est_usd": 1.2,
            "features": 106,
            "artifact_count": 8,
        },
    )
    _write_json(
        optimized,
        {
            "wall_sec": 5400.0,
            "est_usd": 0.8,
            "features": 106,
            "artifact_count": 6,
        },
    )
    _write_json(
        quality,
        {
            "ic_delta": 0.001,
            "precision_at_k_delta": 0.002,
            "hit_rate_delta": 0.001,
            "max_drawdown_delta": 0.0,
            "topk_overlap": 0.9,
            "regime_split_passed": True,
            "feature_count_delta": 0,
        },
    )

    exit_code = main([
        "--job-name",
        "monthly-universal-retrain",
        "--baseline",
        str(baseline),
        "--optimized",
        str(optimized),
        "--quality",
        str(quality),
        "--fail-on-decision",
    ])

    out = json.loads(capsys.readouterr().out)
    assert exit_code == 6
    assert out["decision"] == "BLOCK_SPEC_REGRESSION"
