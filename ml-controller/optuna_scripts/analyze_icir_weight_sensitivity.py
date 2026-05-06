"""
analyze_icir_weight_sensitivity.py — P2 #37: post-hoc sensitivity of
icir_weight in combined_score = tp_score + icir * icir_weight.

Full Optuna over icir_weight requires re-running feature_selection_pipeline
(~30min each), which is prohibitive. Cheaper proxy: load the last run's
per-feature tp_score + icir, re-rank under different icir_weight values,
and report how the selected feature set shifts.

When to actually run a full Optuna: if this analysis shows the current
default (0.1) selects a meaningfully different set than alternatives, it's
worth the full cost. If rankings are stable across w ∈ [0.05, 0.3], the
default is fine.

Usage:
  # From ml-controller container (has GCS creds):
  python -m optuna_scripts.analyze_icir_weight_sensitivity
"""
from __future__ import annotations
import json
import os
import io
import logging
from typing import Any

logger = logging.getLogger(__name__)


def _get_bucket():
    try:
        from google.cloud import storage
    except ImportError:
        return None
    bucket_name = os.environ.get("GCS_BUCKET_NAME")
    if not bucket_name:
        raise RuntimeError("GCS_BUCKET_NAME not configured")
    return storage.Client().bucket(bucket_name)


def _load_feature_pool() -> dict:
    bucket = _get_bucket()
    if bucket is None:
        raise RuntimeError("GCS not available")
    blob = bucket.blob("universal/feature_pool.json")
    if not blob.exists():
        raise RuntimeError("universal/feature_pool.json not found — run feature selection first")
    return json.loads(blob.download_as_text())


def analyze_sensitivity(
    weights: list[float] = None,
    top_k: int = 60,
) -> dict:
    """Compute how the top-K feature set changes across different icir_weight values.

    Returns:
        {
          baseline_w: float,
          rankings: {weight: [feature_names in rank order]},
          top_k_overlap: {weight: jaccard_vs_baseline},
          drop_in: {weight: [features that entered top_k]},
          drop_out: {weight: [features that left top_k]},
          recommended_w: float | None,
          recommended_reason: str,
        }
    """
    weights = weights or [0.0, 0.05, 0.1, 0.2, 0.3, 0.5]
    pool = _load_feature_pool()

    # feature_pool.json stores per-feature scores under different keys across versions
    # look for tp_scores + icir_values — try common structures
    tp_scores: dict[str, float] = {}
    icir_values: dict[str, float] = {}

    scored_list = pool.get("scored") or pool.get("scored_features") or []
    if isinstance(scored_list, list):
        for entry in scored_list:
            name = entry.get("name") or entry.get("feature")
            if not name:
                continue
            tp_scores[name] = float(entry.get("tp_score", entry.get("score", 0.0)))
            icir_values[name] = float(entry.get("icir", 0.0))

    if not tp_scores:
        # Fallback: pool may have only active list, no scores
        return {
            "error": "feature_pool.json lacks per-feature tp_score + icir fields; "
                     "sensitivity analysis unavailable. Re-run feature selection with "
                     "2026-04-18 pipeline to capture scores.",
            "active_features_current": pool.get("tree_active") or pool.get("active", []),
        }

    names_all = sorted(tp_scores.keys())

    rankings = {}
    topk_sets = {}
    for w in weights:
        scored = sorted(
            names_all,
            key=lambda n: -(tp_scores[n] + icir_values[n] * w),
        )
        rankings[str(w)] = scored
        topk_sets[str(w)] = set(scored[:top_k])

    baseline_w = 0.1 if 0.1 in weights else weights[len(weights) // 2]
    baseline_set = topk_sets[str(baseline_w)]

    overlap = {}
    drop_in = {}
    drop_out = {}
    for w in weights:
        s = topk_sets[str(w)]
        if w == baseline_w:
            overlap[str(w)] = 1.0
            drop_in[str(w)] = []
            drop_out[str(w)] = []
            continue
        inter = len(s & baseline_set)
        union = len(s | baseline_set)
        overlap[str(w)] = round(inter / union, 4) if union > 0 else 1.0
        drop_in[str(w)] = sorted(s - baseline_set)
        drop_out[str(w)] = sorted(baseline_set - s)

    # Recommendation heuristic:
    #   - If overlap[w] >= 0.95 across all → default is fine (stable set)
    #   - If overlap[0.0] < 0.80 → icir is meaningful, icir_weight matters
    #   - Suggest running fuller Optuna if cross-weight drift > 20%
    min_overlap = min(v for k, v in overlap.items() if k != str(baseline_w))
    if min_overlap >= 0.95:
        rec_w = baseline_w
        rec_reason = (
            f"Top-{top_k} overlap is ≥95% across w∈{weights}. "
            f"icir_weight is effectively inert for this feature pool; keep default {baseline_w}."
        )
    elif min_overlap >= 0.80:
        rec_w = baseline_w
        rec_reason = (
            f"Top-{top_k} overlap {min_overlap:.0%} at extreme weights. "
            f"Default {baseline_w} is reasonable; running full Optuna could yield +3-8% "
            f"marginal gain, weigh vs ~3 hr re-selection cost."
        )
    else:
        # suggest the weight whose top-k has highest avg (tp_score + icir*w)
        best_w = max(weights, key=lambda w: sum(
            tp_scores[n] + icir_values[n] * w for n in topk_sets[str(w)]
        ) / max(1, len(topk_sets[str(w)])))
        rec_w = best_w
        rec_reason = (
            f"Top-{top_k} overlap drops to {min_overlap:.0%} at extremes — "
            f"icir_weight materially changes selection. "
            f"Best average combined_score at w={best_w}. "
            f"Recommend full Optuna search over icir_weight ∈ [0.0, 0.5] "
            f"using downstream retrain IC as objective."
        )

    return {
        "baseline_w": baseline_w,
        "top_k": top_k,
        "n_features_total": len(tp_scores),
        "rankings_head": {k: v[:top_k] for k, v in rankings.items()},
        "top_k_overlap_vs_baseline": overlap,
        "drop_in": drop_in,
        "drop_out": drop_out,
        "recommended_w": rec_w,
        "recommended_reason": rec_reason,
    }


def persist_analysis(report: dict, path: str = "universal/icir_weight_sensitivity.json") -> bool:
    bucket = _get_bucket()
    if bucket is None:
        return False
    try:
        bucket.blob(path).upload_from_string(
            json.dumps(report, indent=2, ensure_ascii=False),
            content_type="application/json",
        )
        return True
    except Exception as e:
        logger.warning(f"persist_analysis failed: {e}")
        return False


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    report = analyze_sensitivity()
    print(json.dumps(report, indent=2, ensure_ascii=False))
    persist_analysis(report)
