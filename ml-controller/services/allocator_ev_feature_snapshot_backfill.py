"""No-leakage as-of feature snapshot backfill for allocator EV fusion."""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable

from services import d1_client
from services.active8_score_semantics import MODEL_TARGET_SEMANTIC_VERSION
from services.ev_lineage_contract import (
    attach_next_session_open_evidence,
    attach_same_run_model_version_evidence,
    load_model_champion_history,
    reconstruct_point_in_time_ev_lineage,
    reconstruct_rows_with_point_in_time_lineage,
)
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
from services.fusion_market_context import (
    context_for_market_segment,
    load_pit_market_contexts,
    merge_market_context,
    recorded_market_context,
)
from services.pit_sector_alpha import (
    load_pit_sector_alpha_experts_by_key,
    unavailable_sector_alpha,
)


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
    next_session_date: str | None = None,
    limit: int = 1000,
) -> list[dict[str, Any]]:
    next_date = (date.fromisoformat(snapshot_date) + timedelta(days=1)).isoformat()
    supplied_next_session = str(next_session_date or "").strip()[:10] or None
    if supplied_next_session is not None and (
        not _date_lte(next_date, supplied_next_session)
        or not _date_lte(supplied_next_session, (date.fromisoformat(snapshot_date) + timedelta(days=15)).isoformat())
    ):
        raise ValueError("next_session_date_outside_snapshot_window")
    return query_fn(
        """
        /* canonical_reference_snapshot_candidates_v4 */
        WITH next_executable_session AS (
            SELECT COALESCE(
                (SELECT MIN(date(c.date)) FROM canonical_market_daily c
                  WHERE c.stock_id='0050' AND c.source='finlab.price' AND date(c.date)>date(?)),
                date(?)
            ) session_date
        ), eligible_prediction_ids AS (
            SELECT p.id, p.stock_id, p.generated_at
              FROM predictions p
              CROSS JOIN next_executable_session next_session
             WHERE p.prediction_date>=? AND p.prediction_date<?
               AND p.model_name='ensemble' AND p.forecast_data IS NOT NULL
               AND (
                 date(datetime(p.generated_at, '+8 hours'))<=substr(p.prediction_date,1,10)
                 OR (next_session.session_date IS NOT NULL
                     AND datetime(p.generated_at)<datetime(next_session.session_date || ' 01:00:00'))
               )
        ), ranked_prediction_ids AS (
            SELECT p.id, p.stock_id,
                   ROW_NUMBER() OVER (PARTITION BY p.stock_id ORDER BY p.generated_at DESC, p.id DESC) prediction_rank
              FROM eligible_prediction_ids p
        ), canonical_reference AS (
            SELECT r.*
              FROM selection_reference_snapshots_v1 r
             WHERE r.signal_date>=? AND r.signal_date<?
               AND EXISTS (
                 SELECT 1 FROM canonical_run_heads h
                  WHERE h.logical_run_key='screener:' || r.signal_date || ':TW:production:market_screener'
                    AND h.run_id=r.producer_run_id
               )
        )
        SELECT
            COALESCE(dr.stock_id, st.id) stock_id,
            r.symbol,
            r.signal_date recommendation_date,
            p.generated_at prediction_generated_at,
            p.forecast_data,
            COALESCE(r.score_v2, dr.score) score,
            r.score_components score_components,
            dr.alpha_context,
            dr.alpha_allocation existing_alpha_allocation,
            COALESCE(r.market_segment, dr.market_segment, st.market) market_segment,
            COALESCE(dr.recommendation_lane, 'REFERENCE') recommendation_lane,
            dr.current_price, dr.confidence, dr.chip_score, dr.tech_score, dr.ml_score,
            r.producer_run_id reference_producer_run_id,
            r.feature_contract_version reference_contract_version,
            CASE
              WHEN r.feature_available!=1 THEN COALESCE(r.feature_rejection_reason, 'reference_feature_unavailable')
              WHEN st.id IS NULL THEN 'missing_stock_identity'
              WHEN p.id IS NULL THEN 'missing_point_in_time_ensemble_prediction'
              WHEN r.score_components IS NULL THEN 'missing_score_v2_components'
              WHEN json_valid(r.score_components)!=1 THEN 'invalid_score_v2_json'
              WHEN json_extract(r.score_components, '$.version')!='score_v2' THEN 'invalid_score_v2_semantic'
              ELSE NULL
            END reference_feature_rejection_reason,
            COUNT(*) OVER () candidate_total_count
        FROM daily_recommendations dr
        JOIN canonical_reference r
          ON r.signal_date=dr.date AND r.symbol=dr.symbol
        LEFT JOIN stocks st ON st.symbol=dr.symbol
        LEFT JOIN ranked_prediction_ids rp
          ON rp.stock_id=st.id AND rp.prediction_rank=1
        LEFT JOIN predictions p ON p.id=rp.id
        WHERE r.score_components IS NOT NULL
          AND json_extract(r.score_components, '$.version')='score_v2'
        ORDER BY COALESCE(dr.rank, 999999), r.score_v2 DESC, r.symbol
        LIMIT ?
        """,
        [snapshot_date, supplied_next_session, snapshot_date, next_date, snapshot_date, next_date, int(limit)],
    )

def _parse_candidate_row(row: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    parsed = dict(row)
    for key in (
        "score_components",
        "alpha_context",
        "existing_alpha_allocation",
        "forecast_data",
        "row_model_version_evidence",
    ):
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
    generated_values = sorted(
        str(row.get("prediction_generated_at") or "").strip()
        for row in rows
        if str(row.get("prediction_generated_at") or "").strip()
    )
    history_start = generated_values[0] if generated_values else f"{trained_until}T00:00:00Z"
    history_end = generated_values[-1] if generated_values else f"{trained_until}T23:59:59Z"
    champion_events, history_load = load_model_champion_history(
        query_fn,
        start_at=history_start,
        end_at=history_end,
    )
    lineage_rows, lineage_audit = reconstruct_rows_with_point_in_time_lineage(
        rows,
        champion_events=champion_events,
    )
    result = build_l4_alpha_ev_artifact_from_rows(
        lineage_rows,
        trained_until=trained_until,
        lookback_days=lookback_days,
        min_samples=min_samples,
        min_dates=min_dates,
        fit_min_samples=min(100, min_samples),
        fit_min_dates=min(5, min_dates),
    )
    artifact = result.get("artifact") if isinstance(result, dict) else None
    validation = result.get("validation_packet") if isinstance(result, dict) else {}
    if isinstance(artifact, dict):
        training_data = artifact.get("training_data") if isinstance(artifact.get("training_data"), dict) else {}
        sample_count = int(training_data.get("sample_count") or 0)
        date_count = int(training_data.get("date_count") or 0)
        artifact["point_in_time_prediction_lineage"] = {
            "schema_version": "l4-point-in-time-prediction-lineage-v1",
            "generation_mode": "expanding_asof_reconstruction",
            "prediction_date": snapshot_date,
            "trained_until": trained_until,
            "knowledge_cutoff_date": trained_until,
            "training_sample_count": sample_count,
            "training_date_count": date_count,
            "label_purge_date_groups": 5,
            "production_serving_eligible": False,
        }
        artifact["training_data"] = {
            **training_data,
            "lineage_reconstruction": lineage_audit,
            "champion_history_load": history_load,
            "point_in_time_prediction_ledger": artifact["point_in_time_prediction_lineage"],
        }
    return {
        "trained_until": trained_until,
        "rows_loaded": len(rows),
        "lineage_rows_accepted": len(lineage_rows),
        "lineage_reconstruction": lineage_audit,
        "champion_history_load": history_load,
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




def _snapshot_staging_statement(
    snapshot_date: str,
    row: dict[str, Any],
    alpha_allocation: dict[str, Any],
    *,
    run_id: str,
    generated_at: str,
    lineage_cohort_id: str,
    generation_mode: str,
    model_set_signature: str,
    target_semantic_version: str,
) -> tuple[str, list[Any]]:
    l4 = alpha_allocation.get("l4_alpha_ev") if isinstance(alpha_allocation.get("l4_alpha_ev"), dict) else {}
    return (
        """
        INSERT INTO allocator_ev_feature_snapshot_staging (
            run_id,
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
            source_recommendation_date,
            generated_at,
            lineage_cohort_id,
            generation_mode,
            model_set_signature,
            target_semantic_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, stock_id) DO UPDATE SET
            snapshot_date=excluded.snapshot_date,
            symbol=excluded.symbol,
            forecast_data=excluded.forecast_data,
            score=excluded.score,
            score_components=excluded.score_components,
            alpha_context=excluded.alpha_context,
            alpha_allocation=excluded.alpha_allocation,
            market_heat_expected_return=excluded.market_heat_expected_return,
            market_segment=excluded.market_segment,
            recommendation_lane=excluded.recommendation_lane,
            snapshot_source=excluded.snapshot_source,
            l4_model_version=excluded.l4_model_version,
            s12_source=excluded.s12_source,
            as_of_guard=excluded.as_of_guard,
            source_recommendation_date=excluded.source_recommendation_date,
            generated_at=excluded.generated_at,
            lineage_cohort_id=excluded.lineage_cohort_id,
            generation_mode=excluded.generation_mode,
            model_set_signature=excluded.model_set_signature,
            target_semantic_version=excluded.target_semantic_version
        """.strip(),
        [
            run_id,
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
            None,
            AS_OF_GUARD,
            row.get("recommendation_date") or snapshot_date,
            generated_at,
            lineage_cohort_id,
            generation_mode,
            model_set_signature,
            target_semantic_version,
        ],
    )


def _snapshot_run_start_statement(
    *,
    run_id: str,
    snapshot_date: str,
    expected_rows: int,
    native_lineage_rows: int,
    reconstructed_lineage_rows: int,
    rejected_lineage_rows: int,
) -> tuple[str, list[Any]]:
    return (
        """
        INSERT INTO allocator_ev_snapshot_runs (
            run_id, snapshot_date, snapshot_source, as_of_guard, status,
            expected_rows, staged_rows, published_rows,
            native_lineage_rows, reconstructed_lineage_rows, rejected_lineage_rows,
            error_code, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'writing', ?, 0, 0, ?, ?, ?, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(run_id) DO UPDATE SET
            status='writing', expected_rows=excluded.expected_rows,
            staged_rows=0, published_rows=0,
            native_lineage_rows=excluded.native_lineage_rows,
            reconstructed_lineage_rows=excluded.reconstructed_lineage_rows,
            rejected_lineage_rows=excluded.rejected_lineage_rows,
            error_code=NULL, updated_at=CURRENT_TIMESTAMP
        """.strip(),
        [
            run_id,
            snapshot_date,
            SNAPSHOT_SOURCE,
            AS_OF_GUARD,
            expected_rows,
            native_lineage_rows,
            reconstructed_lineage_rows,
            rejected_lineage_rows,
        ],
    )


def _snapshot_publish_statements(
    *,
    run_id: str,
    snapshot_date: str,
    expected_rows: int,
) -> list[tuple[str, list[Any]]]:
    columns = """
        snapshot_date, stock_id, symbol, forecast_data, score, score_components,
        alpha_context, alpha_allocation, market_heat_expected_return,
        market_segment, recommendation_lane, snapshot_source, l4_model_version,
        s12_source, as_of_guard, source_recommendation_date, generated_at,
        lineage_cohort_id, generation_mode, model_set_signature, target_semantic_version
    """.strip()
    return [
        (
            f"""
            INSERT INTO allocator_ev_feature_snapshots ({columns})
            SELECT {columns}
              FROM allocator_ev_feature_snapshot_staging
             WHERE run_id = ?
               AND run_id = (
                   SELECT latest.run_id
                     FROM allocator_ev_snapshot_runs latest
                    WHERE latest.snapshot_date = ?
                      AND latest.snapshot_source = ?
                      AND latest.status IN ('writing','ready')
                    ORDER BY datetime(latest.created_at) DESC, latest.run_id DESC
                    LIMIT 1
               )
               AND 1 = 1
            ON CONFLICT(snapshot_date, stock_id, snapshot_source) DO UPDATE SET
                symbol=excluded.symbol,
                forecast_data=excluded.forecast_data,
                score=excluded.score,
                score_components=excluded.score_components,
                alpha_context=excluded.alpha_context,
                alpha_allocation=excluded.alpha_allocation,
                market_heat_expected_return=excluded.market_heat_expected_return,
                market_segment=excluded.market_segment,
                recommendation_lane=excluded.recommendation_lane,
                l4_model_version=excluded.l4_model_version,
                s12_source=excluded.s12_source,
                as_of_guard=excluded.as_of_guard,
                source_recommendation_date=excluded.source_recommendation_date,
                generated_at=excluded.generated_at,
                lineage_cohort_id=excluded.lineage_cohort_id,
                generation_mode=excluded.generation_mode,
                model_set_signature=excluded.model_set_signature,
                target_semantic_version=excluded.target_semantic_version
            """.strip(),
            [run_id, snapshot_date, SNAPSHOT_SOURCE],
        ),
        (
            """
            DELETE FROM allocator_ev_feature_snapshots
             WHERE snapshot_date = ?
               AND snapshot_source = ?
               AND ? = (
                   SELECT latest.run_id
                     FROM allocator_ev_snapshot_runs latest
                    WHERE latest.snapshot_date = ?
                      AND latest.snapshot_source = ?
                      AND latest.status IN ('writing','ready')
                    ORDER BY datetime(latest.created_at) DESC, latest.run_id DESC
                    LIMIT 1
               )
               AND stock_id NOT IN (
                   SELECT stock_id
                     FROM allocator_ev_feature_snapshot_staging
                    WHERE run_id = ?
               )
            """.strip(),
            [snapshot_date, SNAPSHOT_SOURCE, run_id, snapshot_date, SNAPSHOT_SOURCE, run_id],
        ),
        (
            """
            UPDATE allocator_ev_snapshot_runs
               SET status='ready', staged_rows=?, published_rows=?,
                   published_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
             WHERE run_id=? AND status='writing'
               AND run_id = (
                   SELECT latest.run_id
                     FROM allocator_ev_snapshot_runs latest
                    WHERE latest.snapshot_date = ?
                      AND latest.snapshot_source = ?
                      AND latest.status IN ('writing','ready')
                    ORDER BY datetime(latest.created_at) DESC, latest.run_id DESC
                    LIMIT 1
               )
            """.strip(),
            [expected_rows, expected_rows, run_id, snapshot_date, SNAPSHOT_SOURCE],
        ),
        (
            "DELETE FROM allocator_ev_feature_snapshot_staging WHERE run_id=?",
            [run_id],
        ),
    ]


def _snapshot_run_fail_statement(*, run_id: str, error_code: str) -> tuple[str, list[Any]]:
    return (
        """
        UPDATE allocator_ev_snapshot_runs
           SET status='failed', error_code=?, updated_at=CURRENT_TIMESTAMP
         WHERE run_id=? AND status='writing'
        """.strip(),
        [str(error_code)[:500], run_id],
    )


def _assert_complete_write(result: dict[str, Any], expected: int, *, phase: str) -> None:
    errors = int(result.get("error_count") or 0)
    successes = result.get("success_count")
    if errors > 0 or (successes is not None and int(successes) != expected):
        raise RuntimeError(
            f"allocator_snapshot_{phase}_partial_failure:"
            f"expected={expected}:success={successes}:errors={errors}:"
            f"first_error={result.get('first_error')}"
        )


def build_allocator_ev_feature_snapshots_for_date(
    *,
    snapshot_date: str,
    next_session_date: str | None = None,
    query_fn: QueryFn = d1_client.query,
    write_fn: Callable[[list[tuple[str, list[Any]]]], dict[str, Any]] | None = None,
    dry_run: bool = True,
    candidate_limit: int = 1000,
    l4_lookback_days: int = 90,
    l4_min_samples: int = 500,
    l4_min_dates: int = 20,
    l4_training_limit: int = 6000,
    lineage_cohort_id: str | None = None,
) -> dict[str, Any]:
    generated_at = datetime.now(timezone.utc).isoformat()
    run_id = f"allocator-snapshot:{snapshot_date}:{generated_at.replace(':', '').replace('-', '')}"
    resolved_lineage_cohort_id = str(lineage_cohort_id or run_id).strip()
    if not resolved_lineage_cohort_id:
        raise ValueError("allocator_snapshot_lineage_cohort_id_missing")
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

    raw_candidates = load_allocator_ev_snapshot_candidate_rows(
        query_fn,
        snapshot_date=snapshot_date,
        next_session_date=next_session_date,
        limit=candidate_limit,
    )
    market_context_load_error: str | None = None
    try:
        market_contexts = load_pit_market_contexts(query_fn, [snapshot_date])
    except Exception as exc:  # noqa: BLE001 - missing context is explicit and blocks V12 promotion coverage.
        market_contexts = {}
        market_context_load_error = f"{type(exc).__name__}:{exc}"
    candidate_total = max(
        [int(row.get("candidate_total_count") or 0) for row in raw_candidates] or [0]
    )
    if candidate_total > len(raw_candidates):
        raise RuntimeError(
            "allocator_snapshot_candidate_limit_truncated:"
            f"date={snapshot_date}:loaded={len(raw_candidates)}:total={candidate_total}:"
            f"limit={candidate_limit}"
        )
    timed_candidates, next_session_evidence_load = attach_next_session_open_evidence(
        query_fn,
        raw_candidates,
        supplied_next_session_dates=(
            {snapshot_date: next_session_date}
            if next_session_date else None
        ),
    )
    candidates, row_version_evidence_load = attach_same_run_model_version_evidence(
        query_fn,
        timed_candidates,
    )
    sector_alpha_load_error: str | None = None
    try:
        sector_alpha_by_key = load_pit_sector_alpha_experts_by_key(query_fn, candidates)
    except Exception as exc:  # noqa: BLE001 - missing evidence remains explicit per snapshot.
        sector_alpha_by_key = {}
        sector_alpha_load_error = f"{type(exc).__name__}:{exc}"
    generated_values = sorted(
        str(row.get("prediction_generated_at") or "").strip()
        for row in candidates
        if str(row.get("prediction_generated_at") or "").strip()
    )
    champion_events, champion_history_load = load_model_champion_history(
        query_fn,
        start_at=generated_values[0] if generated_values else f"{snapshot_date}T00:00:00Z",
        end_at=generated_values[-1] if generated_values else f"{snapshot_date}T23:59:59Z",
    )

    statements: list[tuple[str, list[Any]]] = []
    skipped = 0
    skip_reasons: dict[str, int] = {}
    reused_l4 = 0
    snapshots_without_l4 = 0
    native_lineage_rows = 0
    reconstructed_lineage_rows = 0
    rejected_lineage_rows = 0
    market_context_rows = 0
    regime_surface_rows = 0
    sector_alpha_rows = 0
    for raw in candidates:
        row, prediction = _parse_candidate_row(raw)
        reference_rejection = str(row.get("reference_feature_rejection_reason") or "").strip()
        if reference_rejection:
            rejected_lineage_rows += 1
            skipped += 1
            key = f"reference_feature:{reference_rejection}"
            skip_reasons[key] = skip_reasons.get(key, 0) + 1
            continue
        lineage_result = reconstruct_point_in_time_ev_lineage(
            row,
            champion_events=champion_events,
        )
        lineage_status = str(lineage_result.get("status") or "rejected")
        if lineage_status == "native":
            native_lineage_rows += 1
        elif lineage_status == "reconstructed":
            reconstructed_lineage_rows += 1
        else:
            rejected_lineage_rows += 1
            skipped += 1
            blockers = lineage_result.get("blockers") or ["unknown"]
            for blocker in blockers:
                key = f"lineage:{blocker}"
                skip_reasons[key] = skip_reasons.get(key, 0) + 1
            continue
        if isinstance(lineage_result.get("row"), dict):
            row, prediction = _parse_candidate_row(lineage_result["row"])
        ensemble_payload = (
            prediction.get("ensemble_v2")
            if isinstance(prediction.get("ensemble_v2"), dict)
            else {}
        )
        model_set_signature = str(ensemble_payload.get("model_set_signature") or "").strip()
        if not model_set_signature:
            rejected_lineage_rows += 1
            skipped += 1
            skip_reasons["lineage:model_set_signature_missing"] = (
                skip_reasons.get("lineage:model_set_signature_missing", 0) + 1
            )
            continue
        model_score_lineage = (
            prediction.get("model_score_lineage")
            if isinstance(prediction.get("model_score_lineage"), dict)
            else {}
        )
        target_semantic_version = str(
            ensemble_payload.get("target_semantic_version")
            or model_score_lineage.get("target_semantic_version")
            or ""
        ).strip()
        if target_semantic_version != MODEL_TARGET_SEMANTIC_VERSION:
            rejected_lineage_rows += 1
            skipped += 1
            reason = (
                "lineage:target_semantic_version_missing"
                if not target_semantic_version
                else "lineage:target_semantic_version_incompatible"
            )
            skip_reasons[reason] = skip_reasons.get(reason, 0) + 1
            continue
        generation_mode = (
            "native" if lineage_status == "native" else "counterfactual_reconstruction"
        )
        recorded_context = recorded_market_context(row, signal_date=snapshot_date)
        reconstructed_context = context_for_market_segment(
            market_contexts,
            signal_date=snapshot_date,
            market_segment=row.get("market_segment"),
        )
        market_context = merge_market_context(
            recorded_context,
            reconstructed_context,
            signal_date=snapshot_date,
        )
        if market_context.get("market_context_available"):
            market_context_rows += 1
        if market_context.get("regime_surface_available"):
            regime_surface_rows += 1
        alpha_context = (
            dict(row.get("alpha_context"))
            if isinstance(row.get("alpha_context"), dict)
            else {}
        )
        alpha_context["market_regime_context"] = market_context
        sector_expert = sector_alpha_by_key.get((snapshot_date, str(row.get("symbol") or "")))
        if not isinstance(sector_expert, dict):
            sector_expert = unavailable_sector_alpha(snapshot_date, "snapshot_sector_alpha_not_loaded")
        alpha_context["pit_sector_alpha_expert"] = sector_expert
        if sector_expert.get("status") == "loaded" and sector_expert.get("point_in_time") is True:
            sector_alpha_rows += 1
        row["alpha_context"] = alpha_context
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
        alpha_allocation = {
            **{
                key: value for key, value in existing.items()
                if key not in {"l4_alpha_ev", "alpha_ev", "alpha_ev_prediction", "allocator_ev_fusion", "s12_trade_ev"}
            },
            "snapshot_source": SNAPSHOT_SOURCE,
            "as_of_guard": AS_OF_GUARD,
            "snapshot_l4_usage_mode": l4_usage_mode,
            "snapshot_l4_available": l4_payload is not None,
            "execution_policy_label_join": "mature_s12_replay_outcomes_only_after_snapshot",
            "l4_alpha_ev_diagnostic": {
                "status": "loaded" if l4_payload is not None else "unavailable",
                "usage_mode": l4_usage_mode,
                "trained_until": l4_result.get("trained_until"),
                "decision": l4_result.get("decision"),
                "failed_gates": l4_result.get("failed_gates") or [],
                "policy": "missing_expert_is_an_availability_feature_not_a_synthetic_ev",
            },
            "ev_lineage_status": lineage_status,
            "ev_lineage_audit": lineage_result.get("audit"),
        }
        if l4_payload is not None:
            alpha_allocation["l4_alpha_ev"] = l4_payload
        statements.append(
            _snapshot_staging_statement(
                snapshot_date,
                row,
                alpha_allocation,
                run_id=run_id,
                generated_at=generated_at,
                lineage_cohort_id=resolved_lineage_cohort_id,
                generation_mode=generation_mode,
                model_set_signature=model_set_signature,
                target_semantic_version=target_semantic_version,
            )
        )

    write_result: dict[str, Any] = {"dry_run": True, "changes_total": 0}
    publish_result: dict[str, Any] = {"dry_run": True, "changes_total": 0}
    if statements and not dry_run:
        writer = write_fn or (lambda items: d1_client.batch_execute(items, timeout=60.0, chunk_size=100))
        stage_statements = [
            _snapshot_run_start_statement(
                run_id=run_id,
                snapshot_date=snapshot_date,
                expected_rows=len(statements),
                native_lineage_rows=native_lineage_rows,
                reconstructed_lineage_rows=reconstructed_lineage_rows,
                rejected_lineage_rows=rejected_lineage_rows,
            ),
            *statements,
        ]
        try:
            write_result = writer(stage_statements)
            _assert_complete_write(write_result, len(stage_statements), phase="staging")
            staged_rows = query_fn(
                "SELECT COUNT(*) AS row_count FROM allocator_ev_feature_snapshot_staging WHERE run_id=?",
                [run_id],
            )
            staged_count = int((staged_rows[0] if staged_rows else {}).get("row_count") or 0)
            if staged_count != len(statements):
                raise RuntimeError(
                    "allocator_snapshot_staging_count_mismatch:"
                    f"run_id={run_id}:expected={len(statements)}:actual={staged_count}"
                )
            publish_statements = _snapshot_publish_statements(
                run_id=run_id,
                snapshot_date=snapshot_date,
                expected_rows=len(statements),
            )
            publish_result = writer(publish_statements)
            _assert_complete_write(publish_result, len(publish_statements), phase="publish")
            published_run = query_fn(
                "SELECT status, published_rows FROM allocator_ev_snapshot_runs WHERE run_id=?",
                [run_id],
            )
            published = published_run[0] if published_run else {}
            if (
                str(published.get("status") or "") != "ready"
                or int(published.get("published_rows") or 0) != len(statements)
            ):
                raise RuntimeError(
                    "allocator_snapshot_publish_readback_mismatch:"
                    f"run_id={run_id}:status={published.get('status')}:"
                    f"expected={len(statements)}:actual={published.get('published_rows')}"
                )
        except Exception as exc:
            try:
                writer([_snapshot_run_fail_statement(run_id=run_id, error_code=str(exc))])
            except Exception:
                pass
            raise

    day_status = "ok" if statements else "skipped"
    day_reason = None if statements else (
        "no_eligible_score_v2_candidates"
        if not candidates
        else "all_candidates_rejected_by_lineage_or_feature_contract"
    )
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
        "execution_policy_label_join": "mature_s12_replay_outcomes_after_snapshot",
        "candidate_time_s12_feature_count": 0,
        "candidate_rows": len(candidates),
        "candidate_total_rows": candidate_total,
        "snapshots_built": len(statements),
        "snapshots_skipped": skipped,
        "skip_reasons": skip_reasons,
        "reused_l4_payloads": reused_l4,
        "snapshots_without_l4": snapshots_without_l4,
        "champion_history_load": champion_history_load,
        "next_session_evidence_load": next_session_evidence_load,
        "row_model_version_evidence_load": row_version_evidence_load,
        "native_lineage_rows": native_lineage_rows,
        "reconstructed_lineage_rows": reconstructed_lineage_rows,
        "rejected_lineage_rows": rejected_lineage_rows,
        "market_context": {
            "available_rows": market_context_rows,
            "regime_surface_rows": regime_surface_rows,
            "coverage": round(market_context_rows / max(1, len(statements)), 8),
            "load_error": market_context_load_error,
        },
        "pit_sector_alpha": {
            "available_rows": sector_alpha_rows,
            "coverage": round(sector_alpha_rows / max(1, len(statements)), 8),
            "load_error": sector_alpha_load_error,
            "point_in_time_required": True,
        },
        "written": 0 if dry_run else len(statements),
        "stale_rows_deleted": None,
        "snapshot_run_id": run_id,
        "generated_at": generated_at,
        "write_result": write_result,
        "publish_result": publish_result,
    }


def backfill_allocator_ev_feature_snapshots(
    *,
    start_date: str,
    end_date: str,
    next_session_date: str | None = None,
    query_fn: QueryFn = d1_client.query,
    dry_run: bool = True,
    candidate_limit: int = 1000,
    l4_lookback_days: int = 90,
    l4_min_samples: int = 500,
    l4_min_dates: int = 20,
    l4_training_limit: int = 6000,
    lineage_cohort_id: str | None = None,
) -> dict[str, Any]:
    if next_session_date and start_date != end_date:
        raise ValueError("next_session_date_requires_single_snapshot_date")
    rows = []
    for snapshot_date in _date_range(start_date, end_date):
        rows.append(build_allocator_ev_feature_snapshots_for_date(
            snapshot_date=snapshot_date,
            next_session_date=next_session_date,
            query_fn=query_fn,
            dry_run=dry_run,
            candidate_limit=candidate_limit,
            l4_lookback_days=l4_lookback_days,
            l4_min_samples=l4_min_samples,
            l4_min_dates=l4_min_dates,
            l4_training_limit=l4_training_limit,
            lineage_cohort_id=(
                lineage_cohort_id
                if start_date == end_date or not lineage_cohort_id
                else f"{lineage_cohort_id}:{snapshot_date}"
            ),
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
        "candidate_time_s12_feature_count": 0,
        "stale_rows_deleted": sum(int(row.get("stale_rows_deleted") or 0) for row in rows),
        "skip_reasons": aggregate_skip_reasons,
        "results": rows,
    }
