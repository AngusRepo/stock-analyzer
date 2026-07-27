"""Point-in-time S12 structure continuation for intraday Potential Buy.

This service never recomputes prior-evening L4 inputs and never submits orders.
It combines the frozen source-date recommendation evidence with the current
S12 structure, then reuses the production expected-return resolver and gate.
"""
from __future__ import annotations

import json
import math
import uuid
from typing import Any, Callable

from services import d1_client
from services.recommendation_service import (
    _can_promote_ranking_candidate,
    _row_expected_return_with_source,
    _score_v2_seed_inputs_from_payload,
)
from services.s12_trade_ev_bootstrap import S12TradeEvBootstrapProvider
from services.trading_config_loader import load_merged_trading_config_with_contract

QueryFn = Callable[[str, list[Any] | None], list[dict[str, Any]]]
WriteFn = Callable[[list[tuple[str, list[Any]]]], dict[str, Any]]


def _json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    if not isinstance(value, str) or not value.strip():
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _finite(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _structure_class(row: dict[str, Any]) -> str:
    state = str(row.get("state") or "").strip().lower()
    if bool(row.get("invalidated")) or state == "invalidated":
        return "invalidated"
    if not state or state == "data_unavailable":
        return "unavailable"
    if state in {"waiting_session_60m_bearish_risk", "bearish_defense_ready"}:
        return "risk_blocked"
    if bool(row.get("ready")) and state in {"reaction_ready", "limited_takeover_ready"}:
        return "execution_ready"
    return "setup_waiting"


def _source_trade_date(row: dict[str, Any]) -> str | None:
    raw = _json_object(row.get("raw_json"))
    metadata = raw.get("runtimeMetadata") if isinstance(raw.get("runtimeMetadata"), dict) else {}
    value = str(metadata.get("source_trade_date") or "").strip()[:10]
    return value if len(value) == 10 else None


def _load_watch_rows(query_fn: QueryFn, observation_date: str) -> list[dict[str, Any]]:
    return query_fn(
        """
        SELECT id, trade_date, symbol, source, state, ready, invalidated,
               entry_context_json, exit_plan_json, raw_json, updated_at
          FROM s12_structure_snapshots
         WHERE date(trade_date)=date(?)
           AND source='s12_intraday_setup_watch'
         ORDER BY symbol, datetime(updated_at) DESC, id DESC
        """.strip(),
        [observation_date],
    )


def _load_frozen_candidates(
    query_fn: QueryFn,
    source_trade_date: str,
    symbols: list[str],
) -> dict[str, dict[str, Any]]:
    if not symbols:
        return {}
    out: dict[str, dict[str, Any]] = {}
    for offset in range(0, len(symbols), 80):
        chunk = symbols[offset:offset + 80]
        placeholders = ",".join("?" for _ in chunk)
        rows = query_fn(
            f"""
            WITH latest_prediction AS (
              SELECT p.*,
                     ROW_NUMBER() OVER (
                       PARTITION BY p.stock_id
                       ORDER BY datetime(p.generated_at) DESC, p.id DESC
                     ) rn
                FROM predictions p
               WHERE date(p.prediction_date)=date(?)
                 AND p.model_name='ensemble'
                 AND date(datetime(p.generated_at, '+8 hours'))<=date(?)
            )
            SELECT dr.*, p.forecast_data, p.generated_at prediction_generated_at
              FROM daily_recommendations dr
              JOIN stocks st ON st.id=dr.stock_id
              LEFT JOIN latest_prediction p ON p.stock_id=dr.stock_id AND p.rn=1
             WHERE date(dr.date)=date(?)
               AND dr.symbol IN ({placeholders})
            """.strip(),
            [source_trade_date, source_trade_date, source_trade_date, *chunk],
        )
        for raw in rows or []:
            row = dict(raw)
            for key in ("score_components", "alpha_context", "alpha_allocation", "forecast_data"):
                row[key] = _json_object(row.get(key))
            ml_score = _finite(row.get("ml_score"))
            row["score_seed_inputs"] = (
                _score_v2_seed_inputs_from_payload(row.get("score_components"), ml_score=ml_score)
                if ml_score is not None
                else None
            )
            allocation = row.get("alpha_allocation") or {}
            forecast = row.get("forecast_data") or {}
            ensemble = forecast.get("ensemble_v2") if isinstance(forecast.get("ensemble_v2"), dict) else {}
            for key in ("l4_alpha_ev", "allocator_ev_fusion", "s12_trade_ev"):
                payload = allocation.get(key)
                if isinstance(payload, dict):
                    row[key] = payload
            row["ensemble_v2"] = ensemble
            symbol = str(row.get("symbol") or "").strip()
            if symbol:
                out[symbol] = row
    return out


def materialize_s12_formal_ev_decisions(
    *,
    observation_date: str,
    producer_run_id: str,
    query_fn: QueryFn = d1_client.query,
    write_fn: WriteFn = d1_client.batch_execute,
) -> dict[str, Any]:
    config_result = load_merged_trading_config_with_contract()
    config = config_result.config
    ranking_config = config.get("ranking") if isinstance(config.get("ranking"), dict) else {}
    alpha_policy = config.get("alphaFramework") if isinstance(config.get("alphaFramework"), dict) else {}
    watch_rows = _load_watch_rows(query_fn, observation_date)
    latest_by_symbol: dict[str, dict[str, Any]] = {}
    for row in watch_rows:
        symbol = str(row.get("symbol") or "").strip()
        if symbol and symbol not in latest_by_symbol:
            latest_by_symbol[symbol] = dict(row)
    grouped: dict[str, list[dict[str, Any]]] = {}
    for row in latest_by_symbol.values():
        source_date = _source_trade_date(row)
        if source_date:
            grouped.setdefault(source_date, []).append(row)

    statements: list[tuple[str, list[Any]]] = []
    action_counts = {"potential_buy": 0, "hold": 0, "abstain": 0}
    reason_counts: dict[str, int] = {}
    owner_counts: dict[str, int] = {}
    for source_date, structures in sorted(grouped.items()):
        symbols = [str(row.get("symbol") or "") for row in structures]
        frozen = _load_frozen_candidates(query_fn, source_date, symbols)
        provider = S12TradeEvBootstrapProvider.for_run_date(
            observation_date,
            query_fn=query_fn,
        )
        for structure in structures:
            symbol = str(structure.get("symbol") or "").strip()
            structure_class = _structure_class(structure)
            candidate = dict(frozen.get(symbol) or {})
            state = str(structure.get("state") or "data_unavailable")
            expected_return: float | None = None
            uncertainty_adjusted: float | None = None
            owner: str | None = None
            s12_status = "not_evaluated"
            action = "abstain"
            reason = "frozen_source_candidate_missing"
            evidence: dict[str, Any] = {
                "schema_version": "s12-formal-ev-decision-evidence-v1",
                "point_in_time_policy": "frozen_prior_evening_evidence_plus_current_s12_structure",
                "direct_execution_allowed": False,
                "config_contract": config_result.contract.to_dict(),
                "structure_class": structure_class,
                "structure_state": state,
                "source_trade_date": source_date,
                "observation_date": observation_date,
            }
            if candidate:
                prediction = candidate.get("forecast_data") if isinstance(candidate.get("forecast_data"), dict) else {}
                s12_payload = provider.build_for_row(candidate, prediction=prediction)
                candidate["s12_trade_ev"] = s12_payload
                s12_status = str(s12_payload.get("status") or "missing")
                score_components = candidate.get("score_components")
                score_components = score_components if isinstance(score_components, dict) else {}
                if str(score_components.get("reason") or "") == "formal_ml_gate_filtered":
                    action = "abstain"
                    reason = "frozen_source_formal_ml_gate_filtered"
                    source = "formal_ml_gate_filtered"
                    resolver = {}
                    can_promote = False
                elif not isinstance(candidate.get("score_seed_inputs"), dict):
                    action = "abstain"
                    reason = "frozen_source_score_v2_seed_missing"
                    source = "missing"
                    resolver = {}
                    can_promote = False
                else:
                    resolved, source = _row_expected_return_with_source(
                        candidate,
                        alpha_policy=alpha_policy,
                    )
                    uncertainty_adjusted = _finite(resolved)
                    expected_return = uncertainty_adjusted
                    resolver = candidate.get("_allocator_edge_resolver")
                    resolver = resolver if isinstance(resolver, dict) else {}
                    owner = str(resolver.get("expected_return_owner") or "").strip() or None
                    can_promote = _can_promote_ranking_candidate(
                        candidate,
                        ranking_config,
                        alpha_policy=alpha_policy,
                    )
                if reason in {
                    "frozen_source_formal_ml_gate_filtered",
                    "frozen_source_score_v2_seed_missing",
                }:
                    pass
                elif structure_class != "execution_ready":
                    action = "hold" if structure_class == "setup_waiting" else "abstain"
                    reason = f"s12_structure_{structure_class}:{state}"
                elif owner == "risk_abstention":
                    action = "abstain"
                    reason = "no_validated_expected_return_owner"
                elif uncertainty_adjusted is None or uncertainty_adjusted <= 0:
                    action = "hold"
                    reason = "nonpositive_uncertainty_adjusted_expected_return"
                elif can_promote:
                    action = "potential_buy"
                    reason = "positive_formal_ev_after_s12_execution_ready"
                else:
                    action = "hold"
                    reason = str(candidate.get("promotion_blocked_reason") or "production_promotion_gate_failed")
                evidence.update({
                    "expected_return_source": source,
                    "expected_return_owner": owner,
                    "score_v2_contract": {
                        "version": score_components.get("version"),
                        "reason": score_components.get("reason"),
                        "eligible_for_allocation": score_components.get("eligibleForAllocation"),
                    },
                    "allocator_edge_resolver": resolver,
                    "promotion_blocked_reason": candidate.get("promotion_blocked_reason"),
                    "s12_trade_ev": s12_payload,
                    "l4_alpha_ev": candidate.get("l4_alpha_ev"),
                    "allocator_ev_fusion": candidate.get("allocator_ev_fusion"),
                    "prediction_generated_at": candidate.get("prediction_generated_at"),
                })
            decision_id = f"s12-formal-ev:{observation_date}:{source_date}:{symbol}:{uuid.uuid5(uuid.NAMESPACE_URL, producer_run_id + ':' + symbol).hex[:16]}"
            statements.append((
                """
                INSERT INTO s12_formal_ev_decisions (
                  decision_id, observation_date, source_trade_date, symbol,
                  structure_snapshot_id, structure_state, structure_class,
                  s12_ev_status, expected_return_owner, expected_return,
                  uncertainty_adjusted_expected_return, action, reason_code,
                  l4_model_version, fusion_model_version, s12_artifact_id,
                  producer_run_id, evidence_json, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(observation_date, source_trade_date, symbol, producer_run_id) DO UPDATE SET
                  structure_snapshot_id=excluded.structure_snapshot_id,
                  structure_state=excluded.structure_state,
                  structure_class=excluded.structure_class,
                  s12_ev_status=excluded.s12_ev_status,
                  expected_return_owner=excluded.expected_return_owner,
                  expected_return=excluded.expected_return,
                  uncertainty_adjusted_expected_return=excluded.uncertainty_adjusted_expected_return,
                  action=excluded.action,
                  reason_code=excluded.reason_code,
                  l4_model_version=excluded.l4_model_version,
                  fusion_model_version=excluded.fusion_model_version,
                  s12_artifact_id=excluded.s12_artifact_id,
                  evidence_json=excluded.evidence_json,
                  updated_at=CURRENT_TIMESTAMP
                """.strip(),
                [
                    decision_id,
                    observation_date,
                    source_date,
                    symbol,
                    structure.get("id"),
                    state,
                    structure_class,
                    s12_status,
                    owner,
                    expected_return,
                    uncertainty_adjusted,
                    action,
                    reason,
                    ((evidence.get("l4_alpha_ev") or {}).get("model_version")
                     if isinstance(evidence.get("l4_alpha_ev"), dict) else None),
                    ((evidence.get("allocator_ev_fusion") or {}).get("model_version")
                     if isinstance(evidence.get("allocator_ev_fusion"), dict) else None),
                    ((evidence.get("s12_trade_ev") or {}).get("artifact_id")
                     if isinstance(evidence.get("s12_trade_ev"), dict) else None),
                    producer_run_id,
                    json.dumps(evidence, ensure_ascii=False, separators=(",", ":")),
                ],
            ))
            action_counts[action] += 1
            reason_counts[reason] = reason_counts.get(reason, 0) + 1
            owner_key = owner or "missing"
            owner_counts[owner_key] = owner_counts.get(owner_key, 0) + 1

    write_result = write_fn(statements) if statements else {
        "success_count": 0, "error_count": 0,
    }
    if int(write_result.get("error_count") or 0) > 0:
        raise RuntimeError(f"s12_formal_ev_partial_write:{write_result}")
    return {
        "schema_version": "s12-formal-ev-materialization-summary-v1",
        "observation_date": observation_date,
        "producer_run_id": producer_run_id,
        "watch_rows": len(latest_by_symbol),
        "source_dates": sorted(grouped),
        "written": len(statements),
        "action_counts": action_counts,
        "reason_counts": reason_counts,
        "owner_counts": owner_counts,
        "direct_execution_allowed": False,
    }
