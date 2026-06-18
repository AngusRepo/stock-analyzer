from __future__ import annotations

import csv
import json
import math
from collections import Counter
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
TRIAGE = ROOT / "output" / "feature_universe_triage"
REGISTRY_DIR = ROOT / "data" / "feature_registry"

STRATEGY95_BEST = ROOT / "output" / "finlab_strategy95_backtests" / "strategy95_factors_sii_20230101_20260615_top10_bothdir_best.csv"
STRATEGY95_MAPPING = TRIAGE / "strategy95_vs_ml106_full_mapping.csv"
ML106_BEST = ROOT / "output" / "finlab_ml_feature_backtests" / "ml106_features_sii_20230101_20260615_top10_bothdir_best.csv"
OVERLAP_PAIRS = ROOT / "output" / "feature_strategy_overlap_numeric" / "feature_strategy_overlap_sii_20230101_20260615_pairs_ge_0_6.csv"
FINLAB701_AUDITS = ROOT / "output" / "finlab_augment701_backtests" / "finlab701_sii_20230101_20260615_top10_bothdir_audits.csv"
FINLAB701_TRIAGE = TRIAGE / "finlab701_triage_best_by_field.csv"
PRUNE_DECISION = TRIAGE / "unified179_feature_prune_decision_20260617.csv"
PAIRWISE_SUMMARY = TRIAGE / "unified179_pairwise_similarity_summary_20260617.json"


def _rel(path: Path) -> str:
    return path.resolve().relative_to(ROOT.resolve()).as_posix()


def _read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


def _read_csv_optional(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    return _read_csv(path)


def _num(value: Any, default: float | None = None) -> float | None:
    if value in (None, ""):
        return default
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    return out if math.isfinite(out) else default


def _bool_for_status(status: str) -> bool:
    return status in {"candidate", "transform_candidate", "chip_candidate"}


def _load_prune_decisions() -> tuple[dict[str, dict[str, str]], set[str]]:
    decisions = {row["feature_id"]: row for row in _read_csv_optional(PRUNE_DECISION) if row.get("feature_id")}
    missing_panels: set[str] = set()
    if PAIRWISE_SUMMARY.exists():
        summary = json.loads(PAIRWISE_SUMMARY.read_text(encoding="utf-8"))
        missing_panels = {str(item) for item in summary.get("missing_features") or []}
    return decisions, missing_panels


def _selector_contract(feature_id: str, base_status: str, decisions: dict[str, dict[str, str]], missing_panels: set[str]) -> dict[str, Any]:
    decision = decisions.get(feature_id)
    recommended = decision.get("recommended_status") if decision else "keep_candidate"
    if feature_id in missing_panels and recommended == "keep_candidate":
        recommended = "watch_not_selector"

    if base_status == "alias":
        return {
            "active_pool_status": "alias",
            "recommended_status": "alias_high_overlap",
            "selector_role": "alias",
            "promotion_state": "alias",
            "eligible": False,
            "direct_challenger_eligible": False,
            "prior_weight": 0.0,
            "materializer_status": "not_required_alias",
            "reasons": "alias_high_overlap",
        }

    if recommended == "drop_research_candidate":
        return {
            "active_pool_status": "drop_research_candidate",
            "recommended_status": recommended,
            "selector_role": "drop_research_candidate",
            "promotion_state": "dropped_from_formal_pool",
            "eligible": False,
            "direct_challenger_eligible": False,
            "prior_weight": 0.0,
            "materializer_status": "not_required_drop",
            "reasons": decision.get("reasons") if decision else "",
        }

    if recommended == "watch_not_selector":
        materializer_status = "materialized"
        if feature_id in missing_panels:
            materializer_status = "requires_registry_l1_supplement" if feature_id.startswith("l1_") else "missing_pairwise_panel"
        return {
            "active_pool_status": "candidate",
            "recommended_status": recommended,
            "selector_role": "evidence_watch",
            "promotion_state": "research_evidence_watch",
            "eligible": True,
            "direct_challenger_eligible": False,
            "prior_weight": 0.35,
            "materializer_status": materializer_status,
            "reasons": decision.get("reasons") if decision else ("missing_pairwise_panel" if feature_id in missing_panels else ""),
        }

    return {
        "active_pool_status": "candidate",
        "recommended_status": "keep_candidate",
        "selector_role": "core_prior",
        "promotion_state": "core_prior",
        "eligible": True,
        "direct_challenger_eligible": True,
        "prior_weight": 1.0,
        "materializer_status": "materialized",
        "reasons": decision.get("reasons") if decision else "",
    }


def _strategy_status(row: dict[str, str]) -> str:
    # strategy95 is the alpha base. Do not pre-filter by Sharpe/CAGR/MDD here;
    # feature selection and pymoo/novelty own selection from the deduped pool.
    return "candidate"


def _ml_status(row: dict[str, str], max_corr_to_strategy: float | None) -> str:
    # ML106 supplements strategy95. Only remove high-overlap duplicates from the
    # active candidate pool; keep the remaining features for downstream search.
    if max_corr_to_strategy is not None and max_corr_to_strategy >= 0.8:
        return "alias"
    return "candidate"


def _finlab_status(audit: dict[str, str], triage: dict[str, str] | None) -> str:
    if triage:
        decision = triage.get("decision") or ""
        if decision == "keep_as_transform_candidate_not_raw_selector":
            return "transform_candidate"
        if decision == "keep_as_chip_candidate":
            return "chip_candidate"
        if decision == "dedupe_duplicate_metric_signature":
            return "alias"
        return "context_only"
    status = audit.get("status") or ""
    if status in {"context_only_or_not_stock_panel", "low_coverage", "no_cross_section_signal"}:
        return "context_only"
    if status in {"materialize_error", "empty"}:
        return "drop"
    return "reserve"


def build_registry() -> dict[str, Any]:
    strategy_rows = _read_csv(STRATEGY95_MAPPING)
    ml_rows = _read_csv(ML106_BEST)
    pair_rows = _read_csv(OVERLAP_PAIRS)
    finlab_audits = _read_csv(FINLAB701_AUDITS)
    finlab_triage_rows = _read_csv(FINLAB701_TRIAGE)
    finlab_triage = {row["api_key"]: row for row in finlab_triage_rows if row.get("api_key")}
    prune_decisions, missing_panels = _load_prune_decisions()

    max_corr_by_ml: dict[str, float] = {}
    for row in pair_rows:
        ml_feature = row.get("ml_feature")
        corr = _num(row.get("abs_rank_corr"))
        if not ml_feature or corr is None:
            continue
        max_corr_by_ml[ml_feature] = max(corr, max_corr_by_ml.get(ml_feature, 0.0))

    features: list[dict[str, Any]] = []

    for row in strategy_rows:
        feature_id = row["strategy_factor"]
        status = _strategy_status(row)
        contract = _selector_contract(feature_id, status, prune_decisions, missing_panels)
        tier = row.get("overlap_tier") or ""
        nearest_ml = row.get("nearest_ml106_feature") or None
        features.append({
            "feature_id": feature_id,
            "origin_pool": "strategy95",
            "source_system": row.get("strategy_source"),
            "category": row.get("strategy_category"),
            "canonical_group": f"strategy95:{feature_id}",
            "preferred_view": "strategy95",
            "runtime_value_source": "strategy95",
            "active_pool_status": contract["active_pool_status"],
            "recommended_status": contract["recommended_status"],
            "selector_role": contract["selector_role"],
            "promotion_state": contract["promotion_state"],
            "eligible_for_strategy": contract["eligible"],
            "eligible_for_ml": contract["eligible"],
            "eligible_for_ple": contract["eligible"],
            "eligible_for_l1_25": contract["eligible"],
            "eligible_for_alpha_mining": contract["eligible"],
            "eligible_for_direct_challenger_seed": contract["direct_challenger_eligible"],
            "alpha_mining_prior_weight": contract["prior_weight"],
            "feature_selection_prior_weight": contract["prior_weight"],
            "materializer_status": contract["materializer_status"],
            "requires_transform": False,
            "triage": {
                "monthly_sharpe": _num(row.get("strategy_best_sharpe")),
                "cagr": _num(row.get("strategy_best_cagr")),
                "max_drawdown": _num(row.get("strategy_best_mdd")),
                "mean_ic_5d": _num(row.get("strategy_mean_ic_5d")),
                "nearest_ml106_feature": nearest_ml,
                "nearest_abs_rank_corr": _num(row.get("nearest_abs_rank_corr")),
                "overlap_tier": tier,
                "action": row.get("action"),
                "quality_bucket": row.get("action"),
                "prune_reason": contract["reasons"],
            },
        })

    for row in ml_rows:
        feature_id = row["feature_id"]
        max_corr = max_corr_by_ml.get(feature_id)
        status = _ml_status(row, max_corr)
        contract = _selector_contract(feature_id, status, prune_decisions, missing_panels)
        features.append({
            "feature_id": feature_id,
            "origin_pool": "ml106",
            "source_system": "stockvision_ml106",
            "category": row.get("feature_group"),
            "canonical_group": f"ml106:{feature_id}",
            "preferred_view": "ml106" if contract["active_pool_status"] != "alias" else "strategy95",
            "runtime_value_source": "ml106",
            "active_pool_status": contract["active_pool_status"],
            "recommended_status": contract["recommended_status"],
            "selector_role": contract["selector_role"],
            "promotion_state": contract["promotion_state"],
            "eligible_for_strategy": contract["eligible"],
            "eligible_for_ml": contract["eligible"],
            "eligible_for_ple": contract["eligible"],
            "eligible_for_l1_25": contract["eligible"],
            "eligible_for_alpha_mining": contract["eligible"],
            "eligible_for_direct_challenger_seed": contract["direct_challenger_eligible"],
            "alpha_mining_prior_weight": contract["prior_weight"],
            "feature_selection_prior_weight": contract["prior_weight"],
            "materializer_status": contract["materializer_status"],
            "requires_transform": False,
            "triage": {
                "monthly_sharpe": _num(row.get("monthly_sharpe")),
                "cagr": _num(row.get("cagr")),
                "max_drawdown": _num(row.get("max_drawdown")),
                "coverage": _num(row.get("coverage")),
                "max_abs_rank_corr_to_strategy95": max_corr,
                "direction_mode": row.get("direction_mode"),
                "quality_bucket": contract["recommended_status"],
                "prune_reason": contract["reasons"],
            },
        })

    for audit in finlab_audits:
        api_key = audit["api_key"]
        triage = finlab_triage.get(api_key)
        status = _finlab_status(audit, triage)
        features.append({
            "feature_id": api_key,
            "origin_pool": "finlab701",
            "source_system": audit.get("namespace"),
            "category": audit.get("group"),
            "canonical_group": f"finlab:{api_key}",
            "preferred_view": "transform" if status == "transform_candidate" else audit.get("namespace"),
            "runtime_value_source": "finlab701",
            "active_pool_status": status,
            "recommended_status": status,
            "selector_role": status,
            "promotion_state": status,
            "eligible_for_strategy": False,
            "eligible_for_ml": False,
            "eligible_for_ple": False,
            "eligible_for_l1_25": False,
            "eligible_for_alpha_mining": False,
            "eligible_for_direct_challenger_seed": False,
            "alpha_mining_prior_weight": 0.0,
            "feature_selection_prior_weight": 0.0,
            "materializer_status": "not_in_formal_137_pool",
            "candidate_for_strategy": status in {"transform_candidate", "chip_candidate"},
            "candidate_for_ml": status in {"transform_candidate", "chip_candidate"},
            "candidate_for_ple": status in {"transform_candidate", "chip_candidate"},
            "candidate_for_l1_25": status in {"transform_candidate", "chip_candidate"},
            "candidate_for_alpha_mining": status in {"transform_candidate", "chip_candidate"},
            "requires_transform": status == "transform_candidate",
            "triage": {
                "audit_status": audit.get("status"),
                "decision": triage.get("decision") if triage else None,
                "strength_bucket": triage.get("strength_bucket") if triage else None,
                "monthly_sharpe": _num(triage.get("monthly_sharpe")) if triage else None,
                "cagr": _num(triage.get("cagr")) if triage else None,
                "max_drawdown": _num(triage.get("max_drawdown")) if triage else None,
                "coverage": _num(audit.get("coverage")),
                "dataset_lane": audit.get("dataset_lane"),
                "error": audit.get("error") or None,
            },
        })

    status_counts = Counter(row["active_pool_status"] for row in features)
    recommended_status_counts = Counter(row.get("recommended_status") for row in features)
    selector_role_counts = Counter(row.get("selector_role") for row in features)
    materializer_status_counts = Counter(row.get("materializer_status") for row in features)
    origin_counts = Counter(row["origin_pool"] for row in features)
    eligible_counts = {
        key: sum(1 for row in features if row[key])
        for key in [
            "eligible_for_strategy",
            "eligible_for_ml",
            "eligible_for_ple",
            "eligible_for_l1_25",
            "eligible_for_alpha_mining",
        ]
    }
    return {
        "schema_version": "stockvision-unified-feature-registry-v1",
        "policy": {
            "source_of_truth": "single_unified_feature_registry",
            "formal_pool": "137 = 69 core_prior + 68 evidence_watch",
            "audit_lineage_pool": "179 strategy95+ml106 deduped features remains audit lineage only.",
            "excluded_pool": "42 drop_research_candidate features are removed from selector, ML, PLE and pymoo candidate paths.",
            "base_pool": "strategy95_and_ml106_after_cross_pool_dedupe",
            "supplement_pool": "finlab701_triage_transform_candidates_not_active_until_materialized",
            "dedupe_contract": "Feature pruning first removes high-correlation weak duplicates and weak low-coverage panels. The remaining formal pool has selector_role=core_prior or evidence_watch; evidence_watch may enter pymoo combinations with lower prior, but is not a direct challenger seed.",
            "consumer_contract": "L1, L1.25, L1.5, L2/L3 and alpha mining must reference this registry; consumers may choose transforms and feature-selection weights but may not maintain an independent feature universe.",
            "pymoo_contract": "Monthly pymoo NSGA-III + novelty uses eligible_for_alpha_mining=true from this registry, starting with config defaults and then adapting population/generations/mutation after telemetry. It must auto-run FinLab validation before promotion.",
            "no_transition_pool": "canonical114 is superseded by unified_registry_v1.",
        },
        "source_files": {
            "strategy95_mapping": _rel(STRATEGY95_MAPPING),
            "ml106_best": _rel(ML106_BEST),
            "overlap_pairs": _rel(OVERLAP_PAIRS),
            "finlab701_audits": _rel(FINLAB701_AUDITS),
            "finlab701_triage": _rel(FINLAB701_TRIAGE),
            "prune_decision": _rel(PRUNE_DECISION),
            "pairwise_summary": _rel(PAIRWISE_SUMMARY),
        },
        "summary": {
            "total_features": len(features),
            "origin_counts": dict(origin_counts),
            "status_counts": dict(status_counts),
            "recommended_status_counts": dict(recommended_status_counts),
            "selector_role_counts": dict(selector_role_counts),
            "materializer_status_counts": dict(materializer_status_counts),
            "eligible_counts": eligible_counts,
            "formal_candidate_count": sum(1 for row in features if row.get("selector_role") in {"core_prior", "evidence_watch"}),
            "core_prior_count": selector_role_counts.get("core_prior", 0),
            "evidence_watch_count": selector_role_counts.get("evidence_watch", 0),
            "drop_research_candidate_count": selector_role_counts.get("drop_research_candidate", 0),
        },
        "features": features,
    }


def main() -> int:
    registry = build_registry()
    REGISTRY_DIR.mkdir(parents=True, exist_ok=True)
    TRIAGE.mkdir(parents=True, exist_ok=True)
    registry_path = REGISTRY_DIR / "unified_feature_registry_v1.json"
    summary_path = TRIAGE / "unified_feature_registry_v1_summary.json"
    registry_path.write_text(json.dumps(registry, ensure_ascii=False, indent=2), encoding="utf-8")
    summary_path.write_text(json.dumps({
        "schema_version": registry["schema_version"],
        "policy": registry["policy"],
        "source_files": registry["source_files"],
        "summary": registry["summary"],
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "registry_path": str(registry_path),
        "summary_path": str(summary_path),
        "summary": registry["summary"],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
