"""T+5 forward guard for the Fusion artifact that actually served.

This module never trains, promotes, or mutates a champion pointer.  It evaluates
the immutable Fusion payload copied into the learning-domain feature snapshot
and may only force the residual overlay to abstain back to canonical L4.
"""
from __future__ import annotations

import hashlib
import json
import math
from collections import defaultdict
from typing import Any, Callable

from services.d1_domain_client import D1DataDomain, client_for_domain
from services.l4_alpha_ev_resolver import (
    SNAPSHOT_BACKFILL_AS_OF_GUARD,
    SNAPSHOT_BACKFILL_SOURCE,
)
from services.expected_return_artifact_identity import expected_return_artifact_identity
from services.price_horizon_projection_contract import PRICE_HORIZONS_CTE


SCHEMA_VERSION = "expected-return-serving-forward-v1"
ROUNDTRIP_COST_BPS = 18.0
MIN_CROSS_SECTION_ROWS = 20
MIN_EVALUABLE_DATES = 5
DEGRADED_STREAK_TO_BYPASS = 3
PASS_STREAK_TO_RECOVER = 3


def _float_or_none(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str) or not value.strip():
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _pearson(left: list[float], right: list[float]) -> float | None:
    if len(left) != len(right) or len(left) < 2:
        return None
    left_mean = sum(left) / len(left)
    right_mean = sum(right) / len(right)
    left_delta = [value - left_mean for value in left]
    right_delta = [value - right_mean for value in right]
    denominator = math.sqrt(
        sum(value * value for value in left_delta)
        * sum(value * value for value in right_delta)
    )
    if denominator <= 0:
        return None
    return sum(a * b for a, b in zip(left_delta, right_delta, strict=True)) / denominator


def _top_bottom_spread(predictions: list[float], targets: list[float]) -> float | None:
    if len(predictions) != len(targets) or len(predictions) < 5:
        return None
    ordered = sorted(zip(predictions, targets, strict=True), key=lambda item: item[0])
    bucket = max(1, len(ordered) // 5)
    bottom = ordered[:bucket]
    top = ordered[-bucket:]
    return (
        sum(target for _, target in top) / len(top)
        - sum(target for _, target in bottom) / len(bottom)
    )


def _canonical_payload_checksum(value: dict[str, Any]) -> str:
    canonical = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def load_serving_forward_rows(
    query_fn: Callable[[str, list[Any]], list[dict[str, Any]]],
    *,
    as_of_date: str,
    lookback_days: int = 120,
    limit: int = 30000,
) -> list[dict[str, Any]]:
    return query_fn(
        f"""
        WITH {PRICE_HORIZONS_CTE}
        SELECT
            date(fs.snapshot_date) AS prediction_date,
            fs.stock_id,
            fs.symbol,
            fs.alpha_allocation,
            ph.outcome_known_date AS label_known_date,
            ((ph.exit_raw_close * ph.exit_adjustment_factor)
              / (ph.entry_raw_open * ph.entry_adjustment_factor)) - 1.0
              AS canonical_gross_return
        FROM allocator_ev_feature_snapshots fs
        JOIN price_horizons ph
          ON ph.stock_id = fs.stock_id
         AND ph.price_date = date(fs.snapshot_date)
        WHERE date(fs.snapshot_date) <= date(?)
          AND date(fs.snapshot_date) >= date(?, ?)
          AND date(ph.outcome_known_date) <= date(?)
          AND ph.entry_raw_open > 0
          AND ph.exit_raw_close > 0
          AND ph.entry_adjustment_factor > 0
          AND ph.exit_adjustment_factor > 0
          AND fs.snapshot_source = ?
          AND fs.as_of_guard = ?
          AND date(fs.source_recommendation_date) = date(fs.snapshot_date)
          AND fs.alpha_allocation IS NOT NULL
          AND json_valid(fs.alpha_allocation)
          AND json_type(fs.alpha_allocation, '$.recorded_serving_allocator_ev_fusion') = 'object'
        ORDER BY date(fs.snapshot_date), fs.symbol
        LIMIT ?
        """,
        [
            as_of_date,
            as_of_date,
            f"-{max(1, int(lookback_days))} days",
            as_of_date,
            SNAPSHOT_BACKFILL_SOURCE,
            SNAPSHOT_BACKFILL_AS_OF_GUARD,
            max(1, min(int(limit), 50000)),
        ],
    )


def _serving_observation(row: dict[str, Any]) -> dict[str, Any] | None:
    allocation = _dict(row.get("alpha_allocation"))
    fusion = _dict(allocation.get("recorded_serving_allocator_ev_fusion"))
    if not fusion:
        fusion = _dict(allocation.get("allocator_ev_fusion"))
    expected_checksum = str(
        allocation.get("recorded_serving_allocator_ev_fusion_checksum") or ""
    ).strip()
    if expected_checksum:
        try:
            if _canonical_payload_checksum(fusion) != expected_checksum:
                return None
        except (TypeError, ValueError):
            return None
    if (
        str(fusion.get("status") or "").lower() != "loaded"
        or str(fusion.get("overlay_status") or "").lower() != "applied"
        or fusion.get("primary_expected_return_allowed") is not True
    ):
        return None
    final_ev = _float_or_none(fusion.get("final_expected_return"))
    base_ev = _float_or_none(fusion.get("base_expected_return"))
    gross_return = _float_or_none(row.get("canonical_gross_return"))
    prediction_date = str(row.get("prediction_date") or "")[:10]
    label_known_date = str(row.get("label_known_date") or "")[:10]
    if final_ev is None or base_ev is None or gross_return is None or len(prediction_date) != 10:
        return None
    try:
        identity = expected_return_artifact_identity(fusion)
    except (TypeError, ValueError):
        return None
    explicit_artifact_id = str(fusion.get("artifact_id") or "").strip()
    explicit_fingerprint = str(fusion.get("model_fingerprint") or "").strip()
    if explicit_artifact_id and explicit_artifact_id != identity["artifact_id"]:
        return None
    if explicit_fingerprint and explicit_fingerprint != identity["model_fingerprint"]:
        return None
    return {
        "prediction_date": prediction_date,
        "label_known_date": label_known_date,
        "artifact_id": identity["artifact_id"],
        "model_fingerprint": identity["model_fingerprint"],
        "model_version": str(fusion.get("model_version") or "").strip(),
        "symbol": str(row.get("symbol") or ""),
        "final_expected_return": final_ev,
        "l4_expected_return": base_ev,
        "actual_net_return": gross_return - ROUNDTRIP_COST_BPS / 10000.0,
    }


def build_serving_forward_evaluations(
    rows: list[dict[str, Any]],
    *,
    min_cross_section_rows: int = MIN_CROSS_SECTION_ROWS,
) -> list[dict[str, Any]]:
    grouped: dict[tuple[str, str, str], list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        observation = _serving_observation(row)
        if observation is None:
            continue
        key = (
            observation["artifact_id"],
            observation["model_fingerprint"],
            observation["prediction_date"],
        )
        grouped[key].append(observation)

    evaluations: list[dict[str, Any]] = []
    for (artifact_id, fingerprint, prediction_date), observations in sorted(grouped.items()):
        final_values = [row["final_expected_return"] for row in observations]
        l4_values = [row["l4_expected_return"] for row in observations]
        targets = [row["actual_net_return"] for row in observations]
        final_corr = _pearson(final_values, targets)
        l4_corr = _pearson(l4_values, targets)
        final_spread = _top_bottom_spread(final_values, targets)
        l4_spread = _top_bottom_spread(l4_values, targets)
        corr_delta = None if final_corr is None or l4_corr is None else final_corr - l4_corr
        spread_delta = (
            None if final_spread is None or l4_spread is None
            else final_spread - l4_spread
        )
        if (
            len(observations) < min_cross_section_rows
            or corr_delta is None
            or spread_delta is None
        ):
            quality = "INSUFFICIENT"
        elif corr_delta < 0 and spread_delta < 0:
            quality = "DEGRADED"
        else:
            quality = "PASS"
        identity_text = f"{artifact_id}|{fingerprint}|{prediction_date}"
        evaluations.append({
            "schema_version": SCHEMA_VERSION,
            "evaluation_id": hashlib.sha256(identity_text.encode("utf-8")).hexdigest(),
            "prediction_date": prediction_date,
            "label_known_date": max(row["label_known_date"] for row in observations),
            "artifact_id": artifact_id,
            "model_fingerprint": fingerprint,
            "model_version": observations[0]["model_version"],
            "sample_count": len(observations),
            "final_corr": final_corr,
            "l4_corr": l4_corr,
            "corr_delta": corr_delta,
            "final_spread": final_spread,
            "l4_spread": l4_spread,
            "spread_delta": spread_delta,
            "quality_decision": quality,
            "roundtrip_cost_bps": ROUNDTRIP_COST_BPS,
        })
    return evaluations


def _trailing_streak(evaluations: list[dict[str, Any]], quality: str) -> int:
    count = 0
    for evaluation in reversed(evaluations):
        if evaluation["quality_decision"] != quality:
            break
        count += 1
    return count


def derive_forward_guard_state(
    evaluations: list[dict[str, Any]],
    previous_state: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    evaluable = [
        row for row in evaluations
        if row.get("quality_decision") in {"PASS", "DEGRADED"}
    ]
    if not evaluable:
        return None
    latest = max(evaluable, key=lambda row: row["prediction_date"])
    same_identity = sorted(
        (
            row for row in evaluable
            if row["artifact_id"] == latest["artifact_id"]
            and row["model_fingerprint"] == latest["model_fingerprint"]
        ),
        key=lambda row: row["prediction_date"],
    )
    degraded_streak = _trailing_streak(same_identity, "DEGRADED")
    recovery_streak = _trailing_streak(same_identity, "PASS")
    previous_matches = bool(
        previous_state
        and previous_state.get("artifact_id") == latest["artifact_id"]
        and previous_state.get("model_fingerprint") == latest["model_fingerprint"]
    )
    previously_active = bool(
        previous_matches and previous_state.get("state") == "residual_bypass"
    )
    if previously_active and recovery_streak < PASS_STREAK_TO_RECOVER:
        state = "residual_bypass"
        reason = "persistent_degradation_guard_awaiting_three_date_recovery"
    elif previously_active:
        state = "monitoring"
        reason = "three_consecutive_forward_dates_recovered"
    elif (
        len(same_identity) >= MIN_EVALUABLE_DATES
        and degraded_streak >= DEGRADED_STREAK_TO_BYPASS
    ):
        state = "residual_bypass"
        reason = "three_consecutive_jointly_inferior_forward_dates"
    else:
        state = "monitoring"
        reason = (
            "single_or_nonpersistent_degradation_warning"
            if degraded_streak
            else "serving_forward_quality_not_persistently_degraded"
        )
    return {
        "schema_version": SCHEMA_VERSION,
        "model_name": "allocator_ev_fusion",
        "artifact_id": latest["artifact_id"],
        "model_fingerprint": latest["model_fingerprint"],
        "model_version": latest["model_version"],
        "state": state,
        "evaluable_date_count": len(same_identity),
        "degraded_streak": degraded_streak,
        "recovery_streak": recovery_streak,
        "last_prediction_date": same_identity[-1]["prediction_date"],
        "last_quality_decision": same_identity[-1]["quality_decision"],
        "reason": reason,
    }


def _load_previous_state(
    query_fn: Callable[[str, list[Any]], list[dict[str, Any]]],
) -> dict[str, Any] | None:
    rows = query_fn(
        """
        SELECT model_name, artifact_id, model_fingerprint, model_version, state,
               evaluable_date_count, degraded_streak, recovery_streak,
               last_prediction_date, evidence_json, updated_at
          FROM expected_return_forward_guard_state
         WHERE model_name = 'allocator_ev_fusion'
         LIMIT 1
        """,
        [],
    )
    return rows[0] if rows else None


def _persist_evaluations_and_state(
    evaluations: list[dict[str, Any]],
    state: dict[str, Any],
    batch_execute_fn: Callable[[list[tuple[str, list[Any]]]], dict[str, Any]],
) -> dict[str, Any]:
    statements: list[tuple[str, list[Any]]] = []
    for row in evaluations:
        evidence_json = json.dumps(row, ensure_ascii=False, sort_keys=True, allow_nan=False)
        statements.append((
            """
            INSERT INTO expected_return_serving_forward_evaluations (
                evaluation_id, prediction_date, label_known_date, model_name,
                artifact_id, model_fingerprint, model_version, sample_count,
                final_corr, l4_corr, corr_delta, final_spread, l4_spread,
                spread_delta, quality_decision, evidence_json, updated_at
            ) VALUES (?, ?, ?, 'allocator_ev_fusion', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(artifact_id, model_fingerprint, prediction_date) DO UPDATE SET
                evaluation_id=excluded.evaluation_id,
                label_known_date=excluded.label_known_date,
                model_version=excluded.model_version,
                sample_count=excluded.sample_count,
                final_corr=excluded.final_corr,
                l4_corr=excluded.l4_corr,
                corr_delta=excluded.corr_delta,
                final_spread=excluded.final_spread,
                l4_spread=excluded.l4_spread,
                spread_delta=excluded.spread_delta,
                quality_decision=excluded.quality_decision,
                evidence_json=excluded.evidence_json,
                updated_at=CURRENT_TIMESTAMP
            """,
            [
                row["evaluation_id"], row["prediction_date"], row["label_known_date"],
                row["artifact_id"], row["model_fingerprint"], row["model_version"],
                row["sample_count"], row["final_corr"], row["l4_corr"], row["corr_delta"],
                row["final_spread"], row["l4_spread"], row["spread_delta"],
                row["quality_decision"], evidence_json,
            ],
        ))
    state_json = json.dumps(state, ensure_ascii=False, sort_keys=True, allow_nan=False)
    statements.append((
        """
        INSERT INTO expected_return_forward_guard_state (
            model_name, artifact_id, model_fingerprint, model_version, state,
            evaluable_date_count, degraded_streak, recovery_streak,
            last_prediction_date, evidence_json, updated_at
        ) VALUES ('allocator_ev_fusion', ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(model_name) DO UPDATE SET
            artifact_id=excluded.artifact_id,
            model_fingerprint=excluded.model_fingerprint,
            model_version=excluded.model_version,
            state=excluded.state,
            evaluable_date_count=excluded.evaluable_date_count,
            degraded_streak=excluded.degraded_streak,
            recovery_streak=excluded.recovery_streak,
            last_prediction_date=excluded.last_prediction_date,
            evidence_json=excluded.evidence_json,
            updated_at=CURRENT_TIMESTAMP
        """,
        [
            state["artifact_id"], state["model_fingerprint"], state["model_version"],
            state["state"], state["evaluable_date_count"], state["degraded_streak"],
            state["recovery_streak"], state["last_prediction_date"], state_json,
        ],
    ))
    return batch_execute_fn(statements)


def evaluate_serving_forward_guard(
    *,
    as_of_date: str,
    query_fn: Callable[[str, list[Any]], list[dict[str, Any]]] | None = None,
    batch_execute_fn: Callable[[list[tuple[str, list[Any]]]], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    learning_client = client_for_domain(D1DataDomain.LEARNING)
    query = query_fn or learning_client.query
    writer = batch_execute_fn or learning_client.batch_execute
    rows = load_serving_forward_rows(query, as_of_date=as_of_date)
    evaluations = build_serving_forward_evaluations(rows)
    try:
        previous_state = _load_previous_state(query)
    except Exception as exc:
        if "no such table" not in str(exc).lower():
            raise
        previous_state = None
    state = derive_forward_guard_state(evaluations, previous_state)
    if state is None:
        return {
            "schema_version": SCHEMA_VERSION,
            "status": "no_evaluable_primary_fusion_serving_rows",
            "as_of_date": as_of_date,
            "evaluation_count": 0,
            "state_changed": False,
        }
    same_identity = [
        row for row in evaluations
        if row["artifact_id"] == state["artifact_id"]
        and row["model_fingerprint"] == state["model_fingerprint"]
    ]
    persistence = _persist_evaluations_and_state(same_identity, state, writer)
    return {
        "schema_version": SCHEMA_VERSION,
        "status": "ready",
        "as_of_date": as_of_date,
        "evaluation_count": len(same_identity),
        "state": state,
        "persistence": persistence,
    }


def load_allocator_ev_fusion_forward_guard(
    artifact: dict[str, Any] | None,
    *,
    query_fn: Callable[[str, list[Any]], list[dict[str, Any]]] | None = None,
) -> dict[str, Any]:
    base = {
        "schema_version": SCHEMA_VERSION,
        "action": "monitor",
        "lineage_bound": False,
        "reason": "artifact_missing",
    }
    if not isinstance(artifact, dict):
        return base
    try:
        identity = expected_return_artifact_identity(artifact)
    except (TypeError, ValueError) as exc:
        return {**base, "reason": str(exc)}
    query = query_fn or client_for_domain(D1DataDomain.LEARNING).query
    try:
        state = _load_previous_state(query)
    except Exception as exc:
        return {
            **base,
            **identity,
            "reason": (
                "forward_guard_schema_missing"
                if "no such table" in str(exc).lower()
                else f"forward_guard_read_failed:{type(exc).__name__}"
            ),
        }
    if not state:
        return {**base, **identity, "reason": "forward_guard_state_missing"}
    exact = (
        state.get("artifact_id") == identity["artifact_id"]
        and state.get("model_fingerprint") == identity["model_fingerprint"]
    )
    if not exact:
        return {
            **base,
            **identity,
            "reason": "forward_guard_artifact_identity_mismatch",
            "state_artifact_id": state.get("artifact_id"),
            "state_model_fingerprint": state.get("model_fingerprint"),
        }
    return {
        "schema_version": SCHEMA_VERSION,
        **identity,
        "action": "residual_bypass" if state.get("state") == "residual_bypass" else "monitor",
        "lineage_bound": True,
        "reason": state.get("reason") or state.get("state"),
        "state": state.get("state"),
        "evaluable_date_count": int(state.get("evaluable_date_count") or 0),
        "degraded_streak": int(state.get("degraded_streak") or 0),
        "recovery_streak": int(state.get("recovery_streak") or 0),
        "last_prediction_date": state.get("last_prediction_date"),
    }
