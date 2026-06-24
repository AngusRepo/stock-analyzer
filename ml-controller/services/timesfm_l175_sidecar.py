"""TimesFM L2 feature-sidecar contract.

TimesFM is blocked from direct alpha voting. This module turns its forecast
into auditable sidecar features that can enter L3 only after a versioned
retrain/release policy is approved.
"""

from __future__ import annotations

import math
from typing import Any


TIMESFM_L175_FEATURE_NAMES = [
    "timesfm_l175_forecast_return",
    "timesfm_l175_forecast_log_return",
    "timesfm_l175_forecast_slope",
    "timesfm_l175_forecast_curvature",
    "timesfm_l175_random_walk_residual",
    "timesfm_l175_quantile_width",
    "timesfm_l175_forecast_dispersion",
    "timesfm_l175_peer_sequence_mean_return",
    "timesfm_l175_market_excess_return",
    "timesfm_l175_sector_excess_return",
    "timesfm_l175_sign_flip_flag",
]


def _finite_float_or_none(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _price_log_return(forecast_price: Any, reference_price: Any) -> float | None:
    forecast = _finite_float_or_none(forecast_price)
    reference = _finite_float_or_none(reference_price)
    if forecast is None or reference is None or forecast <= 0 or reference <= 0:
        return None
    return math.log(forecast / reference)


def _numeric_series_from_signal(signal: dict[str, Any]) -> list[float]:
    for key in ("forecast_path", "point_forecast", "forecasts", "values"):
        raw = signal.get(key)
        if not isinstance(raw, list):
            continue
        values: list[float] = []
        for item in raw:
            if isinstance(item, dict):
                value = _finite_float_or_none(item.get("forecast") or item.get("value") or item.get("price"))
            else:
                value = _finite_float_or_none(item)
            if value is not None:
                values.append(value)
        if values:
            return values
    return []


def _series_curvature(values: list[float]) -> float | None:
    if len(values) < 3:
        return None
    mid = len(values) // 2
    return values[-1] - (2.0 * values[mid]) + values[0]


def _quantile_width(signal: dict[str, Any]) -> float | None:
    direct = _finite_float_or_none(signal.get("quantile_width"))
    if direct is not None:
        return direct
    for lo_key, hi_key in (
        ("q10", "q90"),
        ("p10", "p90"),
        ("forecast_p10", "forecast_p90"),
        ("lower80", "upper80"),
        ("lower95", "upper95"),
    ):
        lo = _finite_float_or_none(signal.get(lo_key))
        hi = _finite_float_or_none(signal.get(hi_key))
        if lo is not None and hi is not None:
            return abs(hi - lo)
    raw = signal.get("quantile_forecast") or signal.get("quantile_forecasts")
    if isinstance(raw, list):
        values = [_finite_float_or_none(item) for item in raw]
        values = [item for item in values if item is not None]
        if len(values) >= 2:
            return max(values) - min(values)
    return None


def _per_model_signal_payload(data: dict[str, Any], model_name: str) -> dict[str, Any] | None:
    key = str(model_name or "").strip().lower()
    signal = data.get(key)
    if not isinstance(signal, dict):
        return None
    return {
        "forecast_pct": signal.get("forecast_pct"),
        "confidence": signal.get("confidence"),
        "direction": signal.get("direction"),
        "rank_score": signal.get("rank_score"),
        "source": signal.get("source") or model_name,
    }


def _release_policy_active(release_policy: dict[str, Any] | None) -> tuple[bool, str | None, dict[str, Any]]:
    policy = release_policy if isinstance(release_policy, dict) else {}
    status = str(policy.get("status") or policy.get("approval_status") or "").strip().lower()
    release_id = str(policy.get("release_id") or policy.get("policy_id") or "").strip()
    schema = str(policy.get("schema_version") or "").strip()
    retrain = policy.get("retrain_complete") is True
    model_pool = policy.get("model_pool_released") is True
    active = (
        schema == "timesfm-l1-75-l2-feature-release-v1"
        and status in {"approved", "active", "production_approved"}
        and retrain
        and model_pool
    )
    reason = None if active else "requires_formal137_registry_retrain_release"
    return active, reason, {
        "schema_version": schema or None,
        "release_id": release_id or None,
        "status": status or None,
        "retrain_complete": retrain,
        "model_pool_released": model_pool,
    }


def build_timesfm_l175_sidecar(
    data: dict[str, Any],
    *,
    release_policy: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    signal = data.get("timesfm")
    if not isinstance(signal, dict) or signal.get("error"):
        return None

    reference_price = (
        data.get("entry_price")
        or data.get("current_price")
        or signal.get("current_price")
        or signal.get("last_price")
        or signal.get("input_price")
    )
    forecast_return = _finite_float_or_none(signal.get("forecast_pct"))
    forecast_log_return = _price_log_return(signal.get("forecast_price"), reference_price)
    if forecast_log_return is None and forecast_return is not None and forecast_return > -1.0:
        forecast_log_return = math.log1p(forecast_return)

    horizon = (
        _finite_float_or_none(signal.get("horizon"))
        or _finite_float_or_none(data.get("horizon"))
        or 14.0
    )
    forecast_path = _numeric_series_from_signal(signal)
    slope = forecast_return / horizon if forecast_return is not None and horizon and horizon > 0 else None

    peer_returns: list[float] = []
    for src_key in ("dlinear", "patchtst", "itransformer"):
        peer_signal = data.get(src_key)
        if not isinstance(peer_signal, dict):
            continue
        value = _finite_float_or_none(peer_signal.get("forecast_pct"))
        if value is not None:
            peer_returns.append(value)
    dispersion_values = [value for value in [forecast_return, *peer_returns] if value is not None]
    peer_mean = sum(peer_returns) / len(peer_returns) if peer_returns else None
    forecast_dispersion = (
        math.sqrt(sum((value - (sum(dispersion_values) / len(dispersion_values))) ** 2 for value in dispersion_values) / len(dispersion_values))
        if len(dispersion_values) >= 2
        else None
    )
    sign_flip_flag = None
    if forecast_return is not None and peer_mean is not None:
        sign_flip_flag = (forecast_return > 0 > peer_mean) or (forecast_return < 0 < peer_mean)

    market_expected = _finite_float_or_none(
        data.get("market_expected_return")
        or signal.get("market_expected_return")
        or signal.get("expected_market_return")
    )
    sector_expected = _finite_float_or_none(
        data.get("sector_expected_return")
        or signal.get("sector_expected_return")
        or signal.get("expected_sector_return")
    )

    features = {
        "forecast_return": forecast_return,
        "forecast_log_return": forecast_log_return,
        "forecast_slope": slope,
        "forecast_curvature": _series_curvature(forecast_path),
        "random_walk_residual": forecast_return,
        "quantile_width": _quantile_width(signal),
        "forecast_dispersion": forecast_dispersion,
        "peer_sequence_mean_return": peer_mean,
        "market_excess_return": (
            forecast_return - market_expected
            if forecast_return is not None and market_expected is not None
            else None
        ),
        "sector_excess_return": (
            forecast_return - sector_expected
            if forecast_return is not None and sector_expected is not None
            else None
        ),
        "sign_flip_flag": sign_flip_flag,
    }
    l2_feature_values = {
        f"timesfm_l175_{key}": (1.0 if value is True else 0.0 if value is False else value)
        for key, value in features.items()
    }
    active, blocked_reason, release_evidence = _release_policy_active(release_policy)
    current_allowed_use = ["diagnostic", "uncertainty_context", "risk_sidecar"]
    if active:
        current_allowed_use.append("l2_feature_enrichment")

    return {
        "schema_version": "timesfm-l1-75-sidecar-v1",
        "layer": "L2",
        "source": "TimesFM",
        "role": "feature_sidecar",
        "direct_alpha_blocked": True,
        "eligible_for_l2_feature_enrichment": active,
        "l2_feature_input_active": active,
        "l2_feature_input_blocked_reason": blocked_reason,
        "l2_feature_schema_version": "timesfm-l1-75-l2-features-v1",
        "l2_feature_names": TIMESFM_L175_FEATURE_NAMES,
        "l2_feature_values": l2_feature_values,
        "release_evidence": release_evidence,
        "current_allowed_use": current_allowed_use,
        "features": features,
        "raw_context": _per_model_signal_payload(data, "TimesFM"),
    }
