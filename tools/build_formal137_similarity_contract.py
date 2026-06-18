from __future__ import annotations

import csv
import json
import math
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
REGISTRY = ROOT / "data" / "feature_registry" / "unified_feature_registry_v1.json"
PAIRWISE = ROOT / "output" / "feature_universe_triage" / "unified179_pairwise_similarity_long_20260617.csv"
BACKTEST = ROOT / "output" / "feature_universe_triage" / "unified179_feature_backtest_report_20260617.csv"
OUT_DIR = ROOT / "output" / "feature_universe_triage"
REGISTRY_DIR = ROOT / "data" / "feature_registry"


def _rel(path: Path) -> str:
    return path.resolve().relative_to(ROOT.resolve()).as_posix()


def _read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


def _write_csv(rows: list[dict[str, Any]], path: Path) -> None:
    fields = list(rows[0].keys()) if rows else []
    with path.open("w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def _num(value: Any, default: float | None = None) -> float | None:
    if value in (None, ""):
        return default
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    return out if math.isfinite(out) else default


def _quality_score(metric: dict[str, Any] | None, selector_role: str) -> float:
    if not metric:
        base = 0.0
    else:
        sharpe = _num(metric.get("monthly_sharpe"), 0.0) or 0.0
        cagr = _num(metric.get("cagr"), 0.0) or 0.0
        mdd = abs(_num(metric.get("max_drawdown"), 0.35) or 0.35)
        abs_ic = abs(_num(metric.get("mean_ic_5d"), 0.0) or 0.0)
        coverage = _num(metric.get("coverage"), 0.0) or 0.0
        base = (
            max(0.0, min(1.0, (sharpe + 0.25) / 1.75)) * 0.30
            + max(0.0, min(1.0, (cagr + 0.05) / 0.55)) * 0.25
            + max(0.0, min(1.0, 1.0 - max(0.0, mdd - 0.10) / 0.35)) * 0.20
            + max(0.0, min(1.0, abs_ic / 0.04)) * 0.15
            + max(0.0, min(1.0, coverage)) * 0.10
        )
    role_bonus = 0.04 if selector_role == "core_prior" else 0.0
    return round(base + role_bonus, 6)


def _duplicate_level(corr: float | None) -> str:
    if corr is None:
        return "similarity_refresh_required"
    if corr >= 0.8:
        return "high_duplicate"
    if corr >= 0.4:
        return "related_cluster"
    return "independent_candidate"


def _union_find(nodes: list[str], pairs: list[dict[str, Any]], threshold: float) -> dict[str, int]:
    parent = {node: node for node in nodes}

    def find(node: str) -> str:
        while parent[node] != node:
            parent[node] = parent[parent[node]]
            node = parent[node]
        return node

    def union(a: str, b: str) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for row in pairs:
        corr = _num(row.get("abs_rank_corr"), 0.0) or 0.0
        if corr >= threshold:
            union(str(row["feature_a"]), str(row["feature_b"]))

    groups: dict[str, list[str]] = defaultdict(list)
    for node in nodes:
        groups[find(node)].append(node)

    out: dict[str, int] = {}
    for idx, group in enumerate(sorted(groups.values(), key=lambda g: (-len(g), sorted(g)[0])), start=1):
        for node in group:
            out[node] = idx
    return out


def _component_leaders(
    component_by_feature: dict[str, int],
    feature_ids: list[str],
    quality: dict[str, float],
) -> dict[int, str]:
    members: dict[int, list[str]] = defaultdict(list)
    for fid in feature_ids:
        members[component_by_feature[fid]].append(fid)
    return {
        cid: sorted(group, key=lambda fid: (-quality.get(fid, 0.0), fid))[0]
        for cid, group in members.items()
    }


def main() -> int:
    registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
    features = [
        row
        for row in registry.get("features", [])
        if isinstance(row, dict) and row.get("eligible_for_alpha_mining")
    ]
    feature_ids = sorted(str(row["feature_id"]) for row in features)
    feature_set = set(feature_ids)
    meta = {str(row["feature_id"]): row for row in features}
    metrics = {row["feature_id"]: row for row in _read_csv(BACKTEST)}

    pair_rows_all = _read_csv(PAIRWISE)
    pair_rows = [
        row for row in pair_rows_all
        if row.get("feature_a") in feature_set and row.get("feature_b") in feature_set
    ]
    pair_features = {
        fid
        for row in pair_rows
        for fid in [str(row.get("feature_a") or ""), str(row.get("feature_b") or "")]
        if fid
    }
    features_without_pairwise = sorted(feature_set - pair_features)

    nearest: dict[str, dict[str, Any]] = {}
    for row in pair_rows:
        corr = _num(row.get("abs_rank_corr"), 0.0) or 0.0
        for side, peer_side in (("feature_a", "feature_b"), ("feature_b", "feature_a")):
            fid = str(row[side])
            if fid not in nearest or corr > (_num(nearest[fid].get("nearest_abs_rank_corr"), 0.0) or 0.0):
                nearest[fid] = {
                    "nearest_feature": row[peer_side],
                    "nearest_abs_rank_corr": corr,
                    "nearest_rank_corr": _num(row.get("rank_corr")),
                }

    high_component = _union_find(feature_ids, pair_rows, 0.8)
    related_component = _union_find(feature_ids, pair_rows, 0.4)
    quality = {
        fid: _quality_score(metrics.get(fid), str(meta[fid].get("selector_role") or ""))
        for fid in feature_ids
    }
    high_leaders = _component_leaders(high_component, feature_ids, quality)
    related_leaders = _component_leaders(related_component, feature_ids, quality)

    rows: list[dict[str, Any]] = []
    for fid in feature_ids:
        row_meta = meta[fid]
        metric = metrics.get(fid, {})
        near = nearest.get(fid, {})
        nearest_corr = _num(near.get("nearest_abs_rank_corr"))
        high_cid = high_component[fid]
        related_cid = related_component[fid]
        rows.append({
            "feature_id": fid,
            "origin_pool": row_meta.get("origin_pool"),
            "category": row_meta.get("category"),
            "selector_role": row_meta.get("selector_role"),
            "recommended_status": row_meta.get("recommended_status"),
            "materializer_status": row_meta.get("materializer_status"),
            "quality_score": quality[fid],
            "monthly_sharpe": _num(metric.get("monthly_sharpe")),
            "cagr": _num(metric.get("cagr")),
            "max_drawdown": _num(metric.get("max_drawdown")),
            "mean_ic_5d": _num(metric.get("mean_ic_5d")),
            "coverage": _num(metric.get("coverage")),
            "nearest_feature": near.get("nearest_feature"),
            "nearest_abs_rank_corr": nearest_corr,
            "nearest_rank_corr": near.get("nearest_rank_corr"),
            "duplicate_level": _duplicate_level(nearest_corr),
            "high_duplicate_cluster_id": high_cid,
            "high_duplicate_cluster_leader": high_leaders[high_cid],
            "related_cluster_id": related_cid,
            "related_cluster_leader": related_leaders[related_cid],
            "preferred_feature_id": high_leaders[high_cid],
            "similarity_status": "refresh_required" if fid in features_without_pairwise else "measured",
        })

    rows.sort(key=lambda row: (row["selector_role"], row["category"] or "", row["feature_id"]))

    duplicate_counts = Counter(row["duplicate_level"] for row in rows)
    role_counts = Counter(row["selector_role"] for row in rows)
    high_cluster_sizes = Counter(row["high_duplicate_cluster_id"] for row in rows)
    related_cluster_sizes = Counter(row["related_cluster_id"] for row in rows)
    high_clusters = {
        str(cid): {
            "size": size,
            "leader": high_leaders[cid],
            "members": sorted(row["feature_id"] for row in rows if row["high_duplicate_cluster_id"] == cid),
        }
        for cid, size in high_cluster_sizes.items()
        if size >= 2
    }
    related_clusters = {
        str(cid): {
            "size": size,
            "leader": related_leaders[cid],
            "members": sorted(row["feature_id"] for row in rows if row["related_cluster_id"] == cid),
        }
        for cid, size in related_cluster_sizes.items()
        if size >= 2
    }

    summary = {
        "schema_version": "stockvision-formal137-similarity-contract-v1",
        "policy": {
            "formal_pool": "137 = 69 core_prior + 68 evidence_watch",
            "duplicate_levels": {
                "high_duplicate": "nearest abs rank corr >= 0.8",
                "related_cluster": "0.4 <= nearest abs rank corr < 0.8",
                "independent_candidate": "nearest abs rank corr < 0.4",
                "similarity_refresh_required": "feature is in formal pool but not present in the pairwise source artifact",
            },
            "effect": "metadata_only; no selector or top-k behavior change",
        },
        "source_files": {
            "registry": _rel(REGISTRY),
            "pairwise_long": _rel(PAIRWISE),
            "backtest_report": _rel(BACKTEST),
        },
        "counts": {
            "formal_features": len(feature_ids),
            "pair_rows": len(pair_rows),
            "pairwise_feature_coverage": len(feature_set - set(features_without_pairwise)),
            "similarity_refresh_required": len(features_without_pairwise),
            "high_duplicate_clusters_size_ge_2": len(high_clusters),
            "related_clusters_size_ge_2": len(related_clusters),
        },
        "selector_role_counts": dict(role_counts),
        "duplicate_level_counts": dict(duplicate_counts),
        "features_without_pairwise": features_without_pairwise,
        "high_duplicate_clusters": high_clusters,
        "related_clusters": related_clusters,
    }

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    REGISTRY_DIR.mkdir(parents=True, exist_ok=True)
    csv_path = OUT_DIR / "formal137_feature_similarity_contract_20260617.csv"
    pairs_path = OUT_DIR / "formal137_pairwise_similarity_long_20260617.csv"
    json_path = REGISTRY_DIR / "formal137_similarity_contract_v1.json"
    _write_csv(rows, csv_path)
    _write_csv(pair_rows, pairs_path)
    json_path.write_text(json.dumps({**summary, "features": rows}, ensure_ascii=False, indent=2), encoding="utf-8")

    print(json.dumps({
        "json": str(json_path),
        "csv": str(csv_path),
        "pairs_csv": str(pairs_path),
        "counts": summary["counts"],
        "selector_role_counts": summary["selector_role_counts"],
        "duplicate_level_counts": summary["duplicate_level_counts"],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
