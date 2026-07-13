"""No-leakage as-of feature snapshot backfill for allocator EV fusion."""
from __future__ import annotations

import json
from datetime import date, timedelta
from typing import Any, Callable

from services import d1_client
from services.allocator_ev_fusion import _s12_structure_features
from services.l4_alpha_ev_artifact_builder import (
    build_l4_alpha_ev_artifact_from_rows,
    load_l4_alpha_ev_training_rows,
)
from services.l4_alpha_ev_producer import materialize_l4_alpha_ev
from services.l4_alpha_ev_resolver import (
    SNAPSHOT_BACKFILL_APPROVAL_STATE,
    SNAPSHOT_BACKFILL_AS_OF_GUARD,
    SNAPSHOT_BACKFILL_SOURCE,
    SNAPSHOT_BACKFILL_USAGE_SCOPE,
    resolve_l4_alpha_ev,
)
from services.s12_trade_ev_bootstrap import S12TradeEvBootstrapProvider
from services.s12_trade_ev import extract_s12_trade_ev


QueryFn = Callable[[str, list[Any] | None], list[dict[str, Any]]]

SNAPSHOT_SOURCE = SNAPSHOT_BACKFILL_SOURCE
AS_OF_GUARD = SNAPSHOT_BACKFILL_AS_OF_GUARD


def _loads(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str) or not value.strip():
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _dumps(value: Any) -> str | None:
    if value is None:
        return None
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _date_range(start_date: str, end_date: str) -> list[str]:
    start = date.fromisoformat(str(start_date)[:10])
    end = date.fromisoformat(str(end_date)[:10])
    if end < start:
        raise ValueError("end_date_before_start_date")
    out: list[str] = []
    cur = start
    while cur <= end:
        out.append(cur.isoformat())
        cur += timedelta(days=1)
    return out


def _previous_day(day: str) -> str:
    return (date.fromisoformat(str(day)[:10]) - timedelta(days=1)).isoformat()


def _date_lte(left: str, right: str) -> bool:
    try:
        return date.fromisoformat(str(left)[:10]) <= date.fromisoformat(str(right)[:10])
    except ValueError:
        return False


def load_allocator_ev_snapshot_candidate_rows(
    query_fn: QueryFn,
    *,
    snapshot_date: str,
    limit: int = 1000,
) -> list[dict[str, Any]]:
    return query_fn(
        """
        SELECT
            dr.stock_id,
            dr.symbol,
            date(dr.date) AS recommendation_date,
            p.forecast_data,
            dr.score,
            dr.score_components,
            dr.alpha_context,
            dr.alpha_allocation AS existing_alpha_allocation,
            dr.market_segment,
            dr.recommendation_lane,
            dr.current_price,
            dr.confidence,
            dr.chip_score,
            dr.tech_score,
            dr.ml_score
        FROM daily_recommendations dr
        JOIN predictions p
          ON p.stock_id = dr.stock_id
         AND p.prediction_date = dr.date
         AND p.model_name = 'ensemble'
        WHERE date(dr.date) = date(?)
          AND dr.score_components IS NOT NULL
          AND p.forecast_data IS NOT NULL
        ORDER BY dr.rank ASC, dr.score DESC
        LIMIT ?
        """,
        [snapshot_date, int(limit)],
    )


def _parse_candidate_row(row: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    parsed = dict(row)
    for key in ("score_components", "alpha_context", "existing_alpha_allocation", "forecast_data"):
        parsed[key] = _loads(parsed.get(key))
    forecast_data = parsed.get("forecast_data") if isinstance(parsed.get("forecast_data"), dict) else {}
    prediction = dict(forecast_data)
    if isinstance(forecast_data.get("ensemble_v2"), dict):
        prediction["ensemble_v2"] = forecast_data["ensemble_v2"]
    if isinstance(forecast_data.get("alpha_context"), dict) and not parsed.get("alpha_context"):
        parsed["alpha_context"] = forecast_data["alpha_context"]
    if isinstance(forecast_data.get("alpha_allocation"), dict) and not parsed.get("existing_alpha_allocation"):
        parsed["existing_alpha_allocation"] = forecast_data["alpha_allocation"]
    return parsed, prediction


def _existing_l4_payload(allocation: dict[str, Any], *, snapshot_date: str) -> dict[str, Any] | None:
    raw = allocation.get("l4_alpha_ev")
    if not isinstance(raw, dict):
        raw = allocation.get("alpha_ev") if isinstance(allocation.get("alpha_ev"), dict) else None
    if not isinstance(raw, dict):
        return None
    payload = resolve_l4_alpha_ev(raw)
    if payload.get("status") != "loaded":
        return None
    trained_until = str(payload.get("trained_until") or "").strip()
    if not trained_until or not _date_lte(trained_until, _previous_day(snapshot_date)):
        return None
    payload["snapshot_reuse_policy"] = "persisted_candidate_time_l4_payload"
    return payload


def _existing_s12_payload(allocation: dict[str, Any]) -> dict[str, Any] | None:
    raw = allocation.get("s12_trade_ev")
    if not isinstance(raw, dict):
        return None
    value, _source, payload = extract_s12_trade_ev({"s12_trade_ev": raw})
    context = payload.get("candidate_s12_entry_context") if isinstance(payload, dict) else None
    targets = payload.get("s12_structural_targets") if isinstance(payload, dict) else None
    structure_ready = (
        isinstance(context, dict)
        and context.get("detail_available") is True
        and isinstance(targets, dict)
        and str(targets.get("structure_stop_source") or "") != "missing_s12_structure_stop"
    )
    if (
        value is not None
        and isinstance(payload, dict)
        and str(payload.get("status") or "loaded").lower() == "loaded"
        and structure_ready
    ):
        payload["snapshot_reuse_policy"] = "persisted_candidate_time_s12_payload"
        return payload
    return None


def _build_l4_asof_artifact(
    query_fn: QueryFn,
    *,
    snapshot_date: str,
    lookback_days: int,
    min_samples: int,
    min_dates: int,
    limit: int,
) -> dict[str, Any]:
    trained_until = _previous_day(snapshot_date)
    rows = load_l4_alpha_ev_training_rows(
        query_fn,
        end_date=trained_until,
        lookback_days=lookback_days,
        limit=limit,
    )
    result = build_l4_alpha_ev_artifact_from_rows(
        rows,
        trained_until=trained_until,
        lookback_days=lookback_days,
        min_samples=min_samples,
        min_dates=min_dates,
        fit_min_samples=min(100, min_samples),
        fit_min_dates=min(5, min_dates),
    )
    artifact = result.get("artifact") if isinstance(result, dict) else None
    validation = result.get("validation_packet") if isinstance(result, dict) else {}
    return {
        "trained_until": trained_until,
        "rows_loaded": len(rows),
        "status": result.get("status") if isinstance(result, dict) else "failed_validation",
        "artifact": artifact if isinstance(artifact, dict) else None,
        "decision": str((validation or {}).get("decision") or "").upper(),
        "failed_gates": (validation or {}).get("failed_gates") or [],
        "validation_packet": validation,
    }


def _select_l4_snapshot_artifact(l4_result: dict[str, Any]) -> tuple[dict[str, Any] | None, str]:
    artifact = (
        l4_result.get("artifact")
        if isinstance(l4_result.get("artifact"), dict)
        else None
    )
    if artifact is None:
        return None, "missing"
    decision = str(l4_result.get("decision") or "").upper()
    if decision == "PASS":
        return artifact, "production_pass"
    failed_gates = {
        str(value).strip()
        for value in (l4_result.get("failed_gates") or [])
        if str(value).strip()
    }
    if decision != "FAIL" or artifact.get("fitted") is not True:
        return None, "not_fit_eligible"
    return (
        {
            **artifact,
            "promotion_state": SNAPSHOT_BACKFILL_APPROVAL_STATE,
            "snapshot_backfill_only": True,
            "snapshot_backfill_fit_eligible": True,
            "snapshot_backfill_usage_scope": SNAPSHOT_BACKFILL_USAGE_SCOPE,
            "primary_expected_return_allowed": False,
            "assistive_expected_return_allowed": False,
            "production_eligible": False,
            "strict_validation_decision": decision,
            "strict_validation_failed_gates": sorted(failed_gates),
        },
        "snapshot_backfill_only",
    )




def _snapshot_statement(snapshot_date: str, row: dict[str, Any], alpha_allocation: dict[str, Any]) -> tuple[str, list[Any]]:
    l4 = alpha_allocation.get("l4_alpha_ev") if isinstance(alpha_allocation.get("l4_alpha_ev"), dict) else {}
    s12 = alpha_allocation.get("s12_trade_ev") if isinstance(alpha_allocation.get("s12_trade_ev"), dict) else {}
    return (
        """
        INSERT OR REPLACE INTO allocator_ev_feature_snapshots (
            snapshot_date,
            stock_id,
            symbol,
            forecast_data,
            score,
            score_components,
            alpha_context,
            alpha_allocation,
            market_heat_expected_return,
            market_segment,
            recommendation_lane,
            snapshot_source,
            l4_model_version,
            s12_source,
            as_of_guard,
            source_recommendation_date
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """.strip(),
        [
            snapshot_date,
            row.get("stock_id"),
            row.get("symbol"),
            _dumps(row.get("forecast_data")),
            row.get("score"),
            _dumps(row.get("score_components")),
            _dumps(row.get("alpha_context")),
            _dumps(alpha_allocation),
            (row.get("alpha_context") or {}).get("market_heat_expected_return")
            if isinstance(row.get("alpha_context"), dict)
            else None,
            row.get("market_segment"),
            row.get("recommendation_lane"),
            SNAPSHOT_SOURCE,
            l4.get("model_version"),
            s12.get("trade_expected_return_source") or s12.get("source"),
            AS_OF_GUARD,
            row.get("recommendation_date") or snapshot_date,
        ],
    )


def build_allocator_ev_feature_snapshots_for_date(
    *,
    snapshot_date: str,
    query_fn: QueryFn = d1_client.query,
    write_fn: Callable[[list[tuple[str, list[Any]]]], dict[str, Any]] | None = None,
    dry_run: bool = True,
    candidate_limit: int = 1000,
    l4_lookback_days: int = 90,
    l4_min_samples: int = 500,
    l4_min_dates: int = 20,
    l4_training_limit: int = 6000,
    s12_lookback_days: int = 120,
    s12_limit: int = 5000,
    s12_min_samples: int = 30,
    s12_min_sample_dates: int = 8,
) -> dict[str, Any]:
    l4_result = _build_l4_asof_artifact(
        query_fn,
        snapshot_date=snapshot_date,
        lookback_days=l4_lookback_days,
        min_samples=l4_min_samples,
        min_dates=l4_min_dates,
        limit=l4_training_limit,
    )
    artifact, l4_usage_mode = _select_l4_snapshot_artifact(l4_result)
    materialization_scope = (
        SNAPSHOT_BACKFILL_USAGE_SCOPE if l4_usage_mode == "snapshot_backfill_only"
        else "production"
    )

    provider = S12TradeEvBootstrapProvider.for_run_date(
        snapshot_date,
        query_fn=query_fn,
        lookback_days=s12_lookback_days,
        limit=s12_limit,
        min_samples=s12_min_samples,
        min_sample_dates=s12_min_sample_dates,
    )
    candidates = load_allocator_ev_snapshot_candidate_rows(
        query_fn,
        snapshot_date=snapshot_date,
        limit=candidate_limit,
    )
    statements: list[tuple[str, list[Any]]] = []
    skipped = 0
    skip_reasons: dict[str, int] = {}
    reused_l4 = 0
    reused_s12 = 0
    snapshots_without_l4 = 0
    snapshots_with_s12_direct_ev = 0
    snapshots_with_s12_structure = 0
    snapshots_with_s12_limited_takeover = 0
    snapshots_with_s12_full_reaction = 0
    for raw in candidates:
        row, prediction = _parse_candidate_row(raw)
        existing = row.get("existing_alpha_allocation") if isinstance(row.get("existing_alpha_allocation"), dict) else {}
        l4_payload = _existing_l4_payload(existing, snapshot_date=snapshot_date)
        if isinstance(l4_payload, dict):
            reused_l4 += 1
        else:
            l4_payload = materialize_l4_alpha_ev(
                row,
                prediction=prediction,
                policy={"l4_alpha_ev": artifact},
                usage_scope=materialization_scope,
            )
        if not isinstance(l4_payload, dict) or l4_payload.get("status") != "loaded":
            l4_payload = None
            snapshots_without_l4 += 1
        existing_is_backfill_snapshot = str(existing.get("snapshot_source") or "") == SNAPSHOT_SOURCE
        s12_payload = None if existing_is_backfill_snapshot else _existing_s12_payload(existing)
        if isinstance(s12_payload, dict):
            reused_s12 += 1
        else:
            s12_payload = provider.build_for_row(row, prediction=prediction)
        if not isinstance(s12_payload, dict):
            skipped += 1
            skip_reasons["s12_payload_missing"] = skip_reasons.get("s12_payload_missing", 0) + 1
            continue
        s12_value, _s12_source, _ = extract_s12_trade_ev({"s12_trade_ev": s12_payload})
        s12_features = _s12_structure_features(s12_payload)
        if s12_value is not None:
            snapshots_with_s12_direct_ev += 1
        if s12_features["s12_structure_available"] > 0.0:
            snapshots_with_s12_structure += 1
        if s12_features["s12_limited_takeover_ready"] > 0.0:
            snapshots_with_s12_limited_takeover += 1
        if s12_features["s12_full_reaction_ready"] > 0.0:
            snapshots_with_s12_full_reaction += 1
        alpha_allocation = {
            **{
                key: value for key, value in existing.items()
                if key not in {"l4_alpha_ev", "alpha_ev", "alpha_ev_prediction", "allocator_ev_fusion"}
            },
            "s12_trade_ev": s12_payload,
            "snapshot_source": SNAPSHOT_SOURCE,
            "as_of_guard": AS_OF_GUARD,
            "snapshot_l4_usage_mode": l4_usage_mode,
            "snapshot_l4_available": l4_payload is not None,
        }
        if l4_payload is not None:
            alpha_allocation["l4_alpha_ev"] = l4_payload
        statements.append(_snapshot_statement(snapshot_date, row, alpha_allocation))

    write_result: dict[str, Any] = {"dry_run": True, "changes_total": 0}
    if statements and not dry_run:
        writer = write_fn or (lambda items: d1_client.batch_execute(items, timeout=60.0, chunk_size=100))
        write_result = writer(statements)

    day_status = "ok" if statements else "skipped"
    day_reason = None if statements else "no_feature_snapshots_built"
    return {
        "date": snapshot_date,
        "status": day_status,
        "reason": day_reason,
        "l4_usage_mode": l4_usage_mode,
        "l4": {
            key: value
            for key, value in l4_result.items()
            if key not in {"artifact"}
        },
        "s12": provider.summary(),
        "candidate_rows": len(candidates),
        "snapshots_built": len(statements),
        "snapshots_skipped": skipped,
        "skip_reasons": skip_reasons,
        "reused_l4_payloads": reused_l4,
        "reused_s12_payloads": reused_s12,
        "snapshots_without_l4": snapshots_without_l4,
        "snapshots_with_s12_direct_ev": snapshots_with_s12_direct_ev,
        "snapshots_with_s12_structure": snapshots_with_s12_structure,
        "snapshots_with_s12_limited_takeover": snapshots_with_s12_limited_takeover,
        "snapshots_with_s12_full_reaction": snapshots_with_s12_full_reaction,
        "written": 0 if dry_run else int(write_result.get("changes_total") or 0),
        "write_result": write_result,
    }


def backfill_allocator_ev_feature_snapshots(
    *,
    start_date: str,
    end_date: str,
    query_fn: QueryFn = d1_client.query,
    dry_run: bool = True,
    candidate_limit: int = 1000,
    l4_lookback_days: int = 90,
    l4_min_samples: int = 500,
    l4_min_dates: int = 20,
    l4_training_limit: int = 6000,
    s12_lookback_days: int = 120,
    s12_limit: int = 5000,
    s12_min_samples: int = 30,
    s12_min_sample_dates: int = 8,
) -> dict[str, Any]:
    rows = []
    for snapshot_date in _date_range(start_date, end_date):
        rows.append(build_allocator_ev_feature_snapshots_for_date(
            snapshot_date=snapshot_date,
            query_fn=query_fn,
            dry_run=dry_run,
            candidate_limit=candidate_limit,
            l4_lookback_days=l4_lookback_days,
            l4_min_samples=l4_min_samples,
            l4_min_dates=l4_min_dates,
            l4_training_limit=l4_training_limit,
            s12_lookback_days=s12_lookback_days,
            s12_limit=s12_limit,
            s12_min_samples=s12_min_samples,
            s12_min_sample_dates=s12_min_sample_dates,
        ))
    aggregate_skip_reasons: dict[str, int] = {}
    for row in rows:
        for reason, count in (row.get("skip_reasons") or {}).items():
            aggregate_skip_reasons[reason] = aggregate_skip_reasons.get(reason, 0) + int(count or 0)
        day_reason = str(row.get("reason") or "").strip()
        if row.get("status") == "skipped" and day_reason:
            key = f"day:{day_reason}"
            aggregate_skip_reasons[key] = aggregate_skip_reasons.get(key, 0) + 1

    return {
        "schema_version": "allocator-ev-feature-snapshot-backfill-v1",
        "status": "ok",
        "dry_run": dry_run,
        "start_date": start_date,
        "end_date": end_date,
        "days": len(rows),
        "snapshots_built": sum(int(row.get("snapshots_built") or 0) for row in rows),
        "written": sum(int(row.get("written") or 0) for row in rows),
        "skipped_days": sum(1 for row in rows if row.get("status") == "skipped"),
        "l4_snapshot_backfill_only_days": sum(
            1 for row in rows if row.get("l4_usage_mode") == "snapshot_backfill_only"
        ),
        "snapshots_without_l4": sum(int(row.get("snapshots_without_l4") or 0) for row in rows),
        "snapshots_with_s12_direct_ev": sum(int(row.get("snapshots_with_s12_direct_ev") or 0) for row in rows),
        "snapshots_with_s12_structure": sum(int(row.get("snapshots_with_s12_structure") or 0) for row in rows),
        "snapshots_with_s12_limited_takeover": sum(int(row.get("snapshots_with_s12_limited_takeover") or 0) for row in rows),
        "snapshots_with_s12_full_reaction": sum(int(row.get("snapshots_with_s12_full_reaction") or 0) for row in rows),
        "skip_reasons": aggregate_skip_reasons,
        "results": rows,
    }
