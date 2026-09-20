"""Pinned official TimeXer: causal inputs and immutable checkpoint inference.

The two variants have the exact architecture/transforms used by the accepted
research comparison. Price-only does not consume exogenous values. Both retain
the same point-in-time feature-availability eligibility as that comparison.
"""
from __future__ import annotations

import hashlib
import io
from types import SimpleNamespace
from typing import Any

import numpy as np

SCHEMA = "stockvision-official-timexer-v1"
OFFICIAL_COMMIT = "76011909357972bd55a27adba2e1be994d81b327"
SCORE_SEMANTIC = "forecast-t5-over-signal-close-gross-v1"
ARCHITECTURE = {
    "seq_len": 168, "patch_len": 24, "pred_len": 5, "d_model": 512,
    "d_ff": 512, "e_layers": 3, "n_heads": 8, "dropout": 0.1, "use_norm": True,
}


def validate_settings(settings: dict, exogenous: bool) -> None:
    if type(exogenous) is not bool or settings.get("official_commit") != OFFICIAL_COMMIT:
        raise ValueError("timexer_source_or_variant_mismatch")
    if any(settings.get(key) != value for key, value in ARCHITECTURE.items()):
        raise ValueError("timexer_unapproved_architecture")
    if settings.get("max_exogenous_staleness_sessions", 1) != 1:
        raise ValueError("timexer_unapproved_asof_policy")


def official_model(settings: dict, exogenous: bool):
    from .vendor.timexer.models.TimeXer import Model
    validate_settings(settings, exogenous)
    return Model(SimpleNamespace(**ARCHITECTURE, features="MS" if exogenous else "M",
        task_name="short_term_forecast", enc_in=138 if exogenous else 1,
        factor=5, embed="timeF", freq="d", activation="gelu"))


def causal_input(history, features, calendar, day: str, *, settings: dict, exogenous: bool):
    """No outcomes, future filling, latest-price substitution or truncated pool."""
    validate_settings(settings, exogenous)
    dates, prices = np.asarray(history[0], dtype=str), np.asarray(history[1], dtype=np.float32)
    feature_dates, matrix = np.asarray(features[0], dtype=str), np.asarray(features[1], dtype=np.float32)
    calendar = np.asarray(calendar, dtype=str)
    if (dates.ndim != 1 or prices.shape != dates.shape or feature_dates.ndim != 1
            or matrix.shape != (len(feature_dates), 137) or calendar.ndim != 1
            or any(np.any(values[1:] <= values[:-1]) for values in (dates, feature_dates, calendar))):
        raise ValueError("timexer_input_shape_or_order_invalid")
    end = int(np.searchsorted(dates, day, side="right"))
    length = settings["seq_len"]
    if end < length or dates[end - 1] != day:
        return None
    dates, prices = dates[end-length:end], prices[end-length:end]
    if not np.isin(dates, calendar).all():
        raise ValueError("timexer_calendar_missing_price_session")
    indices = np.searchsorted(feature_dates, dates, side="right") - 1
    if np.any(indices < 0):
        return None
    observed = feature_dates[indices]
    ages = np.searchsorted(calendar, dates, side="right") - np.searchsorted(calendar, observed, side="right")
    if observed[-1] != day or np.any(observed > dates) or np.any(ages > 1):
        return None
    if not np.isfinite(prices).all() or np.any(prices <= 0):
        raise ValueError("timexer_invalid_observed_prices")
    mean, scale = float(prices.mean()), float(prices.std()) + 1e-4
    price = ((prices - mean) / scale).reshape(-1, 1)
    values = np.concatenate([matrix[indices], price], axis=1) if exogenous else price
    if not np.isfinite(values).all():
        raise ValueError("timexer_nonfinite_causal_input")
    return values.astype(np.float32), mean, scale, float(prices[-1])


def load_checkpoint(raw: bytes, *, expected_checksum: str, expected_variant: str, device="cpu"):
    """Explicit immutable identity; no latest pointer, refit or model fallback."""
    import torch
    if expected_variant not in {"price", "exo137"}:
        raise ValueError("timexer_unknown_variant")
    if hashlib.sha256(raw).hexdigest() != expected_checksum:
        raise ValueError("timexer_artifact_checksum_mismatch")
    checkpoint = torch.load(io.BytesIO(raw), map_location="cpu", weights_only=True)
    if set(checkpoint) - {"state_dict", "settings", "exogenous", "stockvision"}:
        raise ValueError("timexer_checkpoint_fields_invalid")
    settings, exogenous = checkpoint["settings"], checkpoint["exogenous"]
    validate_settings(settings, exogenous)
    if exogenous != (expected_variant == "exo137"):
        raise ValueError("timexer_artifact_variant_mismatch")
    model = official_model(settings, exogenous)
    model.load_state_dict(checkpoint["state_dict"], strict=True)
    model.to(device)
    model.eval()
    return model, settings


def predict_inputs(model, inputs: list, *, device="cpu", batch_size=64) -> np.ndarray:
    import torch
    if not isinstance(batch_size, int) or not 1 <= batch_size <= 64:
        raise ValueError("timexer_inference_batch_out_of_bounds")
    output = []
    with torch.inference_mode():
        for start in range(0, len(inputs), batch_size):
            batch = inputs[start:start + batch_size]
            values = torch.from_numpy(np.stack([row[0] for row in batch])).to(device)
            forecasts = model(values, None, None, None)[:, -1, 0].cpu().numpy()
            output.extend(float((value * row[2] + row[1]) / row[3] - 1)
                          for row, value in zip(batch, forecasts, strict=True))
    result = np.asarray(output, dtype=float)
    if not np.isfinite(result).all():
        raise ValueError("timexer_nonfinite_prediction")
    return result


def predict_asof(model, *, settings: dict, exogenous: bool, histories: dict,
                 feature_histories: dict, calendar, symbols: list[str], signal_date: str,
                 device="cpu") -> list[dict[str, Any]]:
    if len(symbols) != len(set(symbols)):
        raise ValueError("timexer_duplicate_requested_symbol")
    output, pending = [], []
    for symbol in symbols:
        item = (causal_input(histories[symbol], feature_histories[symbol], calendar,
            signal_date, settings=settings, exogenous=exogenous)
            if symbol in histories and symbol in feature_histories else None)
        row = {"symbol": symbol, "raw_score": None, "available": item is not None,
            "reason": None if item is not None else "timexer_causal_context_unavailable"}
        output.append(row)
        if item is not None:
            pending.append((row, item))
        # Inference is streamed by batch rather than retaining every full tensor.
        if len(pending) == 64:
            predictions = predict_inputs(model, [item for _, item in pending], device=device)
            for (target, _), value in zip(pending, predictions, strict=True):
                target["raw_score"] = float(value)
            pending.clear()
    if pending:
        predictions = predict_inputs(model, [item for _, item in pending], device=device)
        for (target, _), value in zip(pending, predictions, strict=True):
            target["raw_score"] = float(value)
    return output
