from __future__ import annotations

import csv
import json
from collections import Counter
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data" / "feature_registry"
OUT_DIR = ROOT / "output" / "feature_universe_triage"

REGISTRY_PATH = DATA_DIR / "unified_feature_registry_v1.json"
FEATURE_VIEW_PATH = DATA_DIR / "feature_view_contract_v1.json"
SIMILARITY_PATH = DATA_DIR / "formal137_similarity_contract_v1.json"
ML_SELECTION_PATH = DATA_DIR / "ml_feature_selection_contract_v1.json"
MATERIALIZATION_AUDIT_PATH = OUT_DIR / "unified137_materialization_audit_sii_20230101_20260615.json"

JSON_OUT = DATA_DIR / "ml_feature_migration_preflight_v1.json"
CSV_OUT = OUT_DIR / "ml_feature_migration_preflight_20260617.csv"

MATERIALIZATION_READY_STATUSES = {"materialized", "requires_registry_l1_supplement"}


def _rel(path: Path) -> str:
    return path.resolve().relative_to(ROOT.resolve()).as_posix()


def _load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        raise RuntimeError(f"invalid_json_object:{path}")
    return data


def _write_csv(rows: list[dict[str, Any]], path: Path) -> None:
    fields = list(rows[0].keys()) if rows else []
    with path.open("w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def _by_feature_id(rows: list[Any]) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for row in rows:
        if isinstance(row, dict) and row.get("feature_id"):
            result[str(row["feature_id"])] = row
    return result


def _artifact_fresh(artifact: Path, source: Path) -> bool:
    if not artifact.exists() or not source.exists():
        return False
    return artifact.stat().st_mtime + 1e-6 >= source.stat().st_mtime


def _same_path(left: str | None, right: Path) -> bool:
    if not left:
        return False
    try:
        left_path = Path(left)
        if not left_path.is_absolute():
            left_path = ROOT / left_path
        return left_path.resolve() == right.resolve()
    except OSError:
        return False


def _view_by_feature(feature_view: dict[str, Any], view_name: str) -> dict[str, dict[str, Any]]:
    section = (feature_view.get("views") or {}).get(view_name) or {}
    return _by_feature_id(section.get("features") or [])


def _candidate_row(
    feature_id: str,
    registry: dict[str, dict[str, Any]],
    similarity: dict[str, dict[str, Any]],
    ml_view: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    reg = registry.get(feature_id) or {}
    sim = similarity.get(feature_id) or {}
    view = ml_view.get(feature_id) or {}
    materializer_status = str(reg.get("materializer_status") or "")
    materialization_ready = materializer_status in MATERIALIZATION_READY_STATUSES
    return {
        "feature_id": feature_id,
        "origin_pool": reg.get("origin_pool") or "",
        "category": reg.get("category") or "",
        "selector_role": reg.get("selector_role") or "",
        "recommended_status": reg.get("recommended_status") or "",
        "materializer_status": materializer_status,
        "materialization_ready": materialization_ready,
        "duplicate_level": sim.get("duplicate_level") or "",
        "nearest_feature": sim.get("nearest_feature") or "",
        "nearest_abs_rank_corr": sim.get("nearest_abs_rank_corr"),
        "preferred_feature_id": sim.get("preferred_feature_id") or "",
        "high_duplicate_cluster_id": sim.get("high_duplicate_cluster_id") or "",
        "related_cluster_id": sim.get("related_cluster_id") or "",
        "priority": view.get("priority") or "",
        "allowed_transforms": "|".join(str(item) for item in (view.get("allowed_transforms") or [])),
        "feature_selection_entry": "candidate_pool_only",
        "activation_state": "inactive_until_feature_selection_retrain_release_gate",
    }


def build_contract() -> dict[str, Any]:
    registry_doc = _load_json(REGISTRY_PATH)
    feature_view_doc = _load_json(FEATURE_VIEW_PATH)
    similarity_doc = _load_json(SIMILARITY_PATH)
    ml_selection_doc = _load_json(ML_SELECTION_PATH)
    materialization_doc = _load_json(MATERIALIZATION_AUDIT_PATH)

    registry = _by_feature_id(registry_doc.get("features") or [])
    similarity = _by_feature_id(similarity_doc.get("features") or [])
    ml_view = _view_by_feature(feature_view_doc, "ml_training_view")
    ml_counts = ml_selection_doc.get("counts") or {}
    candidate_ids = [str(item) for item in ml_selection_doc.get("formal137_not_in_current_feature_cols") or []]

    rows = [_candidate_row(feature_id, registry, similarity, ml_view) for feature_id in sorted(candidate_ids)]
    materialization_blockers = [row for row in rows if not row["materialization_ready"]]
    selector_counts = Counter(row["selector_role"] or "unknown" for row in rows)
    materializer_counts = Counter(row["materializer_status"] or "unknown" for row in rows)
    duplicate_counts = Counter(row["duplicate_level"] or "unknown" for row in rows)
    category_counts = Counter(row["category"] or "unknown" for row in rows)
    origin_counts = Counter(row["origin_pool"] or "unknown" for row in rows)

    no_unmapped_current = int(ml_counts.get("feature_cols_not_mapped_to_formal137") or 0) == 0
    similarity_ready = int((similarity_doc.get("counts") or {}).get("similarity_refresh_required") or 0) == 0
    materialization_counts = materialization_doc.get("counts") or {}
    materialization_date_range = materialization_doc.get("date_range") or {}
    materialization_audit_fresh = _artifact_fresh(MATERIALIZATION_AUDIT_PATH, REGISTRY_PATH)
    materialization_contract_ready = (
        materialization_doc.get("schema_version") == "stockvision-unified137-materialization-audit-v1"
        and materialization_doc.get("pass") is True
        and _same_path(materialization_doc.get("registry"), REGISTRY_PATH)
        and materialization_audit_fresh
        and materialization_date_range.get("start_date") == "2023-01-01"
        and materialization_date_range.get("end_date") == "2026-06-15"
        and materialization_date_range.get("universe") == "sii"
        and int(materialization_date_range.get("max_symbols") or 0) == 0
        and int(materialization_counts.get("mapped_factor_count") or 0) == int(ml_counts.get("formal137_ml_training_view") or 0)
        and int(materialization_counts.get("missing_expected_count") or 0) == 0
        and int(materialization_counts.get("zero_coverage_count") or 0) == 0
    )
    materialization_ready = not materialization_blockers and materialization_contract_ready
    no_201_invariant = (
        int(ml_counts.get("feature_cols") or 0) < 201
        and int(ml_counts.get("formal137_ml_training_view") or 0) < 201
    )
    status = (
        "preflight_ready"
        if no_unmapped_current and similarity_ready and materialization_ready and no_201_invariant
        else "blocked"
    )

    return {
        "schema_version": "stockvision-ml-feature-migration-preflight-v1",
        "status": status,
        "decision_effect": "local_validation_only",
        "policy": {
            "purpose": "Turn ml_feature_migration_required into an auditable feature-selection migration contract without changing production FEATURE_COLS.",
            "owner": "feature_selection_pipeline",
            "current_runtime_owner": "ml-service/app/features/__init__.py:FEATURE_COLS",
            "candidate_lake": "feature_view_contract_v1.views.ml_training_view",
            "no_direct_feature_cols_mutation": True,
            "no_daily_runtime_effect": True,
            "explicit_wei_approval_required_for_retrain": True,
            "explicit_wei_approval_required_for_release": True,
            "retrain_required_before_activation": True,
            "release_gate_required_before_activation": True,
            "sequence_family_rule": "Sequence family keeps its validated sequence contract; this preflight only governs tabular/tree/TabM candidate evidence.",
        },
        "source_files": {
            "registry": _rel(REGISTRY_PATH),
            "feature_view_contract": _rel(FEATURE_VIEW_PATH),
            "similarity_contract": _rel(SIMILARITY_PATH),
            "ml_feature_selection_contract": _rel(ML_SELECTION_PATH),
            "materialization_audit": _rel(MATERIALIZATION_AUDIT_PATH),
        },
        "counts": {
            "current_feature_cols": ml_counts.get("feature_cols"),
            "formal137_ml_training_view": ml_counts.get("formal137_ml_training_view"),
            "current_feature_cols_mapped_to_formal137": ml_counts.get("feature_cols_mapped_to_formal137"),
            "migration_candidate_count": len(rows),
            "materialization_ready_count": len(rows) - len(materialization_blockers),
            "materialization_blocker_count": len(materialization_blockers),
            "materialization_audit_fresh": materialization_audit_fresh,
            "materialization_contract_ready": materialization_contract_ready,
            "selector_role_counts": dict(selector_counts),
            "materializer_status_counts": dict(materializer_counts),
            "duplicate_level_counts": dict(duplicate_counts),
            "category_counts": dict(category_counts),
            "origin_pool_counts": dict(origin_counts),
        },
        "gate_status": {
            "no_unmapped_current_feature_cols": "pass" if no_unmapped_current else "fail",
            "direct_finlab_materialization_ready": "pass" if materialization_ready else "fail",
            "materialization_audit_fresh": "pass" if materialization_audit_fresh else "fail",
            "materialization_contract_ready": "pass" if materialization_contract_ready else "fail",
            "similarity_contract_ready": "pass" if similarity_ready else "fail",
            "no_201_invariant": "pass" if no_201_invariant else "fail",
            "production_activation": "blocked_until_feature_selection_retrain_release_approval",
        },
        "activation_plan": {
            "stage_0_current_state": "production keeps current 106 FEATURE_COLS.",
            "stage_1_candidate_pool": "Use the 137 ml_training_view as the governed feature-selection candidate pool.",
            "stage_2_selection": "Feature selection may pick from current mapped features plus the 84 migration candidates; high-duplicate candidates are penalized by similarity contract.",
            "stage_3_retrain": "Retrain must produce a model artifact with explicit feature schema lineage before any production activation.",
            "stage_4_release": "Release gate compares IC/RankIC, walk-forward lift, PBO/Deflated Sharpe, runtime, and L1.5/L4 diversity before promotion.",
            "rollback": "Rollback remains current 106 FEATURE_COLS and existing production artifacts.",
        },
        "materialization_blockers": [row["feature_id"] for row in materialization_blockers],
        "migration_candidates": rows,
    }


def main() -> int:
    contract = build_contract()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    JSON_OUT.write_text(json.dumps(contract, ensure_ascii=False, indent=2), encoding="utf-8")
    _write_csv(contract["migration_candidates"], CSV_OUT)
    print(json.dumps({
        "json": str(JSON_OUT),
        "csv": str(CSV_OUT),
        "status": contract["status"],
        "counts": contract["counts"],
        "gate_status": contract["gate_status"],
    }, ensure_ascii=False, indent=2))
    return 0 if contract["status"] == "preflight_ready" else 1


if __name__ == "__main__":
    raise SystemExit(main())
