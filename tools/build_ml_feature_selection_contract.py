from __future__ import annotations

import csv
import ast
import json
from collections import Counter
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
FEATURES_PY = ROOT / "ml-service" / "app" / "features" / "__init__.py"
REGISTRY = ROOT / "data" / "feature_registry" / "unified_feature_registry_v1.json"
FEATURE_VIEW = ROOT / "data" / "feature_registry" / "feature_view_contract_v1.json"
SIMILARITY = ROOT / "data" / "feature_registry" / "formal137_similarity_contract_v1.json"
OUT_DIR = ROOT / "output" / "feature_universe_triage"
REGISTRY_DIR = ROOT / "data" / "feature_registry"


def _rel(path: Path) -> str:
    return path.resolve().relative_to(ROOT.resolve()).as_posix()


ML_FEATURE_ALIAS_TO_REGISTRY = {
    "rsi14": "mom_rsi_14",
    "macdHist": "l1_macdHist",
    "bb_position": "tech_bbands_pctb_20",
    "atr14": "tech_atr_14",
    "ma20_bias": "tech_sma_20_pos",
    "ma60_bias": "l1_closeAboveMa60Pct",
    "vol_ratio_5d": "tech_volume_ratio_5",
    "revenue_yoy": "l1_revenueGrowthYoY",
    "dealer_5d": "l1_dealerNet5d",
    "ma10_bias": "tech_wma_10_pos",
    "limit_down_count": "tech_limit_down_count_10",
}


def _write_csv(rows: list[dict[str, Any]], path: Path) -> None:
    fields = sorted({key for row in rows for key in row.keys()})
    with path.open("w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def _load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        raise RuntimeError(f"invalid_json:{path}")
    return data


def _load_feature_lists(path: Path) -> dict[str, list[str]]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    assignments: dict[str, ast.AST] = {}
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    assignments[target.id] = node.value

    def literal_list(name: str) -> list[str]:
        value = assignments.get(name)
        if value is None:
            return []
        parsed = ast.literal_eval(value)
        return [str(item) for item in parsed]

    night = literal_list("NIGHT_SESSION_COLS")
    orderbook = literal_list("ORDERBOOK_COLS")
    return {
        "FEATURE_COLS": literal_list("FEATURE_COLS"),
        "OPTIONAL_FEATURE_COLS": night + orderbook,
        "CATBOOST_EXTRA_COLS": literal_list("CATBOOST_EXTRA_COLS"),
    }


def _registry_by_feature_id(registry: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        str(row.get("feature_id")): row
        for row in registry.get("features", [])
        if isinstance(row, dict) and row.get("feature_id")
    }


def _view_feature_ids(view: dict[str, Any], view_name: str) -> set[str]:
    section = (view.get("views") or {}).get(view_name) or {}
    return {
        str(row.get("feature_id"))
        for row in section.get("features", [])
        if isinstance(row, dict) and row.get("feature_id")
    }


def _resolve_ml_feature(feature: str, registry: dict[str, dict[str, Any]], ml_training_ids: set[str]) -> dict[str, Any]:
    direct = feature if feature in registry else None
    alias = ML_FEATURE_ALIAS_TO_REGISTRY.get(feature)
    alias_row = registry.get(alias or "")
    if alias and alias_row is not None and bool(alias_row.get("eligible_for_ml")) and alias in ml_training_ids:
        feature_id = alias
        mapping_type = "alias"
    elif direct:
        feature_id = direct
        mapping_type = "direct"
    elif alias:
        feature_id = alias
        mapping_type = "alias_missing_registry"
    else:
        feature_id = ""
        mapping_type = "not_mapped"
    if not feature_id:
        return {
            "ml_feature": feature,
            "registry_feature_id": "",
            "mapping_type": mapping_type,
            "formal137_status": "not_in_unified_registry",
            "selector_role": "",
            "active_pool_status": "",
            "eligible_for_ml": False,
        }
    row = registry.get(feature_id)
    if row is None:
        return {
            "ml_feature": feature,
            "registry_feature_id": feature_id,
            "mapping_type": mapping_type,
            "formal137_status": "missing_registry_feature",
            "selector_role": "",
            "active_pool_status": "",
            "eligible_for_ml": False,
        }
    eligible = bool(row.get("eligible_for_ml")) and feature_id in ml_training_ids
    return {
        "ml_feature": feature,
        "registry_feature_id": feature_id,
        "mapping_type": mapping_type,
        "formal137_status": "formal_candidate" if eligible else str(row.get("active_pool_status") or "not_eligible"),
        "selector_role": row.get("selector_role") or "",
        "active_pool_status": row.get("active_pool_status") or "",
        "eligible_for_ml": eligible,
    }


def main() -> int:
    feature_lists = _load_feature_lists(FEATURES_PY)
    feature_cols = feature_lists["FEATURE_COLS"]
    optional_cols = feature_lists["OPTIONAL_FEATURE_COLS"]
    catboost_extra_cols = feature_lists["CATBOOST_EXTRA_COLS"]

    registry_doc = _load_json(REGISTRY)
    view_doc = _load_json(FEATURE_VIEW)
    similarity_doc = _load_json(SIMILARITY)
    registry = _registry_by_feature_id(registry_doc)
    ml_training_ids = _view_feature_ids(view_doc, "ml_training_view")
    formal_ids = {
        str(row.get("feature_id"))
        for row in registry_doc.get("features", [])
        if isinstance(row, dict) and row.get("active_pool_status") == "candidate"
    }

    rows = [_resolve_ml_feature(feature, registry, ml_training_ids) for feature in feature_cols]
    mapping_counts = Counter(row["mapping_type"] for row in rows)
    status_counts = Counter(row["formal137_status"] for row in rows)
    role_counts = Counter(row["selector_role"] or "none" for row in rows)
    feature_cols_in_formal = {row["registry_feature_id"] for row in rows if row["formal137_status"] == "formal_candidate"}
    formal_not_in_feature_cols = sorted(formal_ids - feature_cols_in_formal)

    contract = {
        "schema_version": "stockvision-ml-feature-selection-contract-v1",
        "policy": {
            "purpose": "Define how current production FEATURE_COLS and the unified 137 ml_training_view relate without creating a 201-column unmanaged soup.",
            "current_production_matrix": "ml-service/app/features/__init__.py:FEATURE_COLS",
            "candidate_lake": "feature_view_contract_v1.views.ml_training_view",
            "owner": "feature_selection_pipeline owns active ML features; FEATURE_COLS/build_feature_matrix owns current production materialization.",
            "no_201_invariant": "Do not concatenate FEATURE_COLS + formal137. Feature selection must choose from a governed candidate view after materialization parity is implemented.",
            "tree_family_rule": "Tree/TabM may use feature selection output; sequence family keeps its own validated sequence contract.",
        },
        "source_files": {
            "feature_cols": "ml-service/app/features/__init__.py:FEATURE_COLS",
            "registry": _rel(REGISTRY),
            "feature_view_contract": _rel(FEATURE_VIEW),
            "similarity_contract": _rel(SIMILARITY),
        },
        "counts": {
            "feature_cols": len(feature_cols),
            "optional_feature_cols": len(optional_cols),
            "catboost_extra_cols": len(catboost_extra_cols),
            "formal137_ml_training_view": len(ml_training_ids),
            "feature_cols_mapped_to_formal137": len(feature_cols_in_formal),
            "feature_cols_not_mapped_to_formal137": sum(1 for row in rows if row["formal137_status"] == "not_in_unified_registry"),
            "formal137_not_in_current_feature_cols": len(formal_not_in_feature_cols),
            "similarity_refresh_required": (similarity_doc.get("counts") or {}).get("similarity_refresh_required"),
        },
        "mapping_counts": dict(mapping_counts),
        "formal137_status_counts": dict(status_counts),
        "selector_role_counts": dict(role_counts),
        "formal137_not_in_current_feature_cols": formal_not_in_feature_cols,
        "feature_mappings": rows,
    }

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    REGISTRY_DIR.mkdir(parents=True, exist_ok=True)
    json_path = REGISTRY_DIR / "ml_feature_selection_contract_v1.json"
    csv_path = OUT_DIR / "ml_feature_selection_contract_20260617.csv"
    json_path.write_text(json.dumps(contract, ensure_ascii=False, indent=2), encoding="utf-8")
    _write_csv(rows, csv_path)
    print(json.dumps({
        "json": str(json_path),
        "csv": str(csv_path),
        "counts": contract["counts"],
        "mapping_counts": contract["mapping_counts"],
        "formal137_status_counts": contract["formal137_status_counts"],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
