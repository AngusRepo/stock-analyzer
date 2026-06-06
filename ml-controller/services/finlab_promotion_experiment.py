from __future__ import annotations

import hashlib
import json
import math
from datetime import datetime, timezone
from typing import Any, Iterable


FINLAB_PROMOTION_EXPERIMENT_SCHEMA_VERSION = "finlab-ml-promotion-experiment-v1"


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sha256_json(payload: Any) -> str:
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def _as_float_list(values: Iterable[Any]) -> list[float]:
    out: list[float] = []
    for value in values or []:
        try:
            number = float(value)
        except (TypeError, ValueError):
            number = float("nan")
        out.append(number)
    return out


def _rank(values: list[float]) -> list[float]:
    order = sorted(range(len(values)), key=lambda idx: values[idx])
    ranks = [0.0] * len(values)
    for rank, idx in enumerate(order):
        ranks[idx] = float(rank)
    return ranks


def _corr(a: list[float], b: list[float]) -> float:
    if len(a) < 3 or len(b) < 3:
        return 0.0
    am = sum(a) / len(a)
    bm = sum(b) / len(b)
    av = [x - am for x in a]
    bv = [x - bm for x in b]
    denom = math.sqrt(sum(x * x for x in av) * sum(y * y for y in bv))
    if denom <= 1e-12:
        return 0.0
    return float(sum(x * y for x, y in zip(av, bv)) / denom)


def rank_ic(scores: Iterable[Any], actual_returns: Iterable[Any]) -> float:
    pairs = [
        (score, actual)
        for score, actual in zip(_as_float_list(scores), _as_float_list(actual_returns))
        if math.isfinite(score) and math.isfinite(actual)
    ]
    if len(pairs) < 3:
        return 0.0
    score_rank = _rank([score for score, _actual in pairs])
    actual_rank = _rank([actual for _score, actual in pairs])
    return round(_corr(score_rank, actual_rank), 6)


def hit_rate(scores: Iterable[Any], actual_returns: Iterable[Any], *, neutral_score: float = 0.5) -> float:
    pairs = [
        (score, actual)
        for score, actual in zip(_as_float_list(scores), _as_float_list(actual_returns))
        if math.isfinite(score) and math.isfinite(actual) and score != neutral_score and actual != 0
    ]
    if not pairs:
        return 0.0
    hits = sum(1 for score, actual in pairs if (score - neutral_score > 0) == (actual > 0))
    return round(hits / len(pairs), 6)


def build_finlab_promotion_experiment_manifest(
    *,
    canonical_features: Iterable[Any],
    sidecar_families: Iterable[dict[str, Any]],
    generated_at: str | None = None,
    min_ic_lift: float = 0.01,
    min_hit_rate_lift: float = 0.005,
    min_candidate_ic: float = 0.02,
    min_coverage: float = 0.95,
) -> dict[str, Any]:
    canonical = [str(value) for value in canonical_features]
    families = [dict(family) for family in sidecar_families or []]
    manifest = {
        "schema_version": FINLAB_PROMOTION_EXPERIMENT_SCHEMA_VERSION,
        "generated_at": generated_at or _utc_now(),
        "baseline_contract": {
            "name": "canonical_106",
            "feature_count": len(canonical),
            "features_hash": _sha256_json(canonical),
            "production_ml_input": "current_106_features_only",
        },
        "candidate_contract": {
            "name": "canonical_106_plus_finlab_sidecar",
            "join_keys": ["symbol", "date"],
            "point_in_time_required": True,
            "sidecar_family_count": len(families),
            "sidecar_fields_total": sum(int(family.get("field_count") or 0) for family in families),
            "sidecar_families": families,
            "production_mutation_allowed": False,
        },
        "experiment_design": {
            "comparison": "106_vs_106_plus_finlab",
            "required_models": ["LightGBM", "XGBoost", "ExtraTrees", "TabM", "GNN"],
            "validation": ["purged_cpcv", "date_holdout_with_embargo", "leakage_guard", "ablation_by_sidecar_family"],
            "metrics": ["rank_ic", "hit_rate", "coverage", "missingness", "turnover_delta"],
            "promotion_rule": "candidate must pass thresholds before feature contract bump and full artifact retrain",
        },
        "thresholds": {
            "min_ic_lift": float(min_ic_lift),
            "min_hit_rate_lift": float(min_hit_rate_lift),
            "min_candidate_ic": float(min_candidate_ic),
            "min_coverage": float(min_coverage),
        },
    }
    manifest["checksum"] = _sha256_json({
        "schema_version": manifest["schema_version"],
        "baseline_contract": manifest["baseline_contract"],
        "candidate_contract": manifest["candidate_contract"],
        "experiment_design": manifest["experiment_design"],
        "thresholds": manifest["thresholds"],
    })
    return manifest


def evaluate_finlab_promotion_lift(
    *,
    baseline_scores: Iterable[Any],
    candidate_scores: Iterable[Any],
    actual_returns: Iterable[Any],
    coverage_mask: Iterable[Any] | None = None,
    thresholds: dict[str, Any] | None = None,
) -> dict[str, Any]:
    baseline = _as_float_list(baseline_scores)
    candidate = _as_float_list(candidate_scores)
    actual = _as_float_list(actual_returns)
    n = min(len(baseline), len(candidate), len(actual))
    if n == 0:
        return {"status": "error", "reason": "empty_inputs"}
    if coverage_mask is None:
        coverage = [math.isfinite(candidate[idx]) for idx in range(n)]
    else:
        raw_mask = list(coverage_mask)
        coverage = [bool(raw_mask[idx]) if idx < len(raw_mask) else False for idx in range(n)]
    covered = [idx for idx in range(n) if coverage[idx]]
    coverage_ratio = len(covered) / n
    base_scores = [baseline[idx] for idx in covered]
    cand_scores = [candidate[idx] for idx in covered]
    actual_values = [actual[idx] for idx in covered]

    baseline_ic = rank_ic(base_scores, actual_values)
    candidate_ic = rank_ic(cand_scores, actual_values)
    baseline_hit = hit_rate(base_scores, actual_values)
    candidate_hit = hit_rate(cand_scores, actual_values)
    ic_lift = round(candidate_ic - baseline_ic, 6)
    hit_lift = round(candidate_hit - baseline_hit, 6)
    gate = {
        "min_ic_lift": 0.01,
        "min_hit_rate_lift": 0.005,
        "min_candidate_ic": 0.02,
        "min_coverage": 0.95,
        **(thresholds or {}),
    }
    failed = []
    if candidate_ic < float(gate["min_candidate_ic"]):
        failed.append("candidate_ic_below_threshold")
    if ic_lift < float(gate["min_ic_lift"]):
        failed.append("ic_lift_below_threshold")
    if hit_lift < float(gate["min_hit_rate_lift"]):
        failed.append("hit_rate_lift_below_threshold")
    if coverage_ratio < float(gate["min_coverage"]):
        failed.append("coverage_below_threshold")
    return {
        "status": "pass" if not failed else "fail",
        "n_rows": n,
        "covered_rows": len(covered),
        "coverage": round(coverage_ratio, 6),
        "baseline_rank_ic": baseline_ic,
        "candidate_rank_ic": candidate_ic,
        "ic_lift": ic_lift,
        "baseline_hit_rate": baseline_hit,
        "candidate_hit_rate": candidate_hit,
        "hit_rate_lift": hit_lift,
        "thresholds": gate,
        "failed_gates": failed,
    }
