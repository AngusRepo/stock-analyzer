"""NeuralForecast-backed sequence artifact runtime for PatchTST/iTransformer."""

from __future__ import annotations

import hashlib
import io
import json
import logging
import os
import shutil
import tempfile
import time
import warnings
import zipfile
from bisect import bisect_right
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np

from .model_store import _get_bucket
from .prep_lineage import (
    attach_prep_lineage_aliases,
    collect_prep_lineage,
    validate_prep_lineage_for_registration,
)
from .training_promotion_policy import resolve_training_promotion_intent
from .research_benchmarks.common import cpcv_proxy_pbo, data_slice_report, direction_accuracy, load_sequence_dataset, rank_ic
from .sequence_training import (
    CANONICAL_ROUNDTRIP_COST_BPS,
    SEQUENCE_RETURN_SEMANTIC_VERSION,
    build_sequence_window_dataset,
    canonical_session_calendar,
)
from .model_validation import build_model_cpcv_evidence
from .oof_lineage import date_market_rank_ic_evidence
from .artifact_contract import ArtifactValidationError, verify_artifact_bytes
from .training_reproducibility import configure_training_reproducibility
from .training_policy import (
    build_model_feature_policy_metadata,
    build_model_training_config_attestation,
)

logger = logging.getLogger(__name__)

DEFAULT_SEQ_LEN = 512
DEFAULT_PRED_LEN = 5
DEFAULT_MAX_STEPS = 30
DEFAULT_BATCH_SIZE = 128
DEFAULT_MAX_SERIES = 1024
DEFAULT_BATCH_COUNT = 5
OOF_MIN_PANEL_OBSERVED_RATIO = 0.95
_RUNTIME_CONFIGURED = False
MODEL_CONFIG: dict[str, dict[str, str]] = {
    "PatchTST": {
        "nf_model_name": "PatchTST",
        "gcs_prefix": "universal/patchtst",
        "artifact_schema": "neuralforecast_patchtst_universal_v1",
        "model_type": "time_series_transformer_neuralforecast_patchtst",
        "default_seq_len": "512",
    },
    "iTransformer": {
        "nf_model_name": "iTransformer",
        "gcs_prefix": "universal/itransformer",
        "artifact_schema": "neuralforecast_itransformer_universal_v1",
        "model_type": "time_series_transformer_neuralforecast_itransformer",
        "default_seq_len": "512",
    },
}

NF_MODEL_DEFAULTS: dict[str, dict[str, Any]] = {
    "PatchTST": {
        "learning_rate": 1e-4,
        "windows_batch_size": 1024,
        "inference_windows_batch_size": 1024,
        "scaler_type": "identity",
        "step_size": 1,
        "patch_len": 16,
        "stride": 8,
        "revin": True,
    },
    "iTransformer": {
        "learning_rate": 1e-3,
        "windows_batch_size": 32,
        "inference_windows_batch_size": 32,
        "scaler_type": "identity",
        "step_size": 1,
    },
}


def _resolve_nf_training_options(payload: dict[str, Any], model_name: str) -> dict[str, Any]:
    defaults = dict(NF_MODEL_DEFAULTS[model_name])
    for key, caster in (
        ("learning_rate", float),
        ("windows_batch_size", int),
        ("inference_windows_batch_size", int),
        ("step_size", int),
        ("patch_len", int),
        ("stride", int),
    ):
        if payload.get(key) is not None:
            defaults[key] = caster(payload[key])
    if payload.get("scaler_type") is not None:
        defaults["scaler_type"] = str(payload["scaler_type"])
    if payload.get("revin") is not None:
        defaults["revin"] = bool(payload["revin"])
    history_mode = str(payload.get("oof_training_history_mode") or "minimum_single_window").strip()
    if history_mode not in {"minimum_single_window", "full_pit_history"}:
        raise ValueError(f"oof_training_history_mode_invalid:{history_mode}")
    return {
        **defaults,
        "trainer_deterministic": bool(payload.get("trainer_deterministic", True)),
        "trainer_benchmark": False,
        "oof_training_history_mode": history_mode,
    }


OOF_FOLD_MODEL_EVIDENCE_SCHEMA_VERSION = "active8-oof-fold-model-evidence-v1"


def _json_safe(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    if isinstance(value, np.generic):
        return _json_safe(value.item())
    if isinstance(value, float) and not np.isfinite(value):
        return None
    return value


def _canonical_json_bytes(payload: dict[str, Any]) -> bytes:
    return json.dumps(
        _json_safe(payload),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def _save_immutable_oof_fold_evidence(
    bucket: Any,
    *,
    path: str,
    evidence: dict[str, Any],
) -> dict[str, Any]:
    unsigned = _json_safe(dict(evidence))
    unsigned.pop("evidence_checksum", None)
    evidence_checksum = hashlib.sha256(_canonical_json_bytes(unsigned)).hexdigest()
    payload = {**unsigned, "evidence_checksum": evidence_checksum}
    raw = _canonical_json_bytes(payload)
    blob = bucket.blob(path)

    def verify_existing() -> dict[str, Any]:
        existing = json.loads(blob.download_as_bytes().decode("utf-8").lstrip("\ufeff"))
        stored_checksum = str(existing.pop("evidence_checksum", "")).removeprefix("sha256:")
        actual_checksum = hashlib.sha256(_canonical_json_bytes(existing)).hexdigest()
        if stored_checksum != actual_checksum or stored_checksum != evidence_checksum:
            raise ValueError(f"oof_fold_evidence_immutable_conflict:{path}")
        return {**existing, "evidence_checksum": stored_checksum, "path": path}

    if blob.exists():
        return verify_existing()
    try:
        blob.upload_from_string(raw, content_type="application/json", if_generation_match=0)
    except Exception:
        if blob.exists():
            return verify_existing()
        raise
    return {**payload, "path": path}


def _utc_version() -> str:
    return "v" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")


def _require_model(model_name: str) -> dict[str, str]:
    if model_name not in MODEL_CONFIG:
        raise ValueError(f"unsupported NeuralForecast sequence model: {model_name}")
    return MODEL_CONFIG[model_name]


def default_seq_len_for_model(model_name: str) -> int:
    return int(_require_model(model_name).get("default_seq_len") or DEFAULT_SEQ_LEN)


def _configure_neuralforecast_runtime() -> None:
    global _RUNTIME_CONFIGURED
    if not _RUNTIME_CONFIGURED:
        warnings.filterwarnings(
            "ignore",
            message=r".*isinstance\(treespec, LeafSpec\).*",
            category=UserWarning,
            module=r"pytorch_lightning\.utilities\._pytree",
        )
        logging.getLogger("pytorch_lightning").setLevel(logging.WARNING)
        logging.getLogger("lightning.pytorch").setLevel(logging.WARNING)
        _RUNTIME_CONFIGURED = True
    try:
        import torch

        if torch.cuda.is_available():
            precision = os.environ.get("TORCH_FLOAT32_MATMUL_PRECISION", "high").strip() or "high"
            torch.set_float32_matmul_precision(precision)
    except Exception as exc:  # noqa: BLE001 - runtime tuning must never block training.
        logger.debug("NeuralForecast torch runtime tuning skipped: %s", exc)


def _coerce_close(row: dict[str, Any]) -> list[float]:
    close: list[float] = []
    for value in row.get("close") or row.get("series_close") or row.get("prices") or []:
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            continue
        if np.isfinite(parsed):
            close.append(parsed)
    return close


def _coerce_open(row: dict[str, Any]) -> list[float]:
    open_prices: list[float] = []
    for value in row.get("open") or row.get("series_open") or []:
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            return []
        if not np.isfinite(parsed) or parsed <= 0:
            return []
        open_prices.append(parsed)
    return open_prices


def _panel_train_eval_rows(
    records: list[dict[str, Any]],
    *,
    seq_len: int,
    pred_len: int,
    max_series: int,
    holdout_offset: int = 0,
    fixed_panel_history: bool = False,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    train_rows: list[dict[str, Any]] = []
    eval_rows: list[dict[str, Any]] = []
    # Reserve one forecast horizon for the point-in-time outcome and another
    # inside the training panel so NeuralForecast can form a supervised window.
    min_history = int(seq_len) + (2 * int(pred_len))
    skipped_short_history = 0
    skipped_label_contract = 0
    considered = 0
    for record in records:
        considered += 1
        if len(eval_rows) >= max(1, max_series):
            break
        close = _coerce_close(record)
        open_prices = _coerce_open(record)
        dates = [str(value) for value in (record.get("dates") or [])]
        end = len(close) - max(0, int(holdout_offset))
        close = close[:end]
        open_prices = open_prices[:end]
        if dates and len(dates) >= end:
            dates = dates[:end]
        if len(close) < min_history:
            skipped_short_history += 1
            continue
        if len(open_prices) != len(close) or len(dates) != len(close):
            skipped_label_contract += 1
            continue
        symbol = str(record.get("symbol") or f"series_{len(eval_rows)}")
        train_close = close[:-pred_len]
        actual_close = close[-pred_len:]
        if not train_close or not actual_close:
            continue
        if fixed_panel_history:
            train_close = train_close[-(seq_len + pred_len):]
        for ds_idx, y_value in enumerate(train_close):
            train_rows.append({"unique_id": symbol, "ds": int(ds_idx), "y": float(y_value)})
        eval_rows.append({
            "unique_id": symbol,
            "market": str(record.get("market") or record.get("market_type") or "TW").upper(),
            "last_close": float(train_close[-1]),
            "entry_open": float(open_prices[-pred_len]),
            "actual_last": float(actual_close[-1]),
            "history_len": int(len(close)),
            "signal_date": dates[-pred_len - 1] if len(dates) == len(close) else None,
            "outcome_date": dates[-1] if len(dates) == len(close) else None,
            "target_semantic_version": SEQUENCE_RETURN_SEMANTIC_VERSION,
        })
    return train_rows, eval_rows, {
        "considered_series": int(considered),
        "valid_series": int(len(eval_rows)),
        "skipped_short_history": int(skipped_short_history),
        "skipped_label_contract": int(skipped_label_contract),
        "min_history": int(min_history),
        "seq_len": int(seq_len),
        "pred_len": int(pred_len),
        "max_series": int(max_series),
        "holdout_offset": int(max(0, holdout_offset)),
        "fixed_panel_history": bool(fixed_panel_history),
    }


def _panel_full_train_rows(
    records: list[dict[str, Any]],
    *,
    seq_len: int,
    pred_len: int,
    max_series: int,
    fixed_panel_history: bool = False,
) -> tuple[list[dict[str, Any]], int]:
    rows: list[dict[str, Any]] = []
    valid_series = 0
    for record in records:
        if valid_series >= max(1, max_series):
            break
        close = _coerce_close(record)
        min_history = int(seq_len) + int(pred_len)
        if len(close) < min_history:
            continue
        if fixed_panel_history:
            close = close[-min_history:]
        symbol = str(record.get("symbol") or f"series_{valid_series}")
        for ds_idx, y_value in enumerate(close):
            rows.append({"unique_id": symbol, "ds": int(ds_idx), "y": float(y_value)})
        valid_series += 1
    return rows, valid_series


def _filter_panel_to_eval_rows(
    train_rows: list[dict[str, Any]],
    eval_rows: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    eval_ids = {str(row.get("unique_id")) for row in eval_rows if row.get("unique_id") is not None}
    return [row for row in train_rows if str(row.get("unique_id")) in eval_ids]


def _canonical_sequence_calendar(records: list[dict[str, Any]]) -> list[str]:
    return canonical_session_calendar(records)


def _aligned_close_values(record: dict[str, Any], dates: list[str]) -> tuple[list[float], float]:
    source_dates = [str(value) for value in (record.get("dates") or [])]
    source_close = _coerce_close(record)
    if len(source_dates) != len(source_close) or not dates:
        return [], 0.0
    values: list[float] = []
    observed = 0
    exact = dict(zip(source_dates, source_close))
    for date in dates:
        idx = bisect_right(source_dates, date) - 1
        if idx < 0:
            return [], 0.0
        values.append(float(source_close[idx]))
        observed += int(date in exact)
    return values, observed / len(dates)


def _build_fixed_oof_panel(
    records: list[dict[str, Any]],
    *,
    calendar: list[str],
    train_end: str,
    seq_len: int,
    pred_len: int,
    max_series: int,
    training_history_mode: str = "minimum_single_window",
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    available_train_dates = [date for date in calendar if date <= train_end]
    train_dates = (
        available_train_dates
        if training_history_mode == "full_pit_history"
        else available_train_dates[-(seq_len + pred_len):]
    )
    if len(train_dates) < seq_len + pred_len:
        raise ValueError("oof_sequence_train_calendar_insufficient")
    candidates: list[tuple[float, str, dict[str, Any], list[float]]] = []
    for record in records:
        values, observed_ratio = _aligned_close_values(record, train_dates)
        if not values or observed_ratio < OOF_MIN_PANEL_OBSERVED_RATIO:
            continue
        symbol = str(record.get("symbol") or "").strip()
        if not symbol:
            continue
        candidates.append((observed_ratio, symbol, record, values))
    candidates.sort(key=lambda item: (-item[0], item[1]))
    selected = candidates[:max(1, max_series)]
    train_rows = [
        {"unique_id": symbol, "ds": idx, "y": float(value)}
        for _ratio, symbol, _record, values in selected
        for idx, value in enumerate(values)
    ]
    selected_records = [record for _ratio, _symbol, record, _values in selected]
    unique_training_windows = sum(
        max(0, len(values) - seq_len - pred_len + 1)
        for _ratio, _symbol, _record, values in selected
    )
    if training_history_mode == "full_pit_history" and unique_training_windows <= len(selected):
        raise ValueError("oof_sequence_full_history_did_not_create_multiple_windows")
    return train_rows, selected_records, {
        "calendar_start": train_dates[0],
        "calendar_end": train_dates[-1],
        "calendar_rows": len(train_dates),
        "eligible_series": len(candidates),
        "selected_series": len(selected),
        "unique_training_windows": int(unique_training_windows),
        "training_windows_per_selected_series": round(unique_training_windows / max(1, len(selected)), 6),
        "training_history_mode": training_history_mode,
        "min_observed_ratio": OOF_MIN_PANEL_OBSERVED_RATIO,
    }


def _dense_oof_eval_panel(
    records: list[dict[str, Any]],
    *,
    calendar: list[str],
    signal_date: str,
    seq_len: int,
    pred_len: int,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    signal_idx = calendar.index(signal_date)
    if signal_idx < seq_len - 1 or signal_idx + pred_len >= len(calendar):
        return [], []
    context_dates = calendar[signal_idx - seq_len + 1:signal_idx + 1]
    entry_date = calendar[signal_idx + 1]
    outcome_date = calendar[signal_idx + pred_len]
    context_rows: list[dict[str, Any]] = []
    labels: list[dict[str, Any]] = []
    for record in records:
        symbol = str(record.get("symbol") or "").strip()
        values, _observed_ratio = _aligned_close_values(record, context_dates)
        if len(values) != seq_len:
            continue
        for idx, value in enumerate(values):
            context_rows.append({"unique_id": symbol, "ds": idx, "y": float(value)})
        source_dates = [str(value) for value in (record.get("dates") or [])]
        source_open = _coerce_open(record)
        source_close = _coerce_close(record)
        if len(source_dates) != len(source_open) or len(source_dates) != len(source_close):
            continue
        date_index = {date: idx for idx, date in enumerate(source_dates)}
        if entry_date not in date_index or outcome_date not in date_index:
            continue
        entry_open = float(source_open[date_index[entry_date]])
        outcome_close = float(source_close[date_index[outcome_date]])
        labels.append({
            "unique_id": symbol,
            "market": str(record.get("market") or record.get("market_type") or "TW").upper(),
            "entry_open": entry_open,
            "actual_last": outcome_close,
            "signal_date": signal_date,
            "outcome_date": outcome_date,
        })
    return context_rows, labels


def _dense_oof_evaluation_records(
    model_name: str,
    records: list[dict[str, Any]],
    panel_records: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    # iTransformer encodes n_series in its learned projection. Its inference
    # panel must therefore match the point-in-time training panel exactly.
    return panel_records if model_name == "iTransformer" else records


def _train_dense_purged_oof(
    payload: dict[str, Any],
    *,
    model_name: str,
    cfg: dict[str, str],
    bucket: Any,
    records: list[dict[str, Any]],
    version: str,
    seq_len: int,
    pred_len: int,
    max_steps: int,
    batch_size: int,
    seed: int,
    max_series: int,
    gcs_prefix: str,
    training_options: dict[str, Any],
) -> dict[str, Any]:
    train_end = str(payload.get("train_end") or "").strip()
    test_start = str(payload.get("test_start") or "").strip()
    test_end = str(payload.get("test_end") or "").strip()
    if not train_end or not test_start or not test_end:
        raise ValueError("oof_sequence_split_range_missing")
    market_map_blob = bucket.blob(f"{gcs_prefix.rstrip('/')}/prep/symbol_market.json")
    if not market_map_blob.exists():
        raise ValueError("oof_sequence_canonical_market_map_missing")
    market_by_symbol = json.loads(market_map_blob.download_as_text())
    records = [
        {
            **record,
            "market_type": market_by_symbol.get(str(record.get("symbol") or "")),
        }
        for record in records
        if market_by_symbol.get(str(record.get("symbol") or "")) in {"LISTED", "OTC", "EMERGING"}
    ]
    calendar = _canonical_sequence_calendar(records)
    train_rows, panel_records, panel_report = _build_fixed_oof_panel(
        records,
        calendar=calendar,
        train_end=train_end,
        seq_len=seq_len,
        pred_len=pred_len,
        max_series=max_series,
        training_history_mode=str(training_options["oof_training_history_mode"]),
    )
    if len(panel_records) < 10:
        raise ValueError(f"oof_sequence_panel_requires_10_series:{len(panel_records)}")
    nf, _train_df = _train_nf(
        train_rows,
        model_name=cfg["nf_model_name"],
        pred_len=pred_len,
        seq_len=seq_len,
        max_steps=max_steps,
        batch_size=batch_size,
        seed=seed,
        n_series=len(panel_records),
        training_options=training_options,
    )
    test_dates = [date for date in calendar if test_start <= date <= test_end]
    evaluation_records = _dense_oof_evaluation_records(model_name, records, panel_records)
    all_rows: list[dict[str, Any]] = []
    daily_metrics: list[dict[str, Any]] = []
    import pandas as pd

    for signal_date in test_dates:
        context_rows, labels = _dense_oof_eval_panel(
            evaluation_records,
            calendar=calendar,
            signal_date=signal_date,
            seq_len=seq_len,
            pred_len=pred_len,
        )
        if len(labels) < 10 or not context_rows:
            continue
        pred_by_id, _pred_col = _predict_horizon_by_id_with_column(
            nf,
            pd.DataFrame(context_rows),
            horizon_idx=pred_len,
            model_name=model_name,
        )
        pred_return: list[float] = []
        actual_return: list[float] = []
        market_segments: list[str] = []
        for label in labels:
            uid = str(label["unique_id"])
            if uid not in pred_by_id:
                continue
            entry_open = float(label["entry_open"])
            cost = CANONICAL_ROUNDTRIP_COST_BPS / 10000.0
            predicted = (float(pred_by_id[uid]) - entry_open) / max(entry_open, 1e-9) - cost
            actual = (float(label["actual_last"]) - entry_open) / max(entry_open, 1e-9) - cost
            pred_return.append(predicted)
            actual_return.append(actual)
            market_segments.append(str(label["market"]))
            all_rows.append({
                "raw_score": predicted,
                "target": actual,
                "date": signal_date,
                "symbol": uid,
                "market": str(label["market"]),
                "label_known_date": str(label["outcome_date"]),
            })
        daily_ic = date_market_rank_ic_evidence(
            raw_scores=np.asarray(pred_return, dtype=float),
            targets=np.asarray(actual_return, dtype=float),
            dates=np.asarray([signal_date] * len(actual_return), dtype=object),
            markets=np.asarray(market_segments, dtype=object),
        )
        daily_metrics.append({
            "fold_id": f"outer_test_{signal_date}",
            "oos_ic": float(daily_ic.get("fold_oos_ic") or 0.0),
            "date_cluster_ics": daily_ic.get("date_cluster_ics") or [],
            "direction_accuracy": direction_accuracy(np.asarray(pred_return), np.asarray(actual_return)),
            "test_rows": len(actual_return),
            "coverage": len(actual_return) / max(1, len(labels)),
        })
    panel_report["evaluation_universe_series"] = len(evaluation_records)
    panel_report["evaluation_prediction_rows"] = len(all_rows)
    panel_report["training_series_cap_applied"] = len(panel_records) < len(records)
    if not all_rows:
        raise ValueError("oof_sequence_dense_predictions_empty")
    non_overlapping_metrics = daily_metrics[::max(1, pred_len)]
    model_cpcv = build_model_cpcv_evidence(
        model=model_name,
        fold_metrics=non_overlapping_metrics,
        policy=payload.get("model_cpcv_policy") or None,
        family="learned_sequence",
        coverage_mode="sequence_window",
        method="outer_train_fixed_dense_test_purged_rank_ic",
    )
    model_cpcv["validation_design"] = {
        "split_owner": "outer_walk_forward_train_end",
        "refit_each_outer_fold": True,
        "refit_inside_test": False,
        "dense_daily_predictions": True,
        "quality_folds_non_overlapping": True,
        "purge_horizon": pred_len,
    }
    persist_oof_artifact = bool(payload.get("persist_oof_artifact", True))
    oof_artifact = None
    if persist_oof_artifact:
        from .oof_lineage import save_oof_prediction_artifact

        oof_artifact = save_oof_prediction_artifact(
            bucket=bucket,
            gcs_prefix=gcs_prefix,
            cohort_id=str(payload.get("cohort_id") or ""),
            fold_id=str(payload.get("fold_id") or payload.get("window_id") or ""),
            model_name=model_name,
            artifact_version=version,
            raw_scores=np.asarray([row["raw_score"] for row in all_rows]),
            targets=np.asarray([row["target"] for row in all_rows]),
            dates=np.asarray([row["date"] for row in all_rows], dtype=object),
            symbols=np.asarray([row["symbol"] for row in all_rows], dtype=object),
            markets=np.asarray([row["market"] for row in all_rows], dtype=object),
            label_known_dates=np.asarray([row["label_known_date"] for row in all_rows], dtype=object),
            split_metadata={
                "method": "outer_train_fixed_dense_test_purged_rank_ic",
                "train_start": payload.get("train_start"),
                "train_end": train_end,
                "test_start": test_start,
                "test_end": test_end,
                "purge_horizon": pred_len,
                "refit_inside_test": False,
            },
        )
    oos_ic = float(np.mean([metric["oos_ic"] for metric in daily_metrics]))
    cohort_id = str(payload.get("cohort_id") or "")
    fold_id = str(payload.get("fold_id") or payload.get("window_id") or "")
    evidence_path = (
        f"{gcs_prefix.rstrip('/')}/oof/{cohort_id}/{fold_id}/"
        f"{model_name.lower()}.evidence.json"
    )
    fold_evidence = _save_immutable_oof_fold_evidence(
        bucket,
        path=evidence_path,
        evidence={
            "schema_version": OOF_FOLD_MODEL_EVIDENCE_SCHEMA_VERSION,
            "generation_mode": "purged_oof",
            "cohort_id": cohort_id,
            "fold_id": fold_id,
            "model_name": model_name,
            "version": version,
            "target_semantic_version": SEQUENCE_RETURN_SEMANTIC_VERSION,
            "model_cpcv": model_cpcv,
            "oos_ic": round(oos_ic, 6),
            "oos_samples": len(all_rows),
            "oos_dates": len({row["date"] for row in all_rows}),
            "oof_artifact": str((oof_artifact or {}).get("path") or ""),
            "oof_artifact_checksum": str((oof_artifact or {}).get("payload_checksum") or ""),
            "split_metadata": {
                "train_start": payload.get("train_start"),
                "train_end": train_end,
                "test_start": test_start,
                "test_end": test_end,
                "purge_horizon": pred_len,
            },
        },
    ) if persist_oof_artifact else None
    return {
        "allowed_use": "promotion_evidence" if persist_oof_artifact else "research_only",
        "production_effect": False,
        "research_source_bundle_checksum": (
            str(payload.get("research_source_bundle_checksum") or "") if not persist_oof_artifact else None
        ),
        "metadata": {
            "version": version,
            "model_name": model_name,
            "generation_mode": "purged_oof",
            "panel_report": panel_report,
            "validation_design": model_cpcv["validation_design"],
            "model_cpcv": model_cpcv,
        },
        "ic_tracking": {
            model_name: {
                "oos_ic": round(oos_ic, 6),
                "oos_samples": len(all_rows),
                "passed": bool(model_cpcv.get("passed")),
                "source": "outer_train_fixed_dense_test_purged_rank_ic",
                "model_cpcv": model_cpcv,
            }
        },
        "metrics": {
            "oos_ic": round(oos_ic, 6),
            "oos_samples": len(all_rows),
            "oos_dates": len({row["date"] for row in all_rows}),
            "daily_metrics": daily_metrics,
            "model_cpcv_decision": model_cpcv.get("decision"),
        },
        "version": version,
        "type": f"{model_name.lower()}_purged_oof",
        "oof_artifact": oof_artifact,
        "oof_evidence_path": fold_evidence["path"] if fold_evidence else None,
        "oof_evidence_checksum": fold_evidence["evidence_checksum"] if fold_evidence else None,
    }


def _series_list_to_df_rows(series_list: list[dict[str, Any]], *, seq_len: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    rows: list[dict[str, Any]] = []
    eval_rows: list[dict[str, Any]] = []
    for idx, item in enumerate(series_list or []):
        close = _coerce_close(item)
        symbol = str(item.get("symbol") or f"series_{idx}")
        if len(close) < seq_len:
            eval_rows.append({"unique_id": symbol, "error": f"insufficient data ({len(close)} < {seq_len})"})
            continue
        window = close[-seq_len:]
        for ds_idx, y_value in enumerate(window):
            rows.append({"unique_id": symbol, "ds": int(ds_idx), "y": float(y_value)})
        eval_rows.append({
            "unique_id": symbol,
            "symbol": symbol,
            "last_close": float(window[-1]),
            "n_used": int(seq_len),
        })
    return rows, eval_rows


def _fold_metrics(candidate_id: str, pred_return: np.ndarray, actual_return: np.ndarray) -> list[dict[str, Any]]:
    pred_return = np.asarray(pred_return, dtype=float).reshape(-1)
    actual_return = np.asarray(actual_return, dtype=float).reshape(-1)
    fold_count = min(5, max(1, len(actual_return) // 30))
    metrics: list[dict[str, Any]] = []
    for fold_id, idx in enumerate(np.array_split(np.arange(len(actual_return)), fold_count)):
        if len(idx) < 2:
            continue
        metrics.append({
            "fold_id": f"{candidate_id}_oos_{fold_id}",
            "oos_ic": rank_ic(pred_return[idx], actual_return[idx]),
            "direction_accuracy": direction_accuracy(pred_return[idx], actual_return[idx]),
            "test_rows": int(len(idx)),
            "coverage": float(len(idx) / max(1, len(actual_return))),
        })
    if metrics:
        return metrics
    return [{
        "fold_id": f"{candidate_id}_oos_holdout",
        "oos_ic": rank_ic(pred_return, actual_return),
        "direction_accuracy": direction_accuracy(pred_return, actual_return),
        "test_rows": int(len(actual_return)),
        "coverage": 1.0 if len(actual_return) else 0.0,
    }]


def _make_nf_model(
    model_name: str,
    *,
    pred_len: int,
    seq_len: int,
    max_steps: int,
    batch_size: int,
    seed: int,
    n_series: int,
    training_options: dict[str, Any] | None = None,
):
    configure_training_reproducibility(seed)
    _configure_neuralforecast_runtime()
    from neuralforecast.models import PatchTST, iTransformer

    training_options = training_options or _resolve_nf_training_options({}, model_name)
    val_check_steps = max(1, min(int(max_steps), 10))
    common = {
        "h": pred_len,
        "input_size": seq_len,
        "max_steps": max_steps,
        "val_check_steps": val_check_steps,
        "batch_size": batch_size,
        "random_seed": seed,
        "enable_checkpointing": False,
        "enable_model_summary": False,
        "enable_progress_bar": False,
        "logger": False,
        "learning_rate": float(training_options["learning_rate"]),
        "windows_batch_size": int(training_options["windows_batch_size"]),
        "inference_windows_batch_size": int(training_options["inference_windows_batch_size"]),
        "step_size": int(training_options["step_size"]),
        "scaler_type": str(training_options["scaler_type"]),
        "deterministic": bool(training_options["trainer_deterministic"]),
        "benchmark": bool(training_options["trainer_benchmark"]),
    }
    if model_name == "PatchTST":
        return PatchTST(
            patch_len=int(training_options["patch_len"]),
            stride=int(training_options["stride"]),
            revin=bool(training_options["revin"]),
            **common,
        )
    if model_name == "iTransformer":
        return iTransformer(n_series=max(1, n_series), **common)
    raise ValueError(f"unsupported NeuralForecast model: {model_name}")


def _train_nf(
    train_rows: list[dict[str, Any]],
    *,
    model_name: str,
    pred_len: int,
    seq_len: int,
    max_steps: int,
    batch_size: int,
    seed: int,
    n_series: int,
    training_options: dict[str, Any],
):
    _configure_neuralforecast_runtime()
    import pandas as pd
    from neuralforecast import NeuralForecast

    df = pd.DataFrame(train_rows)
    model = _make_nf_model(
        model_name,
        pred_len=pred_len,
        seq_len=seq_len,
        max_steps=max_steps,
        batch_size=batch_size,
        seed=seed,
        n_series=n_series,
        training_options=training_options,
    )
    nf = NeuralForecast(models=[model], freq=1)
    nf.fit(df=df)
    return nf, df


def _prediction_column(pred_df: Any, model_name: str | None = None) -> str | None:
    if model_name and model_name in pred_df.columns:
        return str(model_name)
    candidate_cols: list[str] = []
    for col in pred_df.columns:
        col_name = str(col)
        if col_name in {"unique_id", "ds", "index", "level_0"}:
            continue
        try:
            is_numeric = bool(np.issubdtype(pred_df[col].dtype, np.number))
        except Exception:  # noqa: BLE001 - non-pandas objects in tests.
            is_numeric = True
        if is_numeric:
            candidate_cols.append(col_name)
    return candidate_cols[0] if len(candidate_cols) == 1 else None


def _predict_horizon_by_id_with_column(
    nf: Any,
    df: Any,
    *,
    horizon_idx: int,
    model_name: str | None = None,
) -> tuple[dict[str, float], str]:
    pred_df = nf.predict(df=df).reset_index()
    pred_col = _prediction_column(pred_df, model_name)
    if not pred_col:
        columns = ",".join(str(col) for col in pred_df.columns)
        raise RuntimeError(f"NeuralForecast prediction column missing_or_ambiguous:{columns}")
    pred_by_id: dict[str, float] = {}
    for uid, group in pred_df.sort_values(["unique_id", "ds"]).groupby("unique_id", sort=False):
        idx = min(max(int(horizon_idx), 1), len(group)) - 1
        pred_by_id[str(uid)] = float(group.iloc[idx][pred_col])
    return pred_by_id, pred_col


def _predict_horizon_by_id(nf: Any, df: Any, *, horizon_idx: int, model_name: str | None = None) -> dict[str, float]:
    pred_by_id, _pred_col = _predict_horizon_by_id_with_column(
        nf,
        df,
        horizon_idx=horizon_idx,
        model_name=model_name,
    )
    return pred_by_id


def _zip_dir(path: Path) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for file_path in path.rglob("*"):
            if file_path.is_file():
                zf.write(file_path, file_path.relative_to(path).as_posix())
    return buf.getvalue()


def _unzip_bytes(raw: bytes, path: Path) -> None:
    with zipfile.ZipFile(io.BytesIO(raw), "r") as zf:
        zf.extractall(path)


def _save_nf_artifact(bucket: Any, nf: Any, *, model_name: str, version: str, metadata: dict[str, Any]) -> dict[str, Any]:
    cfg = _require_model(model_name)
    with tempfile.TemporaryDirectory(prefix=f"nf_{model_name.lower()}_") as tmp:
        model_dir = Path(tmp) / "model"
        nf.save(path=str(model_dir), overwrite=True, save_dataset=False)
        raw = _zip_dir(model_dir)
    artifact_path = f"{cfg['gcs_prefix']}/{version}.zip"
    metadata_path = f"{cfg['gcs_prefix']}/metadata_{version}.json"
    checksum = "sha256:" + hashlib.sha256(raw).hexdigest()
    bucket.blob(artifact_path).upload_from_string(raw, content_type="application/zip")
    payload = {
        **metadata,
        "checksum": checksum,
        "artifact_path": artifact_path,
        "metadata_path": metadata_path,
    }
    bucket.blob(metadata_path).upload_from_string(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True),
        content_type="application/json",
    )
    return {"artifact_path": artifact_path, "metadata_path": metadata_path, "checksum": checksum, "metadata": payload}


_MODEL_CACHE: dict[str, dict[str, Any]] = {}


def _governed_sequence_identity(
    model_name: str,
    version: str,
    artifact_identity: dict[str, Any] | None,
) -> dict[str, str] | None:
    if artifact_identity is None:
        return None
    if not isinstance(artifact_identity, dict):
        raise ValueError(f"{model_name} governed artifact identity must be an object")
    identity = {
        key: str(artifact_identity.get(key) or "").strip()
        for key in ("model", "version", "artifact_id", "artifact_path", "metadata_path", "checksum")
    }
    missing = [key for key, value in identity.items() if not value]
    if missing:
        raise ValueError(f"{model_name} governed artifact identity missing: {','.join(missing)}")
    if identity["model"] != model_name:
        raise ValueError(f"{model_name} governed artifact model mismatch: {identity['model']}")
    if str(version).strip() != identity["version"]:
        raise ValueError(
            f"{model_name} governed artifact version mismatch: requested={version} expected={identity['version']}"
        )
    return identity


def _validate_governed_sequence_metadata(
    metadata: dict[str, Any],
    *,
    model_name: str,
    identity: dict[str, str],
) -> None:
    metadata_model = str(metadata.get("model_name") or metadata.get("model") or "").strip()
    metadata_version = str(metadata.get("version") or metadata.get("model_version") or "").strip()
    metadata_checksum = str(metadata.get("checksum") or metadata.get("artifact_checksum") or "").strip().lower()
    if metadata_model != model_name:
        raise ValueError(
            f"{model_name} governed metadata model mismatch: actual={metadata_model or '<missing>'}"
        )
    if metadata_version != identity["version"]:
        raise ValueError(
            f"{model_name} governed metadata version mismatch: expected={identity['version']} actual={metadata_version or '<missing>'}"
        )
    if metadata_checksum != identity["checksum"].lower():
        raise ValueError(f"{model_name} governed metadata checksum mismatch")
    for field in ("artifact_path", "metadata_path"):
        actual = str(metadata.get(field) or "").strip()
        if actual and actual != identity[field]:
            raise ValueError(f"{model_name} governed metadata {field} mismatch")
    metadata_artifact_id = str(metadata.get("artifact_id") or metadata.get("serving_artifact_id") or "").strip()
    if metadata_artifact_id and metadata_artifact_id != identity["artifact_id"]:
        raise ValueError(f"{model_name} governed metadata artifact_id mismatch")


def load_neuralforecast_artifact(
    model_name: str,
    version: str = "v1",
    *,
    artifact_identity: dict[str, Any] | None = None,
) -> tuple[Any | None, dict[str, Any] | None]:
    _configure_neuralforecast_runtime()
    from neuralforecast import NeuralForecast

    cfg = _require_model(model_name)
    governed = _governed_sequence_identity(model_name, version, artifact_identity)
    cache_key = ":".join((
        model_name,
        str(version),
        *((governed or {}).get(key, "") for key in (
            "artifact_id", "artifact_path", "metadata_path", "checksum"
        )),
    ))
    if cache_key in _MODEL_CACHE:
        cached = _MODEL_CACHE[cache_key]
        return cached["model"], cached["metadata"]
    try:
        bucket = _get_bucket()
        if bucket is None:
            raise RuntimeError("GCS bucket not available")
        artifact_path = governed["artifact_path"] if governed else f"{cfg['gcs_prefix']}/{version}.zip"
        metadata_path = governed["metadata_path"] if governed else f"{cfg['gcs_prefix']}/metadata_{version}.json"
        artifact_blob = bucket.blob(artifact_path)
        meta_blob = bucket.blob(metadata_path)
        if not artifact_blob.exists():
            return None, None
        if governed and not meta_blob.exists():
            raise ValueError(f"{model_name} governed metadata object missing")
        metadata = json.loads(meta_blob.download_as_text()) if meta_blob.exists() else {}
        if governed:
            _validate_governed_sequence_metadata(metadata, model_name=model_name, identity=governed)
        raw = artifact_blob.download_as_bytes()
        try:
            metadata["artifact_integrity_report"] = verify_artifact_bytes(
                raw,
                governed["checksum"] if governed else metadata.get("checksum") or metadata.get("artifact_checksum"),
                artifact_name=str(getattr(artifact_blob, "name", artifact_path)),
            )
        except ArtifactValidationError as exc:
            raise RuntimeError(f"{model_name} artifact integrity failed: {exc.report}") from exc
        if governed:
            verify_artifact_bytes(
                raw,
                metadata.get("checksum") or metadata.get("artifact_checksum"),
                artifact_name=str(getattr(artifact_blob, "name", artifact_path)),
            )
        tmp = Path(tempfile.mkdtemp(prefix=f"nf_load_{model_name.lower()}_"))
        _unzip_bytes(raw, tmp)
        nf = NeuralForecast.load(path=str(tmp))
        _MODEL_CACHE[cache_key] = {"model": nf, "metadata": metadata, "tmp_dir": str(tmp)}
        return nf, metadata
    except Exception as exc:  # noqa: BLE001
        if governed:
            raise
        logger.warning("[%s NeuralForecast] load failed: %s", model_name, exc)
        return None, None


def clear_neuralforecast_cache() -> None:
    for cached in _MODEL_CACHE.values():
        tmp_dir = cached.get("tmp_dir")
        if tmp_dir:
            shutil.rmtree(str(tmp_dir), ignore_errors=True)
    _MODEL_CACHE.clear()


def neuralforecast_batch_predict(
    *,
    model_name: str,
    series_list: list[dict[str, Any]],
    horizon_used: int = DEFAULT_PRED_LEN,
    version: str = "v1",
    artifact_identity: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    nf, metadata = load_neuralforecast_artifact(
        model_name, version, artifact_identity=artifact_identity
    )
    cfg = _require_model(model_name)
    if nf is None:
        return [
            {
                "symbol": row.get("symbol", "?"),
                "error": f"{model_name} NeuralForecast artifact not in GCS at {cfg['gcs_prefix']}/{version}.zip",
            }
            for row in series_list
        ]

    import pandas as pd

    seq_len = int((metadata or {}).get("seq_len") or DEFAULT_SEQ_LEN)
    pred_len = int((metadata or {}).get("pred_len") or DEFAULT_PRED_LEN)
    rows, eval_rows = _series_list_to_df_rows(series_list, seq_len=seq_len)
    out_by_uid: dict[str, dict[str, Any]] = {
        str(row["unique_id"]): {"symbol": row.get("unique_id", "?"), "error": row["error"]}
        for row in eval_rows
        if row.get("error")
    }
    valid_eval = [row for row in eval_rows if not row.get("error")]
    if rows and valid_eval:
        h_idx = min(max(int(horizon_used), 1), pred_len)
        try:
            pred_by_id, pred_col = _predict_horizon_by_id_with_column(
                nf,
                pd.DataFrame(rows),
                horizon_idx=h_idx,
                model_name=model_name,
            )
        except Exception as exc:  # noqa: BLE001
            return [
                {"symbol": item.get("symbol", "?"), "error": f"{model_name} NeuralForecast inference failed: {type(exc).__name__}: {exc}"}
                for item in series_list
            ]
        for row in valid_eval:
            uid = str(row["unique_id"])
            if uid not in pred_by_id:
                out_by_uid[uid] = {"symbol": row.get("symbol", uid), "error": f"{model_name} prediction missing"}
                continue
            last_close = float(row["last_close"])
            forecast_price = float(pred_by_id[uid])
            forecast_pct = (forecast_price - last_close) / max(last_close, 1e-9)
            out_by_uid[uid] = {
                "symbol": row.get("symbol", uid),
                "model": model_name,
                "forecast_pct": round(float(forecast_pct), 4),
                "forecast_price": round(float(forecast_price), 4),
                "direction": "up" if forecast_pct > 0 else "down",
                "confidence": round(min(0.85, max(0.35, 0.5 + min(0.35, abs(forecast_pct) * 8))), 3),
                "n_used": int(row.get("n_used") or seq_len),
                "model_version": version,
                "artifact_schema": cfg["artifact_schema"],
                "horizon_used": h_idx,
                "prediction_col_used": pred_col,
            }
    return [
        out_by_uid.get(str(item.get("symbol") or f"series_{idx}"), {"symbol": item.get("symbol", "?"), "error": "prediction missing"})
        for idx, item in enumerate(series_list or [])
    ]


def train_neuralforecast_sequence_artifact(payload: dict[str, Any], *, model_name: str) -> dict[str, Any]:
    started_at = time.time()
    cfg = _require_model(model_name)
    bucket = _get_bucket()
    if bucket is None:
        raise RuntimeError("GCS bucket not available")

    version = str(payload.get("output_model_version") or payload.get("version") or _utc_version())
    seq_len = int(payload.get("seq_len") or payload.get("data_slice", {}).get("seq_len") or default_seq_len_for_model(model_name))
    pred_len = int(payload.get("pred_len") or payload.get("data_slice", {}).get("pred_len") or DEFAULT_PRED_LEN)
    max_steps = int(payload.get("max_steps") or payload.get("n_epochs") or payload.get("epochs") or DEFAULT_MAX_STEPS)
    batch_size = int(payload.get("batch_size") or DEFAULT_BATCH_SIZE)
    seed = int(payload.get("seed") or 42)
    reproducibility = configure_training_reproducibility(seed)
    try:
        import torch
        runtime_device = "cuda" if torch.cuda.is_available() else "cpu"
    except ImportError:
        runtime_device = "cpu"
    if payload.get("monthly_training_contract") is not None and runtime_device != "cuda":
        raise RuntimeError(f"monthly_training_gpu_required:{model_name}")
    max_series = int(payload.get("max_series") or payload.get("data_slice", {}).get("max_series") or DEFAULT_MAX_SERIES)
    training_options = _resolve_nf_training_options(payload, model_name)
    gcs_prefix = str(payload.get("gcs_prefix") or payload.get("data_slice", {}).get("gcs_prefix") or "universal").strip().rstrip("/")
    sequence_gcs_prefix = str(
        payload.get("sequence_gcs_prefix")
        or payload.get("data_slice", {}).get("sequence_gcs_prefix")
        or gcs_prefix
    ).strip().rstrip("/")
    sequence_batch_count = int(
        payload.get("sequence_batch_count")
        or payload.get("data_slice", {}).get("sequence_batch_count")
        or payload.get("batch_count")
        or DEFAULT_BATCH_COUNT
    )
    promote_to_active, _promotion_reason = resolve_training_promotion_intent(payload, model_name=model_name)
    generation_mode = str(payload.get("generation_mode") or "native").strip().lower()
    if generation_mode == "purged_oof" and promote_to_active:
        raise ValueError("oof_fold_artifact_cannot_be_promoted_to_production")
    payload.setdefault("batch_count", int(payload.get("batch_count") or DEFAULT_BATCH_COUNT))

    dataset_source = load_sequence_dataset(payload)
    explicit_test_start = str(payload.get("test_start") or "").strip()
    explicit_test_end = str(payload.get("test_end") or "").strip()
    if generation_mode == "purged_oof":
        result = _train_dense_purged_oof(
            payload,
            model_name=model_name,
            cfg=cfg,
            bucket=bucket,
            records=dataset_source.records,
            version=version,
            seq_len=seq_len,
            pred_len=pred_len,
            max_steps=max_steps,
            batch_size=batch_size,
            seed=seed,
            max_series=max_series,
            gcs_prefix=gcs_prefix,
            training_options=training_options,
        )
        result["elapsed_s"] = round(time.time() - started_at, 3)
        return result
    validation_folds = max(3, int(payload.get("validation_folds") or 5))
    folds: list[dict[str, Any]] = []
    all_pred_return: list[float] = []
    all_actual_return: list[float] = []
    all_oof_rows: list[dict[str, Any]] = []
    pred_col = model_name
    series_filter: dict[str, Any] = {}
    fixed_panel_history = model_name == "iTransformer"
    for fold_index in range(validation_folds):
        holdout_offset = fold_index * pred_len
        fold_train_rows, eval_rows, fold_filter = _panel_train_eval_rows(
            dataset_source.records,
            seq_len=seq_len,
            pred_len=pred_len,
            max_series=max_series,
            holdout_offset=holdout_offset,
            fixed_panel_history=fixed_panel_history,
        )
        if fold_index == 0:
            series_filter = fold_filter
        if len(eval_rows) < 10:
            continue
        if generation_mode == "purged_oof":
            eval_rows = [
                row for row in eval_rows
                if explicit_test_start <= str(row.get("signal_date") or "") <= explicit_test_end
            ]
            if len(eval_rows) < 10:
                continue
            fold_train_rows = _filter_panel_to_eval_rows(fold_train_rows, eval_rows)
        fold_nf, fold_df = _train_nf(
            fold_train_rows,
            model_name=cfg["nf_model_name"],
            pred_len=pred_len,
            seq_len=seq_len,
            max_steps=max_steps,
            batch_size=batch_size,
            seed=seed + fold_index,
            n_series=len(eval_rows),
            training_options=training_options,
        )
        pred_by_id, pred_col = _predict_horizon_by_id_with_column(
            fold_nf,
            fold_df,
            horizon_idx=pred_len,
            model_name=model_name,
        )
        pred_return: list[float] = []
        actual_return: list[float] = []
        market_segments: list[str] = []
        signal_dates_per_row: list[str] = []
        for row in eval_rows:
            uid = str(row["unique_id"])
            if uid not in pred_by_id:
                continue
            entry_open = float(row["entry_open"])
            pred_return.append((float(pred_by_id[uid]) - entry_open) / max(entry_open, 1e-9))
            actual_return.append((float(row["actual_last"]) - entry_open) / max(entry_open, 1e-9))
            market_segments.append(str(row.get("market") or ""))
            signal_dates_per_row.append(str(row.get("signal_date") or ""))
            all_oof_rows.append({
                "raw_score": pred_return[-1],
                "target": actual_return[-1],
                "date": str(row.get("signal_date") or ""),
                "symbol": uid,
                "market": str(row.get("market") or "TW"),
                "label_known_date": str(row.get("outcome_date") or ""),
            })
        pred_array = np.asarray(pred_return, dtype=float)
        actual_array = np.asarray(actual_return, dtype=float)
        all_pred_return.extend(pred_return)
        all_actual_return.extend(actual_return)
        outcome_dates = sorted({str(row.get("outcome_date")) for row in eval_rows if row.get("outcome_date")})
        signal_dates = sorted({str(row.get("signal_date")) for row in eval_rows if row.get("signal_date")})
        fold_ic = date_market_rank_ic_evidence(
            raw_scores=pred_array,
            targets=actual_array,
            dates=np.asarray(signal_dates_per_row, dtype=object),
            markets=np.asarray(market_segments, dtype=object),
        )
        folds.append({
            "fold_id": f"chronological_{fold_index + 1}",
            "oos_ic": float(fold_ic.get("fold_oos_ic") or 0.0),
            "date_cluster_ics": fold_ic.get("date_cluster_ics") or [],
            "direction_accuracy": direction_accuracy(pred_array, actual_array),
            "test_rows": int(len(actual_array)),
            "coverage": float(len(actual_array) / max(1, len(eval_rows))),
            "signal_date": signal_dates[-1] if signal_dates else None,
            "outcome_date": outcome_dates[-1] if outcome_dates else None,
            "holdout_offset": holdout_offset,
            "purge_horizon": pred_len,
        })
    if len(folds) < 3:
        raise ValueError(
            f"{model_name} chronological validation requires >=3 retrained folds, got {len(folds)} "
            f"(min_history={series_filter.get('min_history')}, "
            f"skipped_short_history={series_filter.get('skipped_short_history')})"
        )
    model_cpcv = build_model_cpcv_evidence(
        model=model_name,
        fold_metrics=folds,
        policy=payload.get("model_cpcv_policy") or None,
        family="learned_sequence",
        coverage_mode="sequence_window",
        method="purged_walk_forward_retrain_rank_ic",
    )
    model_cpcv["validation_design"] = {
        "split_owner": "chronological_signal_date",
        "refit_each_fold": True,
        "non_overlapping_horizons": True,
        "purge_horizon": pred_len,
        "fold_order": "oldest_to_newest",
    }
    oos_ic = float(np.mean([float(fold["oos_ic"]) for fold in folds]))
    all_pred_array = np.asarray(all_pred_return, dtype=float)
    all_actual_array = np.asarray(all_actual_return, dtype=float)
    metrics = {
        "oos_ic": round(float(oos_ic), 6),
        "direction_accuracy": round(float(direction_accuracy(all_pred_array, all_actual_array)), 6),
        "rank_ic_all": round(float(oos_ic), 6),
        "prediction_col_used": pred_col,
        "pbo": cpcv_proxy_pbo(folds),
        "oos_samples": int(len(all_actual_return)),
        "fold_metrics": folds,
        "model_cpcv_decision": model_cpcv.get("decision"),
    }
    oof_artifact = None
    if generation_mode == "purged_oof":
        from .oof_lineage import save_oof_prediction_artifact

        oof_artifact = save_oof_prediction_artifact(
            bucket=bucket,
            gcs_prefix=gcs_prefix,
            cohort_id=str(payload.get("cohort_id") or ""),
            fold_id=str(payload.get("fold_id") or payload.get("window_id") or ""),
            model_name=model_name,
            artifact_version=version,
            raw_scores=np.asarray([row["raw_score"] for row in all_oof_rows], dtype=float),
            targets=np.asarray([row["target"] for row in all_oof_rows], dtype=float),
            dates=np.asarray([row["date"] for row in all_oof_rows], dtype=object),
            symbols=np.asarray([row["symbol"] for row in all_oof_rows], dtype=object),
            markets=np.asarray([row["market"] for row in all_oof_rows], dtype=object),
            label_known_dates=np.asarray([row["label_known_date"] for row in all_oof_rows], dtype=object),
            split_metadata={
                "method": "purged_walk_forward_retrain_rank_ic",
                "train_start": payload.get("train_start"),
                "train_end": payload.get("train_end"),
                "test_start": explicit_test_start,
                "test_end": explicit_test_end,
                "purge_horizon": pred_len,
                "refit_each_fold": True,
            },
        )

    # Validation models are discarded. The serving artifact is refit once on all
    # point-in-time data known at training time.
    train_rows, deployment_series = _panel_full_train_rows(
        dataset_source.records,
        seq_len=seq_len,
        pred_len=pred_len,
        max_series=max_series,
        fixed_panel_history=fixed_panel_history,
    )
    if deployment_series < 10:
        raise ValueError(f"{model_name} deployment refit requires >=10 valid series, got {deployment_series}")
    nf, _deployment_df = _train_nf(
        train_rows,
        model_name=cfg["nf_model_name"],
        pred_len=pred_len,
        seq_len=seq_len,
        max_steps=max_steps,
        batch_size=batch_size,
        seed=seed,
        n_series=deployment_series,
        training_options=training_options,
    )

    lineage_dates = []
    for row in dataset_source.records[:max_series]:
        dates = row.get("dates") or []
        if dates:
            lineage_dates.extend(str(v) for v in dates[-pred_len:])
    prep_lineage = collect_prep_lineage(
        bucket,
        gcs_prefix=sequence_gcs_prefix,
        batch_count=sequence_batch_count,
        feature_names=["close"],
        rows=len(train_rows),
        dates=lineage_dates,
    )
    prep_freshness = (
        validate_prep_lineage_for_registration(
            prep_lineage,
            as_of_date=payload.get("as_of_date") or payload.get("run_date"),
            max_stale_days=payload.get("max_prep_stale_days"),
            label_horizon_days=payload.get("label_horizon_days"),
        )
        if promote_to_active
        and dataset_source.source.startswith("gs://")
        and gcs_prefix == "universal"
        and payload.get("disable_stale_prep_guard") is not True
        else {"status": "skipped"}
    )
    training_config_attestation = build_model_training_config_attestation(
        model_name,
        payload,
        {
            "seq_len": seq_len,
            "pred_len": pred_len,
            "max_steps": max_steps,
            "batch_size": batch_size,
            "seed": seed,
            "max_series": max_series,
            "validation_folds": validation_folds,
            "runtime_package": "neuralforecast==3.1.9",
            "runtime_device": runtime_device,
            "reproducibility": reproducibility,
            "training_options": training_options,
            "validation_design": model_cpcv["validation_design"],
            "target_semantic_version": SEQUENCE_RETURN_SEMANTIC_VERSION,
        },
    )
    trained_at = datetime.now(timezone.utc).isoformat()
    metadata = attach_prep_lineage_aliases({
        "schema_version": f"{cfg['artifact_schema']}_metadata_v1",
        "artifact_schema": cfg["artifact_schema"],
        "version": version,
        "model_name": model_name,
        "model_type": cfg["model_type"],
        "family": "time_series",
        "runtime_package": "neuralforecast",
        "trained_at": trained_at,
        "feature_names": ["close"],
        "feature_count": 1,
        "seq_len": seq_len,
        "pred_len": pred_len,
        "max_steps": max_steps,
        "batch_size": batch_size,
        "seed": seed,
        "training_options": training_options,
        "metrics": metrics,
        "model_cpcv": model_cpcv,
        "validation_design": model_cpcv["validation_design"],
        "target_semantic_version": SEQUENCE_RETURN_SEMANTIC_VERSION,
        "deployment_fit": {
            "method": "full_known_history_refit_after_chronological_validation",
            "performed": True,
            "series": deployment_series,
            "validation_models_are_not_served": True,
        },
        "oos_ic": metrics["oos_ic"],
        "direction_accuracy": metrics["direction_accuracy"],
        "sample_count": int(len(train_rows)),
        "validation_sample_count": int(len(all_actual_return)),
        "dataset_snapshot": {
            "source": dataset_source.source,
            "gcs_prefix": gcs_prefix,
            "sequence_gcs_prefix": sequence_gcs_prefix,
            "batch_count": sequence_batch_count,
            "max_series": max_series,
            "series_filter": series_filter,
            "data_slice_report": data_slice_report(dataset=dataset_source, start_date=payload.get("start_date"), end_date=payload.get("end_date")),
            "prep_lineage": prep_lineage,
            "prep_freshness": prep_freshness,
        },
        **build_model_feature_policy_metadata(
            model_name,
            ["close"],
            selection_evidence={
                "selection_method": "production_artifact",
                "sequence_contract": "sequence_records_v3",
                "target_semantic_version": SEQUENCE_RETURN_SEMANTIC_VERSION,
            },
        ),
        **({"model_training_config_attestation": training_config_attestation} if training_config_attestation else {}),
    }, prep_lineage)
    saved = _save_nf_artifact(bucket, nf, model_name=model_name, version=version, metadata=metadata)
    return {
        "status": "ok",
        "model": model_name,
        "oof_artifact": oof_artifact,
        "version": version,
        "artifact_path": saved["artifact_path"],
        "metadata_path": saved["metadata_path"],
        "checksum": saved["checksum"],
        "metadata": saved["metadata"],
        "metrics": metrics,
        "model_cpcv": model_cpcv,
        "ic_tracking": {
            model_name: {
                "oos_ic": metrics["oos_ic"],
                "oos_samples": metrics["oos_samples"],
                "pbo": metrics["pbo"],
                "passed": float(metrics["oos_ic"] or 0.0) > 0.0,
                "source": "neuralforecast_sequence_oos",
                "model_cpcv": model_cpcv,
            },
        },
        "oos_ic": metrics["oos_ic"],
        "train_samples": int(len(train_rows)),
        "validation_samples": int(len(all_actual_return)),
        "elapsed_s": round(time.time() - started_at, 3),
    }
