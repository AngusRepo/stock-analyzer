"""Immutable prediction lineage for Active-8 purged walk-forward folds."""

from __future__ import annotations

import hashlib
import io
import json
from typing import Any

import numpy as np
from scipy.stats import spearmanr

from .sequence_training import SEQUENCE_RETURN_SEMANTIC_VERSION

OOF_PREDICTION_SCHEMA_VERSION = "active8-oof-predictions-v1"
OOF_TARGET_SEMANTIC_VERSION = SEQUENCE_RETURN_SEMANTIC_VERSION


def canonical_market_segment(value: Any) -> str:
    text = str(value or "").strip().upper()
    if text in {"TWSE", "LISTED", "TW_LISTED"}:
        return "LISTED"
    if text in {"TPEX", "OTC", "TPEx".upper(), "TW_OTC"}:
        return "OTC"
    if text in {"EMERGING", "TW_EMERGING"}:
        return "EMERGING"
    return text


def _clean_text_array(values: np.ndarray, *, name: str, expected: int) -> np.ndarray:
    array = np.asarray(values, dtype=object).reshape(-1)
    if len(array) != expected:
        raise ValueError(f"oof_{name}_length_mismatch")
    cleaned = np.asarray([str(value or "").strip() for value in array], dtype=object)
    if any(value in {"", "None", "nan", "NaT", "unknown", "model@unknown"} for value in cleaned):
        raise ValueError(f"oof_{name}_missing")
    return cleaned


def percentile_rank_by_date_market(
    raw_scores: np.ndarray,
    dates: np.ndarray,
    markets: np.ndarray,
) -> np.ndarray:
    scores = np.asarray(raw_scores, dtype=float).reshape(-1)
    dates_clean = np.asarray(dates, dtype=object).reshape(-1)
    markets_clean = np.asarray(markets, dtype=object).reshape(-1)
    if len(scores) != len(dates_clean) or len(scores) != len(markets_clean):
        raise ValueError("oof_score_date_market_length_mismatch")
    ranks = np.full(len(scores), np.nan, dtype=float)
    cohorts = sorted({(str(date), str(market)) for date, market in zip(dates_clean, markets_clean)})
    for date, market in cohorts:
        idx = np.flatnonzero(np.asarray([
            str(row_date) == date and str(row_market) == market
            for row_date, row_market in zip(dates_clean, markets_clean)
        ]))
        finite_idx = idx[np.isfinite(scores[idx])]
        if not len(finite_idx):
            continue
        order = np.argsort(scores[finite_idx], kind="mergesort")
        sorted_idx = finite_idx[order]
        if len(sorted_idx) == 1:
            ranks[sorted_idx] = 0.5
        else:
            ranks[sorted_idx] = np.arange(len(sorted_idx), dtype=float) / (len(sorted_idx) - 1)
    return ranks


def oof_date_cluster_rank_ic_from_bytes(payload: bytes, *, min_cohort_rows: int = 10) -> dict[str, Any]:
    """Build trading-date clusters from immutable OOF scores and outcomes."""
    artifact = np.load(io.BytesIO(payload), allow_pickle=True)
    rank_scores = np.asarray(artifact["rank_scores"], dtype=float).reshape(-1)
    targets = np.asarray(artifact["targets"], dtype=float).reshape(-1)
    dates = np.asarray(artifact["dates"], dtype=object).reshape(-1)
    markets = np.asarray(artifact["markets"], dtype=object).reshape(-1)
    if not (len(rank_scores) == len(targets) == len(dates) == len(markets)):
        raise ValueError("oof_date_cluster_length_mismatch")
    date_rows: list[dict[str, Any]] = []
    for date in sorted({str(value) for value in dates}):
        segment_rows: list[tuple[float, int]] = []
        for market in sorted({str(markets[idx]) for idx in np.flatnonzero(dates == date)}):
            idx = np.flatnonzero((dates == date) & (markets == market))
            finite = idx[np.isfinite(rank_scores[idx]) & np.isfinite(targets[idx])]
            if len(finite) < max(3, int(min_cohort_rows)):
                continue
            rho, _ = spearmanr(rank_scores[finite], targets[finite])
            if np.isfinite(rho):
                segment_rows.append((float(rho), int(len(finite))))
        if not segment_rows:
            continue
        total_rows = sum(rows for _ic, rows in segment_rows)
        date_rows.append({
            "date": date,
            "rank_ic": sum(ic * rows for ic, rows in segment_rows) / total_rows,
            "test_rows": total_rows,
            "segments": len(segment_rows),
        })
    return {
        "schema_version": "oof-date-cluster-rank-ic-v1",
        "date_cluster_ics": date_rows,
        "date_cluster_count": len(date_rows),
        "min_cohort_rows": max(3, int(min_cohort_rows)),
    }


def _verify_existing_oof_payload(
    payload: bytes,
    *,
    expected_metadata: dict[str, Any],
    raw_scores: np.ndarray,
    rank_scores: np.ndarray,
    targets: np.ndarray,
    dates: np.ndarray,
    symbols: np.ndarray,
    markets: np.ndarray,
    label_known_dates: np.ndarray,
) -> None:
    try:
        artifact = np.load(io.BytesIO(payload), allow_pickle=True)
        existing_metadata = json.loads(str(artifact["metadata"].item()))
        if existing_metadata != expected_metadata:
            raise ValueError("metadata")
        expected_arrays = {
            "raw_scores": raw_scores,
            "rank_scores": rank_scores,
            "targets": targets,
            "dates": dates,
            "symbols": symbols,
            "markets": markets,
            "label_known_dates": label_known_dates,
        }
        for name, expected in expected_arrays.items():
            if name not in artifact.files:
                raise ValueError(name)
            observed_array = np.asarray(artifact[name])
            expected_array = np.asarray(expected)
            numeric = (
                np.issubdtype(observed_array.dtype, np.number)
                and np.issubdtype(expected_array.dtype, np.number)
            )
            equal = np.array_equal(
                observed_array,
                expected_array,
                equal_nan=True,
            ) if numeric else np.array_equal(observed_array, expected_array)
            if not equal:
                raise ValueError(name)
    except Exception as exc:
        raise ValueError("oof_prediction_artifact_immutable_conflict") from exc


def save_oof_prediction_artifact(
    *,
    bucket: Any,
    gcs_prefix: str,
    cohort_id: str,
    fold_id: str,
    model_name: str,
    artifact_version: str,
    raw_scores: np.ndarray,
    targets: np.ndarray,
    dates: np.ndarray,
    symbols: np.ndarray,
    markets: np.ndarray,
    label_known_dates: np.ndarray,
    split_metadata: dict[str, Any],
    target_semantic_version: str = OOF_TARGET_SEMANTIC_VERSION,
    generation_mode: str = "purged_oof",
) -> dict[str, Any]:
    raw = np.asarray(raw_scores, dtype=float).reshape(-1)
    target = np.asarray(targets, dtype=float).reshape(-1)
    if len(raw) != len(target) or not len(raw):
        raise ValueError("oof_prediction_target_length_mismatch")
    date_values = _clean_text_array(dates, name="dates", expected=len(raw))
    symbol_values = _clean_text_array(symbols, name="symbols", expected=len(raw))
    market_values = np.asarray([
        canonical_market_segment(value)
        for value in _clean_text_array(markets, name="markets", expected=len(raw))
    ], dtype=object)
    if any(value in {"", "TW", "TW_LISTED_OTC"} for value in market_values):
        raise ValueError("oof_market_segment_ambiguous")
    known_values = _clean_text_array(
        label_known_dates,
        name="label_known_dates",
        expected=len(raw),
    )
    if any(known <= date for known, date in zip(known_values, date_values)):
        raise ValueError("oof_label_known_date_not_after_signal_date")
    if not cohort_id or not fold_id or not artifact_version:
        raise ValueError("oof_cohort_fold_or_artifact_version_missing")
    if target_semantic_version != OOF_TARGET_SEMANTIC_VERSION:
        raise ValueError("oof_target_semantic_mismatch")
    if generation_mode not in {"purged_oof", "frozen_forward_oos"}:
        raise ValueError("oof_generation_mode_invalid")

    rank = percentile_rank_by_date_market(raw, date_values, market_values)
    if not np.isfinite(rank).all() or not np.isfinite(target).all():
        raise ValueError("oof_non_finite_prediction_or_target")
    metadata = {
        "schema_version": OOF_PREDICTION_SCHEMA_VERSION,
        "generation_mode": generation_mode,
        "cohort_id": cohort_id,
        "fold_id": fold_id,
        "model_name": model_name,
        "artifact_version": artifact_version,
        "target_semantic_version": target_semantic_version,
        "score_semantic": "same-market-same-date-percentile-rank-v1",
        "rows": int(len(raw)),
        "dates": int(len(set(date_values.tolist()))),
        "split_metadata": split_metadata,
    }
    metadata_bytes = json.dumps(metadata, sort_keys=True, separators=(",", ":")).encode("utf-8")
    metadata["contract_checksum"] = hashlib.sha256(metadata_bytes).hexdigest()

    buffer = io.BytesIO()
    np.savez_compressed(
        buffer,
        metadata=np.asarray(json.dumps(metadata, sort_keys=True)),
        raw_scores=raw,
        rank_scores=rank,
        targets=target,
        dates=date_values,
        symbols=symbol_values,
        markets=market_values,
        label_known_dates=known_values,
    )
    payload = buffer.getvalue()
    path = (
        f"{gcs_prefix.rstrip('/')}/oof/{cohort_id}/{fold_id}/"
        f"{model_name.lower()}.npz"
    )
    blob = bucket.blob(path)

    def existing_result() -> dict[str, Any]:
        existing_payload = blob.download_as_bytes()
        _verify_existing_oof_payload(
            existing_payload,
            expected_metadata=metadata,
            raw_scores=raw,
            rank_scores=rank,
            targets=target,
            dates=date_values,
            symbols=symbol_values,
            markets=market_values,
            label_known_dates=known_values,
        )
        return {
            **metadata,
            "path": path,
            "payload_checksum": hashlib.sha256(existing_payload).hexdigest(),
            "idempotent_existing": True,
        }

    if blob.exists():
        return existing_result()
    try:
        blob.upload_from_string(
            payload,
            content_type="application/octet-stream",
            if_generation_match=0,
        )
    except Exception:
        if blob.exists():
            return existing_result()
        raise
    return {
        **metadata,
        "path": path,
        "payload_checksum": hashlib.sha256(payload).hexdigest(),
        "idempotent_existing": False,
    }
