"""PIT-safe observation-only state-space evidence.

This module deliberately does not vote alpha, size positions, or alter exits.
It estimates a local-linear-trend state from prices known at ``as_of_date`` and
emits an immutable, checksum-bound observation packet for later OOS evaluation.
"""

from __future__ import annotations

import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
import math
from dataclasses import dataclass
from typing import Any

import numpy as np


STATE_SPACE_V2_SCHEMA = "state-space-observation-v2"
STATE_SPACE_V2_CONTRACT = "local-linear-trend-gaussian-mle-v2"
MIN_OBSERVATIONS = 60


def _normalize_json_numbers(value: Any) -> Any:
    """Encode numbers as unambiguous fixed-decimal tokens for cross-runtime hashes."""
    if isinstance(value, dict):
        return {key: _normalize_json_numbers(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_normalize_json_numbers(item) for item in value]
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, (int, float, np.integer, np.floating)):
        number = float(value)
        if not math.isfinite(number):
            raise ValueError("state_space_v2_non_finite_checksum_number")
        token = f"{number:.12f}".rstrip("0").rstrip(".")
        return {"$number": token or "0"}
    return value


def _canonical_json(value: Any) -> str:
    return json.dumps(
        _normalize_json_numbers(value),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )


def _sha256(value: Any) -> str:
    return hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def _normal_cdf(value: float) -> float:
    return 0.5 * (1.0 + math.erf(value / math.sqrt(2.0)))


@dataclass(frozen=True)
class _FilterResult:
    log_likelihood: float
    level: float
    slope: float
    covariance: np.ndarray
    innovation: float
    innovation_variance: float


def _kalman_filter(log_prices: np.ndarray, log_variances: np.ndarray) -> _FilterResult:
    q_level, q_slope, observation_variance = np.exp(log_variances)
    transition = np.array([[1.0, 1.0], [0.0, 1.0]], dtype=np.float64)
    observation = np.array([1.0, 0.0], dtype=np.float64)
    process_covariance = np.diag([q_level, q_slope])
    state = np.array([float(log_prices[0]), 0.0], dtype=np.float64)
    covariance = np.eye(2, dtype=np.float64) * max(observation_variance, 1e-8)
    log_likelihood = 0.0
    innovation = 0.0
    innovation_variance = observation_variance

    for observed in log_prices[1:]:
        predicted_state = transition @ state
        predicted_covariance = transition @ covariance @ transition.T + process_covariance
        innovation = float(observed - observation @ predicted_state)
        innovation_variance = float(observation @ predicted_covariance @ observation + observation_variance)
        if not math.isfinite(innovation_variance) or innovation_variance <= 1e-12:
            raise ValueError("state_space_v2_invalid_innovation_variance")
        gain = (predicted_covariance @ observation) / innovation_variance
        state = predicted_state + gain * innovation
        covariance = (np.eye(2) - np.outer(gain, observation)) @ predicted_covariance
        log_likelihood += -0.5 * (
            math.log(2.0 * math.pi * innovation_variance)
            + innovation * innovation / innovation_variance
        )

    return _FilterResult(
        log_likelihood=log_likelihood,
        level=float(state[0]),
        slope=float(state[1]),
        covariance=covariance,
        innovation=innovation,
        innovation_variance=innovation_variance,
    )


def _fit_local_linear_trend(log_prices: np.ndarray) -> tuple[_FilterResult, dict[str, float]]:
    try:
        from scipy.optimize import minimize
    except ImportError as exc:  # fail closed: no silent hand-tuned fallback
        raise RuntimeError("state_space_v2_requires_scipy_mle") from exc

    returns = np.diff(log_prices)
    base_variance = max(float(np.var(returns, ddof=1)), 1e-8)
    initial = np.log([base_variance * 0.05, base_variance * 0.005, base_variance])
    lower = math.log(max(base_variance * 1e-6, 1e-12))
    upper = math.log(max(base_variance * 1e3, 1e-8))

    def objective(values: np.ndarray) -> float:
        try:
            return -_kalman_filter(log_prices, values).log_likelihood
        except (FloatingPointError, ValueError, OverflowError):
            return 1e30

    optimized = minimize(
        objective,
        initial,
        method="L-BFGS-B",
        bounds=[(lower, upper), (lower, upper), (lower, upper)],
        options={"maxiter": 150, "ftol": 1e-10},
    )
    if not optimized.success or not np.all(np.isfinite(optimized.x)):
        raise RuntimeError(f"state_space_v2_mle_failed:{optimized.message}")
    fitted = _kalman_filter(log_prices, optimized.x)
    q_level, q_slope, observation_variance = np.exp(optimized.x)
    return fitted, {
        "q_level": float(q_level),
        "q_slope": float(q_slope),
        "observation_variance": float(observation_variance),
        "log_likelihood": float(fitted.log_likelihood),
    }


def _pooled_noise_ratios(series_list: list[dict[str, Any]]) -> tuple[dict[str, float] | None, dict[str, Any]]:
    log_series: list[np.ndarray] = []
    for row in series_list:
        prices = np.asarray(row.get("prices") or [], dtype=np.float64)
        prices = prices[np.isfinite(prices) & (prices > 0)]
        if prices.size < MIN_OBSERVATIONS:
            continue
        values = np.log(prices)
        scale = math.sqrt(max(float(np.var(np.diff(values), ddof=1)), 1e-12))
        log_series.append((values - values[0]) / scale)
    if not log_series:
        return None, {"method": "pooled_cross_sectional_mle", "eligible_series": 0, "status": "unavailable"}
    common_length = min(len(values) for values in log_series)
    aligned = np.vstack([values[-common_length:] for values in log_series])
    pooled_path = np.median(aligned, axis=0)
    _fitted, parameters = _fit_local_linear_trend(pooled_path)
    pooled_variance = max(float(np.var(np.diff(pooled_path), ddof=1)), 1e-12)
    ratios = {
        "q_level": parameters["q_level"] / pooled_variance,
        "q_slope": parameters["q_slope"] / pooled_variance,
        "observation_variance": parameters["observation_variance"] / pooled_variance,
    }
    return ratios, {
        "method": "cross_sectional_median_path_pooled_gaussian_mle",
        "eligible_series": len(log_series),
        "common_observations": common_length,
        "noise_ratios": {key: round(value, 12) for key, value in ratios.items()},
        "status": "fitted",
    }


def build_state_space_v2_observation(
    row: dict[str, Any],
    *,
    as_of_date: str,
    horizon_sessions: int = 5,
    pooled_noise_ratios: dict[str, float] | None = None,
) -> dict[str, Any]:
    symbol = str(row.get("symbol") or "").strip()
    prices = np.asarray(row.get("prices") or [], dtype=np.float64)
    prices = prices[np.isfinite(prices) & (prices > 0)]
    if not symbol:
        raise ValueError("state_space_v2_symbol_missing")
    if prices.size < MIN_OBSERVATIONS:
        raise ValueError(f"state_space_v2_insufficient_observations:{prices.size}<{MIN_OBSERVATIONS}")

    log_prices = np.log(prices)
    if pooled_noise_ratios:
        base_variance = max(float(np.var(np.diff(log_prices), ddof=1)), 1e-12)
        q_level = base_variance * float(pooled_noise_ratios["q_level"])
        q_slope = base_variance * float(pooled_noise_ratios["q_slope"])
        observation_variance = base_variance * float(pooled_noise_ratios["observation_variance"])
        fitted = _kalman_filter(log_prices, np.log([q_level, q_slope, observation_variance]))
        parameters = {
            "q_level": q_level,
            "q_slope": q_slope,
            "observation_variance": observation_variance,
            "log_likelihood": fitted.log_likelihood,
        }
    else:
        fitted, parameters = _fit_local_linear_trend(log_prices)
    horizon = max(1, int(horizon_sessions))
    transition_h = np.array([[1.0, float(horizon)], [0.0, 1.0]], dtype=np.float64)
    q = np.diag([parameters["q_level"], parameters["q_slope"]])
    forecast_covariance = transition_h @ fitted.covariance @ transition_h.T + q * horizon
    forecast_variance = max(float(forecast_covariance[0, 0] + parameters["observation_variance"]), 1e-12)
    forecast_log_return = float(fitted.slope * horizon)
    forecast_z = forecast_log_return / math.sqrt(forecast_variance)
    innovation_z = fitted.innovation / math.sqrt(max(fitted.innovation_variance, 1e-12))

    input_identity = {
        "symbol": symbol,
        "as_of_date": as_of_date,
        "prices": [round(float(value), 10) for value in prices.tolist()],
        "sequence_source": row.get("sequence_source") or "unknown",
    }
    observation = {
        "schema_version": STATE_SPACE_V2_SCHEMA,
        "contract_version": STATE_SPACE_V2_CONTRACT,
        "decision_role": "risk_overlay_comparison_only",
        "production_effect": False,
        "symbol": symbol,
        "stock_id": row.get("stock_id"),
        "as_of_date": as_of_date,
        "horizon_sessions": horizon,
        "n_used": int(prices.size),
        "observed_price": round(float(prices[-1]), 8),
        "latent_level": round(float(math.exp(fitted.level)), 10),
        "latent_slope_1d": round(float(math.expm1(fitted.slope)), 10),
        "forecast_return": round(float(math.expm1(forecast_log_return)), 10),
        "forecast_variance": round(forecast_variance, 12),
        "up_probability": round(_normal_cdf(forecast_z), 10),
        "innovation_z": round(float(innovation_z), 10),
        "level_uncertainty": round(float(fitted.covariance[0, 0]), 12),
        "slope_uncertainty": round(float(fitted.covariance[1, 1]), 12),
        "parameters": {key: round(value, 12) for key, value in parameters.items()},
        "input_checksum": _sha256(input_identity),
        "sequence_source": row.get("sequence_source") or "unknown",
    }
    observation["observation_checksum"] = _sha256(observation)
    observation["observation_id"] = f"state-space-v2-{observation['observation_checksum'][:40]}"
    return observation


def build_state_space_v2_batch(
    series_list: list[dict[str, Any]],
    *,
    as_of_date: str,
    run_id: str,
    horizon_sessions: int = 5,
    input_evidence: dict[str, Any] | None = None,
) -> dict[str, Any]:
    observations: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    rows = list(series_list or [])
    pooled_noise_ratios, calibration_evidence = _pooled_noise_ratios(rows)

    def evaluate(row: dict[str, Any]) -> tuple[dict[str, Any] | None, dict[str, str] | None]:
        try:
            return build_state_space_v2_observation(
                row,
                as_of_date=as_of_date,
                horizon_sessions=horizon_sessions,
                pooled_noise_ratios=pooled_noise_ratios,
            ), None
        except Exception as exc:  # individual symbols remain evidence-visible
            return None, {
                "symbol": str(row.get("symbol") or ""),
                "error": f"{type(exc).__name__}:{exc}",
            }

    # The Modal prediction bundle owns exactly four CPUs. executor.map keeps
    # deterministic input order while preventing the observation-only stage
    # from serially adding one MLE wall-time per symbol.
    worker_count = min(4, max(1, len(rows)))
    with ThreadPoolExecutor(max_workers=worker_count, thread_name_prefix="state-space-v2") as executor:
        for observation, error in executor.map(evaluate, rows):
            if observation is not None:
                observations.append(observation)
            if error is not None:
                errors.append(error)

    packet_core = {
        "schema_version": STATE_SPACE_V2_SCHEMA,
        "contract_version": STATE_SPACE_V2_CONTRACT,
        "run_id": run_id,
        "as_of_date": as_of_date,
        "horizon_sessions": max(1, int(horizon_sessions)),
        "production_effect": False,
        "decision_role": "risk_overlay_comparison_only",
        "input_evidence": {
            **(input_evidence or {}),
            "state_space_v2_calibration": calibration_evidence,
        },
        "observations": observations,
        "errors": errors,
    }
    return {
        **packet_core,
        "observation_count": len(observations),
        "error_count": len(errors),
        "payload_checksum": _sha256(packet_core),
    }
