"""Cloud Run Job entrypoint for durable Active-8 OOF materialization."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from typing import Any

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger("oof_materialize_job")

OOF_CONTINUATION_MAX_ATTEMPTS = 12


async def _callback_worker(payload: dict[str, Any]) -> None:
    from routers.pipeline import _callback_worker as callback

    await callback(payload)


def _truthy(value: str) -> bool:
    return value.strip().lower() not in {"0", "false", "no", "off"}


def _bounded_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = os.environ.get(name, str(default)).strip()
    try:
        value = int(raw)
    except ValueError as exc:
        raise RuntimeError(f"invalid integer {name}={raw}") from exc
    if not minimum <= value <= maximum:
        raise RuntimeError(f"{name} outside [{minimum},{maximum}]: {value}")
    return value


async def _execute_lifecycle(
    *,
    cadence: str,
    end_date: str | None,
    promote: bool,
    dispatch_full_fit: bool,
    expected_cohort_id: str | None,
    continuation_attempt: int,
    continuation_only: bool,
) -> dict[str, Any]:
    from routers.walk_forward import OofLifecycleRequest, run_walk_forward_oof_lifecycle
    from services.active8_prep_lifecycle import (
        Active8PrepDependencyPending,
        ensure_active8_daily_prep,
    )

    if continuation_only and expected_cohort_id:
        # Exact continuation reuses the checksum-bound cohort. Rebuilding a
        # current prep cannot change its evidence and would conflate the
        # orchestration deploy with the historical ML artifact producer.
        prep = {
            "status": "reused_immutable_cohort",
            "cohort_id": expected_cohort_id,
            "training_dispatched": False,
        }
    else:
        try:
            prep = await ensure_active8_daily_prep(end_date=end_date, dry_run=False)
        except Active8PrepDependencyPending as exc:
            return {
                "status": "pending",
                "reason": exc.reason,
                "dependency_retry_required": True,
                "prep_lifecycle": exc.evidence,
            }
    result = await run_walk_forward_oof_lifecycle(OofLifecycleRequest(
        cadence=cadence,
        end_date=end_date,
        dry_run=False,
        promote=promote,
        dispatch_full_fit=dispatch_full_fit,
        expected_cohort_id=expected_cohort_id,
        continuation_attempt=continuation_attempt,
        continuation_only=continuation_only,
    ))
    result["prep_lifecycle"] = prep
    return result


async def _execute_allocator_snapshot(
    *,
    start_date: str,
    end_date: str,
    lineage_cohort_id: str,
) -> dict[str, Any]:
    from services.allocator_ev_feature_snapshot_backfill import (
        backfill_allocator_ev_feature_snapshots,
    )

    return await asyncio.to_thread(
        backfill_allocator_ev_feature_snapshots,
        start_date=start_date,
        end_date=end_date,
        next_session_date=os.environ.get("OOF_MATERIALIZE_NEXT_SESSION_DATE", "").strip() or None,
        dry_run=False,
        candidate_limit=_bounded_int("OOF_MATERIALIZE_CANDIDATE_LIMIT", 1000, 1, 5000),
        l4_lookback_days=_bounded_int("OOF_MATERIALIZE_L4_LOOKBACK_DAYS", 90, 30, 365),
        l4_min_samples=_bounded_int("OOF_MATERIALIZE_L4_MIN_SAMPLES", 500, 50, 10000),
        l4_min_dates=_bounded_int("OOF_MATERIALIZE_L4_MIN_DATES", 20, 5, 252),
        l4_training_limit=_bounded_int("OOF_MATERIALIZE_L4_TRAINING_LIMIT", 6000, 500, 20000),
        lineage_cohort_id=lineage_cohort_id,
    )


async def _execute_semantic_reconciliation(
    *,
    expected_cohort_id: str | None,
    knowledge_cutoff_date: str | None,
    cadence: str,
) -> dict[str, Any]:
    from routers.walk_forward import reconcile_terminal_oof_feature_semantics

    if not expected_cohort_id or not knowledge_cutoff_date:
        raise RuntimeError(
            "semantic reconciliation requires exact cohort and knowledge cutoff"
        )
    return await reconcile_terminal_oof_feature_semantics(
        cohort_id=expected_cohort_id,
        knowledge_cutoff_date=knowledge_cutoff_date,
        lifecycle_cadence=cadence,
    )


async def _execute_forward_extension_resume(
    *,
    expected_cohort_id: str | None,
    knowledge_cutoff_date: str | None,
    forward_extension_manifest_path: str | None,
) -> dict[str, Any]:
    """Consume one verified immutable forward extension without rebuilding prep or models."""

    from routers.walk_forward import OofMaterializeRequest, materialize_walk_forward_oof

    if not expected_cohort_id or not knowledge_cutoff_date:
        raise RuntimeError(
            "forward extension resume requires exact cohort and knowledge cutoff"
        )
    if not forward_extension_manifest_path:
        raise RuntimeError("forward extension resume requires exact manifest path")
    result = await materialize_walk_forward_oof(OofMaterializeRequest(
        cohort_id=expected_cohort_id,
        knowledge_cutoff_date=knowledge_cutoff_date,
        # This mode is mutation-isolated from serving, but it must persist the
        # checksum-bound candidate artifact before the forward evaluator reads
        # the registry. A dry run rebuilt the corrected artifact only in
        # memory and then evaluated the stale pre-fix candidate instead.
        dry_run=False,
        confirm=True,
        promote=False,
        dispatch_full_fit=False,
        lifecycle_cadence="daily",
        forward_extension_manifest_path=forward_extension_manifest_path,
        persist_forward_shadow_coverage=True,
    ))
    extension = result.get("forward_extension")
    extension = extension if isinstance(extension, dict) else {}
    dates = sorted({
        str(value or "")[:10]
        for value in extension.get("dates") or []
        if len(str(value or "")[:10]) == 10
    })
    if not dates:
        raise RuntimeError("forward extension resume produced no verified dates")
    coverage = result.get("physical_prediction_coverage")
    coverage = coverage if isinstance(coverage, dict) else {}
    result.update({
        "status": "shadow_evaluated",
        "promoted": False,
        "promotion_allowed": False,
        "promotion_attempted": False,
        "training_dispatched": False,
        "serving_pointer_changed": False,
        "promotion_reason": "immutable_forward_extension_resume_shadow_only",
        "forward_extension_manifest_path": forward_extension_manifest_path,
        "calendar": {
            "cutoff": knowledge_cutoff_date,
            "mature_max_date": dates[-1],
            "calendar_source": "immutable_forward_extension_manifest",
            "parent_physical_coverage": {
                "max_date": coverage.get("base_max_date"),
            },
        },
        "prep_lifecycle": {
            "status": "reused_immutable_forward_extension",
            "business_date": knowledge_cutoff_date,
            "training_dispatched": False,
        },
    })
    return result


def _dependency_retry_reason(result: dict[str, Any]) -> str:
    forward_extension = result.get("daily_forward_extension")
    forward_extension = forward_extension if isinstance(forward_extension, dict) else {}
    full_fit = result.get("full_fit_dispatch")
    full_fit = full_fit if isinstance(full_fit, dict) else {}
    opb_refresh = result.get("opb_refresh")
    opb_refresh = opb_refresh if isinstance(opb_refresh, dict) else {}
    for value in (
        forward_extension.get("reason"),
        full_fit.get("reason"),
        opb_refresh.get("error"),
        result.get("candidate_forward_promotion_error"),
        result.get("reason"),
    ):
        if str(value or "").strip():
            return str(value).strip()
    return "dependency_retry_required"


def _summary(run_id: str, result: dict[str, Any], *, mode: str) -> str:
    if mode == "allocator_snapshot":
        return " ".join([
            f"run_id={run_id}",
            f"status={result.get('status', 'unknown')}",
            f"built={result.get('snapshots_built', 0)}",
            f"written={result.get('written', 0)}",
            f"skipped_days={result.get('skipped_days', 0)}",
            f"without_l4={result.get('snapshots_without_l4', 0)}",
            "l4_blockers=" + json.dumps(
                result.get("l4_materialization_blockers") or {}, separators=(",", ":"), sort_keys=True
            ),
        ])
    if mode == "semantic_reconcile_only":
        return " ".join([
            f"run_id={run_id}",
            f"status={result.get('status', 'unknown')}",
            f"cohort={result.get('cohort_id', 'none')}",
            f"training_dispatched={bool(result.get('training_dispatched'))}",
            f"promotion_attempted={bool(result.get('promotion_attempted'))}",
            f"serving_pointer_changed={bool(result.get('serving_pointer_changed'))}",
        ])
    summary_reason = (
        result.get("promotion_reason")
        or (_dependency_retry_reason(result) if result.get("dependency_retry_required") else result.get("reason"))
        or "none"
    )
    parts = [
        f"run_id={run_id}",
        f"status={result.get('status', 'unknown')}",
        f"cohort={result.get('cohort_id', 'none')}",
        f"promoted={bool(result.get('promoted'))}",
        f"reason={summary_reason}",
        f"full_fit={str((result.get('full_fit_dispatch') or {}).get('status') or 'none')}",
    ]
    prep_lifecycle = result.get("prep_lifecycle")
    prep_lifecycle = prep_lifecycle if isinstance(prep_lifecycle, dict) else {}
    if prep_lifecycle.get("expected_business_date") or prep_lifecycle.get("snapshot_business_date"):
        parts.extend([
            f"expected_snapshot_date={prep_lifecycle.get('expected_business_date') or 'missing'}",
            f"actual_snapshot_date={prep_lifecycle.get('snapshot_business_date') or prep_lifecycle.get('business_date') or 'missing'}",
            f"snapshot_id={prep_lifecycle.get('snapshot_id') or 'missing'}",
        ])
    freshness = _oof_freshness_evidence(result)
    if freshness.get("expected_max_date") or freshness.get("effective_max_date"):
        parts.extend([
            f"oof_base_max={freshness.get('base_max_date') or 'missing'}",
            f"effective_oof_max={freshness.get('effective_max_date') or 'missing'}",
            f"expected_oof_max={freshness.get('expected_max_date') or 'missing'}",
            f"coverage_mode={freshness.get('coverage_mode') or 'unknown'}",
        ])
    return " ".join(parts)


def _oof_freshness_evidence(result: dict[str, Any]) -> dict[str, Any]:
    prep_lifecycle = result.get("prep_lifecycle")
    prep_lifecycle = prep_lifecycle if isinstance(prep_lifecycle, dict) else {}
    receipt = result.get("receipt")
    receipt = receipt if isinstance(receipt, dict) else {}
    calendar = result.get("calendar")
    calendar = calendar if isinstance(calendar, dict) else receipt.get("calendar")
    calendar = calendar if isinstance(calendar, dict) else {}
    shadow = receipt.get("shadow_evaluation")
    shadow = shadow if isinstance(shadow, dict) else {}
    coverage = result.get("physical_prediction_coverage")
    coverage = coverage if isinstance(coverage, dict) else receipt.get("physical_prediction_coverage")
    coverage = coverage if isinstance(coverage, dict) else shadow.get("physical_prediction_coverage")
    coverage = coverage if isinstance(coverage, dict) else {}
    parent_coverage = calendar.get("parent_physical_coverage")
    parent_coverage = parent_coverage if isinstance(parent_coverage, dict) else {}
    expected_max = str(calendar.get("mature_max_date") or "")[:10]
    effective_max = str(coverage.get("max_date") or "")[:10]
    base_max = str(coverage.get("base_max_date") or parent_coverage.get("max_date") or "")[:10]
    coverage_mode = (
        "frozen_forward_shadow"
        if base_max and effective_max and effective_max > base_max
        else "base_materialized"
        if effective_max
        else "missing"
    )
    if not expected_max:
        status = "failed"
        reason = "expected_mature_max_missing"
    elif not effective_max:
        status = "failed"
        reason = "effective_oof_max_missing"
    elif effective_max < expected_max:
        status = "failed"
        reason = "effective_oof_max_behind_immutable_prep"
    else:
        status = "fresh"
        reason = "effective_oof_max_reached_immutable_prep"
    return {
        "schema_version": "active8-oof-freshness-v1",
        "status": status,
        "reason": reason,
        "business_date": str(prep_lifecycle.get("business_date") or "")[:10] or None,
        "source": calendar.get("calendar_source"),
        "prep_manifest_checksum": calendar.get("prep_manifest_checksum"),
        "expected_max_date": expected_max or None,
        "effective_max_date": effective_max or None,
        "base_max_date": base_max or None,
        "coverage_mode": coverage_mode,
        "cohort_id": result.get("cohort_id") or receipt.get("cohort_id"),
    }


async def _run() -> int:
    mode = os.environ.get("OOF_MATERIALIZE_MODE", "oof_lifecycle").strip().lower()
    cadence = os.environ.get("OOF_MATERIALIZE_CADENCE", "daily").strip().lower()
    start_date = os.environ.get("OOF_MATERIALIZE_START_DATE", "").strip() or None
    end_date = os.environ.get("OOF_MATERIALIZE_END_DATE", "").strip() or None
    promote = _truthy(os.environ.get("OOF_MATERIALIZE_PROMOTE", "1"))
    dispatch_full_fit = _truthy(os.environ.get("OOF_MATERIALIZE_DISPATCH_FULL_FIT", "0"))
    expected_cohort_id = (
        os.environ.get("OOF_MATERIALIZE_EXPECTED_COHORT_ID", "").strip() or None
    )
    continuation_attempt = _bounded_int(
        "OOF_MATERIALIZE_CONTINUATION_ATTEMPT", 0, 0, OOF_CONTINUATION_MAX_ATTEMPTS
    )
    continuation_only = _truthy(
        os.environ.get("OOF_MATERIALIZE_CONTINUATION_ONLY", "0")
    )
    forward_extension_manifest_path = (
        os.environ.get("OOF_MATERIALIZE_FORWARD_EXTENSION_MANIFEST_PATH", "").strip()
        or None
    )
    callback_task = os.environ.get(
        "OOF_MATERIALIZE_CALLBACK_TASK",
        f"active8-oof-{cadence}",
    ).strip()
    execution_id = os.environ.get(
        "CLOUD_RUN_EXECUTION",
        f"active8-oof-materialize-{int(time.time())}-{uuid.uuid4().hex[:8]}",
    )
    run_id = os.environ.get("OOF_MATERIALIZE_RUN_ID", "").strip() or execution_id
    scheduler_ticket_id = os.environ.get(
        "OOF_MATERIALIZE_SCHEDULER_TICKET_ID", ""
    ).strip()
    scheduler_run_id = os.environ.get(
        "OOF_MATERIALIZE_SCHEDULER_RUN_ID", ""
    ).strip()
    started = time.time()
    callback_status = "error"
    error: str | None = None
    result: dict[str, Any] = {}
    freshness: dict[str, Any] | None = None

    try:
        if bool(scheduler_ticket_id) != bool(scheduler_run_id):
            raise RuntimeError("OOF scheduler ticket identity is incomplete")
        if mode == "allocator_snapshot":
            if not start_date or not end_date:
                raise RuntimeError("allocator snapshot mode requires start and end dates")
            result = await _execute_allocator_snapshot(
                start_date=start_date,
                end_date=end_date,
                lineage_cohort_id=run_id,
            )
            status = str(result.get("status") or "").lower()
            if (
                status == "ok"
                and int(result.get("snapshots_built") or 0) > 0
                and int(result.get("written") or 0) > 0
            ):
                callback_status = "success"
            else:
                raise RuntimeError(
                    "allocator snapshot incomplete "
                    f"status={status or 'unknown'} built={result.get('snapshots_built')} "
                    f"written={result.get('written')} "
                    f"skip_reasons={result.get('skip_reasons') or {}}"
                )
        elif mode == "semantic_reconcile_only":
            if promote or dispatch_full_fit or continuation_only:
                raise RuntimeError(
                    "semantic_reconcile_only forbids promote, dispatch, and continuation"
                )
            result = await _execute_semantic_reconciliation(
                expected_cohort_id=expected_cohort_id,
                knowledge_cutoff_date=end_date,
                cadence=cadence,
            )
            if (
                result.get("status") != "semantic_reconciled"
                or result.get("training_dispatched") is not False
                or result.get("promotion_attempted") is not False
                or result.get("serving_pointer_changed") is not False
            ):
                raise RuntimeError("semantic reconciliation postcondition failed")
            callback_status = "success"
        elif mode == "forward_extension_resume":
            if cadence != "daily":
                raise RuntimeError("forward_extension_resume requires daily cadence")
            if promote or dispatch_full_fit or continuation_only:
                raise RuntimeError(
                    "forward_extension_resume forbids promotion, training, and continuation"
                )
            result = await _execute_forward_extension_resume(
                expected_cohort_id=expected_cohort_id,
                knowledge_cutoff_date=end_date,
                forward_extension_manifest_path=forward_extension_manifest_path,
            )
            if (
                result.get("status") != "shadow_evaluated"
                or result.get("durable_shadow_base_materialization") is not True
                or result.get("training_dispatched") is not False
                or result.get("promotion_attempted") is not False
                or result.get("serving_pointer_changed") is not False
                or result.get("promoted") is not False
            ):
                raise RuntimeError("forward extension resume postcondition failed")
            freshness = _oof_freshness_evidence(result)
            if freshness["status"] != "fresh":
                raise RuntimeError(
                    "oof_freshness_closure_failed:"
                    f"{freshness['reason']}:expected={freshness['expected_max_date']}:"
                    f"effective={freshness['effective_max_date']}"
                )
            callback_status = "success"
        else:
            if mode != "oof_lifecycle":
                raise RuntimeError(f"invalid OOF materialize mode: {mode}")
            if cadence not in {"daily", "weekly", "monthly"}:
                raise RuntimeError(f"invalid OOF materialize cadence: {cadence}")
            result = await _execute_lifecycle(
                cadence=cadence,
                end_date=end_date,
                promote=promote,
                dispatch_full_fit=dispatch_full_fit,
                expected_cohort_id=expected_cohort_id,
                continuation_attempt=continuation_attempt,
                continuation_only=continuation_only,
            )
            status = str(result.get("status") or "").lower()
            if result.get("dependency_retry_required"):
                if continuation_attempt >= OOF_CONTINUATION_MAX_ATTEMPTS:
                    reason = _dependency_retry_reason(result)
                    raise RuntimeError(
                        "oof_dependency_continuation_exhausted:"
                        f"{reason}:attempt={continuation_attempt}"
                    )
                callback_status = "triggered"
            elif status in {"materialized", "shadow_evaluated", "idempotent_complete"}:
                freshness = _oof_freshness_evidence(result)
                if freshness["status"] != "fresh":
                    raise RuntimeError(
                        "oof_freshness_closure_failed:"
                        f"{freshness['reason']}:expected={freshness['expected_max_date']}:"
                        f"effective={freshness['effective_max_date']}"
                    )
                callback_status = "success"
            elif status in {"pending", "spawned"} and cadence in {"weekly", "monthly"}:
                if continuation_attempt >= OOF_CONTINUATION_MAX_ATTEMPTS:
                    raise RuntimeError(
                        "oof_cohort_continuation_exhausted:"
                        f"status={status}:attempt={continuation_attempt}"
                    )
                callback_status = "triggered"
            elif status in {"skipped", "pending", "spawned"}:
                callback_status = "skipped"
            else:
                raise RuntimeError(f"unexpected OOF materialization status: {status or 'unknown'}")
    except Exception as exc:  # noqa: BLE001 - callback must close every terminal job state.
        logger.exception("[OofMaterializeJob] Failed")
        error = f"{type(exc).__name__}: {exc}"

    summary = _summary(run_id, result, mode=mode)
    if error:
        summary = f"{summary} error={error[:180]}"
    payload: dict[str, Any] = {
        "task": callback_task,
        "status": callback_status,
        "summary": summary,
        "duration_ms": int((time.time() - started) * 1000),
        "run_id": run_id,
        "attempt_id": execution_id,
    }
    if mode in {"oof_lifecycle", "forward_extension_resume"}:
        freshness = freshness or _oof_freshness_evidence(result)
        payload["metadata"] = {
            "oof_freshness": freshness,
            "cadence": cadence,
            "lifecycle_status": str(result.get("status") or "").lower(),
            "cohort_id": result.get("cohort_id"),
            "mode": mode,
            "continuation_attempt": continuation_attempt,
            "continuation_max_attempts": OOF_CONTINUATION_MAX_ATTEMPTS,
            "continuation_only": continuation_only,
            "prep_lifecycle": result.get("prep_lifecycle") if isinstance(result.get("prep_lifecycle"), dict) else {},
        }
        if result.get("dependency_retry_required"):
            payload["metadata"]["dependency_retry_reason"] = _dependency_retry_reason(result)
        calendar = result.get("calendar")
        calendar = calendar if isinstance(calendar, dict) else {}
        payload["run_date"] = end_date or str(calendar.get("cutoff") or "")[:10]
    elif mode == "semantic_reconcile_only":
        payload["metadata"] = {
            "mode": mode,
            "cohort_id": result.get("cohort_id"),
            "training_dispatched": False,
            "promotion_attempted": False,
            "serving_pointer_changed": False,
            "semantic_reconciliation": result.get("semantic_reconciliation") or {},
        }
    if end_date:
        payload["run_date"] = end_date
    if scheduler_ticket_id and scheduler_run_id:
        payload["scheduler_ticket_id"] = scheduler_ticket_id
        payload["scheduler_run_id"] = scheduler_run_id
    if error:
        payload["error"] = error
    await _callback_worker(payload)
    logger.info("[OofMaterializeJob] Finished %s", summary)
    return 0 if callback_status in {"success", "skipped", "triggered"} else 1


def main() -> None:
    raise SystemExit(asyncio.run(_run()))


if __name__ == "__main__":
    main()
