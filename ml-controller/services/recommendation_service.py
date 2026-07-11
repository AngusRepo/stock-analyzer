"""
recommendation_service.py ??Compute recommendations + write D1
2026-04-07 LangGraph A+B refactor

Direct port of worker/src/lib/dailyRecommendation.ts:540-758 core logic:
  - filter SELL/NO_SIGNAL
  - compute ml_score (0-30)
  - hybrid ranking promotion (Sprint 3 P0-4 Architecture C)
  - build template reason / watchPoints
  - bulk D1 update via d1_client.batch_execute
"""
from __future__ import annotations
import json
import logging
import math
import copy
from datetime import datetime, timedelta, timezone
from numbers import Integral, Real
from typing import Any, Optional

from services import d1_client
from services._predictions_schema import (
    COL_STOCK_ID,
    COL_MODEL_NAME,
    COL_GENERATED_AT,
    COL_PREDICTION_DATE,
    COL_HORIZON,
    COL_DIRECTION_ACCURACY,
    COL_FORECAST_DATA,
    COL_ENTRY_PRICE,
    COL_STOP_LOSS,
    COL_TARGET1,
    COL_TARGET2,
    COL_TRADE_SIGNAL,
    COL_FEATURE_VERSION,
    COL_SIGNAL_RAW,
    INSERT_PREDICTIONS_SQL,
)
from services.alpha_framework import (
    apply_alpha_context,
    build_alpha_context,
    normalize_alpha_policy,
    regime_aware_allocate,
)
from services.active_model_policy import gnn_return_history_lookback
from services.fundamental_quality import score_fundamental_quality
from services.market_segment_policy import normalize_segment, policy_for_segment
from services.portfolio_allocation import allocate_sparse_tangent_with_evidence
from services.similarity_evidence import (
    apply_cluster_exposure_cap,
    similarity_components,
    symbol_cluster_evidence,
)
from services.l4_alpha_ev_producer import materialize_l4_alpha_ev
from services.l4_alpha_ev_resolver import extract_l4_alpha_ev
from services.s12_trade_ev import extract_s12_trade_ev
from services.allocator_ev_fusion import materialize_allocator_ev_fusion
from services.timesfm_l175_sidecar import build_timesfm_l175_sidecar

logger = logging.getLogger(__name__)

D1_IN_CLAUSE_CHUNK_SIZE = 80
POTENTIAL_BUY_SIGNAL = "POTENTIAL_BUY"
POTENTIAL_BUY_SELECTION_REASON = "positive_edge_but_zero_weight_due_to_better_alternative"
POTENTIAL_BUY_POLICY = "positive_expected_edge_zero_sparse_weight_not_final_buy"
POTENTIAL_BUY_MIN_EXPECTED_RETURN = 0.005
FORMAL_BUY_SIGNALS = {"BUY", "STRONG_BUY"}


def _normalized_signal(value: Any) -> str:
    return str(value or "").strip().upper()


def _is_formal_buy_signal(value: Any) -> bool:
    return _normalized_signal(value) in FORMAL_BUY_SIGNALS


def _dedupe_preserve_order(values: list[Any]) -> list[Any]:
    seen: set[Any] = set()
    out: list[Any] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        out.append(value)
    return out


def _chunked(values: list[Any], size: int = D1_IN_CLAUSE_CHUNK_SIZE) -> list[list[Any]]:
    if size <= 0:
        raise ValueError("chunk size must be positive")
    unique_values = _dedupe_preserve_order(values)
    return [unique_values[i:i + size] for i in range(0, len(unique_values), size)]


def _prediction_delete_date_expr(run_date: str | None) -> tuple[str, list[Any]]:
    """Align prediction dedupe with the pipeline business date when available."""
    if run_date:
        return f"{COL_PREDICTION_DATE} = ?", [run_date]
    return f"{COL_PREDICTION_DATE} = date('now', '+8 hours')", []


def _require_prediction_feature_version(symbol: str, data: dict) -> str:
    feature_version = str(data.get("feature_version") or "").strip()
    if not feature_version:
        raise ValueError(
            f"missing_feature_version_contract: symbol={symbol} "
            "prediction writer requires canonical feature_version"
        )
    return feature_version


def prune_predictions_outside_universe(stock_ids: list[int], run_date: str) -> int:
    """Remove same-date prediction rows that no longer belong to the current V2 universe."""
    safe_ids = {int(stock_id) for stock_id in stock_ids if stock_id}
    if not safe_ids:
        result = d1_client.execute(
            f"DELETE FROM predictions WHERE {COL_PREDICTION_DATE} = ?",
            [run_date],
            timeout=60,
        )
        return int(((result or {}).get("meta") or {}).get("changes") or 0)

    existing_rows = d1_client.query(
        f"SELECT DISTINCT {COL_STOCK_ID} AS stock_id FROM predictions WHERE {COL_PREDICTION_DATE} = ?",
        [run_date],
        timeout=60,
    )
    stale_ids = sorted({
        int(row["stock_id"])
        for row in existing_rows or []
        if row.get("stock_id") is not None and int(row["stock_id"]) not in safe_ids
    })
    deleted = 0
    for chunk in _chunked(stale_ids):
        placeholders = ",".join("?" for _ in chunk)
        result = d1_client.execute(
            f"DELETE FROM predictions WHERE {COL_PREDICTION_DATE} = ? AND {COL_STOCK_ID} IN ({placeholders})",
            [run_date, *chunk],
            timeout=60,
        )
        deleted += int(((result or {}).get("meta") or {}).get("changes") or 0)
    return deleted


def _sanitize_non_finite(value: Any) -> tuple[Any, int]:
    """Convert NaN/Inf values to None before JSON encoding / HTTP transport."""
    if value is None or isinstance(value, (str, bool)):
        return value, 0
    if isinstance(value, Integral):
        return int(value), 0
    if isinstance(value, Real):
        numeric = float(value)
        if not math.isfinite(numeric):
            return None, 1
        return numeric, 0
    if isinstance(value, dict):
        sanitized: dict[Any, Any] = {}
        replaced = 0
        for key, nested in value.items():
            sanitized_value, nested_replaced = _sanitize_non_finite(nested)
            sanitized[key] = sanitized_value
            replaced += nested_replaced
        return sanitized, replaced
    if isinstance(value, (list, tuple, set)):
        sanitized_list: list[Any] = []
        replaced = 0
        for nested in value:
            sanitized_value, nested_replaced = _sanitize_non_finite(nested)
            sanitized_list.append(sanitized_value)
            replaced += nested_replaced
        return sanitized_list, replaced
    return value, 0


def _enrich_stock_meta_with_segment_policy(stock_meta: dict | None) -> dict:
    """Attach segment calibration/parity metadata and enforce execution hard gates."""
    meta = dict(stock_meta or {})
    segment = normalize_segment(meta.get("market_segment") or meta.get("market"))
    policy = policy_for_segment(segment)
    lane = str(meta.get("recommendation_lane") or "").strip() or policy.recommendation_lane
    if not policy.eligible_for_execution:
        lane = policy.recommendation_lane
    eligible_for_execution = bool(policy.eligible_for_execution and lane == "tradable")

    meta.update({
        "market_segment": segment,
        "recommendation_lane": lane,
        "eligible_for_ml": bool(meta.get("eligible_for_ml", policy.eligible_for_ml)),
        "eligible_for_execution": eligible_for_execution,
        "eligible_for_pending_buy": eligible_for_execution,
        "segment_serving_mode": policy.serving_mode,
        "segment_model_pool_scope": policy.model_pool_scope,
        "segment_calibration_scope": policy.calibration_scope,
        "segment_calibration_artifact_prefix": policy.calibration_artifact_prefix,
        "train_serve_parity_required": policy.train_serve_parity_required,
        "segment_min_ic_samples": policy.min_ic_samples,
        "segment_min_active_days": policy.min_active_days,
    })
    return meta


def _state_space_overlay_payload(data: dict) -> dict[str, Any] | None:
    """Persist state-space overlays for shadow attribution, not alpha voting."""
    overlays: dict[str, Any] = {}
    for source_key, output_key in (
        ("kalman_filter", "kalman_filter"),
        ("markov_switching", "markov_switching"),
    ):
        value = data.get(source_key)
        if (
            isinstance(value, dict)
            and not value.get("error")
            and not value.get("degraded")
            and not value.get("fallback_reason")
        ):
            overlays[output_key] = value
    if not overlays:
        return None
    return {
        "schema_version": "state-space-overlays-v1",
        **overlays,
    }


def _finite_float_or_none(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _price_log_return(forecast_price: Any, reference_price: Any) -> float | None:
    forecast = _finite_float_or_none(forecast_price)
    reference = _finite_float_or_none(reference_price)
    if forecast is None or reference is None or forecast <= 0 or reference <= 0:
        return None
    return math.log(forecast / reference)


def _numeric_series_from_signal(signal: dict[str, Any]) -> list[float]:
    for key in (
        "forecast_return_path",
        "forecast_pct_path",
        "forecast_path_pct",
        "path_pct",
        "return_path",
    ):
        raw = signal.get(key)
        if not isinstance(raw, list):
            continue
        values = [_finite_float_or_none(item) for item in raw]
        values = [item for item in values if item is not None]
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


def _timesfm_sidecar_payload(data: dict) -> dict[str, Any] | None:
    """Build L2 TimesFM feature sidecar without restoring direct-alpha voting."""
    stock_meta = data.get("stock_meta") if isinstance(data.get("stock_meta"), dict) else {}
    existing = stock_meta.get("timesfm_l175_sidecar") if isinstance(stock_meta, dict) else None
    if isinstance(existing, dict):
        return existing
    return build_timesfm_l175_sidecar(
        data,
        release_policy=data.get("timesfm_l175_release_policy")
        if isinstance(data.get("timesfm_l175_release_policy"), dict)
        else None,
    )


# ?????????????????????????????????????????????????????????????????????????????
# ML score calculation (port from dailyRecommendation.ts:558-568)
# ?????????????????????????????????????????????????????????????????????????????

def _ml_thresholds_from_ensemble_v2(ev2: dict[str, Any]) -> dict[str, float] | None:
    policy = ev2.get("ml_threshold_policy")
    policy_thresholds = policy.get("thresholds") if isinstance(policy, dict) else None
    raw_thresholds = policy_thresholds if isinstance(policy_thresholds, dict) else ev2.get("rank_signal_thresholds")
    if not isinstance(raw_thresholds, dict):
        return None
    thresholds = {
        "strongBuyThreshold": _finite_float_or_none(raw_thresholds.get("strongBuyThreshold")),
        "buyThreshold": _finite_float_or_none(raw_thresholds.get("buyThreshold")),
        "sellThreshold": _finite_float_or_none(raw_thresholds.get("sellThreshold")),
        "strongSellThreshold": _finite_float_or_none(raw_thresholds.get("strongSellThreshold")),
    }
    if any(value is None for value in thresholds.values()):
        return None
    strong_buy = thresholds["strongBuyThreshold"]
    buy = thresholds["buyThreshold"]
    sell = thresholds["sellThreshold"]
    strong_sell = thresholds["strongSellThreshold"]
    if not (0 <= strong_sell < sell < buy < strong_buy <= 1):
        return None
    return {key: float(value) for key, value in thresholds.items() if value is not None}


def _linear_between(value: float, left: float, right: float, low: float, high: float) -> float:
    if right <= left:
        return low
    ratio = max(0.0, min(1.0, (value - left) / (right - left)))
    return low + ratio * (high - low)


def _ml_threshold_policy_edge_seed30(ev2: dict[str, Any]) -> tuple[float | None, dict[str, Any] | None]:
    """Score ML EDGE from promoted threshold-policy provenance, not legacy signal tiers."""
    if not isinstance(ev2, dict) or not ev2:
        return None, None
    policy = ev2.get("ml_threshold_policy")
    if not isinstance(policy, dict):
        return None, None
    weight_total = _finite_float_or_none(ev2.get("weight_total")) or 0.0
    reason = str(ev2.get("reason") or "")
    thresholds = _ml_thresholds_from_ensemble_v2(ev2)
    avg_rank = _finite_float_or_none(ev2.get("avg_rank"))
    evidence: dict[str, Any] = {
        "schema_version": "score-v2-ml-edge-policy-v1",
        "source": "ensemble_v2.ml_threshold_policy",
        "policy_id": policy.get("policy_id"),
        "version": policy.get("version"),
        "selected_regime": policy.get("selected_regime") or policy.get("regime"),
        "evidence_hash": policy.get("evidence_hash"),
        "signal": ev2.get("signal"),
        "avg_rank": avg_rank,
        "thresholds": thresholds,
        "weight_total": weight_total,
        "contributing_models": ev2.get("contributing_models") or [],
    }
    if weight_total <= 0 or reason == "no_positive_lifecycle_weight":
        evidence.update({
            "score_seed30": 0.0,
            "status": "blocked",
            "reason": reason or "non_positive_weight_total",
        })
        return 0.0, evidence
    if avg_rank is None or thresholds is None:
        return None, None

    strong_buy = thresholds["strongBuyThreshold"]
    buy = thresholds["buyThreshold"]
    sell = thresholds["sellThreshold"]
    strong_sell = thresholds["strongSellThreshold"]
    if avg_rank >= strong_buy:
        score = _linear_between(avg_rank, strong_buy, 1.0, 26.0, 30.0)
    elif avg_rank >= buy:
        score = _linear_between(avg_rank, buy, strong_buy, 18.0, 26.0)
    elif avg_rank >= 0.5:
        score = _linear_between(avg_rank, 0.5, buy, 8.0, 18.0)
    elif avg_rank > sell:
        score = _linear_between(avg_rank, sell, 0.5, 3.0, 8.0)
    elif avg_rank > strong_sell:
        score = _linear_between(avg_rank, strong_sell, sell, 0.0, 3.0)
    else:
        score = 0.0
    score = _round1(max(0.0, min(30.0, score)))
    evidence.update({
        "score_seed30": score,
        "status": "scored",
        "buy_distance": _round1(avg_rank - buy),
        "sell_distance": _round1(avg_rank - sell),
    })
    return score, evidence


def _ml_edge_policy_evidence(raw_prediction: dict | None) -> dict[str, Any] | None:
    ev2 = (raw_prediction or {}).get("ensemble_v2") or {}
    _score, evidence = _ml_threshold_policy_edge_seed30(ev2)
    return evidence


def overlay_ml_threshold_policy_source_of_truth(
    predictions: dict[str, dict],
    policy_evidence: dict[str, Any],
    *,
    force: bool = True,
) -> dict[str, dict]:
    """Return prediction copies with threshold-policy provenance attached.

    This is for local/read-only rescoring and rerun previews. Runtime pipeline
    should still attach policy evidence before scoring and fail closed when the
    evidence is absent.
    """
    if not isinstance(policy_evidence, dict) or not policy_evidence:
        raise ValueError("policy_evidence is required for local threshold-policy rescore")
    thresholds = policy_evidence.get("thresholds")
    if not isinstance(thresholds, dict) or not thresholds:
        raise ValueError("policy_evidence.thresholds is required for local threshold-policy rescore")

    out: dict[str, dict] = {}
    for symbol, prediction in (predictions or {}).items():
        row = copy.deepcopy(prediction) if isinstance(prediction, dict) else {}
        ev2 = row.get("ensemble_v2")
        if not isinstance(ev2, dict):
            out[symbol] = row
            continue
        if force or not isinstance(ev2.get("ml_threshold_policy"), dict):
            ev2["ml_threshold_policy"] = copy.deepcopy(policy_evidence)
            ev2["rank_signal_thresholds"] = copy.deepcopy(thresholds)
        out[symbol] = row
    return out


def calculate_ml_score(prediction: dict, raw_prediction: dict | None = None) -> float:
    """Compute ml_score 0-30 from actual model evidence.

    Ranking/top-K promotion is an execution/recommendation policy, not a model
    vote. If lifecycle weighting has no positive contributors, keep the row
    eligible for downstream T2/debate via signal, but do not inflate ML score.
    """
    if not prediction:
        return 0.0
    source = str(prediction.get("signal_source") or "")
    ev2 = (raw_prediction or {}).get("ensemble_v2") or {}
    if ev2:
        policy_score, _evidence = _ml_threshold_policy_edge_seed30(ev2)
        if policy_score is not None:
            return _round1(policy_score)
        return 0.0
    sig = _normalized_signal(prediction.get("signal"))
    score = 0.0
    if sig == "STRONG_BUY":
        score += 25
    elif sig == "BUY":
        score += 18
    elif sig == "HOLD":
        score += 8
    score += (prediction.get("confidence") or 0) * 10
    fc = prediction.get("forecast_pct") or 0
    if fc > 0.03:
        score += 5
    elif fc > 0.01:
        score += 2
    score = max(0.0, min(30.0, score))
    return _round1(score)


def _effective_prediction_view(ml: dict | None, use_ensemble_v2: bool = True) -> dict:
    """Normalize recommendation-facing ML fields to a single source of truth.

    When ensemble_v2 is enabled and present, downstream scoring/reasoning/storage
    should read signal/confidence/forecast from ensemble_v2 instead of the legacy
    score_to_signal path. This keeps filter, score, and displayed signal aligned.
    """
    if not ml:
        return {
            "signal": None,
            "confidence": 0.0,
            "forecast_pct": None,
            "forecast_pct_source": "missing",
            "forecast_return_5bar": None,
            "forecast_return_5bar_source": "missing",
            "expected_return": None,
            "expected_return_source": "missing",
            "expected_return_owner": "missing",
            "trade_expected_return_net_pct": None,
            "trade_expected_return_source": "missing",
            "l4_alpha_ev": None,
            "signal_source": "missing",
            "signal_raw": None,
        }

    legacy_signal = ml.get("signal")
    legacy_conf = (ml.get("confidence") if ml.get("confidence") is not None else 0.0) or 0.0
    legacy_forecast = (ml.get("forecast_pct") if ml.get("forecast_pct") is not None else 0.0) or 0.0

    if use_ensemble_v2:
        ev2 = ml.get("ensemble_v2") or {}
        if ev2.get("signal"):
            confidence = ev2.get("confidence") if ev2.get("confidence") is not None else legacy_conf
            l4_alpha_ev = (
                ev2.get("l4_alpha_ev")
                or ev2.get("alpha_ev")
                or ml.get("l4_alpha_ev")
                or ml.get("alpha_ev")
                or ml.get("alpha_ev_prediction")
            )
            return {
                "signal": ev2.get("signal"),
                "confidence": confidence,
                "forecast_pct": ev2.get("forecast_pct"),
                "forecast_pct_source": ev2.get("forecast_pct_source") or "ensemble_v2",
                "forecast_return_5bar": ev2.get("forecast_return_5bar", ev2.get("forecast_pct")),
                "forecast_return_5bar_source": (
                    ev2.get("forecast_return_5bar_source")
                    or ev2.get("forecast_pct_source")
                    or "ensemble_v2"
                ),
                "expected_return": ev2.get("expected_return"),
                "expected_return_source": (
                    ev2.get("expected_return_source")
                    or "s12_trade_ev_required"
                ),
                "expected_return_owner": ev2.get("expected_return_owner") or "s12_trade_ev",
                "trade_expected_return_net_pct": ev2.get("trade_expected_return_net_pct"),
                "trade_expected_return_source": ev2.get("trade_expected_return_source") or "s12_trade_ev_missing",
                "l4_alpha_ev": l4_alpha_ev,
                "signal_source": ev2.get("signal_source") or "ensemble_v2",
                "signal_raw": ev2.get("signal_raw") or legacy_signal,
            }

    return {
        "signal": legacy_signal,
        "confidence": legacy_conf,
        "forecast_pct": legacy_forecast,
        "forecast_pct_source": "legacy",
        "forecast_return_5bar": legacy_forecast,
        "forecast_return_5bar_source": "legacy_forecast_pct",
        "expected_return": None,
        "expected_return_source": "legacy_forecast_pct_not_trade_ev",
        "expected_return_owner": "s12_trade_ev",
        "trade_expected_return_net_pct": None,
        "trade_expected_return_source": "s12_trade_ev_missing",
        "l4_alpha_ev": ml.get("l4_alpha_ev") or ml.get("alpha_ev") or ml.get("alpha_ev_prediction"),
        "signal_source": "legacy",
        "signal_raw": legacy_signal,
    }


# ?????????????????????????????????????????????????????????????????????????????
# Filter + score (port from dailyRecommendation.ts:541-613)
# ?????????????????????????????????????????????????????????????????????????????

def _effective_signal(ml: dict | None, use_ensemble_v2: bool = True) -> str | None:
    """ML_POOL Plan A migration helper ??prefer ensemble_v2.signal over legacy signal.

    Returns the signal string (uppercase) used for downstream BUY/SELL filter.
    If ensemble_v2 absent or use_ensemble_v2=False ??falls back to legacy
    feature-model score_to_signal output. When time-series models have
    no IC data yet, ensemble_v2 weight for them = 0 ??ensemble_v2.signal is
    mathematically equivalent to legacy signal, so migration is no-op until
    IC tracker accumulates time-series IC (Stage 2 cron, ~3-4 weeks).
    """
    eff = _effective_prediction_view(ml, use_ensemble_v2=use_ensemble_v2)
    return (eff.get("signal") or "").upper() or None


def _is_use_ensemble_v2() -> bool:
    """Read trading:config.mlPool.useEnsembleV2 (default True). KV override."""
    from services.trading_config_loader import load_merged_trading_config

    tcfg = load_merged_trading_config()
    ml_pool_cfg = tcfg.get("mlPool", {}) or {}
    v = ml_pool_cfg.get("useEnsembleV2")
    return True if v is None else bool(v)


def _sorted_payload_rows(payload: dict, key: str) -> list[dict]:
    rows = [row for row in (payload.get(key) or []) if isinstance(row, dict)]
    if any(row.get("date") for row in rows):
        return sorted(rows, key=lambda row: str(row.get("date") or ""))
    return rows


def build_ml_vote_summary(ml: dict | None, eff_ml: dict, legacy_counts: dict[str, int]) -> str:
    """Build recommendation-facing ML text from the same source used for scoring."""
    signal = _normalized_signal(eff_ml.get("signal"))
    source = str(eff_ml.get("signal_source") or "")
    forecast_raw = eff_ml.get("forecast_pct")
    forecast_text = "forecast unavailable" if forecast_raw is None else f"{float(forecast_raw) * 100:+.1f}%"
    ev2 = (ml or {}).get("ensemble_v2") or {}

    contributors = ev2.get("contributing_models") or []
    if ev2 and float(ev2.get("weight_total") or 0.0) <= 0:
        return "V2 ensemble 暫無正 IC 權重；持續驗證 IC evidence。"
    if contributors:
        label = "buy" if _is_formal_buy_signal(signal) else "hold" if signal == "HOLD" else "sell"
        return f"V2 ensemble {label}: {len(contributors)} contributing models, forecast {forecast_text}."

    total = legacy_counts.get("total", 0)
    up = legacy_counts.get("up", 0)
    down = legacy_counts.get("down", 0)
    if total <= 0:
        return "ML evidence unavailable"
    if _is_formal_buy_signal(signal):
        return f"ML buy: {up}/{total} models point up, forecast {forecast_text}."
    if signal == "HOLD":
        if up > down:
            return f"ML hold: {up}/{total} models lean up but signal stayed below buy threshold."
        if down > up:
            return f"ML hold: {down}/{total} models lean down, no positive edge."
        return f"ML hold: mixed direction {up}/{down}."
    return "ML sell"


def _forecast_fraction_to_pct(raw: Any) -> float | None:
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(value):
        return None
    return round(value * 100.0, 4)


def build_ml_vote_summary_data(ml: dict | None, legacy_counts: dict[str, int]) -> dict[str, Any]:
    """Structured ML vote evidence for UI/OBS; text reasons are derived elsewhere."""
    ev2 = (ml or {}).get("ensemble_v2") or {}
    tracked = [
        "XGBoost", "ExtraTrees", "LightGBM",
        "TabM", "GNN",
        "DLinear", "PatchTST", "iTransformer",
    ]
    weights = ev2.get("weights") if isinstance(ev2.get("weights"), dict) else {}
    active_weight_count = 0
    for name, value in weights.items():
        if name not in tracked:
            continue
        numeric = _sanitize_non_finite(value)[0]
        if isinstance(numeric, Real) and float(numeric) > 0:
            active_weight_count += 1
    zero_weight_models = [
        name for name in tracked
        if name in weights and _sanitize_non_finite(weights.get(name))[0] in (0, 0.0, None)
    ]
    thresholds = ev2.get("rank_signal_thresholds") if isinstance(ev2.get("rank_signal_thresholds"), dict) else {}
    diagnostics = ev2.get("ic_weight_diagnostics") if isinstance(ev2.get("ic_weight_diagnostics"), dict) else {}
    validation_blocked_models = [
        name for name, detail in diagnostics.items()
        if name in tracked
        and isinstance(detail, dict)
        and str(detail.get("validation_status") or "").upper() == "FAIL"
    ]

    model_scores: dict[str, float] = {}
    rank_scores = (ml or {}).get("rank_scores") or {}
    if isinstance(rank_scores, dict):
        for name in ["XGBoost", "ExtraTrees", "LightGBM", "TabM", "GNN"]:
            try:
                if rank_scores.get(name) is not None:
                    model_scores[name] = float(rank_scores[name])
            except (TypeError, ValueError):
                continue
    for src_key, model_name in (
        ("dlinear", "DLinear"),
        ("patchtst", "PatchTST"),
        ("itransformer", "iTransformer"),
    ):
        sig = (ml or {}).get(src_key) or {}
        try:
            if sig.get("forecast_pct") is not None:
                model_scores[model_name] = 1.0 / (1.0 + math.exp(-float(sig["forecast_pct"]) * 12.0))
        except (TypeError, ValueError, OverflowError):
            continue

    if model_scores:
        bullish = sum(1 for value in model_scores.values() if value >= 0.55)
        bearish = sum(1 for value in model_scores.values() if value <= 0.45)
        flat = max(0, len(model_scores) - bullish - bearish)
        raw_forecast_pct = ev2.get("forecast_pct")
        return {
            "bullish": bullish,
            "bearish": bearish,
            "flat": flat,
            "reported": len(model_scores),
            "missing": max(0, len(tracked) - len(model_scores)),
            "total": len(tracked),
            "forecast_pct": raw_forecast_pct,
            "forecastPct": _forecast_fraction_to_pct(raw_forecast_pct),
            "forecastPctSource": ev2.get("forecast_pct_source"),
            "activeWeightCount": active_weight_count,
            "zeroWeightModels": zero_weight_models,
            "thresholds": {
                "bullish": thresholds.get("buyThreshold"),
                "bearish": thresholds.get("sellThreshold"),
                "strongBullish": thresholds.get("strongBuyThreshold"),
                "strongBearish": thresholds.get("strongSellThreshold"),
            } if thresholds else None,
            "icWeightScope": ev2.get("ic_weight_scope"),
            "validationBlockedModels": validation_blocked_models,
            "source": ev2.get("signal_source") or (ml or {}).get("signal_source") or "unknown",
            "signalRaw": ev2.get("signal_raw") or (ml or {}).get("signal_raw"),
            "contributingModels": [
                name for name in (ev2.get("contributing_models") or [])
                if name in tracked
            ],
            "allocatorLearningLedger": (
                ev2.get("allocator_learning_ledger")
                if isinstance(ev2.get("allocator_learning_ledger"), dict)
                else None
            ),
            "familyVote": ev2.get("family_vote") if isinstance(ev2.get("family_vote"), dict) else None,
        }

    models = (ml or {}).get("models") or []
    if isinstance(models, dict):
        iterable = list(models.values())
    elif isinstance(models, list):
        iterable = models
    else:
        iterable = []

    bullish = bearish = flat = 0
    for model in iterable:
        if not isinstance(model, dict):
            continue
        direction = str(model.get("direction") or model.get("signal") or "").lower()
        if "up" in direction or "buy" in direction or "bull" in direction:
            bullish += 1
        elif "down" in direction or "sell" in direction or "bear" in direction:
            bearish += 1
        else:
            flat += 1

    reported = bullish + bearish + flat
    if reported == 0:
        bullish = int(legacy_counts.get("up", 0) or 0)
        bearish = int(legacy_counts.get("down", 0) or 0)
        reported = int(legacy_counts.get("total", 0) or 0)
        flat = max(0, reported - bullish - bearish)

    total = max(8, reported)
    raw_forecast_pct = ev2.get("forecast_pct")
    return {
        "bullish": bullish,
        "bearish": bearish,
        "flat": flat,
        "reported": reported,
        "missing": max(0, total - reported),
        "total": total,
        "forecast_pct": raw_forecast_pct,
        "forecastPct": _forecast_fraction_to_pct(raw_forecast_pct),
        "forecastPctSource": ev2.get("forecast_pct_source"),
        "activeWeightCount": active_weight_count,
        "zeroWeightModels": zero_weight_models,
        "thresholds": {
            "bullish": thresholds.get("buyThreshold"),
            "bearish": thresholds.get("sellThreshold"),
            "strongBullish": thresholds.get("strongBuyThreshold"),
            "strongBearish": thresholds.get("strongSellThreshold"),
        } if thresholds else None,
        "icWeightScope": ev2.get("ic_weight_scope"),
        "validationBlockedModels": validation_blocked_models,
        "source": ev2.get("signal_source") or (ml or {}).get("signal_source") or "unknown",
        "signalRaw": ev2.get("signal_raw") or (ml or {}).get("signal_raw"),
        "contributingModels": ev2.get("contributing_models") or [],
        "allocatorLearningLedger": (
            ev2.get("allocator_learning_ledger")
            if isinstance(ev2.get("allocator_learning_ledger"), dict)
            else None
        ),
        "familyVote": ev2.get("family_vote") if isinstance(ev2.get("family_vote"), dict) else None,
    }


def _build_alpha_adjustment_details(alpha_context: dict[str, Any], alpha_policy: dict | None = None) -> list[dict[str, Any]]:
    if not isinstance(alpha_context, dict):
        return []
    bucket = alpha_context.get("edge_bucket")
    regime_weight = alpha_context.get("regime_weight")
    risk_overlay = alpha_context.get("risk_overlay") or {}
    risk_flags = risk_overlay.get("flags") or []
    scoring = normalize_alpha_policy(alpha_policy)["scoring"]
    bucket_bonus = _float_or_none(scoring["bucket_bonus"].get(str(bucket))) if bucket else None
    regime_delta = None
    if regime_weight is not None:
        regime_delta = (float(regime_weight) - 1.0) * scoring["regime_weight_impact"]
    risk_penalty = float(risk_overlay.get("penalty") or 0.0) * scoring["overlay_penalty_impact"]
    details: list[dict[str, Any]] = []
    if bucket_bonus is not None:
        details.append({
            "key": "bucket_bonus",
            "label": "Edge bucket",
            "value": round(bucket_bonus, 2),
            "explain": "Adds the configured score bonus for the ML edge bucket.",
        })
    if regime_delta is not None:
        details.append({
            "key": "regime_weight",
            "label": "Regime weight",
            "value": round(regime_delta, 2),
            "explain": "Applies the market-regime weight adjustment.",
        })
    market_heat_alpha = _float_or_none(alpha_context.get("market_heat_alpha"))
    if market_heat_alpha:
        details.append({
            "key": "market_heat_alpha",
            "label": "Market heat",
            "value": round(market_heat_alpha, 2),
            "score": alpha_context.get("market_heat_score"),
            "marketHeatOverlay": alpha_context.get("market_heat_expected_return"),
            "explain": "Adds the momentum/relative-strength score overlay; it is not allocator expected return.",
        })
    if risk_penalty:
        flag_text = ", ".join(str(flag) for flag in risk_flags) if risk_flags else "risk_overlay"
        details.append({
            "key": "risk_overlay",
            "label": "Risk overlay",
            "value": -round(risk_penalty, 2),
            "flags": risk_flags,
            "explain": f"Subtracts the configured risk-overlay penalty for {flag_text}.",
        })
    return details


SCORE_V2_VERSION = "score_v2"
SCORE_V2_WEIGHTS = {
    "mlEdge": 25,
    "chipFlow": 25,
    "technicalStructure": 25,
    "fundamentalQuality": 25,
    "newsTheme": 0,
}


def _score_number(value: Any, fallback: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return number if math.isfinite(number) else fallback


def _parse_score_components_payload(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        payload = value
    elif isinstance(value, str):
        try:
            parsed = json.loads(value)
        except (json.JSONDecodeError, TypeError):
            return None
        payload = parsed if isinstance(parsed, dict) else None
    else:
        payload = None
    if not (isinstance(payload, dict) and payload.get("version") == SCORE_V2_VERSION):
        return None
    return payload


def _parse_json_dict(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except (json.JSONDecodeError, TypeError):
            return None
        return parsed if isinstance(parsed, dict) else None
    return None


def _round1(value: float) -> float:
    return math.floor(float(value) * 10 + 0.5) / 10


def _clamp_score(value: Any, maximum: float) -> float:
    return _round1(max(0.0, min(float(maximum), _score_number(value))))


def _rescale_score(value: Any, old_max: float, new_max: float) -> float:
    if old_max <= 0:
        return 0.0
    return _clamp_score((_score_number(value) / old_max) * new_max, new_max)


def _first_float(*values: Any) -> float | None:
    for value in values:
        parsed = _float_or_none(value)
        if parsed is not None:
            return parsed
    return None


def _score_v2_seed_inputs(row: dict) -> dict[str, float]:
    seeds = row.get("score_seed_inputs")
    if not isinstance(seeds, dict):
        seeds = row.get("seedComponents")
    if isinstance(seeds, dict):
        return {
            "chipFlowSeed40": _score_number(seeds.get("chipFlowSeed40")),
            "technicalSeed30": _score_number(seeds.get("technicalSeed30")),
            "screenerMomentumSeed20": _score_number(seeds.get("screenerMomentumSeed20")),
            "mlEdgeSeed30": _score_number(seeds.get("mlEdgeSeed30")),
            "personaAlphaSeed": _score_number(seeds.get("personaAlphaSeed")),
        }
    raise ValueError("Score V2 seed inputs required: missing score_seed_inputs")


def _score_v2_seed_inputs_from_payload(payload: dict[str, Any] | None, *, ml_score: float) -> dict[str, float] | None:
    if not payload:
        return None
    seeds = payload.get("seedComponents")
    if isinstance(seeds, dict):
        return {
            "chipFlowSeed40": _score_number(seeds.get("chipFlowSeed40")),
            "technicalSeed30": _score_number(seeds.get("technicalSeed30")),
            "screenerMomentumSeed20": _score_number(seeds.get("screenerMomentumSeed20")),
            "mlEdgeSeed30": ml_score,
            "personaAlphaSeed": 0.0,
        }
    components = payload.get("components")
    if not isinstance(components, dict):
        return None
    chip_seed = _rescale_score(components.get("chipFlow"), SCORE_V2_WEIGHTS["chipFlow"], 40)
    combined_technical_seed = _rescale_score(
        components.get("technicalStructure"),
        SCORE_V2_WEIGHTS["technicalStructure"],
        50,
    )
    technical_breakdown = payload.get("technicalBreakdown")
    volume_confirmation = (
        _score_number(technical_breakdown.get("volumeConfirmation"))
        if isinstance(technical_breakdown, dict)
        else 0.0
    )
    momentum_seed = _rescale_score(volume_confirmation, 6, 20) if volume_confirmation > 0 else 0.0
    momentum_seed = _round1(min(momentum_seed, combined_technical_seed, 20.0))
    technical_seed = _round1(min(max(combined_technical_seed - momentum_seed, 0.0), 30.0))
    if technical_seed + momentum_seed < combined_technical_seed:
        momentum_seed = _round1(min(20.0, momentum_seed + (combined_technical_seed - technical_seed - momentum_seed)))
    return {
        "chipFlowSeed40": chip_seed,
        "technicalSeed30": technical_seed,
        "screenerMomentumSeed20": momentum_seed,
        "mlEdgeSeed30": ml_score,
        "personaAlphaSeed": 0.0,
    }


def load_fundamental_quality_by_symbol(screener_recs: list[dict], decision_date: str) -> dict[str, dict[str, Any]]:
    """Read D1 fundamental inputs and return Score V2 fundamental-quality payloads.

    This is read-only and fail-soft. Missing FinLab canonical rows should not
    block the daily pipeline; they leave fundamentalQuality at 0 until FinLab
    structured materialization is available.
    """

    if not screener_recs:
        return {}
    symbols = sorted({str(row.get("symbol") or "").strip() for row in screener_recs if row.get("symbol")})
    revenue_by_symbol: dict[str, list[dict[str, Any]]] = {symbol: [] for symbol in symbols}
    canonical_financial_by_symbol: dict[str, list[dict[str, Any]]] = {symbol: [] for symbol in symbols}

    if symbols:
        try:
            for chunk in _chunked(symbols):
                placeholders = ",".join("?" for _ in chunk)
                rows = d1_client.query(
                    f"""
                    SELECT stock_id, revenue_month, market_segment, revenue, mom, yoy, source, as_of_date
                    FROM canonical_revenue_monthly
                    WHERE stock_id IN ({placeholders})
                    ORDER BY stock_id, revenue_month
                    """,
                    chunk,
                    timeout=60,
                )
                for row in rows or []:
                    symbol = str(row.get("stock_id") or "").strip()
                    if symbol in revenue_by_symbol:
                        revenue_by_symbol[symbol].append(dict(row))
        except Exception as exc:  # noqa: BLE001
            logger.warning("[reco] canonical_revenue_monthly unavailable for fundamental quality: %s", exc)

        try:
            for chunk in _chunked(symbols):
                placeholders = ",".join("?" for _ in chunk)
                rows = d1_client.query(
                    f"""
                    SELECT stock_id, period, market_segment, report_date, available_date,
                           revenue_growth_yoy, gross_margin, operating_margin, roe, eps,
                           pe, pb, dividend_yield, debt_ratio, current_ratio,
                           operating_cash_flow, industry_quality_percentile,
                           roa, roa_comprehensive, roe_comprehensive,
                           free_cash_flow, net_margin, quick_ratio, cash_flow_ratio,
                           equity_to_assets, liabilities_to_equity,
                           gross_margin_growth, operating_income_growth,
                           net_income_growth, recurring_income_growth,
                           total_asset_turnover, receivables_turnover,
                           inventory_turnover, interest_expense_ratio,
                           source, as_of_date
                    FROM canonical_fundamental_features
                    WHERE stock_id IN ({placeholders})
                      AND available_date <= ?
                      AND source = 'finlab.fundamental_factor_diversity'
                    ORDER BY stock_id, available_date, period
                    """,
                    [*chunk, decision_date],
                    timeout=60,
                )
                for row in rows or []:
                    symbol = str(row.get("stock_id") or "").strip()
                    if symbol in canonical_financial_by_symbol:
                        canonical_financial_by_symbol[symbol].append(dict(row))
        except Exception as exc:  # noqa: BLE001
            logger.warning("[reco] canonical_fundamental_features unavailable for fundamental quality: %s", exc)

    out: dict[str, dict[str, Any]] = {}
    for rec in screener_recs:
        symbol = str(rec.get("symbol") or "").strip()
        if not symbol:
            continue
        out[symbol] = score_fundamental_quality(
            decision_date=decision_date,
            revenue_rows=revenue_by_symbol.get(symbol, []),
            financial_rows=canonical_financial_by_symbol.get(symbol, []),
        )
    return out


def _score_v2_components_from_row(row: dict) -> dict[str, float]:
    payload = _parse_score_components_payload(row.get("score_components"))
    if isinstance(payload, dict) and payload.get("version") == SCORE_V2_VERSION and isinstance(payload.get("components"), dict):
        components = payload["components"]
        ml_edge = _clamp_score(components.get("mlEdge"), SCORE_V2_WEIGHTS["mlEdge"])
        chip_flow = _clamp_score(components.get("chipFlow"), SCORE_V2_WEIGHTS["chipFlow"])
        technical_structure = _clamp_score(
            components.get("technicalStructure"),
            SCORE_V2_WEIGHTS["technicalStructure"],
        )
        fundamental_quality = row.get("fundamental_quality_score")
        if fundamental_quality is None and isinstance(row.get("fundamental_quality"), dict):
            fundamental_quality = row["fundamental_quality"].get("score")
        if "score_seed_inputs" in row:
            seeds = _score_v2_seed_inputs(row)
            ml_edge = _rescale_score(seeds["mlEdgeSeed30"], 30, SCORE_V2_WEIGHTS["mlEdge"])
            chip_flow = _rescale_score(seeds["chipFlowSeed40"], 40, SCORE_V2_WEIGHTS["chipFlow"])
            technical_structure = _rescale_score(
                seeds["technicalSeed30"] + seeds["screenerMomentumSeed20"],
                50,
                SCORE_V2_WEIGHTS["technicalStructure"],
            )
        return {
            "mlEdge": ml_edge,
            "chipFlow": chip_flow,
            "technicalStructure": technical_structure,
            "fundamentalQuality": _clamp_score(
                components.get("fundamentalQuality") if fundamental_quality is None else fundamental_quality,
                SCORE_V2_WEIGHTS["fundamentalQuality"],
            ),
            "newsTheme": _clamp_score(components.get("newsTheme"), SCORE_V2_WEIGHTS["newsTheme"]),
        }
    seeds = _score_v2_seed_inputs(row)
    return {
        "mlEdge": _rescale_score(seeds["mlEdgeSeed30"], 30, SCORE_V2_WEIGHTS["mlEdge"]),
        "chipFlow": _rescale_score(seeds["chipFlowSeed40"], 40, SCORE_V2_WEIGHTS["chipFlow"]),
        "technicalStructure": _rescale_score(
            seeds["technicalSeed30"] + seeds["screenerMomentumSeed20"],
            50,
            SCORE_V2_WEIGHTS["technicalStructure"],
        ),
        "fundamentalQuality": 0.0,
        "newsTheme": 0.0,
    }


def _require_canonical_score_v2_components(row: dict) -> dict[str, float]:
    payload = _parse_score_components_payload(row.get("score_components"))
    if not isinstance(payload, dict) or not isinstance(payload.get("components"), dict):
        symbol = row.get("symbol") or row.get("stock_id") or "unknown"
        raise ValueError(f"Score V2 score_components required for ranking promotion: {symbol}")
    return _score_v2_components_from_row({"score_components": payload})


def _score_v2_final_score_for_ranking(row: dict) -> float:
    payload = _parse_score_components_payload(row.get("score_components"))
    if not isinstance(payload, dict) or payload.get("version") != SCORE_V2_VERSION:
        symbol = row.get("symbol") or row.get("stock_id") or "unknown"
        raise ValueError(f"Score V2 score_components required for ranking promotion: {symbol}")
    final = payload.get("finalScore")
    if final is None:
        final = payload.get("total")
    if final is None:
        final = sum(_score_v2_components_from_row({"score_components": payload}).values())
    return _clamp_score(final, 100)


def _score_v2_technical_breakdown(row: dict, target: float) -> dict[str, float]:
    maxima = {
        "trendStructure": 7.0,
        "volatilityStructure": 5.0,
        "reversalExtreme": 5.0,
        "volumeConfirmation": 6.0,
        "executionRisk": 2.0,
    }
    target = _clamp_score(target, SCORE_V2_WEIGHTS["technicalStructure"])
    seeds = _score_v2_seed_inputs(row)

    current_price = _first_float(row.get("current_price"))
    ma20 = _first_float(row.get("ma20"))
    macd_hist = _first_float(row.get("macd_hist"))
    plus_di = _first_float(row.get("plus_di14"), row.get("plusDi14"))
    minus_di = _first_float(row.get("minus_di14"), row.get("minusDi14"))
    adx = _first_float(row.get("adx14"))
    atr = _first_float(row.get("atr14"))
    sar = _first_float(row.get("parabolic_sar"), row.get("parabolicSar"))
    cci = _first_float(row.get("cci20"))
    rsi = _first_float(row.get("rsi14"))
    vw_rsi = _first_float(row.get("volume_weighted_rsi14"), row.get("volumeWeightedRsi14"))
    vmd = _first_float(row.get("volume_momentum_divergence_13_27_10"), row.get("volumeMomentumDivergence132710"))
    squeeze_on = _first_float(row.get("squeeze_on"), row.get("squeezeOn"))
    squeeze_release = _first_float(row.get("squeeze_release"), row.get("squeezeRelease"))
    squeeze_momentum = _first_float(row.get("squeeze_momentum"), row.get("squeezeMomentum"))
    obv_temperature = _first_float(row.get("obv_temperature_60"), row.get("obvTemperature60"))
    adaptive_rsi_midline = _first_float(row.get("adaptive_rsi_midline_50"), row.get("adaptiveRsiMidline50"))
    adaptive_rsi_upper = _first_float(row.get("adaptive_rsi_upper_50"), row.get("adaptiveRsiUpper50"))
    adaptive_rsi_lower = _first_float(row.get("adaptive_rsi_lower_50"), row.get("adaptiveRsiLower50"))
    adaptive_rsi_overbought = _first_float(row.get("adaptive_rsi_overbought"), row.get("adaptiveRsiOverbought"))
    adaptive_rsi_oversold = _first_float(row.get("adaptive_rsi_oversold"), row.get("adaptiveRsiOversold"))

    detailed_values = [
        plus_di,
        minus_di,
        adx,
        atr,
        sar,
        cci,
        vw_rsi,
        vmd,
        squeeze_on,
        squeeze_release,
        squeeze_momentum,
        obv_temperature,
        adaptive_rsi_midline,
        adaptive_rsi_upper,
        adaptive_rsi_lower,
        adaptive_rsi_overbought,
        adaptive_rsi_oversold,
    ]
    if not any(value is not None for value in detailed_values):
        return {
            "trendStructure": _rescale_score(seeds["technicalSeed30"], 30, maxima["trendStructure"]),
            "volatilityStructure": 0.0,
            "reversalExtreme": 0.0,
            "volumeConfirmation": _rescale_score(seeds["screenerMomentumSeed20"], 20, maxima["volumeConfirmation"]),
            "executionRisk": 0.0,
        }

    natr = (atr / current_price * 100.0) if atr is not None and current_price and current_price > 0 else None
    raw = {
        "trendStructure": 0.0,
        "volatilityStructure": 0.0,
        "reversalExtreme": 0.0,
        "volumeConfirmation": 0.0,
        "executionRisk": 0.0,
    }
    if current_price is not None and ma20 is not None and current_price > ma20:
        raw["trendStructure"] += 2.0
    if macd_hist is not None and macd_hist > 0:
        raw["trendStructure"] += 1.5
    if plus_di is not None and minus_di is not None and plus_di > minus_di:
        raw["trendStructure"] += 1.5
    if adx is not None:
        raw["trendStructure"] += 2.0 if adx >= 25 else 1.0 if adx >= 18 else 0.0
    if squeeze_momentum is not None:
        raw["trendStructure"] += 1.0 if squeeze_momentum > 0 else 0.0

    if natr is not None:
        if 1.0 <= natr <= 4.0:
            raw["volatilityStructure"] += 5.0
        elif 0.5 <= natr <= 6.0:
            raw["volatilityStructure"] += 3.0
        elif natr > 0:
            raw["volatilityStructure"] += 1.0
    if squeeze_release is not None and squeeze_release > 0:
        raw["volatilityStructure"] += 3.0
    elif squeeze_on is not None and squeeze_on > 0:
        raw["volatilityStructure"] += 1.5

    if sar is not None and current_price is not None and current_price > sar:
        raw["reversalExtreme"] += 2.0
    if cci is not None:
        raw["reversalExtreme"] += 2.0 if -100 <= cci <= 150 else 1.0
    if rsi is not None:
        has_adaptive_rsi = adaptive_rsi_upper is not None and adaptive_rsi_lower is not None
        if has_adaptive_rsi:
            if adaptive_rsi_oversold is not None and adaptive_rsi_oversold > 0:
                raw["reversalExtreme"] += 1.5
            elif adaptive_rsi_overbought is not None and adaptive_rsi_overbought > 0:
                raw["reversalExtreme"] += 0.0
            elif adaptive_rsi_lower <= rsi <= adaptive_rsi_upper:
                raw["reversalExtreme"] += 1.2
        elif 35 <= rsi <= 75:
            raw["reversalExtreme"] += 1.0

    if obv_temperature is not None:
        if 60 <= obv_temperature <= 85:
            raw["volumeConfirmation"] += 3.0
        elif 45 <= obv_temperature < 60 or 85 < obv_temperature <= 95:
            raw["volumeConfirmation"] += 1.5
    if vmd is not None and vmd > 0:
        raw["volumeConfirmation"] += 1.0 if obv_temperature is not None else 2.0
    if vw_rsi is not None:
        raw["volumeConfirmation"] += 2.0 if 55 <= vw_rsi <= 80 else 1.0 if vw_rsi > 80 else 0.0
    raw["volumeConfirmation"] += _rescale_score(seeds["screenerMomentumSeed20"], 20, 1.0)

    if rsi is not None:
        if adaptive_rsi_upper is not None and adaptive_rsi_lower is not None:
            if adaptive_rsi_lower <= rsi <= adaptive_rsi_upper:
                raw["executionRisk"] += 1.0
        elif 35 <= rsi <= 75:
            raw["executionRisk"] += 1.0
    if obv_temperature is not None and 20 <= obv_temperature <= 90:
        raw["executionRisk"] += 0.5
    if natr is None or natr <= 6.0:
        raw["executionRisk"] += 1.0

    clamped = {key: _clamp_score(value, maxima[key]) for key, value in raw.items()}
    raw_sum = sum(clamped.values())
    if raw_sum <= 0 or target <= 0:
        return {key: 0.0 for key in maxima}
    scale = target / raw_sum
    return {key: _clamp_score(value * scale, maxima[key]) for key, value in clamped.items()}


def build_score_components(row: dict, *, raw_score: float, alpha_policy: dict | None = None) -> dict[str, Any]:
    """Persist canonical Score V2 payload from normalized seed inputs."""
    alpha_context = row.get("alpha_context") or {}
    alpha_adjustment = alpha_context.get("score_adjustment") if isinstance(alpha_context, dict) else 0
    seeds = _score_v2_seed_inputs(row)
    risk_flags = ((alpha_context.get("risk_overlay") or {}).get("flags") if isinstance(alpha_context, dict) else []) or []
    alpha_reason = {
        "bucket": alpha_context.get("edge_bucket") if isinstance(alpha_context, dict) else None,
        "regime": alpha_context.get("regime") if isinstance(alpha_context, dict) else None,
        "regimeWeight": alpha_context.get("regime_weight") if isinstance(alpha_context, dict) else None,
        "riskFlags": risk_flags,
        "riskPenalty": ((alpha_context.get("risk_overlay") or {}).get("penalty") if isinstance(alpha_context, dict) else 0) or 0,
        "marketHeatScore": alpha_context.get("market_heat_score") if isinstance(alpha_context, dict) else None,
        "marketHeatAlpha": alpha_context.get("market_heat_alpha") if isinstance(alpha_context, dict) else None,
        "marketHeatExpectedReturn": alpha_context.get("market_heat_expected_return") if isinstance(alpha_context, dict) else None,
        "details": _build_alpha_adjustment_details(alpha_context if isinstance(alpha_context, dict) else {}, alpha_policy),
    }
    components = _score_v2_components_from_row(row)
    total = _round1(sum(components.values()))
    technical_breakdown = _score_v2_technical_breakdown(row, components["technicalStructure"])
    final_score = _clamp_score(total + _score_number(alpha_adjustment), 100)
    payload: dict[str, Any] = {
        "version": SCORE_V2_VERSION,
        "weights": SCORE_V2_WEIGHTS,
        "components": components,
        "total": total,
        "technicalBreakdown": technical_breakdown,
        "technicalSignals": {
            "plusDi14": _first_float(row.get("plus_di14"), row.get("plusDi14")),
            "minusDi14": _first_float(row.get("minus_di14"), row.get("minusDi14")),
            "adx14": _first_float(row.get("adx14")),
            "parabolicSar": _first_float(row.get("parabolic_sar"), row.get("parabolicSar")),
            "cci20": _first_float(row.get("cci20")),
            "volumeWeightedRsi14": _first_float(row.get("volume_weighted_rsi14"), row.get("volumeWeightedRsi14")),
            "volumeMomentumDivergence132710": _first_float(row.get("volume_momentum_divergence_13_27_10"), row.get("volumeMomentumDivergence132710")),
            "squeezeOn": _first_float(row.get("squeeze_on"), row.get("squeezeOn")),
            "squeezeRelease": _first_float(row.get("squeeze_release"), row.get("squeezeRelease")),
            "squeezeMomentum": _first_float(row.get("squeeze_momentum"), row.get("squeezeMomentum")),
            "obvTemperature60": _first_float(row.get("obv_temperature_60"), row.get("obvTemperature60")),
            "adaptiveRsiMidline50": _first_float(row.get("adaptive_rsi_midline_50"), row.get("adaptiveRsiMidline50")),
            "adaptiveRsiUpper50": _first_float(row.get("adaptive_rsi_upper_50"), row.get("adaptiveRsiUpper50")),
            "adaptiveRsiLower50": _first_float(row.get("adaptive_rsi_lower_50"), row.get("adaptiveRsiLower50")),
            "adaptiveRsiOverbought": _first_float(row.get("adaptive_rsi_overbought"), row.get("adaptiveRsiOverbought")),
            "adaptiveRsiOversold": _first_float(row.get("adaptive_rsi_oversold"), row.get("adaptiveRsiOversold")),
        },
        "riskFlags": list(dict.fromkeys(str(flag) for flag in risk_flags if flag)),
        "reasons": [],
        "seedComponents": {
            **seeds,
        },
        "rawScore": raw_score,
        "alphaAdjustment": alpha_adjustment or 0,
        "finalScore": final_score,
        "formula": "score_v2_total + alphaAdjustment",
        "alphaReason": alpha_reason,
    }
    if isinstance(row.get("fundamental_quality"), dict):
        payload["fundamentalQuality"] = row["fundamental_quality"]
    if isinstance(row.get("chip_evidence"), dict):
        payload["chipEvidence"] = row["chip_evidence"]
    if isinstance(row.get("ml_edge_policy"), dict):
        payload["mlEdgePolicy"] = row["ml_edge_policy"]
    return payload


def _sum_chip_cash_billion(chips: list[dict], prices: list[dict], field: str) -> float:
    """Convert chip share counts to TWD billions using same-day close."""
    if not chips:
        return 0.0
    price_by_date = {p.get("date"): float(p.get("close") or 0.0) for p in prices if p.get("date")}
    fallback_close = 0.0
    for p in reversed(prices):
        close = float(p.get("close") or 0.0)
        if close > 0:
            fallback_close = close
            break
    total = 0.0
    for c in chips:
        close = price_by_date.get(c.get("date")) or fallback_close
        if close <= 0:
            continue
        total += float(c.get(field) or 0.0) * close / 1e8
    return round(total, 6)


def _broker_estimated_amount_twd(amount: Any, shares: Any, close: float, source: Any = None) -> float:
    try:
        amount_value = float(amount) if amount is not None else None
    except (TypeError, ValueError):
        amount_value = None
    try:
        share_value = float(shares or 0.0)
    except (TypeError, ValueError):
        share_value = 0.0
    source_text = str(source or "")
    listed_broker_lots = "finlab.broker_transactions" in source_text and "rotc" not in source_text
    unit_multiplier = 1000.0 if listed_broker_lots else 1.0
    fallback = share_value * close * unit_multiplier if close > 0 else 0.0
    if amount_value is None or not math.isfinite(amount_value):
        return fallback
    nominal_lot_amount = abs(share_value * close)
    if listed_broker_lots and nominal_lot_amount > 0:
        ratio = abs(amount_value) / nominal_lot_amount
        if 0.2 <= ratio <= 5:
            return amount_value * 1000.0
    return amount_value


def _sum_broker_cash_billion(chips: list[dict], prices: list[dict]) -> float:
    """Prefer FinLab estimated broker amount, fallback to broker shares * close."""
    if not chips:
        return 0.0
    total_amount = 0.0
    price_by_date = {p.get("date"): float(p.get("close") or 0.0) for p in prices if p.get("date")}
    fallback_close = 0.0
    for p in reversed(prices):
        close = float(p.get("close") or 0.0)
        if close > 0:
            fallback_close = close
            break
    for c in chips:
        if c.get("broker_estimated_amount") is None and c.get("broker_net_shares") is None:
            continue
        close = price_by_date.get(c.get("date")) or fallback_close
        total_amount += _broker_estimated_amount_twd(
            c.get("broker_estimated_amount"),
            c.get("broker_net_shares"),
            close,
            c.get("chip_source") or c.get("source"),
        )
    return round(total_amount / 1e8, 6)


def _sum_numeric(chips: list[dict], field: str) -> float:
    return round(sum(float(c.get(field) or 0.0) for c in chips), 6)


def _latest_broker_chip(chips: list[dict]) -> dict:
    for c in reversed(chips):
        if c.get("broker_net_shares") is not None or c.get("broker_estimated_amount") is not None:
            return c
    return {}


def _broker_chip_seed40(
    *,
    broker_net_amount_5d_billion: float,
    broker_count_latest: Any = None,
    concentration_latest: Any = None,
) -> float:
    amount = float(broker_net_amount_5d_billion or 0.0) * 1e8
    if amount > 0:
        amount_score = max(4.0, min(18.0, math.log10(1 + abs(amount) / 1_000_000) * 4.5))
        intensity_score = max(0.0, min(14.0, float(broker_net_amount_5d_billion or 0.0) * 80.0))
        broker_count = _float_or_none(broker_count_latest)
        breadth_score = 3.0 if broker_count is None else max(1.0, min(6.0, math.log2(max(1.0, broker_count)) * 1.2))
        concentration = _float_or_none(concentration_latest)
        concentration_penalty = 0.0
        if concentration is not None:
            if concentration > 0.85:
                concentration_penalty = 5.0
            elif concentration > 0.65:
                concentration_penalty = 3.0
        score = amount_score + intensity_score + breadth_score - concentration_penalty
    elif amount > -1_000_000:
        score = 2.0
    else:
        sell_pressure = max(2.0, min(10.0, math.log10(1 + abs(amount) / 1_000_000) * 2.5))
        score = max(0.0, 6.0 - sell_pressure)
    return _round1(max(0.0, min(40.0, score)))


def _canonical_chip_evidence_status(
    *,
    broker_rows: int,
    broker_net_amount_5d_billion: float,
    broker_seed40: float,
) -> tuple[str, str]:
    if broker_rows <= 0:
        return "missing", "broker_missing_or_not_materialized"
    if broker_net_amount_5d_billion > 0 and broker_seed40 > 0:
        return "present_bullish", "materialized_bullish_broker_chip_evidence"
    if broker_net_amount_5d_billion < 0:
        return "present_bearish", "materialized_bearish_broker_chip_evidence"
    return "present_neutral", "materialized_neutral_broker_chip_evidence"


def _format_abs_cash_billion(value: float) -> str:
    abs_value = abs(value)
    if 0 < abs_value < 0.01:
        return f"TWD {abs_value * 100:.1f}m"
    return f"{abs_value:.2f}億"


def _float_or_none(value: Any) -> float | None:
    if value is None:
        return None
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def _ema(values: list[float], span: int) -> list[float]:
    if not values:
        return []
    alpha = 2.0 / (span + 1.0)
    out = [values[0]]
    for value in values[1:]:
        out.append(value * alpha + out[-1] * (1.0 - alpha))
    return out


def _derive_technical_snapshot(payload: dict, rec: dict) -> dict[str, float | None]:
    """Return latest RSI/MACD/MA20 for recommendation text.

    The screener can emit research-only/emerging seeds before technical_indicators
    are materialized. In that case, derive the same snapshot from payload prices
    instead of treating missing fields as bearish.
    """
    indicators = _sorted_payload_rows(payload, "indicators") if payload else []
    latest_ind = indicators[-1] if indicators else {}
    prices = _sorted_payload_rows(payload, "prices") if payload else []
    closes = [
        float(p.get("close"))
        for p in prices
        if _float_or_none(p.get("close")) is not None
    ]

    ma20 = _float_or_none(latest_ind.get("ma20"))
    rsi14 = _float_or_none(latest_ind.get("rsi14"))
    macd_hist = _float_or_none(latest_ind.get("macdHist"))
    atr14 = _first_float(latest_ind.get("atr14"))
    plus_di14 = _first_float(latest_ind.get("plusDi14"), latest_ind.get("plus_di14"))
    minus_di14 = _first_float(latest_ind.get("minusDi14"), latest_ind.get("minus_di14"))
    adx14 = _first_float(latest_ind.get("adx14"))
    parabolic_sar = _first_float(latest_ind.get("parabolicSar"), latest_ind.get("parabolic_sar"))
    cci20 = _first_float(latest_ind.get("cci20"))
    volume_weighted_rsi14 = _first_float(latest_ind.get("volumeWeightedRsi14"), latest_ind.get("volume_weighted_rsi14"))
    volume_momentum_divergence = _first_float(
        latest_ind.get("volumeMomentumDivergence132710"),
        latest_ind.get("volume_momentum_divergence_13_27_10"),
    )
    squeeze_on = _first_float(latest_ind.get("squeezeOn"), latest_ind.get("squeeze_on"))
    squeeze_release = _first_float(latest_ind.get("squeezeRelease"), latest_ind.get("squeeze_release"))
    squeeze_momentum = _first_float(latest_ind.get("squeezeMomentum"), latest_ind.get("squeeze_momentum"))
    obv_temperature_60 = _first_float(latest_ind.get("obvTemperature60"), latest_ind.get("obv_temperature_60"))
    adaptive_rsi_midline_50 = _first_float(latest_ind.get("adaptiveRsiMidline50"), latest_ind.get("adaptive_rsi_midline_50"))
    adaptive_rsi_upper_50 = _first_float(latest_ind.get("adaptiveRsiUpper50"), latest_ind.get("adaptive_rsi_upper_50"))
    adaptive_rsi_lower_50 = _first_float(latest_ind.get("adaptiveRsiLower50"), latest_ind.get("adaptive_rsi_lower_50"))
    adaptive_rsi_overbought = _first_float(latest_ind.get("adaptiveRsiOverbought"), latest_ind.get("adaptive_rsi_overbought"))
    adaptive_rsi_oversold = _first_float(latest_ind.get("adaptiveRsiOversold"), latest_ind.get("adaptive_rsi_oversold"))

    if ma20 is None and len(closes) >= 20:
        ma20 = sum(closes[-20:]) / 20.0

    if rsi14 is None and len(closes) >= 15:
        gains = 0.0
        losses = 0.0
        for i in range(len(closes) - 14, len(closes)):
            delta = closes[i] - closes[i - 1]
            if delta > 0:
                gains += delta
            else:
                losses -= delta
        avg_gain = gains / 14.0
        avg_loss = losses / 14.0
        rsi14 = 100.0 if avg_loss == 0 else 100.0 - 100.0 / (1.0 + avg_gain / avg_loss)

    if macd_hist is None and len(closes) >= 35:
        ema12 = _ema(closes, 12)
        ema26 = _ema(closes, 26)
        macd_line = [a - b for a, b in zip(ema12, ema26)][25:]
        signal_line = _ema(macd_line, 9)
        if macd_line and signal_line:
            macd_hist = macd_line[-1] - signal_line[-1]

    return {
        "ma20": ma20,
        "rsi14": rsi14 if rsi14 is not None else _float_or_none(rec.get("rsi14")),
        "macd_hist": macd_hist if macd_hist is not None else _float_or_none(rec.get("macd_hist")),
        "atr14": atr14,
        "plus_di14": plus_di14,
        "minus_di14": minus_di14,
        "adx14": adx14,
        "parabolic_sar": parabolic_sar,
        "cci20": cci20,
        "volume_weighted_rsi14": volume_weighted_rsi14,
        "volume_momentum_divergence_13_27_10": volume_momentum_divergence,
        "squeeze_on": squeeze_on,
        "squeeze_release": squeeze_release,
        "squeeze_momentum": squeeze_momentum,
        "obv_temperature_60": obv_temperature_60,
        "adaptive_rsi_midline_50": adaptive_rsi_midline_50,
        "adaptive_rsi_upper_50": adaptive_rsi_upper_50,
        "adaptive_rsi_lower_50": adaptive_rsi_lower_50,
        "adaptive_rsi_overbought": adaptive_rsi_overbought,
        "adaptive_rsi_oversold": adaptive_rsi_oversold,
    }


def build_reason(s: dict) -> str:
    """Build fallback reason from canonical Score V2 payload."""
    payload = s.get("score_components")
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except (json.JSONDecodeError, TypeError):
            payload = None
    if not (isinstance(payload, dict) and payload.get("version") == SCORE_V2_VERSION):
        return "Score V2 missing: canonical score_components unavailable"
    components = _score_v2_components_from_row({"score_components": payload})
    final_score = _clamp_score(payload.get("finalScore", payload.get("total")), 100)
    total = _clamp_score(payload.get("total"), 100)
    alpha = _round1(_score_number(payload.get("alphaAdjustment"), final_score - total))

    market_segment = str(s.get("market_segment") or "").upper()
    broker_rows = int(s.get("broker_rows") or 0)
    broker_cash_5d = _score_number(s.get("broker_net_amount_5d"))
    if market_segment == "EMERGING" and broker_rows > 0:
        chip_context = (
            f"興櫃券商分點 5d {_format_abs_cash_billion(broker_cash_5d)}"
            f", 分點數={s.get('broker_count_latest', 'N/A')}"
        )
    elif market_segment == "EMERGING":
        chip_context = "emerging broker flow evidence unavailable"
    else:
        net_amount = _score_number(s.get("foreign_net_5d")) + _score_number(s.get("trust_net_5d")) + _score_number(s.get("dealer_net_5d"))
        chip_context = f"上市櫃法人買賣超 5d {net_amount:.1f}億"

    technical_parts: list[str] = []
    rsi = _first_float(s.get("rsi14"))
    if rsi is not None:
        technical_parts.append(f"RSI {rsi:.0f}")
    macd_hist = _first_float(s.get("macd_hist"))
    if macd_hist is not None:
        technical_parts.append("MACD positive" if macd_hist > 0 else "MACD non-positive")
    adx = _first_float(s.get("adx14"))
    if adx is not None:
        plus_di = _first_float(s.get("plus_di14"))
        minus_di = _first_float(s.get("minus_di14"))
        direction = ""
        if plus_di is not None and minus_di is not None:
            direction = " bullish" if plus_di > minus_di else " bearish"
        technical_parts.append(f"ADX {adx:.0f}{direction}")
    technical_context = ", ".join(technical_parts) if technical_parts else "technical signals limited"
    ml_context = str(s.get("ml_vote_summary_text") or s.get("ml_vote_summary") or "ML evidence limited")

    return (
        f"Score V2 {final_score:.1f}/100 (base {total:.1f}, alpha {alpha:+.1f}): "
        f"ML Edge {components['mlEdge']:.1f}/25, "
        f"Chip Flow {components['chipFlow']:.1f}/25, "
        f"Technical {components['technicalStructure']:.1f}/25. "
        f"Chip Flow: {chip_context}; Technical: {technical_context}; ML Edge: {ml_context}"
    )


def build_watch_points(s: dict) -> list[str]:
    """Build concise risk watch points used when LLM reasons are unavailable."""
    points: list[str] = []
    rsi = float(s.get("rsi14") or 50.0)
    conf = float(s.get("ml_confidence") or 0.0)
    sig = _normalized_signal(s.get("_signal"))
    forecast_pct = float(s.get("ml_forecast_pct") or 0.0)

    if rsi > 80:
        points.append("RSI above 80; watch for overheated momentum.")
    elif rsi > 75:
        points.append("RSI above 75; confirm follow-through before adding risk.")
    if float(s.get("macd_hist") or 0.0) < 0 and float(s.get("current_price") or 0.0) > float(s.get("ma20") or 0.0):
        points.append("Price is above MA20 but MACD histogram is negative; momentum confirmation is weak.")
    adx = _float_or_none(s.get("adx14"))
    vmd = _float_or_none(s.get("volume_momentum_divergence_13_27_10"))
    if adx is not None and adx < 15:
        points.append("ADX below 15; trend strength is limited.")
    if vmd is not None and vmd < 0:
        points.append("Volume momentum divergence is negative; confirm demand before entry.")
    if float(s.get("foreign_net_5d") or 0.0) < 0:
        points.append("Foreign net flow is negative over 5d.")
    if float(s.get("trust_net_5d") or 0.0) < 0 < float(s.get("foreign_net_5d") or 0.0):
        points.append("Trust flow conflicts with foreign buying; chip confirmation is mixed.")
    market_segment = str(s.get("market_segment") or "").upper()
    broker_rows = int(s.get("broker_rows") or 0)
    if market_segment == "EMERGING" and broker_rows > 0:
        points.append("Emerging-market chip evidence uses FinLab broker flow; validate liquidity and broker concentration.")
    elif market_segment == "EMERGING" or int(s.get("chip_rows") or 0) == 0:
        points.append("Emerging-market chip evidence is limited; rely more on price, volume, and ML confirmation.")
    if _is_formal_buy_signal(sig) and forecast_pct < 0:
        points.append("BUY signal has a negative forecast; require stronger confirmation.")
    elif conf < 0.45:
        points.append("ML confidence is below 0.45; treat as low-conviction evidence.")
    elif sig == "HOLD":
        points.append("ML signal is HOLD; wait for stronger evidence before promotion.")
    if not points:
        points.append("No major risk flags detected; continue monitoring price, volume, and ML evidence.")
    return points


def _filtered_allocator_ev_diagnostic(row: dict[str, Any], eff_ml: dict[str, Any]) -> dict[str, Any]:
    fusion_payload = row.get("allocator_ev_fusion") if isinstance(row.get("allocator_ev_fusion"), dict) else None
    resolver = row.get("_allocator_edge_resolver") if isinstance(row.get("_allocator_edge_resolver"), dict) else None
    expected_payload = row.get("_expected_return_payload") if isinstance(row.get("_expected_return_payload"), dict) else None
    diagnostic: dict[str, Any] = {
        "status": "loaded" if fusion_payload and fusion_payload.get("status") == "loaded" else "not_evaluated",
        "reason": "ml_filter_preserved_non_buy",
        "diagnostic_role": "filtered_row_diagnostic_not_expected_return_owner",
        "sparse_decision_coverage": False,
        "decision_pool_reason": "ml_filter_preserved_non_buy",
        "filtered_signal": eff_ml.get("signal") or row.get("signal"),
        "filtered_signal_source": eff_ml.get("signal_source") or row.get("signal_source"),
        "filtered_confidence": eff_ml.get("confidence") or row.get("confidence"),
        "expected_return": row.get("promotion_expected_return"),
        "expected_return_source": row.get("promotion_expected_return_source"),
        "expected_return_owner": (resolver or {}).get("expected_return_owner"),
        "allocator_edge_resolver": resolver,
    }
    if fusion_payload:
        diagnostic.update({
            "fusion_status": fusion_payload.get("status"),
            "fusion_expected_return": fusion_payload.get("expected_return"),
            "fusion_expected_return_source": fusion_payload.get("expected_return_source"),
            "fusion_promotion_tier": fusion_payload.get("promotion_tier"),
            "fusion_primary_expected_return_allowed": fusion_payload.get("primary_expected_return_allowed"),
            "allocator_ev_fusion": fusion_payload,
        })
    elif expected_payload:
        diagnostic["expected_return_payload"] = expected_payload
    return {k: v for k, v in diagnostic.items() if v is not None}


def filter_and_score_recommendations(
    screener_recs: list[dict],
    predictions: dict[str, dict],   # symbol ??ml result from ml-service
    payloads: list[dict],            # PredictPayload as dict (for reason data)
    persona_opinions: dict | None = None,  # symbol ??{trust:{...}, retail:{...}}
    persona_weight: float = 1.0,   # 0 = disable, 1 = default, 0.5 = shadow mode
    regime_label: str | None = None,
    regime_surface: dict | None = None,
    alpha_policy: dict | None = None,
    fundamental_quality_by_symbol: dict[str, dict[str, Any]] | None = None,
    run_date: str | None = None,
    include_filtered_diagnostics: bool = False,
) -> tuple[list[dict], int] | tuple[list[dict], int, dict[str, dict[str, Any]]]:
    """
    Returns (final_recs, sell_filtered_count).
    When include_filtered_diagnostics=True, also returns diagnostics for
    SELL/NO_SIGNAL rows after L4/S12/fusion materialization.

    For each screener_rec:
      1. Look up matching prediction
      2. Filter SELL/NO_SIGNAL ??drop
      3. Compute ml_score, persona_score, total_score
      4. Build template reason / watchPoints
      5. Return updated row dict

    persona_score integration (Batch B):
      - Reads persona_opinions[symbol] ??{trust, retail}
      - compute_persona_score maps to [-20, +20] scalar
      - Multiplied by persona_weight (KV-driven dial for rollout safety)
      - Stored as Score V2 alphaAdjustment before finalScore is persisted
      - Opinion-less symbols contribute 0 (NEUTRAL default)
    """
    payload_by_sym = {p["symbol"]: p for p in payloads}
    final: list[dict] = []
    filtered_diagnostics: dict[str, dict[str, Any]] = {}
    sell_count = 0

    # ML_POOL Plan A migration (2026-04-19): toggle which signal drives the
    # BUY/SELL gate. Default True = use ensemble_v2 formal alpha slots
    # with lifecycle weights). KV override:
    # trading:config.mlPool.useEnsembleV2=false ??fall back to legacy feature-model signal.
    use_ev2 = _is_use_ensemble_v2()

    # Lazy-import persona helpers so this module stays import-safe even if
    # persona_service has a downstream issue.
    _persona_helpers = None
    if persona_opinions and persona_weight != 0:
        try:
            from services.persona_service import (
                TrustOpinion, RetailOpinion, compute_persona_score,
            )
            _persona_helpers = (TrustOpinion, RetailOpinion, compute_persona_score)
        except Exception as e:
            logger.warning(f"[reco] persona helpers unavailable ({e}); disabling persona_score")
            _persona_helpers = None

    s12_trade_ev_provider = None
    if run_date:
        try:
            from services.s12_trade_ev_bootstrap import S12TradeEvBootstrapProvider

            s12_trade_ev_provider = S12TradeEvBootstrapProvider.for_run_date(str(run_date))
            logger.info("[reco] S12 trade EV bootstrap loaded: %s", s12_trade_ev_provider.summary())
        except Exception as e:  # noqa: BLE001 - fail closed; allocator will see missing EV.
            logger.warning("[reco] S12 trade EV bootstrap unavailable; allocator EV will fail closed: %s", e)
            s12_trade_ev_provider = None

    for rec in screener_recs:
        symbol = rec["symbol"]
        ml = predictions.get(symbol)
        eff_ml = _effective_prediction_view(ml, use_ensemble_v2=use_ev2)
        sig = (eff_ml.get("signal") or "").upper() or None

        # ML score reflects model evidence only; ranking/top-K promotion is
        # tracked in signal_source/reason but should not inflate ML votes.
        ml_score = calculate_ml_score(eff_ml, ml) if ml else 0.0
        ml_edge_policy = _ml_edge_policy_evidence(ml) if ml else None
        existing_score_components = _parse_score_components_payload(rec.get("score_components"))
        score_seed_inputs = _score_v2_seed_inputs_from_payload(existing_score_components, ml_score=ml_score)
        if score_seed_inputs is None:
            raise ValueError(f"Score V2 screener score_components required for {symbol}")

        # Persona score (Batch B: ?縑/?? augmentation)
        persona_score = 0.0
        persona_applied = None  # for downstream reason text
        if _persona_helpers is not None and persona_opinions:
            TrustOp, RetailOp, compute_score = _persona_helpers
            op = persona_opinions.get(symbol)
            if op:
                try:
                    trust = TrustOp(**op.get("trust", {})) if op.get("trust") else None
                    retail = RetailOp(**op.get("retail", {})) if op.get("retail") else None
                    if trust and retail:
                        persona_score = compute_score(trust, retail) * persona_weight
                        score_seed_inputs["personaAlphaSeed"] = persona_score
                        persona_applied = {
                            "trust_signal": trust.signal, "trust_strength": trust.strength,
                            "retail_signal": retail.signal, "retail_strength": retail.strength,
                        }
                except Exception as e:
                    logger.debug(f"[reco] persona_score failed for {symbol}: {e}")

        payload = payload_by_sym.get(symbol, {})
        raw_stock_meta = payload.get("stock_meta", {}) if payload else {}
        if not raw_stock_meta:
            raw_stock_meta = {
                "market_segment": rec.get("market_segment") or rec.get("market"),
                "recommendation_lane": rec.get("recommendation_lane"),
                "eligible_for_ml": rec.get("eligible_for_ml", True),
                "eligible_for_pending_buy": rec.get("eligible_for_pending_buy"),
            }
        stock_meta = _enrich_stock_meta_with_segment_policy(raw_stock_meta)
        recommendation_lane = stock_meta.get("recommendation_lane") or "tradable"
        market_segment = stock_meta.get("market_segment") or "UNKNOWN"
        eligible_for_pending_buy = bool(stock_meta.get("eligible_for_pending_buy", recommendation_lane == "tradable"))
        env_for_stock = payload.get("market_env", {}) if payload else {}

        # Extract latest indicator values from payload. If the indicator table
        # is not ready for a research-only seed, derive from payload prices.
        technical = _derive_technical_snapshot(payload, rec)

        # Latest price from payload
        prices = _sorted_payload_rows(payload, "prices") if payload else []
        current_price = prices[-1]["close"] if prices else (rec.get("current_price"))

        # Foreign / trust net (5d sum from chips)
        chips = _sorted_payload_rows(payload, "chips") if payload else []
        recent_chips = chips[-5:]
        foreign_net_5d = _sum_chip_cash_billion(recent_chips, prices, "foreign_net")
        trust_net_5d = _sum_chip_cash_billion(recent_chips, prices, "trust_net")
        dealer_net_5d = _sum_chip_cash_billion(recent_chips, prices, "dealer_net")
        broker_net_amount_5d = _sum_broker_cash_billion(recent_chips, prices)
        broker_net_shares_5d = _sum_numeric(recent_chips, "broker_net_shares")
        latest_broker = _latest_broker_chip(recent_chips)
        broker_rows = sum(
            1 for chip in recent_chips
            if chip.get("broker_net_shares") is not None or chip.get("broker_estimated_amount") is not None
        )
        upstream_chip_evidence = (
            existing_score_components.get("chipEvidence")
            if isinstance(existing_score_components, dict)
            and isinstance(existing_score_components.get("chipEvidence"), dict)
            else None
        )
        chip_evidence = None
        if broker_rows > 0:
            broker_seed40 = _broker_chip_seed40(
                broker_net_amount_5d_billion=broker_net_amount_5d,
                broker_count_latest=latest_broker.get("broker_count"),
                concentration_latest=latest_broker.get("broker_concentration"),
            )
            broker_evidence_status, evidence_status = _canonical_chip_evidence_status(
                broker_rows=broker_rows,
                broker_net_amount_5d_billion=broker_net_amount_5d,
                broker_seed40=broker_seed40,
            )
            previous_chip_seed40 = float(score_seed_inputs["chipFlowSeed40"] or 0.0)
            chip_evidence = {
                "schema_version": "canonical_chip_evidence_v2",
                "evidence_status": evidence_status,
                "evidenceStatus": evidence_status,
                "brokerEvidenceStatus": broker_evidence_status,
                "scoring_policy": "screener_score_v2_seed_owner_evidence_only",
                "scoringPolicy": "screener_score_v2_seed_owner_evidence_only",
                "source": latest_broker.get("chip_source") or "finlab.rotc_broker_transactions",
                "source_date": latest_broker.get("date"),
                "sourceDate": latest_broker.get("date"),
                "brokerFlowUsed": True,
                "broker_net_amount_5d_billion": broker_net_amount_5d,
                "broker_net_shares_5d": broker_net_shares_5d,
                "broker_count_latest": latest_broker.get("broker_count"),
                "concentration_latest": latest_broker.get("broker_concentration"),
                "broker_chip_seed40": broker_seed40,
                "previous_chip_seed40": previous_chip_seed40,
                "chip_seed_override_applied": False,
                "as_of_date": latest_broker.get("as_of_date"),
            }
        else:
            chip_evidence = {
                "schema_version": "canonical_chip_evidence_v2",
                "evidence_status": "broker_missing_or_not_materialized",
                "evidenceStatus": "broker_missing_or_not_materialized",
                "brokerEvidenceStatus": "missing",
                "scoring_policy": "existing_screener_chip_seed_only",
                "scoringPolicy": "existing_screener_chip_seed_only",
                "brokerFlowUsed": False,
            }
        if upstream_chip_evidence is not None:
            chip_evidence = upstream_chip_evidence

        total_score = round((
            score_seed_inputs["chipFlowSeed40"]
            + score_seed_inputs["technicalSeed30"]
            + score_seed_inputs["mlEdgeSeed30"]
            + score_seed_inputs["personaAlphaSeed"]
        ) * 10) / 10

        # ML model votes from prediction
        ml_models_total = 0
        ml_models_up = 0
        ml_models_down = 0
        if ml:
            models = ml.get("models")
            # ml-service can return models as dict {name: {...}} or list [{name, ...}]
            iterable = []
            if isinstance(models, dict):
                iterable = models.values()
            elif isinstance(models, list):
                iterable = models
            for m in iterable:
                if isinstance(m, dict):
                    direction = m.get("direction") or ""
                    ml_models_total += 1
                    if direction == "up":
                        ml_models_up += 1
                    elif direction == "down":
                        ml_models_down += 1

        legacy_counts = {"total": ml_models_total, "up": ml_models_up, "down": ml_models_down}
        ml_vote_text = build_ml_vote_summary(
            ml,
            eff_ml,
            legacy_counts,
        )
        ml_vote_summary = build_ml_vote_summary_data(ml, legacy_counts)
        reason_data = {
            "foreign_consecutive": 0,  # TODO: compute consec from chips if needed
            "foreign_net_5d": foreign_net_5d,
            "trust_net_5d": trust_net_5d,
            "dealer_net_5d": dealer_net_5d,
            "broker_net_amount_5d": broker_net_amount_5d,
            "broker_net_shares_5d": broker_net_shares_5d,
            "broker_count_latest": latest_broker.get("broker_count"),
            "broker_concentration_latest": latest_broker.get("broker_concentration"),
            "broker_rows": broker_rows,
            "rsi14": technical.get("rsi14"),
            "macd_hist": technical.get("macd_hist"),
            "adx14": technical.get("adx14"),
            "cci20": technical.get("cci20"),
            "volume_weighted_rsi14": technical.get("volume_weighted_rsi14"),
            "volume_momentum_divergence_13_27_10": technical.get("volume_momentum_divergence_13_27_10"),
            "squeeze_on": technical.get("squeeze_on"),
            "squeeze_release": technical.get("squeeze_release"),
            "squeeze_momentum": technical.get("squeeze_momentum"),
            "obv_temperature_60": technical.get("obv_temperature_60"),
            "adaptive_rsi_midline_50": technical.get("adaptive_rsi_midline_50"),
            "adaptive_rsi_upper_50": technical.get("adaptive_rsi_upper_50"),
            "adaptive_rsi_lower_50": technical.get("adaptive_rsi_lower_50"),
            "adaptive_rsi_overbought": technical.get("adaptive_rsi_overbought"),
            "adaptive_rsi_oversold": technical.get("adaptive_rsi_oversold"),
            "current_price": current_price,
            "ma20": technical.get("ma20"),
            "_signal": eff_ml.get("signal"),
            "ml_confidence": eff_ml.get("confidence") or 0,
            "ml_forecast_pct": eff_ml.get("forecast_pct"),
            "ml_forecast_pct_source": eff_ml.get("forecast_pct_source"),
            "forecast_return_5bar": eff_ml.get("forecast_return_5bar"),
            "forecast_return_5bar_source": eff_ml.get("forecast_return_5bar_source"),
            "expected_return": eff_ml.get("expected_return"),
            "expected_return_source": eff_ml.get("expected_return_source"),
            "trade_expected_return_net_pct": eff_ml.get("trade_expected_return_net_pct"),
            "trade_expected_return_source": eff_ml.get("trade_expected_return_source"),
            "l4_alpha_ev": eff_ml.get("l4_alpha_ev"),
            "ml_models_total": ml_models_total,
            "ml_models_up": ml_models_up,
            "ml_models_down": ml_models_down,
            "ml_vote_summary": ml_vote_text,
            "chip_rows": len(chips),
            "market_segment": market_segment,
        }

        watch_points = build_watch_points(reason_data)
        if recommendation_lane == "emerging_watchlist" or not eligible_for_pending_buy:
            watch_points = [
                *watch_points,
                "research_only:emerging_not_for_auto_trade",
                f"market_segment:{market_segment}",
            ]

        row = {
            "date": rec["date"],
            "stock_id": rec.get("stock_id"),
            "symbol": symbol,
            "rec_id": rec.get("id"),
            "name": rec.get("name"),
            "sector": rec.get("sector"),
            "industry": rec.get("industry") or rec.get("sector"),
            "score_seed_inputs": score_seed_inputs,
            "chip_score": score_seed_inputs["chipFlowSeed40"],
            "tech_score": score_seed_inputs["technicalSeed30"],
            "momentum_score": score_seed_inputs["screenerMomentumSeed20"],
            "ml_score": score_seed_inputs["mlEdgeSeed30"],
            "ml_edge_policy": ml_edge_policy,
            "persona_score": persona_score,
            "persona_applied": persona_applied,  # None if no persona data
            "score": total_score,
            "signal": eff_ml.get("signal"),
            "signal_raw": eff_ml.get("signal_raw"),
            "signal_source": eff_ml.get("signal_source"),
            "confidence": eff_ml.get("confidence"),
            "ml_forecast_pct": eff_ml.get("forecast_pct"),
            "ml_forecast_pct_source": eff_ml.get("forecast_pct_source"),
            "forecast_return_5bar": eff_ml.get("forecast_return_5bar"),
            "forecast_return_5bar_source": eff_ml.get("forecast_return_5bar_source"),
            "expected_return": eff_ml.get("expected_return"),
            "expected_return_source": eff_ml.get("expected_return_source"),
            "expected_return_owner": eff_ml.get("expected_return_owner"),
            "trade_expected_return_net_pct": eff_ml.get("trade_expected_return_net_pct"),
            "trade_expected_return_source": eff_ml.get("trade_expected_return_source"),
            "l4_alpha_ev": eff_ml.get("l4_alpha_ev"),
            "dispersion_diagnostics": ml.get("dispersion_diagnostics") if isinstance(ml, dict) else None,
            "ml_vote_summary": ml_vote_summary,
            "ml_vote_summary_text": ml_vote_text,
            "current_price": current_price,
            "market_segment": market_segment,
            "recommendation_lane": recommendation_lane,
            "eligible_for_ml": bool(stock_meta.get("eligible_for_ml", True)),
            "eligible_for_pending_buy": eligible_for_pending_buy,
            "has_buy_signal": 1 if (eligible_for_pending_buy and _is_formal_buy_signal(sig)) else 0,
            "watch_points": watch_points,
            "foreign_net_5d": foreign_net_5d,
            "trust_net_5d": trust_net_5d,
            "chip_evidence": chip_evidence,
            "ma20": technical.get("ma20"),
            "rsi14": technical.get("rsi14"),
            "macd_hist": technical.get("macd_hist"),
            "atr14": technical.get("atr14"),
            "plus_di14": technical.get("plus_di14"),
            "minus_di14": technical.get("minus_di14"),
            "adx14": technical.get("adx14"),
            "parabolic_sar": technical.get("parabolic_sar"),
            "cci20": technical.get("cci20"),
            "volume_weighted_rsi14": technical.get("volume_weighted_rsi14"),
            "volume_momentum_divergence_13_27_10": technical.get("volume_momentum_divergence_13_27_10"),
            "squeeze_on": technical.get("squeeze_on"),
            "squeeze_release": technical.get("squeeze_release"),
            "squeeze_momentum": technical.get("squeeze_momentum"),
            "obv_temperature_60": technical.get("obv_temperature_60"),
            "adaptive_rsi_midline_50": technical.get("adaptive_rsi_midline_50"),
            "adaptive_rsi_upper_50": technical.get("adaptive_rsi_upper_50"),
            "adaptive_rsi_lower_50": technical.get("adaptive_rsi_lower_50"),
            "adaptive_rsi_overbought": technical.get("adaptive_rsi_overbought"),
            "adaptive_rsi_oversold": technical.get("adaptive_rsi_oversold"),
        }
        fundamental_quality = (fundamental_quality_by_symbol or {}).get(symbol)
        if isinstance(fundamental_quality, dict):
            row["fundamental_quality"] = fundamental_quality
        if existing_score_components:
            row["score_components"] = existing_score_components
        if regime_label:
            alpha_context = build_alpha_context(row, eff_ml, payload, regime_label, regime_surface=regime_surface, policy=alpha_policy)
            apply_alpha_context(row, ml, alpha_context)
        if s12_trade_ev_provider is not None:
            s12_trade_ev = s12_trade_ev_provider.build_for_row(row, prediction=ml)
            row["s12_trade_ev"] = s12_trade_ev
            if s12_trade_ev.get("status") == "loaded":
                row["trade_expected_return_net_pct"] = s12_trade_ev.get("trade_expected_return_net_pct")
                row["trade_expected_return_source"] = s12_trade_ev.get("trade_expected_return_source")
        row["score_components"] = build_score_components(row, raw_score=total_score, alpha_policy=alpha_policy)
        row["score"] = row["score_components"]["finalScore"]
        l4_alpha_ev = materialize_l4_alpha_ev(row, prediction=ml, policy=alpha_policy)
        if isinstance(l4_alpha_ev, dict):
            row["l4_alpha_ev"] = l4_alpha_ev
            if isinstance(ml, dict):
                ml["l4_alpha_ev"] = l4_alpha_ev
                ev2 = ml.get("ensemble_v2") if isinstance(ml.get("ensemble_v2"), dict) else None
                if ev2 is not None:
                    ev2["l4_alpha_ev"] = l4_alpha_ev
        expected_return, expected_return_source = _row_expected_return_with_source(row, alpha_policy=alpha_policy)
        row["promotion_expected_return"] = expected_return
        row["promotion_expected_return_source"] = expected_return_source

        # Preserve full diagnostic coverage for ML-filtered rows without
        # allowing them into the sparse allocator decision pool.
        if sig and ("SELL" in sig or sig == "NO_SIGNAL"):
            sell_count += 1
            if include_filtered_diagnostics:
                filtered_diagnostics[symbol] = _filtered_allocator_ev_diagnostic(row, eff_ml)
            continue

        row["reason"] = build_reason({**reason_data, **row})
        final.append(row)

    if include_filtered_diagnostics:
        return final, sell_count, filtered_diagnostics
    return final, sell_count


# ?????????????????????????????????????????????????????????????????????????????
# Hybrid Ranking promotion (port from dailyRecommendation.ts:639-697)
# ?????????????????????????????????????????????????????????????????????????????

def _signal_tier(sig: Optional[str]) -> float:
    s = _normalized_signal(sig)
    if not s:
        return 0.20
    if s == "STRONG_BUY":
        return 1.00
    if s == "BUY":
        return 0.70
    if s == "HOLD":
        return 0.35
    return 0.0


def _can_promote_ranking_candidate(row: dict, ranking_config: dict, alpha_policy: dict | None = None) -> bool:
    """Avoid turning a negative/weak ML expectation into a BUY label."""
    lane = row.get("recommendation_lane") or "tradable"
    if row.get("eligible_for_pending_buy") is False or lane != "tradable":
        row["promotion_blocked_reason"] = "research_only_or_not_tradable"
        return False
    expected_return, expected_return_source = _row_expected_return_with_source(row, alpha_policy=alpha_policy)
    row["promotion_expected_return"] = expected_return
    row["promotion_expected_return_source"] = expected_return_source
    forecast_pct = row.get("forecast_return_5bar", row.get("ml_forecast_pct", row.get("forecast_pct")))
    forecast_pct_source = str(
        row.get("forecast_return_5bar_source")
        or row.get("ml_forecast_pct_source")
        or row.get("forecast_pct_source")
        or ""
    ).strip()
    missing_expected_return = _expected_return_source_missing(expected_return_source)
    if missing_expected_return:
        row["promotion_blocked_reason"] = "forecast_pct_missing_no_expected_return_input"
        row["promotion_blocked_forecast_pct"] = forecast_pct
        row["promotion_blocked_forecast_pct_source"] = forecast_pct_source or expected_return_source
        row["promotion_blocked_expected_return_source"] = expected_return_source
        row["promotion_blocked_expected_return_policy"] = (
            "requires_validated_l4_alpha_ev_or_s12_trade_ev_positive_expected_return"
        )
        return False
    resolver = row.get("_allocator_edge_resolver") if isinstance(row.get("_allocator_edge_resolver"), dict) else {}
    cold_start_block_reason = str(resolver.get("conditional_admission_block_reason") or "").strip()
    if cold_start_block_reason:
        row["promotion_blocked_reason"] = cold_start_block_reason
        row["promotion_blocked_expected_return"] = expected_return
        row["promotion_blocked_expected_return_source"] = expected_return_source
        row["promotion_blocked_expected_return_policy"] = "cold_start_requires_verified_s12_structure_before_l4_buy"
        return False
    min_forecast = float(ranking_config.get("promoteMinForecastPct", 0.0))
    if expected_return < min_forecast:
        if resolver.get("conditional_admission_allowed") is True and expected_return > 0:
            row["promotion_conditional_admission"] = True
            row["promotion_conditional_admission_policy"] = resolver.get("conditional_admission_policy")
            row["promotion_static_min_expected_return"] = min_forecast
            row["promotion_expected_return"] = expected_return
            row["promotion_expected_return_source"] = expected_return_source
            return True
        row["promotion_blocked_reason"] = "negative_or_below_min_forecast"
        row["promotion_blocked_forecast_pct"] = forecast_pct
        row["promotion_blocked_forecast_pct_source"] = forecast_pct_source or None
        row["promotion_blocked_expected_return"] = expected_return
        row["promotion_blocked_expected_return_source"] = expected_return_source
        row["promotion_blocked_min_expected_return"] = min_forecast
        return False
    try:
        ml_edge = float(_score_v2_components_from_row(row).get("mlEdge") or 0.0)
    except (TypeError, ValueError):
        ml_edge = 0.0
    try:
        min_ml_edge = float(ranking_config.get("promoteMinMlEdge", 0.0) or 0.0)
    except (TypeError, ValueError):
        min_ml_edge = 0.0
    if ml_edge <= min_ml_edge:
        row["promotion_blocked_reason"] = "missing_formal_ml_edge"
        row["promotion_blocked_ml_edge"] = ml_edge
        row["promotion_blocked_min_ml_edge"] = min_ml_edge
        row["promotion_blocked_expected_return"] = expected_return
        row["promotion_blocked_expected_return_source"] = expected_return_source
        return False
    return True


def build_return_history_from_payloads(payloads: list[dict], *, lookback: int | None = None) -> dict[str, list[float]]:
    """Build close-to-close return history for allocator risk estimates."""
    history: dict[str, list[float]] = {}
    safe_lookback = max(2, min(int(lookback or gnn_return_history_lookback()), 504))
    for payload in payloads or []:
        symbol = str(payload.get("symbol") or payload.get("stock_id") or "").strip()
        if not symbol:
            continue
        prices = _sorted_payload_rows(payload, "prices")[-(safe_lookback + 1):]
        closes: list[float] = []
        for row in prices:
            close = _float_or_none(row.get("close"))
            if close is None:
                close = _float_or_none(row.get("adj_close"))
            if close is not None and close > 0:
                closes.append(close)
        returns: list[float] = []
        for idx in range(1, len(closes)):
            prev = closes[idx - 1]
            cur = closes[idx]
            if prev > 0:
                value = cur / prev - 1.0
                if math.isfinite(value):
                    returns.append(round(value, 8))
        if returns:
            history[symbol] = returns
    return history


def _l2_timesfm_sidecar_from_prediction(prediction: dict | None) -> dict[str, Any] | None:
    pred = prediction if isinstance(prediction, dict) else {}
    stock_meta = pred.get("stock_meta") if isinstance(pred.get("stock_meta"), dict) else {}
    candidates = [
        stock_meta.get("timesfm_l175_sidecar"),
        stock_meta.get("timesfm_l2_sidecar"),
        pred.get("timesfm_sidecar"),
    ]
    for candidate in candidates:
        if isinstance(candidate, dict) and candidate:
            return {**candidate, "layer": "L2"}
    return None


def _l2_timesfm_evidence_from_sidecar(sidecar: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(sidecar, dict) or not sidecar:
        return None
    features = sidecar.get("features") if isinstance(sidecar.get("features"), dict) else {}
    return {
        "schema_version": "l2_timesfm_enrichment_evidence_v1",
        "source": "timesfm_l2_sidecar",
        "stage": "L2",
        "selection_role": "feature_enrichment_not_gate",
        "final_recommendation_gate": False,
        "l3_formal_inference_selected": True,
        "direct_alpha_blocked": bool(sidecar.get("direct_alpha_blocked", True)),
        "sidecar_schema_version": sidecar.get("schema_version"),
        "sidecar_layer": "L2",
        "role": sidecar.get("role") or "feature_sidecar",
        "eligible_for_l2_feature_enrichment": bool(sidecar.get("eligible_for_l2_feature_enrichment")),
        "l2_feature_input_active": bool(sidecar.get("l2_feature_input_active")),
        "l2_feature_input_blocked_reason": sidecar.get("l2_feature_input_blocked_reason"),
        "l2_feature_schema_version": sidecar.get("l2_feature_schema_version"),
        "l2_feature_names": sidecar.get("l2_feature_names") if isinstance(sidecar.get("l2_feature_names"), list) else [],
        "current_allowed_use": sidecar.get("current_allowed_use") if isinstance(sidecar.get("current_allowed_use"), list) else [],
        "populated_feature_count": sum(
            1 for value in features.values()
            if value is not None and value != ""
        ),
    }


def _l2_timesfm_missing_evidence(l2_summary: dict[str, Any] | None = None) -> dict[str, Any]:
    summary = l2_summary if isinstance(l2_summary, dict) else {}
    gate = summary.get("gate") if isinstance(summary.get("gate"), dict) else {}
    gate_reason = str(gate.get("reason") or summary.get("reason") or "missing_sidecar").strip()
    gate_status = str(gate.get("status") or summary.get("status") or "").strip() or None
    return {
        "schema_version": "l2_timesfm_enrichment_evidence_v1",
        "source": "timesfm_l2_sidecar",
        "stage": "L2",
        "selection_role": "feature_enrichment_not_gate",
        "final_recommendation_gate": False,
        "l3_formal_inference_selected": True,
        "direct_alpha_blocked": True,
        "evidence_status": "missing_sidecar",
        "l2_summary_status": summary.get("status"),
        "l2_gate_allowed": gate.get("allowed"),
        "l2_gate_reason": gate_reason,
        "l2_gate_status": gate_status,
    }


def apply_l2_timesfm_evidence(
    recommendations: list[dict],
    predictions: dict[str, dict],
    *,
    fallback_size: int | None = None,
    l2_summary: dict[str, Any] | None = None,
) -> list[dict]:
    """Attach Layer 2 TimesFM enrichment evidence without gating L3/L4 input."""
    _ = fallback_size
    enriched: list[dict] = []
    for row in recommendations:
        row = dict(row)
        pred = predictions.get(str(row.get("symbol") or "")) or {}
        sidecar = _l2_timesfm_sidecar_from_prediction(pred)
        evidence = _l2_timesfm_evidence_from_sidecar(sidecar)
        if evidence:
            row["l2_timesfm_evidence"] = evidence
            row["timesfm_sidecar"] = sidecar
            row["watch_points"] = [
                *(row.get("watch_points") if isinstance(row.get("watch_points"), list) else []),
                (
                    "l2_timesfm_evidence:"
                    f"active={bool(evidence.get('l2_feature_input_active'))}:"
                    f"features={evidence.get('populated_feature_count')}"
                ),
            ]
        else:
            evidence = _l2_timesfm_missing_evidence(l2_summary)
            gate_reason = str(evidence.get("l2_gate_reason") or "missing_sidecar")
            row["l2_timesfm_evidence"] = evidence
            row["watch_points"] = [
                *(row.get("watch_points") if isinstance(row.get("watch_points"), list) else []),
                f"l2_timesfm_evidence:missing_sidecar:{gate_reason}",
            ]
        enriched.append(row)
    return enriched


_CORE_FAMILY_MODEL_GROUPS: dict[str, tuple[str, ...]] = {
    "tree": ("XGBoost", "ExtraTrees", "LightGBM"),
    "tabular_neural": ("TabM",),
    "graph": ("GNN",),
    "learned_sequence": ("DLinear", "PatchTST", "iTransformer"),
}
_DIRECT_ALPHA_BLOCKED_MODELS = {"TimesFM"}

_SEQUENCE_MODEL_SOURCE_KEYS: dict[str, str] = {
    "DLinear": "dlinear",
    "PatchTST": "patchtst",
    "iTransformer": "itransformer",
}


def _finite_rank_score(value: Any) -> float | None:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(numeric):
        return None
    return max(0.0, min(1.0, numeric))


def _forecast_pct_to_rank_score(value: Any) -> float | None:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(numeric):
        return None
    try:
        return 1.0 / (1.0 + math.exp(-numeric * 12.0))
    except OverflowError:
        return 1.0 if numeric > 0 else 0.0


def _model_rank_score(prediction: dict, model_name: str) -> float | None:
    if model_name in _DIRECT_ALPHA_BLOCKED_MODELS:
        return None
    if model_name in _SEQUENCE_MODEL_SOURCE_KEYS:
        signal = prediction.get(_SEQUENCE_MODEL_SOURCE_KEYS[model_name])
        if not isinstance(signal, dict):
            return None
        return _forecast_pct_to_rank_score(signal.get("forecast_pct"))
    rank_scores = prediction.get("rank_scores")
    if not isinstance(rank_scores, dict):
        return None
    return _finite_rank_score(rank_scores.get(model_name))


def _positive_lifecycle_weights(prediction: dict) -> dict[str, float] | None:
    ev2 = prediction.get("ensemble_v2")
    if not isinstance(ev2, dict):
        return None
    weights = ev2.get("weights")
    if isinstance(weights, dict):
        out: dict[str, float] = {}
        for name, raw in weights.items():
            if str(name) in _DIRECT_ALPHA_BLOCKED_MODELS:
                continue
            try:
                value = float(raw)
            except (TypeError, ValueError):
                continue
            if math.isfinite(value) and value > 0:
                out[str(name)] = value
        return out
    contributors = ev2.get("contributing_models")
    if isinstance(contributors, list):
        return {
            str(name): 1.0
            for name in contributors
            if str(name) and str(name) not in _DIRECT_ALPHA_BLOCKED_MODELS
        }
    return None


def build_core_family_evidence(
    prediction: dict | None,
    *,
    require_lifecycle_weights: bool = False,
) -> dict[str, Any]:
    """Layer 3 formal family evidence from lifecycle-positive production outputs."""
    pred = prediction if isinstance(prediction, dict) else {}
    lifecycle_weights = _positive_lifecycle_weights(pred)
    families: dict[str, dict[str, Any]] = {}
    active_families: list[str] = []
    family_scores: list[float] = []
    inactive_models: list[str] = []
    inactive_lifecycle_models: list[str] = []
    duplicate_groups_all: dict[str, list[list[str]]] = {}
    effective_model_vote_count = 0

    for family_name, model_names in _CORE_FAMILY_MODEL_GROUPS.items():
        model_scores: dict[str, float] = {}
        score_buckets: dict[float, dict[str, Any]] = {}
        for model_name in model_names:
            lifecycle_weight = lifecycle_weights.get(model_name) if lifecycle_weights is not None else None
            if require_lifecycle_weights and lifecycle_weights is None:
                inactive_lifecycle_models.append(model_name)
                continue
            if lifecycle_weights is not None and lifecycle_weight is None:
                inactive_lifecycle_models.append(model_name)
                continue
            score = _model_rank_score(pred, model_name)
            if score is not None:
                model_scores[model_name] = round(score, 6)
                weight = float(lifecycle_weight if lifecycle_weight is not None else 1.0)
                bucket_key = round(float(score), 6)
                bucket = score_buckets.setdefault(bucket_key, {"score": float(score), "weight": 0.0, "models": []})
                bucket["weight"] = max(float(bucket["weight"]), weight)
                bucket["models"].append(model_name)
            else:
                inactive_models.append(model_name)
        if model_scores:
            weighted_sum = sum(float(row["score"]) * float(row["weight"]) for row in score_buckets.values())
            weight_sum = sum(float(row["weight"]) for row in score_buckets.values())
            family_score = weighted_sum / weight_sum if weight_sum > 0 else sum(model_scores.values()) / len(model_scores)
            duplicate_groups = [
                list(row["models"])
                for row in score_buckets.values()
                if len(row.get("models") or []) > 1
            ]
            if duplicate_groups:
                duplicate_groups_all[family_name] = duplicate_groups
            effective_count = len(score_buckets)
            effective_model_vote_count += effective_count
            score_values = list(model_scores.values())
            active_families.append(family_name)
            family_scores.append(family_score)
            families[family_name] = {
                "status": "active",
                "score": round(family_score, 6),
                "models": model_scores,
                "model_count": len(model_scores),
                "effective_model_count": effective_count,
                "duplicate_model_groups": duplicate_groups,
                "duplicate_guard_applied": bool(duplicate_groups),
                "model_score_range": round(max(score_values) - min(score_values), 6) if score_values else 0.0,
                "lifecycle_weighted": lifecycle_weights is not None,
            }
        else:
            families[family_name] = {
                "status": (
                    "inactive_lifecycle_weight"
                    if lifecycle_weights is not None or require_lifecycle_weights
                    else "inactive_missing_artifact"
                ),
                "score": None,
                "models": {},
                "expected_models": list(model_names),
            }

    family_score = sum(family_scores) / len(family_scores) if family_scores else 0.0
    return {
        "schema_version": "core_family_evidence_v1",
        "evidence_source": "formal_core_family_evidence",
        "rank_source": "deprecated_formal_core_family_vote",
        "family_score": round(family_score, 6),
        "active_family_count": len(active_families),
        "active_families": active_families,
        "families": families,
        "effective_model_vote_count": effective_model_vote_count,
        "duplicate_model_groups": duplicate_groups_all,
        "inactive_formal_models": sorted(set(inactive_models)),
        "inactive_lifecycle_models": sorted(set(inactive_lifecycle_models)),
        "lifecycle_weight_source": (
            "ensemble_v2.weights"
            if lifecycle_weights is not None
            else "ensemble_v2_required_missing" if require_lifecycle_weights else "model_output_fallback"
        ),
    }


def build_core_family_vote(
    prediction: dict | None,
    *,
    require_lifecycle_weights: bool = False,
) -> dict[str, Any]:
    """Backward-compatible alias; new callers should use core family evidence."""
    return build_core_family_evidence(
        prediction,
        require_lifecycle_weights=require_lifecycle_weights,
    )


def _merge_core_family_evidence(row: dict, evidence: dict[str, Any]) -> None:
    row["core_family_evidence"] = evidence
    row["core_family_vote"] = evidence
    row["watch_points"] = [
        *(row.get("watch_points") if isinstance(row.get("watch_points"), list) else []),
        (
            "core_family_evidence:"
            f"families={evidence.get('active_family_count')}:"
            f"score={evidence.get('family_score')}"
        ),
    ]

    summary = row.get("ml_vote_summary")
    if isinstance(summary, str):
        try:
            summary = json.loads(summary)
        except json.JSONDecodeError:
            summary = {"text": row.get("ml_vote_summary")}
    if not isinstance(summary, dict):
        summary = {}
    evidence_summary = {
        "schema_version": evidence.get("schema_version"),
        "family_score": evidence.get("family_score"),
        "active_family_count": evidence.get("active_family_count"),
        "active_families": evidence.get("active_families"),
        "effective_model_vote_count": evidence.get("effective_model_vote_count"),
        "duplicate_model_groups": evidence.get("duplicate_model_groups"),
        "inactive_formal_models": evidence.get("inactive_formal_models"),
        "selection_role": "evidence_only_not_capacity_gate",
    }
    summary["coreFamilyEvidence"] = evidence_summary
    summary["coreFamilyVote"] = evidence_summary
    row["ml_vote_summary"] = summary

    components = row.get("score_components")
    if isinstance(components, str):
        components = _parse_score_components_payload(components) or {"raw": row.get("score_components")}
    if isinstance(components, dict):
        components["coreFamilyEvidence"] = evidence
        components["coreFamilyVote"] = evidence
        row["score_components"] = components


def apply_core_family_evidence(
    recommendations: list[dict],
    predictions: dict[str, dict],
    *,
    target_size: int | None = None,
    min_active_families: int = 2,
    strict: bool = True,
    require_lifecycle_weights: bool = False,
) -> list[dict]:
    """Attach Layer 3 family evidence without ranking or truncating the candidate pool."""
    if not recommendations:
        return []

    enriched: list[dict] = []
    insufficient: list[str] = []
    for row in recommendations:
        symbol = str(row.get("symbol") or "")
        pred = predictions.get(symbol) if isinstance(predictions, dict) else None
        evidence = build_core_family_evidence(pred, require_lifecycle_weights=require_lifecycle_weights)
        evidence["min_active_families"] = int(min_active_families)
        evidence["evidence_status"] = (
            "sufficient_family_breadth"
            if int(evidence.get("active_family_count") or 0) >= int(min_active_families)
            else "insufficient_family_breadth"
        )
        evidence["selection_role"] = "evidence_only_not_capacity_gate"
        if isinstance(pred, dict):
            pred["core_family_evidence"] = evidence
            pred["core_family_vote"] = evidence
        if int(evidence.get("active_family_count") or 0) < min_active_families:
            insufficient.append(symbol)
        enriched_row = {**row, "core_family_evidence": evidence, "core_family_vote": evidence}
        _merge_core_family_evidence(enriched_row, evidence)
        enriched.append(enriched_row)

    if strict and insufficient and len(insufficient) == len(recommendations):
        logger.warning(
            "core_family_evidence_all_insufficient: %s/%s rows lack production family breadth",
            len(insufficient),
            len(recommendations),
        )
    return enriched


def apply_core_family_rank(
    recommendations: list[dict],
    predictions: dict[str, dict],
    *,
    target_size: int | None = None,
    min_active_families: int = 2,
    strict: bool = True,
    require_lifecycle_weights: bool = False,
) -> list[dict]:
    """Deprecated alias for apply_core_family_evidence; no rank/capacity cutoff."""
    return apply_core_family_evidence(
        recommendations,
        predictions,
        target_size=target_size,
        min_active_families=min_active_families,
        strict=strict,
        require_lifecycle_weights=require_lifecycle_weights,
    )


def _allocation_method(policy: dict) -> str:
    allocation = policy.get("allocation") if isinstance(policy, dict) else {}
    value = (allocation or {}).get("engine") or (allocation or {}).get("method") or ""
    return str(value or "").strip()


def _is_sparse_potential_buy_evidence(evidence: dict[str, Any]) -> bool:
    if evidence.get("selection_reason") != POTENTIAL_BUY_SELECTION_REASON:
        return False
    if evidence.get("eligible_for_sparse") is not True:
        return False
    if evidence.get("positive_expected_edge") is not True:
        return False
    try:
        expected_return = float(evidence.get("expected_return") or 0.0)
        single_name_weight = float(evidence.get("single_name_weight") or 0.0)
    except (TypeError, ValueError):
        return False
    if not math.isfinite(expected_return) or expected_return < POTENTIAL_BUY_MIN_EXPECTED_RETURN:
        return False
    return math.isfinite(single_name_weight) and single_name_weight <= 0.0


def _row_expected_return(row: dict, alpha_policy: dict | None = None) -> float:
    value, _source = _row_expected_return_with_source(row, alpha_policy=alpha_policy)
    return value


_MISSING_EXPECTED_RETURN_SOURCES = {
    "missing",
    "uncalibrated_rank_score",
    "missing_calibrated_forecast_pct",
    "no_positive_lifecycle_weight",
    "s12_trade_ev_required",
    "s12_trade_ev_missing",
    "s12_trade_ev_missing_no_allocation_edge",
    "legacy_forecast_pct_not_trade_ev",
    "forecast_return_5bar_not_trade_ev",
    "calibrated_rank_bin_forecast_not_trade_ev",
    "calibrated_rank_tail_clamp_forecast_not_trade_ev",
    "market_heat_factor_overlay_not_expected_return",
    "missing_no_expected_return",
    "uncalibrated_rank_score_no_expected_return",
    "missing_calibrated_forecast_pct_no_expected_return",
    "no_positive_lifecycle_weight_no_expected_return",
    "missing_expected_return_no_allocation_edge",
}


def _dict_payload(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _expected_return_source_missing(source: str) -> bool:
    normalized = str(source or "").strip()
    return (
        normalized in _MISSING_EXPECTED_RETURN_SOURCES
        or normalized.endswith("_no_expected_return")
        or normalized.endswith("_not_trade_ev")
        or normalized.endswith("_insufficient_samples")
        or normalized.endswith("_missing")
    )


def _expected_return_source_is_trade_ev(source: str) -> bool:
    normalized = str(source or "").strip().lower()
    if not normalized:
        return False
    if "forecast" in normalized or "market_heat" in normalized:
        return False
    return "trade_ev" in normalized or normalized.startswith("s12_") or normalized.startswith("paper_trade")


def _expected_return_source_is_l4_alpha_ev(source: str, payload: dict[str, Any] | None = None) -> bool:
    normalized = str(source or "").strip().lower()
    owner = str((payload or {}).get("expected_return_owner") or (payload or {}).get("selection_alpha_owner") or "").lower()
    if owner == "l4_alpha_ev":
        return True
    return normalized.startswith("l4_alpha_ev") or "l4_alpha_ev" in normalized


def _expected_return_source_is_allocator_ev_fusion(source: str, payload: dict[str, Any] | None = None) -> bool:
    normalized = str(source or "").strip().lower()
    owner = str((payload or {}).get("expected_return_owner") or "").lower()
    if owner == "allocator_ev_fusion":
        return True
    return normalized.startswith("allocator_ev_fusion") or "allocator_ev_fusion" in normalized


def _s12_trade_ev_is_verified_symbol_owner(source: str, payload: dict[str, Any] | None) -> bool:
    if not isinstance(payload, dict):
        return False
    normalized = str(source or payload.get("trade_expected_return_source") or "").strip().lower()
    if normalized.startswith("s12_structural_cold_start_ev") or normalized.startswith("s12_structural_setup_cold_start_ev"):
        return False
    if normalized.endswith("_insufficient_samples") or normalized.endswith("_insufficient_sample_dates"):
        return False
    status = str(payload.get("status") or "").strip().lower()
    if status not in {"loaded", "verified"}:
        return False
    scope = str(
        payload.get("bootstrap_scope")
        or payload.get("replay_scope")
        or payload.get("scope")
        or ""
    ).strip().lower()
    if scope == "symbol":
        return True
    sample_policy = str(payload.get("sample_policy") or "").strip().lower()
    return "verified_s12" in sample_policy and "symbol" in sample_policy


def _forecast_source_not_trade_ev(source: str) -> str:
    normalized = str(source or "").strip()
    if not normalized:
        return "missing_expected_return_no_allocation_edge"
    if normalized in _MISSING_EXPECTED_RETURN_SOURCES or normalized.endswith("_no_expected_return"):
        return normalized
    if "forecast" in normalized or "calibrated_rank" in normalized or normalized == "legacy":
        return f"{normalized}_forecast_not_trade_ev"
    return f"{normalized}_not_trade_ev"


def _canonical_expected_return_from_row(
    row: dict,
    *,
    alpha_policy: dict | None = None,
    market_heat_expected_return: float = 0.0,
) -> tuple[float | None, str, dict[str, Any] | None]:
    trade_ev_value, trade_ev_source, trade_ev_payload = extract_s12_trade_ev(row)
    alpha_ev_value, alpha_ev_source, alpha_ev_payload = extract_l4_alpha_ev(row)
    fusion_payload = materialize_allocator_ev_fusion(
        row,
        l4_value=alpha_ev_value,
        l4_source=alpha_ev_source,
        l4_payload=alpha_ev_payload,
        s12_value=trade_ev_value,
        s12_source=trade_ev_source,
        s12_payload=trade_ev_payload,
        market_heat_expected_return=market_heat_expected_return,
        policy=alpha_policy,
    )
    fusion_loaded_non_primary = False
    if isinstance(fusion_payload, dict):
        row["allocator_ev_fusion"] = fusion_payload
        status = str(fusion_payload.get("status") or "").strip().lower()
        value = _float_or_none(fusion_payload.get("expected_return"))
        primary_allowed = fusion_payload.get("primary_expected_return_allowed") is True
        if status == "loaded" and value is not None and primary_allowed:
            return value, str(fusion_payload.get("expected_return_source") or "allocator_ev_fusion"), fusion_payload
        fusion_loaded_non_primary = status == "loaded"
        if status == "rejected":
            return None, str(fusion_payload.get("expected_return_source") or "allocator_ev_fusion_rejected"), fusion_payload

    if fusion_loaded_non_primary and alpha_ev_value is not None:
        return alpha_ev_value, alpha_ev_source, alpha_ev_payload

    if trade_ev_value is not None and _s12_trade_ev_is_verified_symbol_owner(trade_ev_source, trade_ev_payload):
        return trade_ev_value, trade_ev_source, trade_ev_payload

    if alpha_ev_value is not None:
        return alpha_ev_value, alpha_ev_source, alpha_ev_payload

    if trade_ev_value is not None:
        return trade_ev_value, trade_ev_source, trade_ev_payload

    candidates: list[tuple[Any, Any, str, dict[str, Any] | None]] = [
        (
            row.get("expected_return"),
            row.get("expected_return_source"),
            "daily_recommendation.expected_return",
            None,
        ),
    ]
    ev2 = row.get("ensemble_v2") if isinstance(row.get("ensemble_v2"), dict) else {}
    if ev2:
        candidates.append((
            ev2.get("expected_return"),
            ev2.get("expected_return_source"),
            "ensemble_v2.expected_return",
            ev2,
        ))
    forecast_data = _dict_payload(row.get("forecast_data"))
    fd_ev2 = forecast_data.get("ensemble_v2") if isinstance(forecast_data.get("ensemble_v2"), dict) else {}
    if fd_ev2:
        candidates.append((
            fd_ev2.get("expected_return"),
            fd_ev2.get("expected_return_source"),
            "forecast_data.ensemble_v2.expected_return",
            fd_ev2,
        ))

    first_rejected_source: str | None = alpha_ev_source if alpha_ev_payload else trade_ev_source
    for raw_value, raw_source, owner, payload in candidates:
        source = str(raw_source or "").strip()
        if raw_value is None:
            if _expected_return_source_missing(source):
                return None, f"{source}_no_expected_return", payload
            if source:
                first_rejected_source = _forecast_source_not_trade_ev(source)
            continue
        value = _float_or_none(raw_value)
        if value is None:
            continue
        if _expected_return_source_missing(source):
            return None, f"{source}_no_expected_return", payload
        effective_source = source or owner
        if _expected_return_source_is_l4_alpha_ev(effective_source, payload):
            return None, f"{effective_source}_requires_validated_l4_alpha_ev_payload_no_expected_return", payload
        if not _expected_return_source_is_trade_ev(effective_source):
            return None, _forecast_source_not_trade_ev(effective_source), payload
        return value, effective_source, payload
    return None, first_rejected_source or "missing_expected_return_no_allocation_edge", alpha_ev_payload or trade_ev_payload


def _expected_return_uncertainty_adjustment(row: dict, value: float) -> tuple[float, dict[str, Any] | None]:
    if value <= 0:
        return value, None
    diagnostics = row.get("dispersion_diagnostics")
    if not isinstance(diagnostics, dict):
        forecast_data = _dict_payload(row.get("forecast_data"))
        diagnostics = forecast_data.get("dispersion_diagnostics")
    if not isinstance(diagnostics, dict):
        return value, None

    multiplier = 1.0
    reasons: list[str] = []
    active_count = _float_or_none(diagnostics.get("active_weight_count"))
    weight_hhi = _float_or_none(diagnostics.get("weight_hhi"))
    merge_compression = _float_or_none(diagnostics.get("merge_compression"))
    raw_model_count = _float_or_none(diagnostics.get("raw_model_count"))
    if active_count is not None and active_count < 4:
        multiplier *= 0.85
        reasons.append("low_active_weight_count")
    if weight_hhi is not None and weight_hhi > 0.45:
        multiplier *= 0.90
        reasons.append("high_weight_concentration")
    if merge_compression is not None and merge_compression > 0.08:
        multiplier *= 0.90
        reasons.append("high_merge_compression")
    if raw_model_count is not None and raw_model_count < 4:
        multiplier *= 0.90
        reasons.append("low_raw_model_count")
    multiplier = max(0.65, min(1.0, multiplier))
    if not reasons or multiplier >= 0.999999:
        return value, None
    adjusted = round(value * multiplier, 10)
    evidence = {
        "schema_version": "expected-return-uncertainty-adjustment-v1",
        "source": "prediction_dispersion",
        "raw_expected_return": round(value, 10),
        "adjusted_expected_return": adjusted,
        "multiplier": round(multiplier, 6),
        "reasons": reasons,
        "active_weight_count": active_count,
        "weight_hhi": weight_hhi,
        "merge_compression": merge_compression,
        "raw_model_count": raw_model_count,
        "policy": "positive_expected_return_haircut_not_signal_override",
    }
    row["_expected_return_uncertainty_adjustment"] = evidence
    return adjusted, evidence


def _allocator_target_quality(payload: dict[str, Any]) -> dict[str, Any]:
    targets = payload.get("s12_structural_targets") if isinstance(payload.get("s12_structural_targets"), dict) else {}
    multiplier = _float_or_none(targets.get("reward_confidence_multiplier"))
    if multiplier is None:
        multiplier = _float_or_none(payload.get("reward_confidence_multiplier"))
    if multiplier is None:
        multiplier = 1.0
    state = str(targets.get("target_quality_state") or "").strip()
    if not state:
        t1 = str(targets.get("target1_source") or "")
        t2 = str(targets.get("target2_source") or "")
        if "r_multiple_fallback" in t1 and "r_multiple_fallback" in t2:
            state = "r_multiple_fallback_both"
        elif "r_multiple_fallback" in t2:
            state = "partial_structure_target"
        else:
            state = "structure_targets"
    return {
        "target_quality_state": state,
        "reward_confidence_multiplier": round(max(0.25, min(1.0, float(multiplier))), 6),
        "target1_source": targets.get("target1_source"),
        "target2_source": targets.get("target2_source"),
    }


def _allocator_edge_quality(
    row: dict,
    *,
    payload: dict[str, Any],
    market_heat_expected_return: float,
    target_quality: dict[str, Any],
) -> dict[str, Any]:
    components = _score_v2_components_from_row(row)
    final_score = _float_or_none(row.get("score"))
    if final_score is None:
        final_score = _float_or_none(row.get("_combined_score"))
        if final_score is not None:
            final_score *= 100.0
    score_quality = max(0.0, min(1.0, (final_score or 0.0) / 100.0))
    heat_quality = max(0.0, min(1.0, market_heat_expected_return / 0.01))
    target_multiplier = float(target_quality.get("reward_confidence_multiplier") or 1.0)
    status = str(payload.get("status") or "").strip().lower()
    execution_ready = payload.get("execution_ready")
    status_quality = 0.90 if status == "loaded" else 0.72 if status == "setup_only" else 0.50
    if execution_ready is False:
        status_quality = min(status_quality, 0.72)
    component_floor = min(
        float(components.get("chipFlow") or 0.0) / 25.0,
        float(components.get("technicalStructure") or 0.0) / 25.0,
        float(components.get("fundamentalQuality") or 0.0) / 25.0,
    )
    quality = (
        (0.35 * score_quality)
        + (0.20 * heat_quality)
        + (0.25 * target_multiplier)
        + (0.10 * status_quality)
        + (0.10 * max(0.0, min(1.0, component_floor)))
    )
    return {
        "allocator_edge_quality_score": round(quality * 100.0, 4),
        "score_quality": round(score_quality, 6),
        "market_heat_quality": round(heat_quality, 6),
        "target_quality_multiplier": round(target_multiplier, 6),
        "status_quality": round(status_quality, 6),
        "component_floor_quality": round(max(0.0, min(1.0, component_floor)), 6),
        "components": components,
    }


def _cold_start_admission_block_reason(
    *,
    payload: dict[str, Any],
    source: str,
    target_quality: dict[str, Any],
) -> str | None:
    cold_start_source = source.startswith("s12_structural_cold_start_ev") or source.startswith("s12_structural_setup_cold_start_ev")
    if not cold_start_source:
        return None
    if payload.get("execution_ready") is False or str(payload.get("status") or "").strip().lower() == "setup_only":
        return "s12_cold_start_execution_not_ready"
    replay = payload.get("replay_bootstrap") if isinstance(payload.get("replay_bootstrap"), dict) else {}
    replay_scope = str(replay.get("bootstrap_scope") or "").strip()
    replay_samples = _float_or_none(replay.get("sampleCount")) or 0.0
    replay_min_samples = _float_or_none(replay.get("minSamples")) or 30.0
    replay_dates = _float_or_none(replay.get("sampleDateCount")) or 0.0
    replay_warmup_min_dates = min(3.0, _float_or_none(replay.get("minSampleDates")) or 8.0)
    replay_ev = _float_or_none(replay.get("trade_expected_return_net_pct"))
    replay_r = _float_or_none(replay.get("expected_R"))
    replay_has_warmup_breadth = (
        replay_scope in {"symbol", "market_segment_alpha_bucket", "market_segment"}
        and replay_samples >= replay_min_samples
        and replay_dates >= replay_warmup_min_dates
    )
    replay_positive_support = (
        replay_has_warmup_breadth
        and replay_ev is not None
        and replay_ev > 0
        and (replay_r is None or replay_r > 0)
    )
    if replay_has_warmup_breadth and not replay_positive_support:
        return "s12_cold_start_peer_replay_negative_or_zero"
    if str(target_quality.get("target_quality_state") or "").strip() == "r_multiple_fallback_both":
        if replay_positive_support:
            return None
        return "s12_cold_start_requires_real_structure_targets"
    targets = payload.get("s12_structural_targets") if isinstance(payload.get("s12_structural_targets"), dict) else {}
    if str(targets.get("structure_stop_source") or "").strip() == "missing_s12_structure_stop":
        return "s12_cold_start_requires_real_structure_stop"
    context = payload.get("candidate_s12_entry_context")
    if not isinstance(context, dict):
        context = payload.get("s12_entry_context")
    if not isinstance(context, dict):
        context = {}
    has_entry_context = bool(context.get("detail_available")) or any(
        context.get(key) is not None
        for key in ("ready", "state", "entry_archetype", "vwap_fast_acceptance", "vwap_slow_context", "htf_hard_block")
    )
    if not has_entry_context:
        if replay_positive_support:
            return None
        return "s12_cold_start_requires_s12_entry_context"
    return None


def _allocator_edge_resolver(
    row: dict,
    *,
    expected_return: float,
    expected_return_source: str,
    payload: dict[str, Any] | None,
    market_heat_expected_return: float,
) -> tuple[float, str, dict[str, Any]]:
    payload_dict = payload if isinstance(payload, dict) else {}
    source = str(expected_return_source or "").strip()
    expected_return_owner = (
        "allocator_ev_fusion"
        if _expected_return_source_is_allocator_ev_fusion(source, payload_dict)
        else "l4_alpha_ev"
        if _expected_return_source_is_l4_alpha_ev(source, payload_dict)
        else "s12_trade_ev"
    )
    target_quality = _allocator_target_quality(payload_dict)
    edge_quality = _allocator_edge_quality(
        row,
        payload=payload_dict,
        market_heat_expected_return=market_heat_expected_return,
        target_quality=target_quality,
    )
    cold_start_source = source.startswith("s12_structural_cold_start_ev") or source.startswith("s12_structural_setup_cold_start_ev")
    cold_start_block_reason = _cold_start_admission_block_reason(
        payload=payload_dict,
        source=source,
        target_quality=target_quality,
    ) if expected_return_owner == "s12_trade_ev" else None
    conditional_admission_allowed = (
        expected_return_owner == "s12_trade_ev"
        and
        cold_start_source
        and cold_start_block_reason is None
        and expected_return > 0
        and edge_quality["allocator_edge_quality_score"] >= 60.0
        and market_heat_expected_return >= 0.003
    )
    evidence = {
        "schema_version": "allocator-edge-resolver-v1",
        "expected_return_owner": expected_return_owner,
        "expected_return": round(float(expected_return), 10),
        "expected_return_source": source,
        "payload_status": payload_dict.get("status"),
        "payload_semantic": payload_dict.get("semantic"),
        "selection_alpha_owner": payload_dict.get("selection_alpha_owner"),
        "validation_decision": payload_dict.get("validation_decision"),
        "approval_state": payload_dict.get("approval_state"),
        "model_version": payload_dict.get("model_version"),
        "feature_snapshot_version": payload_dict.get("feature_snapshot_version"),
        "trained_until": payload_dict.get("trained_until"),
        "sample_policy": payload_dict.get("sample_policy"),
        "execution_ready": payload_dict.get("execution_ready"),
        "execution_gate_required": payload_dict.get("execution_gate_required"),
        "market_heat_expected_return": round(float(market_heat_expected_return), 10),
        "market_heat_role": "diagnostic_context_not_expected_return_owner",
        "policy": "allocator_expected_edge_accepts_validated_l4_alpha_ev_or_s12_trade_ev",
        "adjustment_applied": False,
        "allocator_edge_quality_score": edge_quality["allocator_edge_quality_score"],
        "edge_quality": edge_quality,
        "s12_target_quality": target_quality,
        "conditional_admission_block_reason": cold_start_block_reason,
        "conditional_admission_allowed": conditional_admission_allowed,
        "conditional_admission_policy": (
            "positive_s12_cold_ev_can_enter_allocator_when_quality_high_even_if_below_static_min"
            if conditional_admission_allowed
            else "standard_static_min_gate"
        ),
    }
    if expected_return_owner == "allocator_ev_fusion":
        evidence["candidate_contract"] = "production_allocator_ev_fusion_l4_selection_alpha_plus_s12_execution_trade_ev"
    elif expected_return_owner == "l4_alpha_ev":
        evidence["candidate_contract"] = "production_l4_alpha_ev_selection_expected_return"
    elif source.startswith("s12_structural_setup_cold_start_ev"):
        evidence["candidate_contract"] = "setup_ev_allowed_for_selection_execution_requires_s12_reaction_ready"
    elif source.startswith("s12_structural_cold_start_ev"):
        evidence["candidate_contract"] = "s12_structural_cold_start_ev_until_replay_samples_sufficient"
    elif source.startswith("s12_replay_trade_outcomes"):
        evidence["candidate_contract"] = "verified_s12_replay_trade_outcomes"
    else:
        evidence["candidate_contract"] = "accepted_trade_ev_source"
    row["_allocator_edge_resolver"] = evidence
    return expected_return, source, evidence


def _row_expected_return_with_source(row: dict, *, alpha_policy: dict | None = None) -> tuple[float, str]:
    alpha_context = row.get("alpha_context") if isinstance(row.get("alpha_context"), dict) else {}
    heat_edge = _float_or_none(row.get("market_heat_expected_return"))
    if heat_edge is None:
        heat_edge = _float_or_none(alpha_context.get("market_heat_expected_return"))
    heat_edge = max(0.0, heat_edge or 0.0)
    if heat_edge > 0:
        row["_market_heat_allocator_overlay"] = {
            "source": "market_heat_factor",
            "market_heat_expected_return": heat_edge,
            "policy": "diagnostic_overlay_not_expected_return",
        }

    canonical_value, canonical_source, payload = _canonical_expected_return_from_row(
        row,
        alpha_policy=alpha_policy,
        market_heat_expected_return=heat_edge,
    )
    if isinstance(payload, dict):
        row["_expected_return_payload"] = payload
    if canonical_value is None:
        if (
            canonical_source != "missing_expected_return_no_allocation_edge"
            and _expected_return_source_missing(canonical_source)
        ):
            return 0.0, canonical_source
        if canonical_source != "missing_expected_return_no_allocation_edge":
            return 0.0, canonical_source
    else:
        resolved_value, resolved_source, resolver_evidence = _allocator_edge_resolver(
            row,
            expected_return=canonical_value,
            expected_return_source=canonical_source,
            payload=payload,
            market_heat_expected_return=heat_edge,
        )
        adjusted_value, adjustment = _expected_return_uncertainty_adjustment(row, resolved_value)
        source = resolved_source
        if adjustment:
            source = f"{source}_dispersion_adjusted"
            resolver_evidence["dispersion_adjusted"] = True
            resolver_evidence["post_dispersion_expected_return"] = round(adjusted_value, 10)
        return adjusted_value, source

    return 0.0, "missing_expected_return_no_allocation_edge"


def _opb_trade_ev_payload(allocation: dict[str, Any]) -> dict[str, Any]:
    for key in ("s12_trade_ev", "expected_return_payload", "trade_ev"):
        payload = allocation.get(key)
        if isinstance(payload, dict):
            return payload
    return {}


def _opb_reward_from_row(row: dict[str, Any], allocation: dict[str, Any]) -> tuple[float | None, dict[str, Any]]:
    trade_pnl_pct = _float_or_none(row.get("trade_pnl_pct"))
    trade_pnl_r = _float_or_none(row.get("trade_pnl_r"))
    actual_return_pct = _float_or_none(row.get("actual_return_pct"))
    trade_ev = _opb_trade_ev_payload(allocation)
    risk_pct = _float_or_none(trade_ev.get("risk_pct"))
    source = "missing"
    if trade_pnl_pct is not None:
        reward = trade_pnl_pct
        source = "trade_pnl_pct"
    elif trade_pnl_r is not None:
        scale = risk_pct if risk_pct is not None and risk_pct > 0 else 0.01
        reward = trade_pnl_r * scale
        source = "trade_pnl_r_scaled_by_s12_risk_pct" if risk_pct else "trade_pnl_r_scaled_default_1pct_risk"
    elif actual_return_pct is not None:
        reward = actual_return_pct
        source = "actual_return_pct_5bar_fallback"
    else:
        return None, {"reward_source": source}
    clamped = max(-0.20, min(0.20, reward))
    return clamped, {
        "reward_source": source,
        "raw_reward": round(reward, 10),
        "reward": round(clamped, 10),
        "trade_pnl_pct": None if trade_pnl_pct is None else round(trade_pnl_pct, 10),
        "trade_pnl_r": None if trade_pnl_r is None else round(trade_pnl_r, 6),
        "risk_pct": None if risk_pct is None else round(risk_pct, 10),
        "actual_return_pct": None if actual_return_pct is None else round(actual_return_pct, 10),
    }


def _row_daily_risk_estimate(symbol: str, risk_history: dict[str, list[float]], daily_vol_floor: float = 0.01) -> float:
    values: list[float] = []
    for value in risk_history.get(symbol, []) or []:
        try:
            numeric = float(value)
        except (TypeError, ValueError):
            continue
        if math.isfinite(numeric):
            values.append(numeric)
    if len(values) < 2:
        return daily_vol_floor
    mean = sum(values) / len(values)
    variance = sum((value - mean) ** 2 for value in values) / max(len(values) - 1, 1)
    return max(daily_vol_floor, math.sqrt(max(0.0, variance)))


def load_online_portfolio_bandit_reward_ledger(
    *,
    lookback_days: int = 180,
    limit: int = 5000,
    query_fn: Any | None = None,
) -> list[dict[str, Any]]:
    """Build OPB arm rewards from realized recommendation outcomes."""

    cutoff = (datetime.now(timezone.utc).date() - timedelta(days=max(1, int(lookback_days)))).isoformat()
    max_rows = max(1, min(int(limit), 20000))
    query = query_fn or d1_client.query
    try:
        rows = query(
            """
            SELECT dr.date,
                   dr.stock_id,
                   dr.symbol,
                   dr.alpha_allocation,
                   p.trade_pnl_pct,
                   p.trade_pnl_r,
                   p.actual_return_pct
              FROM daily_recommendations dr
              JOIN predictions p
                ON p.stock_id = dr.stock_id
               AND p.prediction_date = dr.date
             WHERE dr.date >= ?
               AND dr.alpha_allocation IS NOT NULL
               AND json_valid(dr.alpha_allocation)
               AND json_extract(dr.alpha_allocation, '$.selected') = 1
               AND json_extract(dr.alpha_allocation, '$.opb_controller.enabled') = 1
               AND (p.trade_pnl_pct IS NOT NULL OR p.trade_pnl_r IS NOT NULL OR p.actual_return_pct IS NOT NULL)
             ORDER BY dr.date DESC, dr.rank ASC
             LIMIT ?
            """,
            [cutoff, max_rows],
            timeout=30.0,
        )
    except Exception as exc:  # noqa: BLE001 - OPB learning must not block serving.
        logger.warning("[Ranking] OnlinePortfolioBandit reward ledger unavailable; using priors: %s", exc)
        return []

    daily_rewards: dict[tuple[str, str], dict[str, float]] = {}
    for row in rows or []:
        allocation = _parse_json_dict(row.get("alpha_allocation"))
        opb = allocation.get("opb_controller") if isinstance(allocation, dict) else None
        selected_arm = opb.get("selected_arm") if isinstance(opb, dict) else None
        arm_id = str((selected_arm or {}).get("arm_id") or "").strip()
        business_date = str(row.get("date") or "").strip()
        if not arm_id or not business_date:
            continue
        reward, reward_meta = _opb_reward_from_row(row, allocation or {})
        if reward is None:
            continue
        weight = _float_or_none((allocation or {}).get("allocation_weight"))
        if weight is None:
            weight = _float_or_none((allocation or {}).get("single_name_weight"))
        if weight is None or weight <= 0:
            weight = 1.0
        bucket = daily_rewards.setdefault((business_date, arm_id), {
            "weighted_reward": 0.0,
            "weight": 0.0,
            "weighted_r": 0.0,
            "r_weight": 0.0,
            "source_counts": {},
            "risk_pct_rows": 0.0,
        })
        bucket["weighted_reward"] += reward * weight
        bucket["weight"] += weight
        trade_pnl_r = _float_or_none(reward_meta.get("trade_pnl_r"))
        if trade_pnl_r is not None:
            bucket["weighted_r"] += trade_pnl_r * weight
            bucket["r_weight"] += weight
        reward_source = str(reward_meta.get("reward_source") or "unknown")
        source_counts = bucket.setdefault("source_counts", {})
        source_counts[reward_source] = float(source_counts.get(reward_source, 0.0) or 0.0) + 1.0
        if reward_meta.get("risk_pct") is not None:
            bucket["risk_pct_rows"] += 1.0

    by_arm: dict[str, dict[str, Any]] = {}
    for (business_date, arm_id), bucket in daily_rewards.items():
        total_weight = bucket["weight"]
        if total_weight <= 0:
            continue
        arm_bucket = by_arm.setdefault(arm_id, {
            "rewards": [],
            "r_rewards": [],
            "source_counts": {},
            "risk_pct_rows": 0.0,
            "reward_history": [],
        })
        daily_reward = bucket["weighted_reward"] / total_weight
        arm_bucket["rewards"].append(daily_reward)
        daily_r = None
        if bucket["r_weight"] > 0:
            daily_r = bucket["weighted_r"] / bucket["r_weight"]
            arm_bucket["r_rewards"].append(daily_r)
        arm_bucket["reward_history"].append({
            "date": business_date,
            "reward": daily_reward,
            "reward_r": daily_r,
        })
        for source, count in (bucket.get("source_counts") or {}).items():
            source_counts = arm_bucket.setdefault("source_counts", {})
            source_counts[source] = float(source_counts.get(source, 0.0) or 0.0) + float(count or 0.0)
        arm_bucket["risk_pct_rows"] += float(bucket.get("risk_pct_rows") or 0.0)

    ledger: list[dict[str, Any]] = []
    for arm_id, stats in sorted(by_arm.items()):
        rewards = stats.get("rewards") or []
        if not rewards:
            continue
        reward_sum = sum(rewards)
        samples = len(rewards)
        r_rewards = stats.get("r_rewards") or []
        ledger.append({
            "policy_id": "OnlinePortfolioBandit",
            "arm_id": arm_id,
            "samples": samples,
            "reward_sum": reward_sum,
            "reward_mean": reward_sum / samples,
            "reward_mean_r": (sum(r_rewards) / len(r_rewards)) if r_rewards else None,
            "reward_r_samples": len(r_rewards),
            "reward_source_counts": {
                key: int(value)
                for key, value in sorted((stats.get("source_counts") or {}).items())
            },
            "risk_pct_rows": int(stats.get("risk_pct_rows") or 0),
            "reward_history": sorted(stats.get("reward_history") or [], key=lambda row: row["date"]),
            "source": "daily_recommendations.alpha_allocation+predictions.trade_outcome",
            "reward_policy": "prefer_trade_pnl_pct_then_trade_pnl_r_scaled_by_s12_risk_then_actual_return_pct_fallback",
        })
    return ledger


def _apply_sparse_tangent_buy_selection(
    scored: list[dict],
    ranking_config: dict,
    policy: dict,
    *,
    confidence_floor: float,
    return_history: dict[str, list[float]] | None = None,
    opb_reward_ledger: list[dict[str, Any]] | None = None,
) -> list[dict]:
    allocation = policy.get("allocation") or {}
    buy_signal_count = int(allocation.get("buy_signal_count") or 3)
    buy_signal_count = max(1, min(30, buy_signal_count))
    risk_history = return_history or {}
    def _allocation_float(keys: list[str], default: float | None) -> float | None:
        for key in keys:
            raw = allocation.get(key)
            if raw is None:
                continue
            try:
                value = float(raw)
            except (TypeError, ValueError):
                continue
            if math.isfinite(value):
                return value
        return default

    def _allocation_int(keys: list[str], default: int) -> int:
        value = _allocation_float(keys, float(default))
        if value is None:
            return default
        return int(value)

    def _allocation_text(keys: list[str], default: str) -> str:
        for key in keys:
            raw = allocation.get(key)
            if raw is None:
                continue
            text = str(raw or "").strip()
            if text:
                return text
        return default

    max_weight = float(_allocation_float(["max_weight", "maxWeight"], 0.55) or 0.55)
    cluster_edge_threshold = _allocation_float(["cluster_edge_threshold", "clusterEdgeThreshold"], None)
    cluster_threshold_quantile = float(
        _allocation_float(["cluster_threshold_quantile", "clusterThresholdQuantile"], 0.9) or 0.9
    )
    max_cluster_weight = float(
        _allocation_float(["max_cluster_weight", "maxClusterWeight"], max_weight) or max_weight
    )
    sector_concentration_cap = _allocation_float(["sector_concentration_cap", "sectorConcentrationCap"], 0.5)
    strategy_concentration_cap = _allocation_float(["strategy_concentration_cap", "strategyConcentrationCap"], 0.5)
    family_concentration_cap = _allocation_float(["family_concentration_cap", "familyConcentrationCap"], 0.5)
    allocation_objective = _allocation_text(
        ["objective", "allocationObjective", "allocation_objective"],
        "mean_variance_alpha_utility",
    )
    alpha_strength = float(_allocation_float(["alpha_strength", "alphaStrength"], 1.0) or 1.0)
    risk_aversion = float(_allocation_float(["risk_aversion", "riskAversion"], 2.0) or 2.0)
    turnover_penalty = float(_allocation_float(["turnover_penalty", "turnoverPenalty"], 0.0) or 0.0)
    l2_penalty = float(_allocation_float(["l2_penalty", "l2Penalty"], 0.0) or 0.0)
    utility_iterations = max(40, min(500, _allocation_int(["utility_iterations", "utilityIterations"], 180)))

    def _sanitize_final_weights(
        weights: dict[str, Any],
        *,
        preserve_total_exposure: bool = False,
    ) -> dict[str, float]:
        cleaned: list[tuple[str, float]] = []
        for symbol, raw_weight in weights.items():
            symbol_text = str(symbol or "").strip()
            if not symbol_text:
                continue
            try:
                weight = float(raw_weight or 0.0)
            except (TypeError, ValueError):
                continue
            if math.isfinite(weight) and weight > 0:
                cleaned.append((symbol_text, weight))
        total = sum(weight for _symbol, weight in cleaned)
        if total <= 0:
            return {}
        if preserve_total_exposure:
            if total > 1.0:
                return {symbol: round(weight / total, 10) for symbol, weight in cleaned}
            return {symbol: round(weight, 10) for symbol, weight in cleaned}
        return {symbol: round(weight / total, 10) for symbol, weight in cleaned}

    allocation_contract = {
        "engine": "sparse_tangent_inverse_risk",
        "allocation_method": "sparse_tangent_inverse_risk_final_allocation",
        "input_scope": "post_l3_5_evidence_fusion_candidates",
        "input_candidate_pool_policy": "full_eligible_pool_no_buy_signal_rank_gate",
        "selection_policy": "positive_expected_edge_sparse_weights_no_forced_fill",
        "capacity_policy": "endogenous_positive_marginal_utility_no_hard_top_k",
        "max_capacity_not_target": False,
        "hard_minimum_fill": False,
        "allows_empty_portfolio": True,
        "legacy_rank_topk_fallback_allowed": False,
        "buy_signal_count": buy_signal_count,
        "allocation_capacity": buy_signal_count,
        "buy_signal_count_role": "legacy_display_setting_ignored_by_allocator",
        "sector_concentration_cap": sector_concentration_cap,
        "strategy_concentration_cap": strategy_concentration_cap,
        "family_concentration_cap": family_concentration_cap,
        "allocation_objective": allocation_objective,
        "alpha_strength": alpha_strength,
        "risk_aversion": risk_aversion,
        "turnover_penalty": turnover_penalty,
        "l2_penalty": l2_penalty,
        "diversity_loss_report_scope": "l3_to_l4_sparse_allocation_capacity_and_concentration",
    }

    eligible_rows = [
        row for row in scored
        if _can_promote_ranking_candidate(row, ranking_config, alpha_policy=policy)
    ]
    eligible_row_ids = {id(row) for row in eligible_rows}
    allocation_contract["allocation_candidate_pool_size"] = len(eligible_rows)
    controller = str(allocation.get("controller") or "OnlinePortfolioBandit").strip()

    def _preserve_signal_raw(row: dict) -> None:
        if "signal_raw" not in row:
            row["signal_raw"] = row.get("signal")
        if "signal_source_raw" not in row:
            row["signal_source_raw"] = row.get("signal_source")

    for row in scored:
        signal_text = str(row.get("signal") or "").upper()
        had_allocator_signal = (
            signal_text in {"BUY", POTENTIAL_BUY_SIGNAL}
            or int(row.get("has_buy_signal") or 0) == 1
        )
        row["has_buy_signal"] = 0
        if had_allocator_signal:
            _preserve_signal_raw(row)
            row["signal"] = "HOLD"
            row["signal_source"] = "sparse_tangent_inverse_risk"
            row["ranking_promoted"] = False
            row["sparse_tangent_selected"] = False
            alpha_allocation = row.get("alpha_allocation") if isinstance(row.get("alpha_allocation"), dict) else {}
            row["alpha_allocation"] = {
                **alpha_allocation,
                **allocation_contract,
                "selected": False,
                "controller": controller,
                "potential_buy": False,
            }

    allocation_candidates: list[dict[str, Any]] = []
    candidate_evidence_by_symbol: dict[str, dict[str, Any]] = {}
    for row in eligible_rows:
        symbol = str(row.get("symbol") or "").strip()
        expected_return, expected_return_source = _row_expected_return_with_source(row, alpha_policy=policy)
        candidate = {
            "symbol": symbol,
            "score": row.get("score"),
            "expected_return": expected_return,
            "expected_return_source": expected_return_source,
            "allocator_edge_quality_score": (
                (row.get("_allocator_edge_resolver") or {}).get("allocator_edge_quality_score")
                if isinstance(row.get("_allocator_edge_resolver"), dict)
                else None
            ),
            "conditional_admission_allowed": (
                (row.get("_allocator_edge_resolver") or {}).get("conditional_admission_allowed")
                if isinstance(row.get("_allocator_edge_resolver"), dict)
                else None
            ),
            "s12_target_quality_state": (
                ((row.get("_allocator_edge_resolver") or {}).get("s12_target_quality") or {}).get("target_quality_state")
                if isinstance(row.get("_allocator_edge_resolver"), dict)
                else None
            ),
            "market_heat_score": row.get("market_heat_score"),
            "market_heat_expected_return": row.get("market_heat_expected_return"),
            "turnover_pressure": row.get("turnover_pressure") or row.get("turnover") or row.get("expected_turnover"),
        }
        allocation_candidates.append(candidate)
        if symbol:
            candidate_evidence_by_symbol[symbol] = {
                "expected_return": expected_return,
                "expected_return_source": expected_return_source,
                "expected_return_payload": row.get("_expected_return_payload"),
                "allocator_edge_resolver": row.get("_allocator_edge_resolver"),
                "expected_return_owner": (
                    row.get("_allocator_edge_resolver", {}).get("expected_return_owner")
                    if isinstance(row.get("_allocator_edge_resolver"), dict)
                    else None
                ),
                "promotion_conditional_admission": row.get("promotion_conditional_admission"),
                "promotion_conditional_admission_policy": row.get("promotion_conditional_admission_policy"),
                "promotion_static_min_expected_return": row.get("promotion_static_min_expected_return"),
                "expected_return_uncertainty_adjustment": row.get("_expected_return_uncertainty_adjustment"),
                "market_heat_score": row.get("market_heat_score"),
                "market_heat_expected_return": row.get("market_heat_expected_return"),
                "risk_estimate": _row_daily_risk_estimate(symbol, risk_history),
                "risk_estimate_source": (
                    "return_history_sample_std" if len(risk_history.get(symbol, []) or []) >= 2 else "daily_vol_floor"
                ),
            }
    optimizer_candidates = sorted(
        [row for row in allocation_candidates if str(row.get("symbol") or "").strip()],
        key=lambda row: float(row.get("score") or 0.0),
        reverse=True,
    )
    allocation_rank_by_symbol = {
        str(row.get("symbol") or "").strip(): idx + 1
        for idx, row in enumerate(optimizer_candidates)
    }
    optimizer_symbols = set(allocation_rank_by_symbol)
    positive_edge_count = sum(
        1 for row in optimizer_candidates
        if max(0.0, float(row.get("expected_return") or 0.0)) > 0.0
    )
    return_history_candidate_symbols = sorted(
        symbol for symbol in optimizer_symbols
        if risk_history.get(symbol)
    )
    opb_packet: dict[str, Any] | None = None
    allocation_result: dict[str, Any] = {}
    if controller == "OnlinePortfolioBandit":
        try:
            from services.online_portfolio_bandit import build_online_portfolio_bandit_l2_packet

            opb_packet = build_online_portfolio_bandit_l2_packet(
                candidates=allocation_candidates,
                return_history=risk_history,
                reward_ledger=opb_reward_ledger or [],
                stage="L3_production_allocation_controller",
                candidate_cap_limit=None,
                max_cluster_weight=max_cluster_weight,
                cluster_edge_threshold=cluster_edge_threshold,
                cluster_threshold_quantile=cluster_threshold_quantile,
                allocation_objective=allocation_objective,
                alpha_strength=alpha_strength,
                risk_aversion=risk_aversion,
                turnover_penalty=turnover_penalty,
                l2_penalty=l2_penalty,
                utility_iterations=utility_iterations,
            )
            weights = dict(((opb_packet.get("controlled_allocation") or {}).get("weights") or {}))
            weights = _sanitize_final_weights(weights, preserve_total_exposure=True)
        except Exception as exc:  # noqa: BLE001 - allocator must fall back deterministically.
            logger.warning("[Ranking] OnlinePortfolioBandit controller failed; fallback sparse tangent: %s", exc)
            weights = {}
    else:
        weights = {}

    if not weights:
        # Legacy buy_signal_count cannot truncate the utility optimizer.
        allocation_result = allocate_sparse_tangent_with_evidence(
            allocation_candidates,
            risk_history,
            top_k=max(1, len(allocation_candidates)),
            max_weight=max_weight,
            max_cluster_weight=max_cluster_weight,
            cluster_edge_threshold=cluster_edge_threshold,
            cluster_threshold_quantile=cluster_threshold_quantile,
            allocation_objective=allocation_objective,
            alpha_strength=alpha_strength,
            risk_aversion=risk_aversion,
            turnover_penalty=turnover_penalty,
            l2_penalty=l2_penalty,
            utility_iterations=utility_iterations,
        )
        weights = dict(allocation_result.get("weights") or {})
    else:
        opb_allocation = (opb_packet.get("controlled_allocation") or {}) if opb_packet else {}
        opb_sparse_evidence = (
            opb_allocation.get("sparse_evidence")
            if isinstance(opb_allocation.get("sparse_evidence"), dict)
            else {}
        )
        opb_similarity_symbols = sorted({
            *[str(row.get("symbol") or "").strip() for row in optimizer_candidates],
            *[str(symbol or "").strip() for symbol in weights],
        })
        opb_similarity = similarity_components(
            opb_similarity_symbols,
            risk_history,
            weights=weights,
            edge_threshold=cluster_edge_threshold,
            threshold_quantile=cluster_threshold_quantile,
        )
        weights, cluster_penalty_applied = apply_cluster_exposure_cap(
            weights,
            opb_similarity,
            max_cluster_weight=max_cluster_weight,
            preserve_total_weight=True,
        )
        if cluster_penalty_applied:
            opb_similarity = similarity_components(
                opb_similarity_symbols,
                risk_history,
                weights=weights,
                edge_threshold=cluster_edge_threshold,
                threshold_quantile=cluster_threshold_quantile,
            )
        opb_candidate_diagnostics = dict(opb_sparse_evidence.get("candidate_diagnostics") or {})
        if opb_candidate_diagnostics:
            opb_candidate_diagnostics = {
                symbol: {
                    **diagnostic,
                    "final_weight": round(float(weights.get(symbol, 0.0) or 0.0), 10),
                    "opb_controller_diagnostics": True,
                }
                for symbol, diagnostic in opb_candidate_diagnostics.items()
            }
        allocation_result = {
            **opb_sparse_evidence,
            "weights": weights,
            "similarity_evidence": opb_similarity,
            "cluster_penalty_applied": cluster_penalty_applied,
            "max_cluster_weight": max_cluster_weight,
            "unallocated_cash_weight": round(max(0.0, 1.0 - sum(float(value or 0.0) for value in weights.values())), 10),
            "candidate_diagnostics": opb_candidate_diagnostics,
        }
    selected_symbols = set(weights)
    selected_by_symbol = {row.get("symbol"): row for row in eligible_rows}
    history_coverage = sum(1 for symbol in selected_symbols if risk_history.get(symbol))
    similarity_evidence = allocation_result.get("similarity_evidence") or {}
    objective_evidence = allocation_result.get("objective_evidence") or {}
    allocation_diagnostics_by_symbol = allocation_result.get("candidate_diagnostics") or {}
    cluster_penalty_applied = bool(allocation_result.get("cluster_penalty_applied"))
    cluster_evidence_by_symbol = {
        symbol: symbol_cluster_evidence(symbol, similarity_evidence)
        for symbol in candidate_evidence_by_symbol
    }
    sparse_diagnostics_base = {
        "candidate_count": len(allocation_candidates),
        "evaluated_candidate_count": len(optimizer_candidates),
        "candidate_pool_policy": allocation_result.get(
            "candidate_pool_policy",
            "full_eligible_pool_before_sparse_selection",
        ),
        "optimizer_evaluated_candidate_count": allocation_result.get(
            "evaluated_candidate_count",
            len(optimizer_candidates),
        ),
        "legacy_top_k_ignored": allocation_result.get("legacy_top_k_ignored", buy_signal_count),
        "allocation_capacity": None,
        "positive_edge_count": positive_edge_count,
        "selected_count": len(selected_symbols),
        "zero_selection_allowed": True,
        "capacity_policy": "endogenous_positive_marginal_utility_no_hard_top_k",
        "return_history_candidate_count": len(return_history_candidate_symbols),
        "return_history_candidate_symbols": return_history_candidate_symbols,
        "controller": controller,
        "controller_packet_enabled": opb_packet is not None,
        "controller_reward_ledger_samples": sum(
            int(float(row.get("samples") or 0))
            for row in (opb_reward_ledger or [])
            if isinstance(row, dict)
        ),
        "covariance_method": similarity_evidence.get("covariance_method"),
        "covariance_shrinkage": similarity_evidence.get("covariance_shrinkage"),
        "cluster_penalty_applied": cluster_penalty_applied,
        "max_cluster_weight": max_cluster_weight,
        "sector_concentration_cap": sector_concentration_cap,
        "strategy_concentration_cap": strategy_concentration_cap,
        "family_concentration_cap": family_concentration_cap,
        "unallocated_cash_weight": allocation_result.get("unallocated_cash_weight"),
        "similarity_component_count": similarity_evidence.get("component_count"),
        "effective_independent_count": similarity_evidence.get("effective_independent_count"),
        "pairwise_corr_max": similarity_evidence.get("pairwise_corr_max"),
        "cluster_edge_threshold": similarity_evidence.get("edge_threshold"),
        "cluster_edge_threshold_source": similarity_evidence.get("edge_threshold_source"),
        "allocation_objective": allocation_result.get("allocation_objective", allocation_objective),
        "objective_evidence": objective_evidence,
    }

    def _float_from_row(row: dict, keys: tuple[str, ...]) -> float | None:
        for key in keys:
            value = row.get(key)
            if value is None and isinstance(row.get("score_components"), dict):
                value = row["score_components"].get(key)
            if value is None:
                continue
            try:
                number = float(value)
            except (TypeError, ValueError):
                continue
            if math.isfinite(number):
                return number
        return None

    def _drawdown_state(risk_estimate: float, live_backtest_divergence: float | None) -> str:
        if live_backtest_divergence is not None and live_backtest_divergence >= 0.35:
            return "live_backtest_divergence_elevated"
        if risk_estimate >= 0.12:
            return "drawdown_risk_elevated"
        if risk_estimate > 0:
            return "normal"
        return "unknown"

    def _sparse_allocation_evidence(row: dict, *, selected: bool, weight: float | None = None) -> dict[str, Any]:
        symbol = str(row.get("symbol") or "").strip()
        evidence = candidate_evidence_by_symbol.get(symbol)
        rank = allocation_rank_by_symbol.get(symbol)
        expected_return_raw = (
            (evidence or {}).get("expected_return")
            if evidence
            else row.get("promotion_expected_return")
        )
        expected_return = _float_or_none(expected_return_raw) or 0.0
        risk_estimate = float((evidence or {}).get("risk_estimate") or 0.0)
        expected_return_payload = (
            (evidence or {}).get("expected_return_payload")
            if isinstance((evidence or {}).get("expected_return_payload"), dict)
            else row.get("_expected_return_payload") if isinstance(row.get("_expected_return_payload"), dict) else None
        )
        resolver = (
            (evidence or {}).get("allocator_edge_resolver")
            if isinstance((evidence or {}).get("allocator_edge_resolver"), dict)
            else row.get("_allocator_edge_resolver")
        )
        expected_return_owner = str((resolver or {}).get("expected_return_owner") or "").strip()
        allocator_ev_fusion_payload = (
            expected_return_payload
            if expected_return_owner == "allocator_ev_fusion"
            or str((expected_return_payload or {}).get("expected_return_owner") or "").strip() == "allocator_ev_fusion"
            else None
        )
        if allocator_ev_fusion_payload is None and isinstance(row.get("allocator_ev_fusion"), dict):
            allocator_ev_fusion_payload = row["allocator_ev_fusion"]
        l4_alpha_ev_payload = (
            (allocator_ev_fusion_payload or {}).get("l4_alpha_ev")
            if isinstance(allocator_ev_fusion_payload, dict) and isinstance(allocator_ev_fusion_payload.get("l4_alpha_ev"), dict)
            else expected_return_payload
            if expected_return_owner == "l4_alpha_ev"
            or str((expected_return_payload or {}).get("expected_return_owner") or "").strip() == "l4_alpha_ev"
            else None
        )
        if l4_alpha_ev_payload is None and isinstance(row.get("l4_alpha_ev"), dict):
            l4_alpha_ev_payload = row["l4_alpha_ev"]
        s12_trade_ev_payload = (
            allocator_ev_fusion_payload.get("s12_trade_ev")
            if isinstance(allocator_ev_fusion_payload, dict) and isinstance(allocator_ev_fusion_payload.get("s12_trade_ev"), dict)
            else expected_return_payload if expected_return_owner == "s12_trade_ev" else None
        )
        if s12_trade_ev_payload is None and isinstance(row.get("s12_trade_ev"), dict):
            s12_trade_ev_payload = row["s12_trade_ev"]
        s12_entry_context = (
            s12_trade_ev_payload.get("s12_entry_context")
            if isinstance(s12_trade_ev_payload, dict) and isinstance(s12_trade_ev_payload.get("s12_entry_context"), dict)
            else None
        )
        s12_cold_policy = (
            s12_trade_ev_payload.get("cold_start_policy")
            if isinstance(s12_trade_ev_payload, dict) and isinstance(s12_trade_ev_payload.get("cold_start_policy"), dict)
            else None
        )
        s12_context_haircuts = []
        if isinstance(s12_cold_policy, dict) and isinstance(s12_cold_policy.get("s12_context_haircuts"), list):
            s12_context_haircuts = [
                str(item).strip()
                for item in s12_cold_policy.get("s12_context_haircuts") or []
                if str(item).strip()
            ]
        elif isinstance(s12_entry_context, dict) and isinstance(s12_entry_context.get("equity_mutation_risk_haircuts"), list):
            s12_context_haircuts = [
                str(item).strip()
                for item in s12_entry_context.get("equity_mutation_risk_haircuts") or []
                if str(item).strip()
            ]
        s12_context_multiplier = _float_or_none(
            (s12_cold_policy or {}).get("s12_context_multiplier")
            if isinstance(s12_cold_policy, dict)
            else None
        )
        if s12_context_multiplier is None and isinstance(s12_entry_context, dict):
            s12_context_multiplier = _float_or_none(s12_entry_context.get("multiplier"))
        market_heat_score = _float_from_row(row, ("market_heat_score",))
        market_heat_expected_return = _float_from_row(row, ("market_heat_expected_return",))
        single_name_weight = round(float(weight or 0.0), 8)
        live_backtest_divergence = _float_from_row(row, ("live_backtest_divergence", "live_vs_backtest_divergence"))
        turnover_pressure = _float_from_row(row, ("turnover_pressure", "turnover", "expected_turnover"))
        positive_expected_edge = expected_return > 0.0
        utility_diagnostics = (
            allocation_diagnostics_by_symbol.get(symbol)
            if isinstance(allocation_diagnostics_by_symbol, dict)
            else None
        ) or {}
        marginal_utility = _float_or_none(utility_diagnostics.get("marginal_utility"))
        if selected:
            selection_reason = "selected_positive_edge_sparse_weight"
        elif symbol and symbol not in candidate_evidence_by_symbol:
            selection_reason = "not_eligible_for_sparse_input"
        elif not positive_expected_edge:
            selection_reason = "no_positive_expected_edge"
        elif cluster_penalty_applied:
            selection_reason = "positive_edge_but_zero_weight_due_to_correlation"
        elif marginal_utility is not None and marginal_utility <= 0:
            selection_reason = "positive_edge_but_nonpositive_marginal_utility"
        else:
            selection_reason = "positive_edge_but_zero_weight_due_to_better_alternative"
        sparse_weight_state = (
            "selected_positive_sparse_weight"
            if selected and single_name_weight > 0
            else "zero_sparse_weight_after_inverse_risk"
        )
        cluster_evidence = cluster_evidence_by_symbol.get(symbol) or {}
        return {
            "eligible_for_sparse": symbol in candidate_evidence_by_symbol,
            "allocation_rank": rank,
            "allocation_rank_policy": "diagnostic_only_not_capacity_gate",
            "sparse_weight_state": sparse_weight_state,
            "expected_return": round(expected_return, 10),
            "expected_return_source": (evidence or {}).get("expected_return_source")
            or row.get("promotion_expected_return_source"),
            "expected_return_owner": expected_return_owner or None,
            "allocator_edge_resolver": resolver,
            "promotion_conditional_admission": bool(
                (evidence or {}).get("promotion_conditional_admission")
                or row.get("promotion_conditional_admission")
            ),
            "promotion_conditional_admission_policy": (
                (evidence or {}).get("promotion_conditional_admission_policy")
                or row.get("promotion_conditional_admission_policy")
            ),
            "promotion_static_min_expected_return": (
                (evidence or {}).get("promotion_static_min_expected_return")
                or row.get("promotion_static_min_expected_return")
            ),
            "expected_return_uncertainty_adjustment": (
                (evidence or {}).get("expected_return_uncertainty_adjustment")
                or row.get("_expected_return_uncertainty_adjustment")
            ),
            "allocator_ev_fusion": allocator_ev_fusion_payload,
            "allocator_ev_fusion_diagnostic": allocator_ev_fusion_payload if isinstance(allocator_ev_fusion_payload, dict) else {
                "status": "not_evaluated",
                "reason": "artifact_missing_or_candidate_not_materialized",
                "diagnostic_role": "coverage_marker_not_expected_return_owner",
            },
            "l4_alpha_ev": l4_alpha_ev_payload,
            "s12_trade_ev": s12_trade_ev_payload,
            "s12_entry_context": s12_entry_context,
            "s12_context_multiplier": s12_context_multiplier,
            "s12_context_haircuts": s12_context_haircuts,
            "s12_vwap_fast_acceptance": (
                s12_entry_context.get("vwap_fast_acceptance")
                if isinstance(s12_entry_context, dict)
                else None
            ),
            "s12_vwap_slow_context": (
                s12_entry_context.get("vwap_slow_context")
                if isinstance(s12_entry_context, dict)
                else None
            ),
            "s12_htf_hard_block": (
                s12_entry_context.get("htf_hard_block")
                if isinstance(s12_entry_context, dict)
                else None
            ),
            "market_heat_score": None if market_heat_score is None else round(market_heat_score, 6),
            "market_heat_expected_return": (
                None if market_heat_expected_return is None else round(market_heat_expected_return, 10)
            ),
            "positive_expected_edge": positive_expected_edge,
            "risk_estimate": round(risk_estimate, 10),
            "risk_estimate_source": (evidence or {}).get("risk_estimate_source"),
            "single_name_weight": single_name_weight,
            "single_name_weight_limit": max_weight,
            "drawdown_state": _drawdown_state(risk_estimate, live_backtest_divergence),
            "live_backtest_divergence": None if live_backtest_divergence is None else round(live_backtest_divergence, 6),
            "turnover_pressure": None if turnover_pressure is None else round(turnover_pressure, 6),
            "selection_reason": selection_reason,
            "sparse_input_blocked_reason": row.get("promotion_blocked_reason"),
            "promotion_blocked_forecast_pct": row.get("promotion_blocked_forecast_pct"),
            "promotion_blocked_forecast_pct_source": row.get("promotion_blocked_forecast_pct_source"),
            "promotion_blocked_expected_return": row.get("promotion_blocked_expected_return"),
            "promotion_blocked_expected_return_source": row.get("promotion_blocked_expected_return_source"),
            "promotion_blocked_min_expected_return": row.get("promotion_blocked_min_expected_return"),
            "promotion_blocked_ml_edge": row.get("promotion_blocked_ml_edge"),
            "promotion_blocked_min_ml_edge": row.get("promotion_blocked_min_ml_edge"),
            "optimizer_objective": utility_diagnostics.get(
                "optimizer_objective",
                allocation_result.get("allocation_objective", allocation_objective),
            ),
            "alpha_utility": utility_diagnostics,
            "cluster_id": cluster_evidence.get("cluster_id"),
            "cluster_size": cluster_evidence.get("cluster_size"),
            "cluster_exposure": cluster_evidence.get("cluster_exposure"),
            "cluster_pairwise_corr_max": cluster_evidence.get("pairwise_corr_max"),
            "max_cluster_weight": max_cluster_weight,
            "pairwise_corr_max": similarity_evidence.get("pairwise_corr_max"),
            "covariance_method": similarity_evidence.get("covariance_method"),
            "covariance_shrinkage": similarity_evidence.get("covariance_shrinkage"),
            "cluster_penalty_applied": cluster_penalty_applied,
            "sparse_diagnostics": {
                **sparse_diagnostics_base,
                "allocation_weight": single_name_weight,
            },
        }

    for symbol, weight in weights.items():
        row = selected_by_symbol.get(symbol)
        if not row:
            continue
        _preserve_signal_raw(row)
        row["signal"] = "BUY"
        row["signal_source"] = "sparse_tangent_inverse_risk"
        row["has_buy_signal"] = 1
        row["confidence"] = max(float(row.get("confidence") or 0.0), confidence_floor)
        row["allocation_weight"] = round(float(weight), 8)
        row["ranking_promoted"] = False
        row["sparse_tangent_selected"] = True
        alpha_allocation = row.get("alpha_allocation") if isinstance(row.get("alpha_allocation"), dict) else {}
        row["alpha_allocation"] = {
            **alpha_allocation,
            **allocation_contract,
            "selected": True,
            "controller": controller,
            "allocation_weight": round(float(weight), 8),
            "return_history_coverage": history_coverage,
            "return_history_symbols": sorted(symbol for symbol in selected_symbols if risk_history.get(symbol)),
            **_sparse_allocation_evidence(row, selected=True, weight=float(weight)),
            "potential_buy": False,
            "opb_controller": {
                "enabled": opb_packet is not None,
                "stage": opb_packet.get("stage") if opb_packet else None,
                "allocation_role": opb_packet.get("allocation_role") if opb_packet else None,
                "selection_policy": opb_packet.get("selection_policy") if opb_packet else None,
                "selected_arm": opb_packet.get("selected_arm") if opb_packet else None,
            },
        }
        watch_points = row.get("watch_points")
        if not isinstance(watch_points, list):
            watch_points = []
        watch_points.append(f"allocation:sparse_tangent_inverse_risk:{round(float(weight), 6)}")
        row["watch_points"] = watch_points

    for row in scored:
        if row.get("symbol") in selected_symbols:
            continue
        alpha_allocation = row.get("alpha_allocation")
        if isinstance(alpha_allocation, dict) or id(row) in eligible_row_ids or row.get("promotion_blocked_reason"):
            symbol = str(row.get("symbol") or "").strip()
            allocation_evidence = _sparse_allocation_evidence(
                row,
                selected=False,
                weight=float(weights.get(symbol, 0.0) or 0.0),
            )
            is_potential_buy = _is_sparse_potential_buy_evidence(allocation_evidence)
            row["alpha_allocation"] = {
                **(alpha_allocation if isinstance(alpha_allocation, dict) else {}),
                **allocation_contract,
                "selected": False,
                "controller": controller,
                **allocation_evidence,
                "potential_buy": is_potential_buy,
            }
            if is_potential_buy:
                _preserve_signal_raw(row)
                row["signal"] = POTENTIAL_BUY_SIGNAL
                row["signal_source"] = "sparse_tangent_inverse_risk_potential_buy"
                row["has_buy_signal"] = 0
                row["ranking_promoted"] = False
                row["sparse_tangent_selected"] = False
                row["alpha_allocation"]["potential_buy_policy"] = POTENTIAL_BUY_POLICY
                row["alpha_allocation"]["potential_buy_reason"] = POTENTIAL_BUY_SELECTION_REASON
                row["alpha_allocation"]["potential_buy_min_expected_return"] = POTENTIAL_BUY_MIN_EXPECTED_RETURN
                watch_points = row.get("watch_points")
                if not isinstance(watch_points, list):
                    watch_points = []
                watch_points.append("allocation:potential_buy:positive_edge_zero_weight")
                row["watch_points"] = watch_points

    logger.info(
        "[Ranking] sparse_tangent_inverse_risk selected "
        f"{len(selected_symbols)}/{buy_signal_count} capacity BUY rows: {sorted(selected_symbols)}"
    )
    return scored


def apply_sparse_tangent_allocation(
    recommendations: list[dict],
    ranking_config: dict,
    ensemble_v2_cfg: dict | None = None,
    regime_label: str | None = None,
    regime_surface: dict | None = None,
    alpha_policy: dict | None = None,
    return_history: dict[str, list[float]] | None = None,
    opb_reward_ledger: list[dict[str, Any]] | None = None,
) -> list[dict]:
    """Run the production allocation owner after Score V2 + ML ranking.

    Legacy top-K promotion is retired. BUY rows are now owned by
    sparse_tangent_inverse_risk, optionally controlled by OnlinePortfolioBandit.
    """
    if not ranking_config or not ranking_config.get("enabled", True):
        return recommendations

    policy = normalize_alpha_policy(alpha_policy)
    promote_min_conf = ranking_config.get("promoteMinConf", 0.60)
    effective_boost = float(promote_min_conf)

    promotion_weights = ranking_config.get("scoreV2PromotionWeights") or {}
    score_v2_weight = float(promotion_weights.get("scoreV2", 0.80))
    ml_conf_weight = float(promotion_weights.get("mlConfidence", 0.15))
    signal_tier_weight = float(promotion_weights.get("signalTier", 0.05))
    weight_total = max(1e-9, score_v2_weight + ml_conf_weight + signal_tier_weight)

    # Compute combined_score for each.
    scored = []
    for r in recommendations:
        _require_canonical_score_v2_components(r)
        score_v2_norm = min(1.0, _score_v2_final_score_for_ranking(r) / 100.0)
        ml_conf = max(0.0, min(1.0, r.get("confidence") or 0))
        tier = _signal_tier(r.get("signal"))
        combined = (
            (score_v2_weight * score_v2_norm)
            + (ml_conf_weight * ml_conf)
            + (signal_tier_weight * tier)
        ) / weight_total
        r["_combined_score"] = combined
        r["_combined_score_source"] = "score_v2_final_score_plus_ml_tiebreak"
        scored.append(r)

    if _allocation_method(policy) != "sparse_tangent_inverse_risk":
        raise ValueError(
            "legacy_topk_allocation_retired: "
            "production recommendations require sparse_tangent_inverse_risk"
        )

    allocated = regime_aware_allocate(
        scored,
        regime_label,
        slate_size=max(int(policy["allocation"].get("buy_signal_count") or 3), policy["allocation"]["slate_size"]),
        policy=policy,
        regime_surface=regime_surface,
    )
    return _apply_sparse_tangent_buy_selection(
        allocated,
        ranking_config,
        policy,
        confidence_floor=effective_boost,
        return_history=return_history,
        opb_reward_ledger=opb_reward_ledger,
    )


# ?????????????????????????????????????????????????????????????????????????????
# D1 writers
# ?????????????????????????????????????????????????????????????????????????????

def write_predictions_to_d1(
    predictions: dict[str, dict],
    stock_id_map: dict[str, int],
    run_date: str | None = None,
) -> int:
    """
    Write predictions table.
    predictions: {symbol: ml_result}
    stock_id_map: {symbol: stock_id} from active stocks

    Returns count written.
    """
    statements: list[tuple[str, list[Any]]] = []
    inserted_rows = 0
    use_ev2 = _is_use_ensemble_v2()
    for symbol, data in predictions.items():
        if data.get("error"):
            continue
        stock_id = stock_id_map.get(symbol)
        if not stock_id:
            continue
        feature_version = _require_prediction_feature_version(str(symbol), data)
        sanitized_count = 0
        skipped_model_rows: list[str] = []
        # ML_POOL Plan A migration: ensemble_v2 (8-model w/ R1+R3) drives the
        # stored signal. Legacy 5-feature signal kept in forecast_data for audit.
        legacy_signal = data.get("signal") or "NO_SIGNAL"
        ev2 = data.get("ensemble_v2") or {}
        ev2_signal = ev2.get("signal")
        ev2_signal_source = ev2.get("signal_source") or "ensemble_v2"
        raw_signal = (ev2_signal if (use_ev2 and ev2_signal) else legacy_signal) or "NO_SIGNAL"
        if raw_signal == "NO_SIGNAL":
            trade_signal = None
        elif _is_formal_buy_signal(raw_signal):
            trade_signal = "buy"
        elif "SELL" in raw_signal:
            trade_signal = "sell"
        else:
            trade_signal = "hold"

        forecast_payload, replaced = _sanitize_non_finite({
            "signal": raw_signal,
            "legacy_signal": legacy_signal,                 # feature-model signal (audit trail)
            "ensemble_v2": data.get("ensemble_v2"),         # 8-model R1+R3 (audit trail)
            "signal_source": ev2_signal_source if (use_ev2 and ev2_signal) else "legacy",
            "alpha_context": data.get("alpha_context"),
            "alpha_allocation": data.get("alpha_allocation"),
            "l4_alpha_ev": data.get("l4_alpha_ev") or data.get("alpha_ev") or data.get("alpha_ev_prediction"),
            "s12_trade_ev": data.get("s12_trade_ev"),
            "core_ml_evidence": data.get("core_ml_evidence") or data.get("core_ml_gate"),
            "core_ml_gate": data.get("core_ml_gate") or data.get("core_ml_evidence"),
            "core_family_vote": data.get("core_family_vote"),
            "gnn": data.get("gnn"),
            "timesfm": data.get("timesfm"),
            "timesfm_sidecar": _timesfm_sidecar_payload(data),
            "state_space_overlays": _state_space_overlay_payload(data),
            "formal_layer3_blockers": data.get("formal_layer3_blockers"),
            "feature_schema": data.get("feature_schema"),
            "feature_count": data.get("feature_count"),
            "feature_version": data.get("feature_version"),
            "models": data.get("models"),
            "forecasts": data.get("forecasts"),
            "arf_features": data.get("arf_features"),
            "dispersion_diagnostics": data.get("dispersion_diagnostics"),
            "stock_meta": _enrich_stock_meta_with_segment_policy(data.get("stock_meta")),
        })
        sanitized_count += replaced
        forecast_data = json.dumps(forecast_payload, ensure_ascii=False)
        confidence, replaced = _sanitize_non_finite(data.get("confidence"))
        sanitized_count += replaced
        entry_price, replaced = _sanitize_non_finite(data.get("entry_price"))
        sanitized_count += replaced
        stop_loss, replaced = _sanitize_non_finite(data.get("stop_loss"))
        sanitized_count += replaced
        target1, replaced = _sanitize_non_finite(data.get("target1"))
        sanitized_count += replaced
        target2, replaced = _sanitize_non_finite(data.get("target2"))
        sanitized_count += replaced

        delete_date_sql, delete_date_params = _prediction_delete_date_expr(run_date)
        # H2: delete stale before insert
        statements.append((
            f"DELETE FROM predictions WHERE {COL_STOCK_ID}=? AND {COL_MODEL_NAME}='ensemble' "
            f"AND {delete_date_sql}",
            [stock_id, *delete_date_params],
        ))
        statements.append((
            f"DELETE FROM predictions WHERE {COL_STOCK_ID}=? AND {COL_MODEL_NAME}!='ensemble' "
            f"AND {delete_date_sql}",
            [stock_id, *delete_date_params],
        ))
        statements.append((
            INSERT_PREDICTIONS_SQL,
            [
                stock_id,
                run_date,
                14,
                confidence,
                forecast_data,
                entry_price,
                stop_loss,
                target1,
                target2,
                trade_signal,
                feature_version,
                raw_signal,
            ],
        ))
        inserted_rows += 1

        # 2026-04-19 ML_POOL Stage 2: per-model rows for weekly IC tracking.
        # 2026-06-27: active-8 challenger rows are non-voting live-gate evidence
        # for artifact registry candidates; TimesFM remains L2 sidecar only.
        per_model_scores = _extract_per_model_scores_for_d1(data)
        for model_name, model_score in per_model_scores.items():
            safe_model_score, replaced = _sanitize_non_finite(model_score)
            sanitized_count += replaced
            if safe_model_score is None:
                skipped_model_rows.append(model_name)
                continue
            signal_payload = _per_model_signal_payload(data, model_name)
            per_model_payload, replaced = _sanitize_non_finite(
                {
                    "signal": raw_signal,
                    "rank_score": safe_model_score,
                    "source": "model_pool_stage2_challenger" if model_name.endswith("::challenger") else "model_pool_stage2",
                    "forecast_pct": signal_payload.get("forecast_pct"),
                    "forecast_pct_source": (
                        f"{signal_payload.get('source_key')}.forecast_pct"
                        if signal_payload.get("forecast_pct") is not None
                        else None
                    ),
                    "model_signal": signal_payload or None,
                    "stock_meta": _enrich_stock_meta_with_segment_policy(data.get("stock_meta")),
                }
            )
            sanitized_count += replaced
            per_model_forecast = json.dumps(
                per_model_payload,
                ensure_ascii=False,
            )
            # Use INSERT with explicit model_name override (INSERT_PREDICTIONS_SQL
            # hardcodes 'ensemble'; build a parallel SQL for per-model name).
            statements.append((
                _build_per_model_insert_sql(),
                [
                    stock_id, model_name,
                    run_date,
                    14,                     # horizon
                    safe_model_score,       # direction_accuracy = rank_score
                    per_model_forecast,
                    entry_price,
                    stop_loss,
                    target1,
                    target2,
                    trade_signal,
                    feature_version,
                    raw_signal,
                ],
            ))
            inserted_rows += 1
        if sanitized_count or skipped_model_rows:
            logger.warning(
                "[recommendation_service] Sanitized %s non-finite values before D1 write for %s; skipped_model_rows=%s",
                sanitized_count,
                symbol,
                skipped_model_rows or "none",
            )

    if not statements:
        return 0
    d1_client.batch_execute(statements)
    # Count inserted rows explicitly because cleanup adds delete-only statements.
    logger.info(f"[recommendation_service] Wrote {inserted_rows} prediction rows to D1 (incl. per-model)")
    return inserted_rows


def write_layer2_timesfm_enrichment_audit(
    *,
    predictions: dict[str, dict],
    screener_recs: list[dict],
    run_date: str | None,
    screener_run_id: str | None,
    l2_summary: dict[str, Any] | None = None,
) -> int:
    """Persist L2 TimesFM sidecar enrichment evidence into screener_funnel_items."""
    if not run_date or not screener_run_id:
        return 0
    statements: list[tuple[str, list[Any]]] = [
        (
            "DELETE FROM screener_funnel_items WHERE run_id=? AND date=? AND stage='layer2_timesfm_enrichment'",
            [screener_run_id, run_date],
        )
    ]
    prediction_by_symbol = predictions if isinstance(predictions, dict) else {}
    for idx, source_row in enumerate(screener_recs or [], start=1):
        symbol = str(source_row.get("symbol") or "").strip()
        if not symbol:
            continue
        pred = prediction_by_symbol.get(symbol) if isinstance(prediction_by_symbol.get(symbol), dict) else {}
        sidecar = _l2_timesfm_sidecar_from_prediction(pred)
        evidence = _l2_timesfm_evidence_from_sidecar(sidecar)
        if evidence:
            if evidence.get("l2_feature_input_active"):
                reason_code = "timesfm_l2_feature_input_active"
            elif evidence.get("l2_feature_input_blocked_reason"):
                reason_code = str(evidence.get("l2_feature_input_blocked_reason"))
            else:
                reason_code = "timesfm_l2_sidecar_observe"
        else:
            evidence = _l2_timesfm_missing_evidence(l2_summary)
            reason_code = f"timesfm_l2_sidecar_missing:{evidence.get('l2_gate_reason') or 'unknown'}"

        try:
            score_before = float(source_row.get("score")) if source_row.get("score") is not None else None
        except (TypeError, ValueError):
            score_before = None

        statements.append((
            """
            INSERT INTO screener_funnel_items
              (run_id, date, symbol, name, stage, decision, reason_code,
               score_before, score_after, rank, evidence)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """.strip(),
            [
                screener_run_id,
                run_date,
                symbol,
                source_row.get("name"),
                "layer2_timesfm_enrichment",
                "observe",
                reason_code,
                score_before,
                None,
                idx,
                json.dumps(evidence, ensure_ascii=False),
            ],
        ))

    d1_client.batch_execute(statements)
    inserted = len(statements) - 1
    logger.info(
        "[recommendation_service] Wrote %s L2 TimesFM enrichment audit rows run_id=%s date=%s",
        inserted,
        screener_run_id,
        run_date,
    )
    return inserted


def write_layer3_formal_gate_audit(
    *,
    predictions: dict[str, dict],
    recommendations: list[dict],
    layer2_symbols: list[str],
    run_date: str,
    screener_run_id: str | None,
    target_size: int | None = None,
) -> int:
    """Persist formal L3 pass/drop evidence into screener_funnel_items."""
    run_id = str(screener_run_id or "").strip()
    if not run_id:
        logger.warning("[recommendation_service] L3 audit skipped: screener_run_id missing")
        return 0

    symbols = _dedupe_preserve_order([str(symbol or "").strip() for symbol in layer2_symbols])
    symbols = [symbol for symbol in symbols if symbol]
    if not symbols:
        logger.info("[recommendation_service] L3 audit skipped: no layer2 symbols")
        return 0

    final_by_symbol = {
        str(row.get("symbol") or ""): row
        for row in recommendations
        if row.get("symbol")
    }
    statements: list[tuple[str, list[Any]]] = [
        (
            "DELETE FROM screener_funnel_items WHERE run_id = ? AND date = ? AND stage = ?",
            [run_id, run_date, "layer3_formal_ml_gate"],
        )
    ]

    for idx, symbol in enumerate(symbols, start=1):
        pred = predictions.get(symbol) if isinstance(predictions, dict) else None
        final_row = final_by_symbol.get(symbol)
        vote = {}
        ev2 = {}
        if isinstance(pred, dict):
            vote = pred.get("core_family_evidence") if isinstance(pred.get("core_family_evidence"), dict) else {}
            if not vote:
                vote = pred.get("core_family_vote") if isinstance(pred.get("core_family_vote"), dict) else {}
            ev2 = pred.get("ensemble_v2") if isinstance(pred.get("ensemble_v2"), dict) else {}
        active_family_count = int((vote or {}).get("active_family_count") or 0)
        if not isinstance(pred, dict):
            decision = "drop"
            reason_code = "formal_family_prediction_missing"
        elif not ev2:
            decision = "drop"
            reason_code = "formal_family_ensemble_v2_missing"
        elif active_family_count < 2:
            decision = "drop"
            reason_code = "formal_family_insufficient_active_families"
        else:
            decision = "pass"
            reason_code = "formal_family_evidence_pass"

        evidence = {
            "schema_version": "layer3_formal_ml_gate_audit_v1",
            "source": "daily_pipeline_v2.apply_core_family_evidence",
            "target_size": target_size,
            "selection_role": "evidence_only_not_capacity_gate",
            "layer2_count": len(symbols),
            "active_family_count": active_family_count,
            "active_families": (vote or {}).get("active_families") or [],
            "inactive_formal_models": (vote or {}).get("inactive_formal_models") or [],
            "inactive_lifecycle_models": (vote or {}).get("inactive_lifecycle_models") or [],
            "lifecycle_weight_source": (vote or {}).get("lifecycle_weight_source"),
            "contributing_models": ev2.get("contributing_models") if isinstance(ev2, dict) else [],
            "weights": ev2.get("weights") if isinstance(ev2, dict) else {},
        }
        try:
            score_after = float((vote or {}).get("family_score"))
        except (TypeError, ValueError):
            score_after = None
        source_row = final_row or {"symbol": symbol}
        try:
            score_before = float(source_row.get("score")) if source_row.get("score") is not None else None
        except (TypeError, ValueError):
            score_before = None

        statements.append((
            """
            INSERT INTO screener_funnel_items
              (run_id, date, symbol, name, stage, decision, reason_code,
               score_before, score_after, rank, evidence)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """.strip(),
            [
                run_id,
                run_date,
                symbol,
                source_row.get("name"),
                "layer3_formal_ml_gate",
                decision,
                reason_code,
                score_before,
                score_after,
                int(final_row.get("rank") or idx) if final_row else idx,
                json.dumps(evidence, ensure_ascii=False),
            ],
        ))

    d1_client.batch_execute(statements)
    inserted = len(statements) - 1
    logger.info(
        "[recommendation_service] Wrote %s L3 formal gate audit rows run_id=%s date=%s",
        inserted,
        run_id,
        run_date,
    )
    return inserted


# ?????????????????????????????????????????????????????????????????????????????
# 2026-04-19 ML_POOL Stage 2 helpers (per-model row writers)
# ?????????????????????????????????????????????????????????????????????????????

# Models whose rank scores we want stored for alpha IC tracking.
# State-space overlays explain regime/risk context rather than vote as alpha.
_PER_MODEL_TRACKED = (
    "XGBoost", "ExtraTrees", "LightGBM",
    "TabM", "GNN",
    "DLinear", "PatchTST", "iTransformer",
)

_PER_MODEL_TRACKED_SET = set(_PER_MODEL_TRACKED)


def _extract_per_model_scores_for_d1(pred: dict) -> dict[str, float]:
    """Pull out per-model rank scores from one stock's prediction dict.

    For 5 feature models: read pred["rank_scores"][model_name] (raw 0~1
      from predict_stock_v2).
    For 3 time-series alpha predictors: sigmoid-map .forecast_pct ??0~1
      (mirror of pipeline_v2._ts_to_rank with scale=12).

    Returns formal active/family slots that have a usable score in the dict.
    """
    import math
    out: dict[str, float] = {}
    rank_scores = pred.get("rank_scores") or {}
    for name in ("XGBoost", "ExtraTrees", "LightGBM", "TabM", "GNN"):
        v = rank_scores.get(name)
        if v is not None:
            try:
                out[name] = float(v)
            except (TypeError, ValueError):
                pass
    challenger_rank_scores = pred.get("challenger_rank_scores") or {}
    if isinstance(challenger_rank_scores, dict):
        for name, value in challenger_rank_scores.items():
            base_name = str(name).replace("::challenger", "")
            if base_name not in _PER_MODEL_TRACKED_SET:
                continue
            try:
                out[f"{base_name}::challenger"] = float(value)
            except (TypeError, ValueError):
                pass
    # Time-series alpha predictors: forecast_pct ??sigmoid rank.
    if "GNN" not in out:
        gnn_payload = pred.get("gnn") if isinstance(pred.get("gnn"), dict) else {}
        v = gnn_payload.get("rank_score")
        if v is not None:
            try:
                out["GNN"] = float(v)
            except (TypeError, ValueError):
                pass
    _SRC_KEY_MODEL = (
        ("dlinear",          "DLinear"),
        ("patchtst",         "PatchTST"),
        ("itransformer",     "iTransformer"),
    )
    for src_key, model_name in _SRC_KEY_MODEL:
        sig = pred.get(src_key) or {}
        fp = sig.get("forecast_pct")
        if fp is None:
            continue
        try:
            out[model_name] = 1.0 / (1.0 + math.exp(-float(fp) * 12.0))
        except (TypeError, ValueError, OverflowError):
            pass
    return out


def _per_model_signal_payload(pred: dict, model_name: str) -> dict[str, Any]:
    source_key = {
        "DLinear": "dlinear",
        "PatchTST": "patchtst",
        "iTransformer": "itransformer",
    }.get(model_name)
    if not source_key:
        return {}
    signal = pred.get(source_key)
    if not isinstance(signal, dict):
        return {}
    payload: dict[str, Any] = {}
    for key in (
        "forecast_pct",
        "forecast_price",
        "direction",
        "confidence",
        "n_used",
        "model_version",
        "model_id",
        "context_len",
        "seq_len",
        "artifact_path",
    ):
        if signal.get(key) is not None:
            payload[key] = signal.get(key)
    if payload:
        payload["source_key"] = source_key
    return payload


def _build_per_model_insert_sql() -> str:
    """Same contract as INSERT_PREDICTIONS_SQL but accepts model_name as parameter."""
    return f"""
INSERT INTO predictions (
    {COL_STOCK_ID}, {COL_MODEL_NAME}, {COL_GENERATED_AT}, {COL_PREDICTION_DATE}, {COL_HORIZON}, {COL_DIRECTION_ACCURACY},
    {COL_FORECAST_DATA}, {COL_ENTRY_PRICE}, {COL_STOP_LOSS}, {COL_TARGET1}, {COL_TARGET2},
    {COL_TRADE_SIGNAL}, {COL_FEATURE_VERSION}, {COL_SIGNAL_RAW}
) VALUES (?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
""".strip()


def _existing_recommendation_seed_stock_ids(recommendations: list[dict], run_date: str) -> set[int]:
    stock_ids = sorted({int(r["stock_id"]) for r in recommendations if r.get("stock_id")})
    if not stock_ids:
        return set()
    existing: set[int] = set()
    chunk_size = 80
    for i in range(0, len(stock_ids), chunk_size):
        chunk = stock_ids[i:i + chunk_size]
        placeholders = ",".join("?" for _ in chunk)
        rows = d1_client.query(
            f"""
            WITH latest_screener_run AS (
                SELECT run_id
                  FROM screener_funnel_runs
                 WHERE date = ?
                   AND status = 'success'
                 ORDER BY created_at DESC
                 LIMIT 1
            )
            SELECT dr.stock_id
              FROM daily_recommendations dr
              JOIN screener_funnel_items sfi
                ON sfi.run_id = (SELECT run_id FROM latest_screener_run)
               AND sfi.symbol = dr.symbol
               AND (
                    (sfi.stage = 'l1_candidate_seed_after_overlay' AND sfi.decision = 'selected')
                 OR (sfi.stage = 'final_selection' AND sfi.decision = 'selected')
               )
             WHERE dr.date = ?
               AND dr.stock_id IN ({placeholders})
            """,
            [run_date, run_date, *chunk],
        )
        existing.update(int(row["stock_id"]) for row in rows if row.get("stock_id") is not None)
    return existing


def _assert_recommendation_seed_rows_exist(recommendations: list[dict], run_date: str) -> set[int]:
    stock_ids = sorted({int(r["stock_id"]) for r in recommendations if r.get("stock_id")})
    if not stock_ids:
        return set()
    existing = _existing_recommendation_seed_stock_ids(recommendations, run_date)
    if not existing:
        raise RuntimeError(
            "Missing screener-owned daily_recommendations seed rows for "
            f"run_date={run_date}: {stock_ids[:10]} (missing={len(stock_ids)}/{len(stock_ids)})"
        )
    return existing


def _filter_to_existing_recommendation_seed_rows(recommendations: list[dict], run_date: str) -> list[dict]:
    """Return rows that are still owned by the screener seed table.

    The pipeline may produce ML-only promotion rows that were not in the
    screener-owned daily_recommendations seed set. Those rows should remain in
    prediction/model evidence, but must not abort the post-market chain or
    create controller-owned daily_recommendations rows.
    """
    stock_ids = sorted({int(r["stock_id"]) for r in recommendations if r.get("stock_id")})
    if not stock_ids:
        return recommendations
    existing = _assert_recommendation_seed_rows_exist(recommendations, run_date)
    missing = [sid for sid in stock_ids if sid not in existing]
    if missing:
        logger.warning(
            "[recommendation_service] Skipping %s ML-only recommendation rows without screener seed for run_date=%s: %s",
            len(missing),
            run_date,
            missing[:10],
        )
    return [r for r in recommendations if r.get("stock_id") and int(r["stock_id"]) in existing]


def _delete_stale_recommendation_rows(recommendations: list[dict], run_date: str) -> int:
    """Keep only rows owned by the latest screener candidate seed for run_date."""
    if not recommendations:
        return 0
    rows = d1_client.query(
        """
        WITH latest_screener_run AS (
            SELECT run_id
              FROM screener_funnel_runs
             WHERE date = ?
               AND status = 'success'
             ORDER BY created_at DESC
             LIMIT 1
        )
        SELECT dr.stock_id
          FROM daily_recommendations dr
         WHERE dr.date = ?
           AND COALESCE(dr.recommendation_lane, 'tradable') = 'tradable'
           AND COALESCE(dr.eligible_for_ml, 1) = 1
           AND NOT EXISTS (
             SELECT 1
               FROM screener_funnel_items sfi
             WHERE sfi.run_id = (SELECT run_id FROM latest_screener_run)
                AND sfi.symbol = dr.symbol
                AND (
                     (sfi.stage = 'l1_candidate_seed_after_overlay' AND sfi.decision = 'selected')
                  OR (sfi.stage = 'final_selection' AND sfi.decision = 'selected')
                )
           )
        """,
        [run_date, run_date],
        timeout=60,
    )
    if not rows:
        run = d1_client.query(
            """
            SELECT run_id
              FROM screener_funnel_runs
             WHERE date = ?
               AND status = 'success'
             ORDER BY created_at DESC
             LIMIT 1
            """,
            [run_date],
            timeout=60,
        )
        if not run:
            logger.warning(
                "[recommendation_service] No latest screener candidate-seed run for run_date=%s; skip stale cleanup",
                run_date,
            )
        return 0
    stale_ids = sorted({
        int(row["stock_id"])
        for row in rows or []
        if row.get("stock_id") is not None
    })
    changes = 0
    for chunk in _chunked(stale_ids):
        placeholders = ",".join("?" for _ in chunk)
        result = d1_client.execute(
            f"DELETE FROM daily_recommendations WHERE date = ? AND stock_id IN ({placeholders})",
            [run_date, *chunk],
            timeout=60,
        )
        changes += int(((result or {}).get("meta") or {}).get("changes") or 0)
    if changes:
        logger.warning(
            "[recommendation_service] Deleted %s daily_recommendations rows outside latest screener candidate seed for run_date=%s",
            changes,
            run_date,
        )
    return changes


def update_recommendations_in_d1(
    recommendations: list[dict],
    run_date: str,
) -> int:
    """
    Update screener-owned daily_recommendations rows with ML fields.

    Screener is the only owner allowed to create seed rows. The pipeline must
    fail fast when the source-of-truth seed is missing instead of silently
    creating controller-owned fallback rows.
    """
    if not recommendations:
        return 0

    recommendations = _filter_to_existing_recommendation_seed_rows(recommendations, run_date)
    if not recommendations:
        return 0
    _delete_stale_recommendation_rows(recommendations, run_date)

    statements: list[tuple[str, list[Any]]] = []
    for idx, r in enumerate(recommendations, start=1):
        is_buy_signal = (
            str(r.get("signal") or "").upper() == "BUY"
            and int(r.get("has_buy_signal") or 0) == 1
        )
        score_seed_inputs = _score_v2_seed_inputs(r)
        chip_flow_seed, replaced_chip_seed = _sanitize_non_finite(score_seed_inputs["chipFlowSeed40"])
        technical_seed, replaced_technical_seed = _sanitize_non_finite(score_seed_inputs["technicalSeed30"])
        screener_momentum_seed, replaced_momentum_seed = _sanitize_non_finite(score_seed_inputs["screenerMomentumSeed20"])
        ml_score, replaced_ml = _sanitize_non_finite(score_seed_inputs["mlEdgeSeed30"])
        score, replaced_score = _sanitize_non_finite(r.get("score") or 0)
        confidence, replaced_conf = _sanitize_non_finite(r.get("confidence"))
        current_price, replaced_price = _sanitize_non_finite(r.get("current_price"))
        foreign_net_5d, replaced_foreign = _sanitize_non_finite(r.get("foreign_net_5d") or 0)
        trust_net_5d, replaced_trust = _sanitize_non_finite(r.get("trust_net_5d") or 0)
        rsi14, replaced_rsi = _sanitize_non_finite(r.get("rsi14"))
        macd_hist, replaced_macd = _sanitize_non_finite(r.get("macd_hist"))
        watch_points, replaced_watch = _sanitize_non_finite(r.get("watch_points") or [])
        alpha_context, replaced_alpha_context = _sanitize_non_finite(r.get("alpha_context"))
        alpha_allocation, replaced_alpha_allocation = _sanitize_non_finite(r.get("alpha_allocation"))
        if not is_buy_signal and isinstance(alpha_allocation, dict) and alpha_allocation.get("selected"):
            alpha_allocation = {
                **alpha_allocation,
                "selected": False,
                "stale_selection_cleared_reason": "final_signal_not_buy",
            }
        ml_vote_summary, replaced_ml_vote_summary = _sanitize_non_finite(r.get("ml_vote_summary"))
        score_components, replaced_score_components = _sanitize_non_finite(r.get("score_components"))
        if isinstance(score_components, dict) and score_components.get("version") == SCORE_V2_VERSION:
            score = _score_number(
                score_components.get("finalScore", score_components.get("total")),
                score,
            )
        sanitized_count = (
            replaced_chip_seed
            + replaced_technical_seed
            + replaced_momentum_seed
            + replaced_ml
            + replaced_score
            + replaced_conf
            + replaced_price
            + replaced_foreign
            + replaced_trust
            + replaced_rsi
            + replaced_macd
            + replaced_watch
            + replaced_alpha_context
            + replaced_alpha_allocation
            + replaced_ml_vote_summary
            + replaced_score_components
        )
        if sanitized_count:
            logger.warning(
                "[recommendation_service] Sanitized %s non-finite recommendation values before D1 update for %s",
                sanitized_count,
                r["symbol"],
            )
        stock_id = r.get("stock_id")
        if not stock_id:
            logger.warning("[recommendation_service] Skip recommendation without stock_id: %s", r.get("symbol"))
            continue
        statements.append((
            """
            UPDATE daily_recommendations SET
                symbol=?,
                name=?,
                sector=?,
                rank=?,
                score=?,
                signal=?,
                confidence=?,
                reason=?,
                watch_points=?,
                has_buy_signal=?,
                current_price=?,
                foreign_net_5d=?,
                trust_net_5d=?,
                rsi14=?,
                macd_hist=?,
                chip_score=?,
                tech_score=?,
                momentum_score=?,
                ml_score=?,
                industry=?,
                market_segment=?,
                recommendation_lane=?,
                eligible_for_ml=?,
                eligible_for_pending_buy=?,
                alpha_context=?,
                alpha_allocation=?,
                ml_vote_summary=?,
                score_components=?
            WHERE date=? AND stock_id=?
            """.strip(),
            [
                r["symbol"],
                r.get("name") or r["symbol"],
                r.get("sector"),
                r.get("rank") or idx,
                score,
                r.get("signal"),
                confidence,
                r.get("reason") or "pipeline_reason_unavailable",
                json.dumps(watch_points, ensure_ascii=False),
                r.get("has_buy_signal") or 0,
                current_price,
                foreign_net_5d,
                trust_net_5d,
                rsi14,
                macd_hist,
                chip_flow_seed,
                technical_seed,
                screener_momentum_seed,
                ml_score,
                r.get("industry"),
                r.get("market_segment") or "UNKNOWN",
                r.get("recommendation_lane") or "tradable",
                1 if r.get("eligible_for_ml", True) else 0,
                1 if r.get("eligible_for_pending_buy", True) else 0,
                json.dumps(alpha_context, ensure_ascii=False) if alpha_context is not None else None,
                json.dumps(alpha_allocation, ensure_ascii=False) if alpha_allocation is not None else None,
                json.dumps(ml_vote_summary, ensure_ascii=False) if ml_vote_summary is not None else None,
                json.dumps(score_components, ensure_ascii=False) if score_components is not None else None,
                run_date,
                stock_id,
            ],
        ))

    if not statements:
        return 0
    result = d1_client.batch_execute(statements)
    changes = int(result if isinstance(result, int) else (result or {}).get("changes_total") or 0)
    if changes < len(statements):
        raise RuntimeError(
            f"Recommendation update touched {changes}/{len(statements)} rows; "
            "screener seed ownership may be broken"
        )
    logger.info(f"[recommendation_service] Updated {len(statements)} daily_recommendations rows")
    return len(statements)


def delete_filtered_recommendations(
    filtered_symbols: list[str],
    run_date: str,
    *,
    filtered_diagnostics: dict[str, dict[str, Any]] | None = None,
) -> int:
    """Preserve screener-owned rows and mark ML-filtered symbols as non-buy."""
    if not filtered_symbols:
        return 0
    statements = [
        (
            """
            UPDATE daily_recommendations
               SET signal = 'HOLD',
                   has_buy_signal = 0,
                   watch_points = CASE
                     WHEN json_valid(watch_points) THEN json_insert(
                       watch_points,
                       '$[#]',
                       'ml_filter:preserved_screener_seed_not_buy'
                     )
                     ELSE json_array('ml_filter:preserved_screener_seed_not_buy')
                   END,
                   alpha_allocation = json_object(
                     'engine',
                     'sparse_tangent_inverse_risk',
                     'allocation_method',
                     'sparse_tangent_inverse_risk_final_allocation',
                     'input_scope',
                     'post_l3_5_evidence_fusion_candidates',
                     'selection_policy',
                     'positive_expected_edge_sparse_weights_no_forced_fill',
                     'selected',
                     0,
                     'eligible_for_sparse',
                     0,
                     'expected_return',
                     0,
                     'expected_return_source',
                     'ml_filtered_sell_or_no_signal_preserved_seed',
                     'selection_reason',
                     'preserved_screener_seed_non_buy',
                     'stale_selection_cleared_reason',
                     'ml_filter_preserved_non_buy',
                     'sparse_input_blocked_reason',
                     'ml_filter_preserved_non_buy',
                     'no_l3_allocation_reason',
                     'ml_filtered_sell_or_no_signal_preserved_seed',
                     'allocator_ev_fusion_diagnostic',
                     json(?)
                   )
             WHERE date = ? AND symbol = ?
            """.strip(),
            [
                json.dumps(
                    {
                        "status": "not_evaluated",
                        "reason": "ml_filter_preserved_non_buy",
                        "diagnostic_role": "coverage_marker_not_expected_return_owner",
                        **((filtered_diagnostics or {}).get(sym) or {}),
                    },
                    ensure_ascii=False,
                ),
                run_date,
                sym,
            ],
        )
        for sym in filtered_symbols
    ]
    d1_client.batch_execute(statements)
    logger.info(f"[recommendation_service] Preserved {len(filtered_symbols)} ML-filtered screener seed rows")
    return len(filtered_symbols)


def re_rank_recommendations(run_date: str) -> None:
    """Re-rank daily_recommendations after filter+promotion.

    The pipeline writes rows in allocation order. Keep that rank as the primary
    ordering so slate diversification does not need to inflate predictive score.
    """
    rows = d1_client.query(
        "SELECT symbol FROM daily_recommendations WHERE date = ? "
        "ORDER BY rank ASC, CASE WHEN json_valid(score_components) THEN "
        "COALESCE(CAST(json_extract(score_components, '$.finalScore') AS REAL), "
        "CAST(json_extract(score_components, '$.total') AS REAL), 0) ELSE 0 END DESC",
        [run_date],
    )
    statements = [
        ("UPDATE daily_recommendations SET rank = ? WHERE date = ? AND symbol = ?",
         [i + 1, run_date, r["symbol"]])
        for i, r in enumerate(rows)
    ]
    if statements:
        d1_client.batch_execute(statements)
    logger.info(f"[recommendation_service] Re-ranked {len(statements)} rows")


def _clean_reason_variant_trade_plan(entry: dict[str, Any]) -> dict[str, str]:
    raw = entry.get("tradePlan") or entry.get("trade_plan") or {}
    if not isinstance(raw, dict):
        return {}
    out: dict[str, str] = {}
    for key, value in raw.items():
        clean_key = str(key or "").strip()
        clean_value = str(value or "").strip()
        if clean_key and clean_value:
            out[clean_key] = clean_value[:260]
    return out


def merge_llm_reasons_into_recommendations(
    recommendations: list[dict],
    llm_reasons: dict[str, dict],
) -> None:
    """Apply LLM-generated reasons in-place. Falls back to template if LLM missing."""
    if not llm_reasons:
        return
    for r in recommendations:
        sym = r["symbol"]
        if sym in llm_reasons:
            entry = llm_reasons[sym]
            reason = str(entry.get("reason") or "").strip()
            llm_points = [
                str(p).strip()
                for p in (entry.get("watchPoints") or [])
                if isinstance(p, str) and p.strip()
            ]
            if reason:
                r["reason"] = reason
            if entry.get("watchPoints"):
                domain_points = [
                    p for p in (r.get("watch_points") or [])
                    if isinstance(p, str)
                    and (
                        p.startswith("Alpha bucket:")
                        or p.startswith("Alpha overlay:")
                        or p.startswith("Market structure:")
                        or p.startswith("Market structure unavailable:")
                        or p.startswith("ML ensemble:")
                    )
                ]
                r["watch_points"] = llm_points + domain_points
            if reason:
                payload = _parse_score_components_payload(r.get("score_components"))
                if payload:
                    variants = payload.get("reasonVariants")
                    if not isinstance(variants, dict):
                        variants = {}
                    variants["gemini"] = {
                        "source": str(entry.get("source") or "gemini_3_5_flash"),
                        "provider": "gemini",
                        "model": str(entry.get("model") or "gemini-3.5-flash"),
                        "decision_effect": "advisory_only",
                        "reason": reason[:700],
                        "tradePlan": _clean_reason_variant_trade_plan(entry),
                        "watchPoints": llm_points[:5],
                    }
                    payload["reasonVariants"] = variants
                    r["score_components"] = payload


def merge_breeze2_reason_shadow_into_score_components(
    recommendations: list[dict],
    breeze2_shadow: dict[str, dict],
) -> None:
    """Persist Breeze2 as a side-by-side Score V2 reason variant.

    This keeps Gemini/primary reasons authoritative for the card headline while
    exposing Breeze2's advisory-only text for UI comparison.
    """
    if not breeze2_shadow:
        return
    for row in recommendations:
        symbol = str(row.get("symbol") or "").strip()
        entry = breeze2_shadow.get(symbol)
        if not isinstance(entry, dict):
            continue
        reason = str(entry.get("reason") or "").strip()
        if not reason:
            continue
        payload = _parse_score_components_payload(row.get("score_components"))
        if not payload:
            continue
        variants = payload.get("reasonVariants")
        if not isinstance(variants, dict):
            variants = {}
        watch_points = [
            str(point).strip()
            for point in (entry.get("watchPoints") or [])
            if isinstance(point, str) and point.strip()
        ][:5]
        variants["breeze2"] = {
            "source": str(entry.get("source") or "breeze2_shadow"),
            "decision_effect": "advisory_only",
            "reason": reason[:700],
            "tradePlan": _clean_reason_variant_trade_plan(entry),
            "watchPoints": watch_points,
            "breeze2_context": str(entry.get("breeze2_context") or "unknown"),
            "riskFlags": [str(flag) for flag in (entry.get("riskFlags") or []) if flag][:8],
        }
        payload["reasonVariants"] = variants
        row["score_components"] = payload
