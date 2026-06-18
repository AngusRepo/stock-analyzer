from __future__ import annotations

import csv
import json
from collections import Counter
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
REGISTRY = ROOT / "data" / "feature_registry" / "unified_feature_registry_v1.json"
SIMILARITY = ROOT / "data" / "feature_registry" / "formal137_similarity_contract_v1.json"
OUT_DIR = ROOT / "output" / "feature_universe_triage"
REGISTRY_DIR = ROOT / "data" / "feature_registry"


def _rel(path: Path) -> str:
    return path.resolve().relative_to(ROOT.resolve()).as_posix()


VIEW_TRANSFORMS = {
    "strategy_view": [
        "raw",
        "rank_pct",
        "sector_rank_pct",
        "threshold_signal",
    ],
    "ml_training_view": [
        "winsorized",
        "zscore",
        "rank_pct",
        "sector_neutral_zscore",
        "lag_1d",
        "lag_5d",
    ],
    "ple_router_view": [
        "rank_pct",
        "feature_cluster_exposure",
        "strategy_affinity_support",
        "uncertainty_bucket",
    ],
    "l1_25_view": [
        "strategy_feature_cluster",
        "crowding_contribution",
        "recent_ic",
        "decay_state",
    ],
    "alpha_mining_view": [
        "rank_pct",
        "direction_adjusted_rank",
        "novelty_reference",
        "cluster_penalty_reference",
    ],
}


def _write_csv(rows: list[dict[str, Any]], path: Path) -> None:
    fields = list(rows[0].keys()) if rows else []
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


def _similarity_by_feature(similarity: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        str(row.get("feature_id")): row
        for row in similarity.get("features", [])
        if isinstance(row, dict) and row.get("feature_id")
    }


def _view_feature(
    feature: dict[str, Any],
    sim: dict[str, Any],
    *,
    view_name: str,
) -> dict[str, Any]:
    selector_role = str(feature.get("selector_role") or "")
    duplicate_level = str(sim.get("duplicate_level") or "unknown")
    is_core = selector_role == "core_prior"
    return {
        "feature_id": feature.get("feature_id"),
        "origin_pool": feature.get("origin_pool"),
        "source_system": feature.get("source_system"),
        "category": feature.get("category"),
        "selector_role": selector_role,
        "recommended_status": feature.get("recommended_status"),
        "materializer_status": feature.get("materializer_status"),
        "duplicate_level": duplicate_level,
        "nearest_feature": sim.get("nearest_feature"),
        "nearest_abs_rank_corr": sim.get("nearest_abs_rank_corr"),
        "high_duplicate_cluster_id": sim.get("high_duplicate_cluster_id"),
        "high_duplicate_cluster_leader": sim.get("high_duplicate_cluster_leader"),
        "related_cluster_id": sim.get("related_cluster_id"),
        "related_cluster_leader": sim.get("related_cluster_leader"),
        "preferred_feature_id": sim.get("preferred_feature_id"),
        "similarity_status": sim.get("similarity_status"),
        "allowed_transforms": VIEW_TRANSFORMS[view_name],
        "priority": "primary" if is_core else "secondary_evidence",
        "direct_challenger_eligible": bool(feature.get("eligible_for_direct_challenger_seed")),
        "prior_weight": feature.get("alpha_mining_prior_weight"),
    }


def _build_view(
    registry_features: list[dict[str, Any]],
    similarity_features: dict[str, dict[str, Any]],
    *,
    view_name: str,
    eligibility_key: str,
) -> dict[str, Any]:
    rows = [
        _view_feature(feature, similarity_features.get(str(feature.get("feature_id")), {}), view_name=view_name)
        for feature in registry_features
        if feature.get(eligibility_key)
    ]
    role_counts = Counter(row["selector_role"] for row in rows)
    duplicate_counts = Counter(row["duplicate_level"] for row in rows)
    return {
        "view_name": view_name,
        "eligibility_key": eligibility_key,
        "feature_count": len(rows),
        "selector_role_counts": dict(role_counts),
        "duplicate_level_counts": dict(duplicate_counts),
        "allowed_transforms": VIEW_TRANSFORMS[view_name],
        "features": rows,
    }


def main() -> int:
    registry = _load_json(REGISTRY)
    similarity = _load_json(SIMILARITY)
    similarity_features = _similarity_by_feature(similarity)
    registry_features = [
        row
        for row in registry.get("features", [])
        if isinstance(row, dict) and row.get("active_pool_status") == "candidate"
    ]

    views = {
        "strategy_view": _build_view(
            registry_features,
            similarity_features,
            view_name="strategy_view",
            eligibility_key="eligible_for_strategy",
        ),
        "ml_training_view": _build_view(
            registry_features,
            similarity_features,
            view_name="ml_training_view",
            eligibility_key="eligible_for_ml",
        ),
        "ple_router_view": _build_view(
            registry_features,
            similarity_features,
            view_name="ple_router_view",
            eligibility_key="eligible_for_ple",
        ),
        "l1_25_view": _build_view(
            registry_features,
            similarity_features,
            view_name="l1_25_view",
            eligibility_key="eligible_for_l1_25",
        ),
        "alpha_mining_view": _build_view(
            registry_features,
            similarity_features,
            view_name="alpha_mining_view",
            eligibility_key="eligible_for_alpha_mining",
        ),
    }

    summary_rows: list[dict[str, Any]] = []
    for view_name, view in views.items():
        summary_rows.append({
            "view_name": view_name,
            "feature_count": view["feature_count"],
            "core_prior": view["selector_role_counts"].get("core_prior", 0),
            "evidence_watch": view["selector_role_counts"].get("evidence_watch", 0),
            "high_duplicate": view["duplicate_level_counts"].get("high_duplicate", 0),
            "related_cluster": view["duplicate_level_counts"].get("related_cluster", 0),
            "independent_candidate": view["duplicate_level_counts"].get("independent_candidate", 0),
            "similarity_refresh_required": view["duplicate_level_counts"].get("similarity_refresh_required", 0),
        })

    contract = {
        "schema_version": "stockvision-feature-view-contract-v1",
        "policy": {
            "purpose": "Same canonical 137 feature pool, different consumer views. Do not collapse L1 strategy, L1.25, PLE, ML training, and alpha mining into one scorer.",
            "formal_pool": "137 = 69 core_prior + 68 evidence_watch",
            "no_201_invariant": "Views must derive from unified_feature_registry_v1; no consumer may maintain an independent 95+106+701 soup.",
            "ml_training_rule": "ml_training_view defines candidates and transforms only; monthly/weekly feature selection still owns active ML feature choice.",
            "strategy_rule": "strategy_view remains threshold-friendly evidence for L1 labeler, not a ranker.",
            "ple_rule": "ple_router_view may consume governed feature evidence plus strategy matrix and L1.25 priors; it must not replace L2/L3.",
        },
        "source_files": {
            "registry": _rel(REGISTRY),
            "similarity_contract": _rel(SIMILARITY),
        },
        "summary": {
            "view_count": len(views),
            "formal_candidate_count": len(registry_features),
            "view_counts": {name: view["feature_count"] for name, view in views.items()},
            "no_201_invariant_pass": all(view["feature_count"] <= len(registry_features) for view in views.values()),
        },
        "views": views,
    }

    REGISTRY_DIR.mkdir(parents=True, exist_ok=True)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    json_path = REGISTRY_DIR / "feature_view_contract_v1.json"
    summary_csv = OUT_DIR / "feature_view_contract_summary_20260617.csv"
    json_path.write_text(json.dumps(contract, ensure_ascii=False, indent=2), encoding="utf-8")
    _write_csv(summary_rows, summary_csv)
    print(json.dumps({
        "json": str(json_path),
        "summary_csv": str(summary_csv),
        "summary": contract["summary"],
        "views": summary_rows,
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
