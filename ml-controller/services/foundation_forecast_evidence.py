"""Build foundation time-series validation evidence from verified predictions."""

from __future__ import annotations

import json
import math
from typing import Any

from services import d1_client
from services.model_cpcv_evidence import build_foundation_forecast_validation_evidence


DEFAULT_LOOKBACK_DAYS = 30
DEFAULT_LIMIT = 2000


def _as_float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _safe_json(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if raw is None or raw == "":
        return {}
    try:
        parsed = json.loads(str(raw))
    except (TypeError, ValueError, json.JSONDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _first_float(*values: Any) -> tuple[float | None, str | None]:
    for source, value in values:
        parsed = _as_float(value)
        if parsed is not None:
            return parsed, str(source)
    return None, None


def _forecast_from_payload(payload: dict[str, Any]) -> tuple[float | None, str | None]:
    signal = payload.get("model_signal") if isinstance(payload.get("model_signal"), dict) else {}
    nested_timesfm = payload.get("timesfm") if isinstance(payload.get("timesfm"), dict) else {}
    forecast_pct, source = _first_float(
        ("forecast_data.forecast_pct", payload.get("forecast_pct")),
        ("forecast_data.model_signal.forecast_pct", signal.get("forecast_pct")),
        ("forecast_data.timesfm.forecast_pct", nested_timesfm.get("forecast_pct")),
    )
    if forecast_pct is not None:
        return forecast_pct, source

    rank_score = _as_float(payload.get("rank_score"))
    if rank_score is None:
        return None, None
    return rank_score - 0.5, "forecast_data.rank_score_centered"


def _prediction_from_d1_row(row: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]] | None:
    payload = _safe_json(row.get("forecast_data"))
    forecast_pct, source = _forecast_from_payload(payload)
    realized = _as_float(row.get("actual_return_pct"))
    symbol = str(row.get("symbol") or row.get("stock_id") or "").strip()
    prediction_date = str(row.get("prediction_date") or "").strip()
    if not symbol or forecast_pct is None or realized is None:
        return None

    signal = payload.get("model_signal") if isinstance(payload.get("model_signal"), dict) else {}
    rank_score = _as_float(payload.get("rank_score"))
    confidence, _ = _first_float(
        ("forecast_data.confidence", payload.get("confidence")),
        ("forecast_data.model_signal.confidence", signal.get("confidence")),
        ("forecast_data.rank_score_confidence", None if rank_score is None else abs(rank_score - 0.5) * 2.0),
    )
    prediction_key = f"{symbol}|{prediction_date}" if prediction_date else symbol
    prediction = {
        "prediction_key": prediction_key,
        "prediction_id": row.get("id"),
        "symbol": symbol,
        "prediction_date": prediction_date or None,
        "forecast_pct": forecast_pct,
        "forecast_pct_source": source,
        "rank_score": rank_score,
        "confidence": confidence,
    }
    realized_row = {
        "prediction_key": prediction_key,
        "prediction_id": row.get("id"),
        "symbol": symbol,
        "prediction_date": prediction_date or None,
        "realized_return": realized,
    }
    return prediction, realized_row


def fetch_verified_foundation_prediction_rows(
    *,
    model_name: str = "TimesFM",
    run_date: str | None,
    lookback_days: int = DEFAULT_LOOKBACK_DAYS,
    limit: int = DEFAULT_LIMIT,
) -> list[dict[str, Any]]:
    params: list[Any] = [model_name]
    date_clause = ""
    if run_date:
        date_clause = """
          AND date(p.prediction_date) <= date(?)
          AND date(p.prediction_date) >= date(?, ?)
        """
        params.extend([run_date, run_date, f"-{int(lookback_days)} days"])
    else:
        date_clause = "AND date(p.prediction_date) >= date('now', ?)"
        params.append(f"-{int(lookback_days)} days")
    params.append(int(limit))

    return d1_client.query(
        f"""
        SELECT
          p.id,
          p.stock_id,
          s.symbol,
          p.prediction_date,
          p.generated_at,
          p.verified_at,
          p.actual_return_pct,
          p.forecast_data
        FROM predictions p
        JOIN stocks s ON p.stock_id = s.id
        WHERE p.model_name = ?
          AND p.verified_at IS NOT NULL
          AND p.actual_return_pct IS NOT NULL
          {date_clause}
        ORDER BY date(p.prediction_date) DESC, p.generated_at DESC, p.id DESC
        LIMIT ?
        """,
        params,
        timeout=60.0,
    )


def build_foundation_evidence_from_d1(
    *,
    model_name: str = "TimesFM",
    run_date: str | None,
    lookback_days: int = DEFAULT_LOOKBACK_DAYS,
    policy: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    rows = fetch_verified_foundation_prediction_rows(
        model_name=model_name,
        run_date=run_date,
        lookback_days=lookback_days,
    )
    predictions: list[dict[str, Any]] = []
    realized: list[dict[str, Any]] = []
    source_counts: dict[str, int] = {}
    skipped = 0
    for row in rows:
        parsed = _prediction_from_d1_row(row)
        if parsed is None:
            skipped += 1
            continue
        prediction, realized_row = parsed
        predictions.append(prediction)
        realized.append(realized_row)
        source = str(prediction.get("forecast_pct_source") or "unknown")
        source_counts[source] = source_counts.get(source, 0) + 1

    if not predictions:
        return None

    evidence = build_foundation_forecast_validation_evidence(
        model=model_name,
        predictions=predictions,
        realized_returns=realized,
        policy=policy,
    )
    evidence["source"] = "predictions_verified_outcomes"
    evidence["run_date"] = run_date
    evidence["lookback_days"] = int(lookback_days)
    evidence["queried_rows"] = len(rows)
    evidence["skipped_rows"] = skipped
    evidence["forecast_pct_sources"] = source_counts
    return evidence


def attach_timesfm_foundation_evidence_to_followup_payload(
    payload_dict: dict[str, Any],
    *,
    lookback_days: int = DEFAULT_LOOKBACK_DAYS,
) -> dict[str, Any]:
    stages = payload_dict.get("stages") if isinstance(payload_dict.get("stages"), dict) else {}
    lifecycle = stages.get("artifact_lifecycle") if isinstance(stages.get("artifact_lifecycle"), dict) else {}
    results = lifecycle.get("results") if isinstance(lifecycle.get("results"), dict) else {}
    timesfm = results.get("TimesFM") if isinstance(results.get("TimesFM"), dict) else None
    if not isinstance(timesfm, dict):
        return {"attempted": False, "updated": False, "reason": "timesfm_lifecycle_result_missing"}

    metrics = timesfm.get("metrics") if isinstance(timesfm.get("metrics"), dict) else {}
    has_oos = timesfm.get("oos_ic") is not None or metrics.get("oos_ic") is not None
    has_validation = (
        isinstance(timesfm.get("foundation_forecast_validation"), dict)
        or isinstance(timesfm.get("last_artifact_evidence"), dict)
        or isinstance(timesfm.get("model_cpcv"), dict)
    )
    if has_oos and has_validation:
        return {"attempted": False, "updated": False, "reason": "timesfm_evidence_already_present"}

    evidence = build_foundation_evidence_from_d1(
        model_name="TimesFM",
        run_date=payload_dict.get("run_date"),
        lookback_days=lookback_days,
    )
    if not evidence:
        return {"attempted": True, "updated": False, "reason": "no_verified_timesfm_rows"}

    oos_ic = evidence.get("oos_ic_mean")
    metrics = dict(metrics)
    metrics.update({
        "oos_ic": oos_ic,
        "oos_samples": evidence.get("samples"),
        "direction_accuracy": evidence.get("direction_accuracy"),
        "coverage_mean": evidence.get("coverage_mean"),
        "forecast_bias": evidence.get("forecast_bias"),
        "forecast_pct_sources": evidence.get("forecast_pct_sources"),
        "validation_method": evidence.get("method"),
    })
    timesfm["metrics"] = metrics
    timesfm["oos_ic"] = oos_ic
    timesfm["model_cpcv"] = evidence
    timesfm["foundation_forecast_validation"] = evidence
    timesfm["last_artifact_evidence"] = {
        "oos_ic": oos_ic,
        "oos_samples": evidence.get("samples"),
        "direction_accuracy": evidence.get("direction_accuracy"),
        "coverage_mean": evidence.get("coverage_mean"),
        "method": evidence.get("method"),
        "decision": evidence.get("decision"),
        "forecast_pct_sources": evidence.get("forecast_pct_sources"),
    }
    return {
        "attempted": True,
        "updated": True,
        "model": "TimesFM",
        "oos_ic": oos_ic,
        "samples": evidence.get("samples"),
        "decision": evidence.get("decision"),
    }
