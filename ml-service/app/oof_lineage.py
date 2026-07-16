"""Immutable prediction lineage for Active-8 purged walk-forward folds."""

from __future__ import annotations

import hashlib
import io
import json
from typing import Any

import numpy as np

OOF_PREDICTION_SCHEMA_VERSION = "active8-oof-predictions-v1"
OOF_TARGET_SEMANTIC_VERSION = "next-session-open-to-fifth-session-close-v2"


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
) -> dict[str, Any]:
    raw = np.asarray(raw_scores, dtype=float).reshape(-1)
    target = np.asarray(targets, dtype=float).reshape(-1)
    if len(raw) != len(target) or not len(raw):
        raise ValueError("oof_prediction_target_length_mismatch")
    date_values = _clean_text_array(dates, name="dates", expected=len(raw))
    symbol_values = _clean_text_array(symbols, name="symbols", expected=len(raw))
    market_values = _clean_text_array(markets, name="markets", expected=len(raw))
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

    rank = percentile_rank_by_date_market(raw, date_values, market_values)
    if not np.isfinite(rank).all() or not np.isfinite(target).all():
        raise ValueError("oof_non_finite_prediction_or_target")
    metadata = {
        "schema_version": OOF_PREDICTION_SCHEMA_VERSION,
        "generation_mode": "purged_oof",
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
    bucket.blob(path).upload_from_string(payload, content_type="application/octet-stream")
    return {
        **metadata,
        "path": path,
        "payload_checksum": hashlib.sha256(payload).hexdigest(),
    }
