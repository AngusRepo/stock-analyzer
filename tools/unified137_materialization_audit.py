from __future__ import annotations

import argparse
import importlib.util
import json
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
ALPHA_MINER = ROOT / "tools" / "finlab_alpha_miner_bakeoff.py"
REGISTRY = ROOT / "data" / "feature_registry" / "unified_feature_registry_v1.json"
OUT_DIR = ROOT / "output" / "feature_universe_triage"


def _rel(path: Path) -> str:
    resolved = path.resolve()
    try:
        return resolved.relative_to(ROOT.resolve()).as_posix()
    except ValueError:
        return str(resolved)


def _resolve_repo_path(path_text: str) -> Path:
    path = Path(path_text)
    return path if path.is_absolute() else ROOT / path


def _load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot_load_module:{path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _load_registry(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict) or not isinstance(data.get("features"), list):
        raise RuntimeError(f"invalid_registry:{path}")
    return data


def _audit_output_path(output_dir: Path, universe: str, start_date: str, end_date: str, max_symbols: int) -> Path:
    suffix = f"{universe}_{start_date}_{end_date}".replace("-", "")
    if max_symbols > 0:
        suffix += f"_symbols{max_symbols}"
    return output_dir / f"unified137_materialization_audit_{suffix}.json"


def _eligible_feature_ids(registry: dict[str, Any]) -> set[str]:
    return {
        str(row.get("feature_id"))
        for row in registry.get("features", [])
        if isinstance(row, dict) and row.get("eligible_for_alpha_mining") and row.get("feature_id")
    }


def _int_count(counts: dict[str, Any], key: str, default: int = -1) -> int:
    value = counts.get(key)
    if value is None:
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _validate_existing_artifact(
    *,
    artifact_path: Path,
    registry_path: Path,
    registry: dict[str, Any],
    start_date: str,
    end_date: str,
    universe: str,
    max_symbols: int,
    started_at: float,
    refresh_metadata: bool = False,
) -> tuple[int, dict[str, Any]]:
    expected = _eligible_feature_ids(registry)
    errors: list[str] = []
    if not artifact_path.exists():
        errors.append(f"materialization_artifact_missing:{artifact_path}")
        return 2, {
            "schema_version": "stockvision-unified137-materialization-audit-v1",
            "mode": "artifact_validation",
            "generated_at": pd.Timestamp.utcnow().isoformat(),
            "runtime_seconds": round(time.time() - started_at, 3),
            "artifact": _rel(artifact_path),
            "registry": _rel(registry_path),
            "errors": errors,
            "pass": False,
            "next_action": "rerun_with_--rebuild_after_intentional_materialization_refresh",
        }

    try:
        artifact = json.loads(artifact_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        errors.append(f"materialization_artifact_invalid_json:{exc}")
        artifact = {}

    counts = artifact.get("counts") if isinstance(artifact.get("counts"), dict) else {}
    date_range = artifact.get("date_range") if isinstance(artifact.get("date_range"), dict) else {}
    artifact_registry = str(artifact.get("registry") or "")
    registry_mtime = registry_path.stat().st_mtime
    artifact_mtime = artifact_path.stat().st_mtime

    if artifact.get("schema_version") != "stockvision-unified137-materialization-audit-v1":
        errors.append("schema_version_mismatch")
    if artifact_registry and _resolve_repo_path(artifact_registry).resolve() != registry_path.resolve():
        errors.append("registry_path_mismatch")
    stale_only = artifact_mtime + 1e-6 < registry_mtime
    if stale_only:
        errors.append("materialization_artifact_older_than_registry")
    if date_range.get("start_date") != start_date:
        errors.append("start_date_mismatch")
    if date_range.get("end_date") != end_date:
        errors.append("end_date_mismatch")
    if date_range.get("universe") != universe:
        errors.append("universe_mismatch")
    if int(date_range.get("max_symbols") or 0) != max_symbols:
        errors.append("max_symbols_mismatch")
    if _int_count(counts, "eligible_for_alpha_mining") != len(expected):
        errors.append("eligible_feature_count_mismatch")
    if _int_count(counts, "mapped_factor_count") != len(expected):
        errors.append("mapped_factor_count_mismatch")
    if _int_count(counts, "missing_expected_count") != 0:
        errors.append("missing_expected_count_nonzero")
    if _int_count(counts, "unavailable_count") != 0:
        errors.append("unavailable_count_nonzero")
    if _int_count(counts, "zero_coverage_count") != 0:
        errors.append("zero_coverage_count_nonzero")
    if artifact.get("pass") is not True:
        errors.append("artifact_pass_not_true")

    refreshed_metadata = False
    if refresh_metadata and errors == ["materialization_artifact_older_than_registry"]:
        artifact["registry"] = _rel(registry_path)
        artifact["metadata_refreshed_at"] = pd.Timestamp.utcnow().isoformat()
        artifact["metadata_refresh_reason"] = "registry_metadata_only_refresh; materialized factor counts and coverage were unchanged"
        artifact_path.write_text(json.dumps(artifact, ensure_ascii=False, indent=2), encoding="utf-8")
        artifact_mtime = artifact_path.stat().st_mtime
        errors = []
        refreshed_metadata = True

    summary = {
        "schema_version": "stockvision-unified137-materialization-audit-v1",
        "mode": "artifact_validation",
        "generated_at": pd.Timestamp.utcnow().isoformat(),
        "runtime_seconds": round(time.time() - started_at, 3),
        "artifact": _rel(artifact_path),
        "registry": _rel(registry_path),
        "registry_mtime": pd.Timestamp.fromtimestamp(registry_mtime).isoformat(),
        "artifact_mtime": pd.Timestamp.fromtimestamp(artifact_mtime).isoformat(),
        "metadata_refreshed": refreshed_metadata,
        "date_range": {
            "start_date": start_date,
            "end_date": end_date,
            "universe": universe,
            "max_symbols": max_symbols,
        },
        "counts": counts,
        "panel_mapping_pass": artifact.get("panel_mapping_pass") is True,
        "coverage_pass": artifact.get("coverage_pass") is True,
        "errors": errors,
        "pass": not errors,
        "decision_effect": "local_artifact_validation_only",
        "next_action": "use_--rebuild_only_when_intentionally_refreshing_materialization_panel",
    }
    return (0 if summary["pass"] else 2), summary


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit unified 137 feature pool materialization coverage.")
    parser.add_argument("--feature-registry", default=str(REGISTRY))
    parser.add_argument("--factor-json", default=str(ROOT / "worker" / ".tmp-test-run-codex" / "alphabuilders_factors_fresh.json"))
    parser.add_argument("--start-date", default="2023-01-01")
    parser.add_argument("--end-date", default="2026-06-15")
    parser.add_argument("--universe", choices=["sii", "sii_otc"], default="sii")
    parser.add_argument("--max-symbols", type=int, default=0)
    parser.add_argument("--output-dir", default=str(OUT_DIR))
    parser.add_argument(
        "--rebuild",
        action="store_true",
        help="Rebuild the full feature panel. Default only validates the existing materialization artifact.",
    )
    parser.add_argument(
        "--refresh-metadata",
        action="store_true",
        help="Refresh artifact metadata when the existing materialization artifact is semantically valid but older than registry metadata.",
    )
    args = parser.parse_args()

    t0 = time.time()
    registry_path = Path(args.feature_registry)
    registry = _load_registry(registry_path)
    expected = _eligible_feature_ids(registry)
    eligible = [
        row
        for row in registry.get("features", [])
        if isinstance(row, dict) and row.get("eligible_for_alpha_mining")
    ]

    out_dir = Path(args.output_dir)
    out_path = _audit_output_path(out_dir, args.universe, args.start_date, args.end_date, args.max_symbols)
    if not args.rebuild:
        exit_code, summary = _validate_existing_artifact(
            artifact_path=out_path,
            registry_path=registry_path,
            registry=registry,
            start_date=args.start_date,
            end_date=args.end_date,
            universe=args.universe,
            max_symbols=args.max_symbols,
            started_at=t0,
            refresh_metadata=args.refresh_metadata,
        )
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return exit_code

    alpha = _load_module(ALPHA_MINER, "stockvision_unified137_materialization_alpha_miner")

    close, tradable, values, meta, info = alpha._build_unified_registry_factor_universe(args)
    mapped = set(values.keys())
    missing_from_builder = set(str(item).split(":", 1)[-1] for item in info.get("missing") or [])
    unavailable = set(info.get("unavailable_candidates") or [])
    missing_expected = expected - mapped
    extra_mapped = mapped - expected
    coverage_by_factor: dict[str, float] = {}
    factor_stats: dict[str, dict[str, Any]] = {}
    for fid, frame in values.items():
        clean = frame.replace([np.inf, -np.inf], np.nan)
        arr = clean.to_numpy(dtype=float, copy=False)
        finite = np.isfinite(arr)
        coverage = float(finite.mean()) if arr.size else 0.0
        coverage_by_factor[fid] = coverage
        finite_values = arr[finite]
        unique_values = int(len(np.unique(finite_values))) if finite_values.size else 0
        factor_stats[fid] = {
            "coverage": coverage,
            "unique_values": unique_values,
            "non_constant": unique_values > 1,
        }
    zero_coverage = sorted(fid for fid, coverage in coverage_by_factor.items() if coverage <= 0.0)
    very_low_coverage = sorted(fid for fid, coverage in coverage_by_factor.items() if 0.0 < coverage < 0.05)
    panel_mapping_pass = not missing_expected and not unavailable
    coverage_pass = not zero_coverage

    role_counts: dict[str, int] = {}
    origin_counts: dict[str, int] = {}
    for row in eligible:
        role = str(row.get("selector_role") or "unknown")
        origin = str(row.get("origin_pool") or "unknown")
        role_counts[role] = role_counts.get(role, 0) + 1
        origin_counts[origin] = origin_counts.get(origin, 0) + 1

    summary = {
        "schema_version": "stockvision-unified137-materialization-audit-v1",
        "mode": "rebuild",
        "generated_at": pd.Timestamp.utcnow().isoformat(),
        "runtime_seconds": round(time.time() - t0, 3),
        "registry": _rel(registry_path),
        "date_range": {
            "start_date": args.start_date,
            "end_date": args.end_date,
            "universe": args.universe,
            "max_symbols": args.max_symbols,
        },
        "counts": {
            "eligible_for_alpha_mining": len(expected),
            "mapped_factor_count": len(mapped),
            "missing_expected_count": len(missing_expected),
            "builder_missing_count": len(missing_from_builder),
            "unavailable_count": len(unavailable),
            "extra_mapped_count": len(extra_mapped),
            "zero_coverage_count": len(zero_coverage),
            "very_low_coverage_count": len(very_low_coverage),
            "trading_days": int(len(close.index)),
            "symbols": int(len(close.columns)),
        },
        "role_counts": role_counts,
        "origin_counts": origin_counts,
        "missing_expected": sorted(missing_expected),
        "builder_missing": sorted(missing_from_builder),
        "unavailable_candidates": sorted(unavailable),
        "extra_mapped": sorted(extra_mapped),
        "zero_coverage": zero_coverage,
        "very_low_coverage": very_low_coverage,
        "factor_stats": factor_stats,
        "registry_l1_supplement": info.get("registry_l1_supplement"),
        "selected_selector_role_counts": info.get("selected_selector_role_counts"),
        "panel_mapping_pass": panel_mapping_pass,
        "coverage_pass": coverage_pass,
        "pass": panel_mapping_pass and coverage_pass,
    }

    out_dir.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"output": str(out_path), **summary}, ensure_ascii=False, indent=2))
    return 0 if summary["pass"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
