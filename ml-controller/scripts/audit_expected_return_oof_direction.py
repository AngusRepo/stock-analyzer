"""Recompute L4/L4+ OOF direction and lineage from immutable local artifacts."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

import numpy as np
from scipy.stats import spearmanr

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml-controller"))

from services.active8_oof_cohort_materializer import build_fusion_oof_rows  # noqa: E402
from services.allocator_ev_fusion_artifact_builder import (  # noqa: E402
    _predict as predict_fusion_residual,
    _samples as fusion_samples,
)
from services.expected_return_artifact_identity import (  # noqa: E402
    expected_return_artifact_identity,
)
from services.l4_alpha_ev_artifact_builder import _samples as l4_samples  # noqa: E402


def _sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _mean(values: list[float]) -> float | None:
    return float(np.mean(values)) if values else None


def _corr(values: list[float], targets: list[float]) -> float | None:
    if len(values) < 3 or len(values) != len(targets):
        return None
    if np.std(values) <= 1e-12 or np.std(targets) <= 1e-12:
        return None
    result = float(np.corrcoef(values, targets)[0, 1])
    return result if math.isfinite(result) else None


def _spearman(values: list[float], targets: list[float]) -> float | None:
    if len(values) < 3 or len(values) != len(targets):
        return None
    if np.std(values) <= 1e-12 or np.std(targets) <= 1e-12:
        return None
    result = float(spearmanr(values, targets).statistic)
    return result if math.isfinite(result) else None


def _spread(values: list[float], targets: list[float]) -> float | None:
    if len(values) < 5 or len(values) != len(targets):
        return None
    ordered = sorted(zip(values, targets, strict=True), key=lambda pair: pair[0])
    bucket = max(1, len(ordered) // 5)
    return float(np.mean([target for _, target in ordered[-bucket:]])) - float(
        np.mean([target for _, target in ordered[:bucket]])
    )


def _group_metrics(
    rows: list[tuple[str, str, float, float]],
) -> dict[str, Any]:
    by_date_market: dict[tuple[str, str], list[tuple[float, float]]] = defaultdict(list)
    for date, market, value, target in rows:
        by_date_market[(date, market)].append((value, target))
    daily: dict[str, list[tuple[float, float]]] = defaultdict(list)
    group_rows: list[dict[str, Any]] = []
    for (date, market), pairs in sorted(by_date_market.items()):
        values = [pair[0] for pair in pairs]
        targets = [pair[1] for pair in pairs]
        pearson = _corr(values, targets)
        rank_ic = _spearman(values, targets)
        spread = _spread(values, targets)
        group_rows.append({
            "date": date,
            "market": market,
            "samples": len(pairs),
            "pearson": pearson,
            "spearman": rank_ic,
            "top_bottom_spread": spread,
        })
        if rank_ic is not None and spread is not None:
            daily[date].append((rank_ic, spread))
    date_rows = [
        {
            "date": date,
            "spearman": float(np.mean([value[0] for value in values])),
            "top_bottom_spread": float(np.mean([value[1] for value in values])),
        }
        for date, values in sorted(daily.items())
    ]
    pooled_values = [row[2] for row in rows]
    pooled_targets = [row[3] for row in rows]
    return {
        "samples": len(rows),
        "date_market_groups": len(group_rows),
        "date_count": len(date_rows),
        "pooled_pearson": _corr(pooled_values, pooled_targets),
        "pooled_spearman": _spearman(pooled_values, pooled_targets),
        "equal_date_market_spearman": _mean([row["spearman"] for row in date_rows]),
        "equal_date_market_top_bottom_spread": _mean(
            [row["top_bottom_spread"] for row in date_rows]
        ),
        "positive_ic_dates": sum(row["spearman"] > 0 for row in date_rows),
        "positive_spread_dates": sum(row["top_bottom_spread"] > 0 for row in date_rows),
        "by_date": date_rows,
    }


def _load_indexed_artifact(path: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    raw = path.read_bytes()
    expected_checksum = path.name.split(".", 1)[0].lower()
    if _sha256(raw) != expected_checksum:
        raise ValueError(f"artifact_checksum_mismatch:{path.name}")
    lines = gzip.decompress(raw).decode("utf-8").splitlines()
    if not lines:
        raise ValueError(f"artifact_empty:{path.name}")
    metadata = json.loads(lines[0]).get("_metadata") or {}
    rows = [json.loads(line) for line in lines[1:]]
    kind = str(metadata.get("artifact_kind") or "")
    date_field = {
        "allocator_ev_snapshots": "snapshot_date",
        "l4_predictions": "prediction_date",
    }.get(kind)
    if not date_field:
        raise ValueError(f"artifact_kind_invalid:{kind}")
    dates = sorted({str(row.get(date_field) or "")[:10] for row in rows})
    date_checksum = _sha256("\n".join(dates).encode("utf-8"))
    if (
        len(rows) != int(metadata.get("row_count") or -1)
        or len(dates) != int(metadata.get("date_count") or -1)
        or (dates[0] if dates else None) != metadata.get("min_date")
        or (dates[-1] if dates else None) != metadata.get("max_date")
        or date_checksum != metadata.get("date_set_checksum")
        or any(str(row.get("cohort_id") or "") != metadata.get("cohort_id") for row in rows)
    ):
        raise ValueError(f"artifact_metadata_or_row_contract_mismatch:{path.name}")
    return metadata, rows


def _load_candidate_packets(directory: Path) -> dict[str, dict[str, Any]]:
    packets: dict[str, dict[str, Any]] = {}
    for path in directory.glob("*.json"):
        if path.name == "manifest.json":
            continue
        raw = path.read_bytes()
        if _sha256(raw) != path.stem.lower():
            raise ValueError(f"candidate_packet_checksum_mismatch:{path.name}")
        packet = json.loads(raw)
        artifact = packet.get("artifact") or {}
        identity = expected_return_artifact_identity(artifact)
        if artifact.get("model_fingerprint") != identity["model_fingerprint"]:
            raise ValueError(f"candidate_model_fingerprint_mismatch:{path.name}")
        owner = str(artifact.get("expected_return_owner") or "")
        packets[owner] = {**packet, "packet_checksum": path.stem.lower()}
    if set(packets) != {"l4_alpha_ev", "allocator_ev_fusion"}:
        raise ValueError("candidate_pair_missing")
    return packets


def audit(directory: Path) -> dict[str, Any]:
    indexed: dict[str, tuple[dict[str, Any], list[dict[str, Any]]]] = {}
    for path in directory.glob("*.jsonl.gz"):
        metadata, rows = _load_indexed_artifact(path)
        indexed[str(metadata["artifact_kind"])] = (metadata, rows)
    if set(indexed) != {"allocator_ev_snapshots", "l4_predictions"}:
        raise ValueError("indexed_oof_artifact_pair_missing")
    snapshot_metadata, snapshot_rows = indexed["allocator_ev_snapshots"]
    l4_metadata, prediction_rows = indexed["l4_predictions"]
    if (
        snapshot_metadata["cohort_id"] != l4_metadata["cohort_id"]
        or snapshot_metadata["source_manifest_checksum"]
        != l4_metadata["source_manifest_checksum"]
    ):
        raise ValueError("indexed_oof_lineage_pair_mismatch")

    samples, sample_audit = l4_samples(snapshot_rows)
    target_by_key: dict[tuple[str, str, str, str], dict[str, Any]] = {}
    duplicate_snapshot_keys = 0
    for sample in samples:
        source = sample["source_row"]
        key = (
            str(source.get("fold_id") or ""),
            str(sample["date"]),
            str(sample.get("symbol") or ""),
            str(source.get("market_segment") or "UNKNOWN"),
        )
        if key in target_by_key:
            duplicate_snapshot_keys += 1
        target_by_key[key] = sample
    if duplicate_snapshot_keys:
        raise ValueError(f"duplicate_snapshot_identity:{duplicate_snapshot_keys}")

    prediction_keys: set[tuple[str, str, str, str]] = set()
    joined: list[tuple[str, str, float, float]] = []
    lineage_errors: defaultdict[str, int] = defaultdict(int)
    for row in prediction_rows:
        key = (
            str(row.get("fold_id") or ""),
            str(row.get("prediction_date") or "")[:10],
            str(row.get("symbol") or ""),
            str(row.get("market_segment") or "UNKNOWN"),
        )
        if key in prediction_keys:
            lineage_errors["duplicate_prediction_identity"] += 1
        prediction_keys.add(key)
        prediction_date = key[1]
        trained_until = str(row.get("trained_until") or "")[:10]
        payload = json.loads(row.get("prediction_json") or "{}")
        pit = payload.get("point_in_time_prediction_lineage") or {}
        if not trained_until or trained_until >= prediction_date:
            lineage_errors["trained_until_not_before_prediction"] += 1
        if (
            str(pit.get("prediction_date") or "")[:10] != prediction_date
            or str(pit.get("trained_until") or "")[:10] != trained_until
            or pit.get("source_manifest_checksum")
            != snapshot_metadata["source_manifest_checksum"]
        ):
            lineage_errors["prediction_payload_lineage_mismatch"] += 1
        sample = target_by_key.get(key)
        if sample is None:
            lineage_errors["prediction_target_join_missing"] += 1
            continue
        joined.append((
            prediction_date,
            key[3],
            float(row["expected_return"]),
            float(sample["target"]),
        ))

    feature_metrics = {
        feature: _group_metrics([
            (
                str(sample["date"]),
                str(sample["source_row"].get("market_segment") or "UNKNOWN"),
                float(sample["features"][feature]),
                float(sample["target"]),
            )
            for sample in samples
        ])
        for feature in samples[0]["features"] if samples
    }

    packets = _load_candidate_packets(directory)
    fusion_rows = build_fusion_oof_rows(
        snapshot_rows,
        prediction_rows,
        knowledge_cutoff_date="9999-12-31",
        query_fn=lambda _sql, _params: [],
    )
    fusion_sample_rows, fusion_sample_audit = fusion_samples(
        fusion_rows,
        execution_cost_bps=18.0,
    )
    fusion_artifact = packets["allocator_ev_fusion"]["artifact"]
    residual = fusion_artifact.get("residual_adjustment_model") or {}
    residual_intercept = float(residual.get("intercept") or 0.0)
    residual_coefficients = {
        str(key): float(value)
        for key, value in (residual.get("coefficients") or {}).items()
    }
    residual_clip = fusion_artifact.get("residual_output_clip") or {}
    clip_min = float(residual_clip.get("min") or -0.02)
    clip_max = float(residual_clip.get("max") or 0.02)
    fusion_joined = []
    for sample in fusion_sample_rows:
        base = float(sample["features"]["l4_expected_return"])
        residual_value = predict_fusion_residual(
            sample,
            residual_intercept,
            residual_coefficients,
        )
        expected_return = base + min(clip_max, max(clip_min, residual_value))
        fusion_joined.append((
            str(sample["date"]),
            str(sample.get("market_segment") or "UNKNOWN"),
            expected_return,
            float(sample["actual_return_target"]),
        ))

    candidate_summary = {}
    for owner, packet in packets.items():
        artifact = packet["artifact"]
        validation = packet.get("validation_packet") or {}
        coefficients = (
            artifact.get("coefficients")
            if owner == "l4_alpha_ev"
            else (artifact.get("residual_adjustment_model") or {}).get("coefficients")
        ) or {}
        candidate_summary[owner] = {
            "model_version": artifact.get("model_version"),
            "model_fingerprint": artifact.get("model_fingerprint"),
            "packet_checksum": packet["packet_checksum"],
            "decision": validation.get("decision"),
            "failed_gates": validation.get("failed_gates") or [],
            "negative_coefficients": {
                name: value for name, value in coefficients.items() if float(value) < 0.0
            },
            "nonzero_coefficients": sum(abs(float(value)) > 1e-12 for value in coefficients.values()),
            "oos_metrics": validation.get("oos_metrics"),
            "sample_audit": validation.get("sample_audit"),
        }

    l4_metrics = _group_metrics(joined)
    fusion_metrics = _group_metrics(fusion_joined)
    return {
        "schema_version": "expected-return-oof-direction-audit-v1",
        "status": "PASS" if not lineage_errors else "FAIL",
        "direction_semantic": "higher_prediction_selects_higher_net_executable_return",
        "source": {
            "cohort_id": snapshot_metadata["cohort_id"],
            "source_manifest_checksum": snapshot_metadata["source_manifest_checksum"],
            "snapshot_rows": len(snapshot_rows),
            "snapshot_dates": snapshot_metadata["date_count"],
            "l4_prediction_rows": len(prediction_rows),
            "l4_prediction_dates": l4_metadata["date_count"],
        },
        "lineage": {
            "errors": dict(sorted(lineage_errors.items())),
            "joined_prediction_rows": len(joined),
            "unmatched_eligible_snapshot_rows": len(target_by_key) - len(joined),
            "l4_sample_audit": sample_audit,
            "fusion_sample_audit": fusion_sample_audit,
        },
        "l4_chronological_oof": l4_metrics,
        "l4_feature_direction": feature_metrics,
        "fusion_candidate_exact_replay": fusion_metrics,
        "candidates": candidate_summary,
        "conclusion": {
            "join_or_pit_direction_bug_detected": bool(lineage_errors),
            "l4_quality_positive": bool(
                (l4_metrics["equal_date_market_spearman"] or 0.0) > 0.0
                and (l4_metrics["equal_date_market_top_bottom_spread"] or 0.0) > 0.0
            ),
            "fusion_residual_nonzero": candidate_summary[
                "allocator_ev_fusion"
            ]["nonzero_coefficients"] > 0,
            "promotion_bypass_detected": any(
                summary["decision"] == "PASS" and summary["failed_gates"]
                for summary in candidate_summary.values()
            ),
        },
    }


def compact_summary(result: dict[str, Any]) -> dict[str, Any]:
    def metrics(value: dict[str, Any]) -> dict[str, Any]:
        return {key: item for key, item in value.items() if key != "by_date"}

    return {
        "schema_version": result["schema_version"],
        "status": result["status"],
        "direction_semantic": result["direction_semantic"],
        "source": result["source"],
        "lineage": result["lineage"],
        "l4_chronological_oof": metrics(result["l4_chronological_oof"]),
        "l4_feature_direction": {
            feature: metrics(value)
            for feature, value in result["l4_feature_direction"].items()
        },
        "fusion_candidate_exact_replay": metrics(
            result["fusion_candidate_exact_replay"]
        ),
        "candidates": {
            owner: {
                key: value
                for key, value in candidate.items()
                if key not in {"oos_metrics", "sample_audit"}
            }
            for owner, candidate in result["candidates"].items()
        },
        "conclusion": result["conclusion"],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("artifact_dir", type=Path)
    parser.add_argument("--pretty", action="store_true")
    parser.add_argument("--summary", action="store_true")
    args = parser.parse_args()
    result = audit(args.artifact_dir.resolve())
    print(json.dumps(
        compact_summary(result) if args.summary else result,
        ensure_ascii=False,
        indent=2 if args.pretty else None,
        sort_keys=True,
        allow_nan=False,
    ))


if __name__ == "__main__":
    main()
