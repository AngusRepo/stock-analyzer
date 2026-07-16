from __future__ import annotations

import argparse
import copy
import json
import math
import sys
from collections import Counter, defaultdict
from datetime import date, timedelta
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services import d1_client  # noqa: E402
from services.active_model_policy import ACTIVE_ALPHA_MODELS  # noqa: E402
from services.active8_score_semantics import normalize_active8_cross_sectional_scores  # noqa: E402
from services.allocator_ev_fusion_artifact_builder import (  # noqa: E402
    build_allocator_ev_fusion_artifact_from_rows,
    load_allocator_ev_fusion_training_rows,
)
from services.l4_alpha_ev_artifact_builder import (  # noqa: E402
    build_l4_alpha_ev_artifact_from_rows,
    load_l4_alpha_ev_training_rows,
)
from services.l4_alpha_ev_producer import materialize_l4_alpha_ev  # noqa: E402
from services.ensemble_v2 import attach_ensemble_v2, build_formal_model_input_contract  # noqa: E402
from services.model_lifecycle_policy import resolve_degraded_dampening  # noqa: E402
from services.model_ic_tracker import compute_weekly_ic_from_rows  # noqa: E402
from services.opb_counterfactual_prior import (  # noqa: E402
    build_opb_arm_prior_artifact,
    load_opb_counterfactual_inputs,
)
from services.allocator_ev_feature_snapshot_backfill import (  # noqa: E402
    build_allocator_ev_feature_snapshots_for_date,
)
from services.ev_lineage_contract import (  # noqa: E402
    load_model_champion_history,
    prediction_timing_blockers,
    reconstruct_rows_with_point_in_time_lineage,
)
from services.recommendation_service import (  # noqa: E402
    apply_sparse_tangent_allocation,
    load_online_portfolio_bandit_reward_ledger,
)
from services.s12_trade_ev_bootstrap import (  # noqa: E402
    S12_REPLAY_ENGINE_SIGNATURE,
    S12TradeEvBootstrapProvider,
    _replay_cohort_signature,
)
from services.trading_config_loader import load_merged_trading_config  # noqa: E402


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


def _finite(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _apply_s12_structure_overlay(
    rows: list[dict[str, Any]],
    *,
    run_date: str,
    overlay_path: str,
) -> dict[str, Any]:
    document = json.loads(Path(overlay_path).read_text(encoding="utf-8"))
    assessments = document.get("rows") if isinstance(document, dict) else None
    if not isinstance(assessments, list):
        raise ValueError("S12 structure overlay requires a rows array")

    snapshots: dict[str, dict[str, Any]] = {}
    for raw in assessments:
        if not isinstance(raw, dict):
            continue
        symbol = str(raw.get("symbol") or "").strip()
        state = str(raw.get("state") or "").strip()
        if not symbol or not state:
            continue
        execution = raw.get("execution") if isinstance(raw.get("execution"), dict) else {}
        exit_plan = raw.get("exitPlan") if isinstance(raw.get("exitPlan"), dict) else {}
        ready = bool(raw.get("ready"))
        calibration = "uncalibrated"
        snapshots[symbol] = {
            "symbol": symbol,
            "entry_price": _finite(execution.get("entryPrice")),
            "s12_structure_stop": _finite(execution.get("stopLoss")),
            "s12_target1": _finite(execution.get("target1")),
            "s12_target2": _finite(execution.get("target2")),
            "s12_state": state,
            "s12_ready": ready,
            "s12_detail": raw.get("detail"),
            "s12_structure_snapshot": {
                "trade_date": run_date,
                "source": "local_frozen_s12_structure_overlay",
            },
            "s12_replay_lineage": {
                "replay_engine_signature": S12_REPLAY_ENGINE_SIGNATURE,
                "entry_policy_signature": state.lower(),
                "exit_calibration_signature": calibration,
                "replay_cohort_signature": _replay_cohort_signature(state, calibration),
            },
            "s12_structure": {
                "state": state,
                "ready": ready,
                "detail": raw.get("detail"),
                "exitPlan": exit_plan,
            },
            "canonical_trade_lifecycle": {
                "entry": {
                    "s12": {
                        "state": state,
                        "ready": ready,
                        "detail": raw.get("detail"),
                        "structureStop": _finite(execution.get("stopLoss")),
                        "exitPlan": {
                            "tp1": _finite(execution.get("target1")),
                            "mainExit": _finite(execution.get("target2")),
                            "trailingInitial": _finite(execution.get("stopLoss")),
                        },
                    }
                }
            },
        }

    provider = S12TradeEvBootstrapProvider.for_run_date(run_date)
    provider.structure_snapshots = snapshots
    status_counts: Counter[str] = Counter()
    source_counts: Counter[str] = Counter()
    positive = 0
    for row in rows:
        prediction = {
            "ensemble_v2": row.get("ensemble_v2"),
            "alpha_context": row.get("alpha_context"),
            "forecast_data": row.get("forecast_data"),
        }
        payload = provider.build_for_row(row, prediction=prediction)
        row["s12_trade_ev"] = payload
        row["trade_expected_return_net_pct"] = payload.get("trade_expected_return_net_pct")
        row["trade_expected_return_source"] = payload.get("trade_expected_return_source")
        status_counts[str(payload.get("status") or "missing")] += 1
        source_counts[str(payload.get("trade_expected_return_source") or payload.get("source") or "missing")] += 1
        expected_return = _finite(payload.get("trade_expected_return_net_pct"))
        if expected_return is not None and expected_return > 0:
            positive += 1
    return {
        "schema_version": "local-s12-structure-overlay-audit-v1",
        "path": str(Path(overlay_path)),
        "assessment_rows": len(assessments),
        "snapshot_rows": len(snapshots),
        "provider": provider.summary(),
        "status_counts": dict(status_counts),
        "source_counts": dict(source_counts),
        "positive_expected_return_rows": positive,
    }


def _load_candidate_rows(run_date: str, *, next_session_date: str | None = None) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    rows = d1_client.query(
        """
        SELECT dr.*, s.symbol, s.name, p.forecast_data,
               p.generated_at AS prediction_generated_at
        FROM daily_recommendations dr
        JOIN stocks s ON s.id = dr.stock_id
        JOIN predictions p
          ON p.stock_id = dr.stock_id
         AND p.prediction_date = dr.date
         AND p.model_name = 'ensemble'
        WHERE date(dr.date) = date(?)
        ORDER BY dr.score DESC, s.symbol ASC
        """,
        [run_date],
    )
    normalized: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    for raw in rows:
        score_components = _loads(raw.get("score_components"))
        score_version = str(score_components.get("version") or "").strip()
        if int(raw.get("eligible_for_ml") or 0) != 1 or score_version != "score_v2":
            rejected.append({
                "symbol": str(raw.get("symbol") or ""),
                "blockers": ["not_canonical_score_v2_candidate"],
                "eligible_for_ml": int(raw.get("eligible_for_ml") or 0),
                "score_version": score_version or None,
            })
            continue
        timing_row = {
            "prediction_date": run_date,
            "prediction_generated_at": raw.get("prediction_generated_at"),
            "next_session_open_at": f"{next_session_date}T01:00:00Z" if next_session_date else None,
        }
        blockers = prediction_timing_blockers(timing_row)
        if blockers:
            rejected.append({
                "symbol": str(raw.get("symbol") or ""),
                "prediction_generated_at": raw.get("prediction_generated_at"),
                "blockers": blockers,
            })
            continue
        allocation = _loads(raw.get("alpha_allocation"))
        forecast = _loads(raw.get("forecast_data"))
        alpha_context = _loads(raw.get("alpha_context"))
        s12 = allocation.get("s12_trade_ev") if isinstance(allocation.get("s12_trade_ev"), dict) else None
        row = {
            **raw,
            "forecast_data": forecast,
            "ensemble_v2": forecast.get("ensemble_v2") if isinstance(forecast.get("ensemble_v2"), dict) else {},
            "historical_ensemble_v2": copy.deepcopy(
                forecast.get("ensemble_v2") if isinstance(forecast.get("ensemble_v2"), dict) else {}
            ),
            "score_components": score_components,
            "alpha_context": alpha_context,
            "alpha_allocation": {},
            "historical_alpha_allocation": allocation,
            "historical_signal": raw.get("signal"),
            "historical_allocation_weight": raw.get("allocation_weight"),
            "s12_trade_ev": s12,
            "trade_expected_return_net_pct": (s12 or {}).get("trade_expected_return_net_pct"),
            "trade_expected_return_source": (s12 or {}).get("trade_expected_return_source"),
            "confidence": raw.get("confidence") or (forecast.get("ensemble_v2") or {}).get("confidence"),
        }
        for key in ("l4_alpha_ev", "alpha_ev", "alpha_ev_prediction", "allocator_ev_fusion"):
            row.pop(key, None)
            if isinstance(row.get("ensemble_v2"), dict):
                row["ensemble_v2"].pop(key, None)
            row["forecast_data"].pop(key, None)
        normalized.append(row)
    return normalized, {
        "schema_version": "local-frozen-upstream-lineage-audit-v1",
        "run_date": run_date,
        "next_session_date": next_session_date,
        "next_session_evidence": "actual_next_session_verified_not_model_input" if next_session_date else "missing",
        "next_session_evidence_role": "event_time_audit_only_not_feature_or_label",
        "source_rows": len(rows),
        "eligible_rows": len(normalized),
        "rejected_rows": len(rejected),
        "rejected": rejected,
    }


def _load_active_model_outputs(run_date: str) -> dict[str, dict[str, Any]]:
    placeholders = ",".join("?" for _ in ACTIVE_ALPHA_MODELS)
    rows = d1_client.query(
        f"""
        SELECT s.symbol, p.model_name, p.forecast_data
        FROM predictions p
        JOIN stocks s ON s.id = p.stock_id
        WHERE date(p.prediction_date) = date(?)
          AND p.model_name IN ({placeholders})
        ORDER BY s.symbol ASC, p.model_name ASC
        """,
        [run_date, *ACTIVE_ALPHA_MODELS],
    )
    outputs: dict[str, dict[str, Any]] = {}
    sequence_keys = {
        "DLinear": "dlinear",
        "PatchTST": "patchtst",
        "iTransformer": "itransformer",
    }
    for row in rows:
        symbol = str(row.get("symbol") or "").strip()
        model_name = str(row.get("model_name") or "").strip()
        payload = _loads(row.get("forecast_data"))
        rank = _finite(payload.get("rank_score"))
        if not symbol or model_name not in ACTIVE_ALPHA_MODELS or rank is None:
            continue
        prediction = outputs.setdefault(symbol, {"rank_scores": {}})
        if model_name in sequence_keys:
            signal = payload.get("model_signal") if isinstance(payload.get("model_signal"), dict) else {}
            forecast_pct = _finite(signal.get("forecast_pct", payload.get("forecast_pct")))
            if forecast_pct is not None:
                prediction[sequence_keys[model_name]] = {**signal, "forecast_pct": forecast_pct}
            prediction["rank_scores"][model_name] = rank
        else:
            prediction["rank_scores"][model_name] = rank
    return outputs


def _active8_eligible_rows(
    rows: list[dict[str, Any]],
    outputs: dict[str, dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    eligible: list[dict[str, Any]] = []
    excluded: list[dict[str, Any]] = []
    for row in rows:
        symbol = str(row.get("symbol") or "")
        contract = build_formal_model_input_contract(outputs.get(symbol))
        row["formal_layer3_contract"] = contract
        if contract["complete"]:
            eligible.append(row)
        else:
            excluded.append({
                "symbol": symbol,
                "missing_models": contract["missing_models"],
                "lineage_blockers": contract.get("lineage_blockers") or [],
            })
    return eligible, excluded


def _rank_distribution(outputs: dict[str, dict[str, Any]]) -> dict[str, dict[str, float | int | None]]:
    summary: dict[str, dict[str, float | int | None]] = {}
    for model_name in ACTIVE_ALPHA_MODELS:
        values = [
            rank
            for prediction in outputs.values()
            if (rank := _finite((prediction.get("rank_scores") or {}).get(model_name))) is not None
        ]
        mean = sum(values) / len(values) if values else None
        variance = (
            sum((value - mean) ** 2 for value in values) / len(values)
            if values and mean is not None
            else None
        )
        summary[model_name] = {
            "rows": len(values),
            "minimum": min(values) if values else None,
            "maximum": max(values) if values else None,
            "mean": mean,
            "stddev": math.sqrt(variance) if variance is not None else None,
        }
    return summary


def _attach_current_active8_ensemble(
    rows: list[dict[str, Any]],
    outputs: dict[str, dict[str, Any]],
    config: dict[str, Any],
    run_date: str,
) -> dict[str, Any]:
    import os
    from google.cloud import storage

    bucket_name = str(os.environ.get("GCS_BUCKET_NAME") or "").strip()
    if not bucket_name:
        raise RuntimeError("GCS_BUCKET_NAME missing for model-pool replay")
    blob = storage.Client().bucket(bucket_name).blob("universal/model_pool.json")
    if not blob.exists():
        raise RuntimeError("universal/model_pool.json missing")
    pool = json.loads(blob.download_as_text().lstrip("\ufeff"))
    model_status: dict[str, str] = {}
    artifact_versions: dict[str, str] = {}
    artifact_target_semantics: dict[str, str] = {}
    for model_name in ACTIVE_ALPHA_MODELS:
        entry = (pool.get("models") or {}).get(model_name) or {}
        model_status[model_name] = str(entry.get("status") or "retired")
        artifact_versions[model_name] = str(
            entry.get("version")
            or entry.get("model_version")
            or (entry.get("last_artifact_evidence") or {}).get("model_version")
            or ""
        ).strip()
        artifact_target_semantics[model_name] = str(
            entry.get("target_semantic_version")
            or (entry.get("last_artifact_evidence") or {}).get("target_semantic_version")
            or ""
        ).strip()
    candidate_by_symbol = {str(row.get("symbol") or ""): row for row in rows}
    for symbol, prediction in outputs.items():
        candidate = candidate_by_symbol.get(symbol) or {}
        forecast = candidate.get("forecast_data") if isinstance(candidate.get("forecast_data"), dict) else {}
        prediction["stock_meta"] = dict(forecast.get("stock_meta") or {})
    rank_distribution_before = _rank_distribution(outputs)
    rank_normalization = normalize_active8_cross_sectional_scores(
        outputs,
        artifact_versions=artifact_versions,
        artifact_target_semantics=artifact_target_semantics,
        run_date=run_date,
    )
    rank_distribution_after = _rank_distribution(outputs)
    dampening = resolve_degraded_dampening(config)
    ev2_cfg = copy.deepcopy(config.get("ensemble_v2") or {})
    start_date = (date.fromisoformat(run_date) - timedelta(days=35)).isoformat()
    ic_rows: list[dict[str, Any]] = []
    for model_name in ACTIVE_ALPHA_MODELS:
        ic_rows.extend(d1_client.query(
            """
            SELECT id, stock_id, model_name, forecast_data,
                   CASE WHEN date(verified_at) <= date(?) THEN actual_return_pct ELSE NULL END AS actual_return_pct,
                   CASE WHEN date(verified_at) <= date(?) THEN verified_at ELSE NULL END AS verified_at,
                   prediction_date, generated_at
              FROM predictions
             WHERE model_name = ?
               AND date(prediction_date) BETWEEN date(?) AND date(?)
             ORDER BY date(prediction_date) ASC, stock_id ASC, generated_at ASC
             LIMIT 6000
            """,
            [run_date, run_date, model_name, start_date, run_date],
        ))
    ic_result = compute_weekly_ic_from_rows(
        ic_rows,
        min_samples=50,
        min_dates=10,
        all_tracked=tuple(ACTIVE_ALPHA_MODELS),
    )

    ic_policy = ev2_cfg.get("icWeighting") if isinstance(ev2_cfg.get("icWeighting"), dict) else {}
    prior = float(ic_policy.get("priorIc", ic_policy.get("priorIC", 0.015)) or 0.015)
    prior_strength = float(ic_policy.get("priorStrength", 20.0) or 20.0)
    hard_zero_samples = int(ic_policy.get("minSamplesForHardZero", 40) or 40)

    def effective_weight(model_name: str, segment: str) -> float:
        result = ic_result.get(model_name) or {}
        lane = (result.get("segments") or {}).get(segment) or {}
        source = lane if lane.get("status") == "computed" else result
        raw_ic = _finite(source.get("ic"))
        sample_count = int(source.get("n_samples") or 0)
        if raw_ic is None:
            entry = (pool.get("models") or {}).get(model_name) or {}
            evidence = entry.get("last_artifact_evidence") or {}
            raw_ic = _finite(evidence.get("oos_ic", evidence.get("after_oos_ic")))
            sample_count = int(
                evidence.get("oos_samples")
                or evidence.get("validation_sample_count")
                or evidence.get("sample_count")
                or 0
            )
        if raw_ic is None:
            return 0.0
        alpha = sample_count / (sample_count + prior_strength) if sample_count + prior_strength > 0 else 1.0
        posterior = alpha * raw_ic + (1.0 - alpha) * prior
        if raw_ic < 0 and sample_count >= hard_zero_samples and posterior <= 0:
            return 0.0
        return max(0.0, posterior)

    weights_by_segment = {
        segment: {model_name: effective_weight(model_name, segment) for model_name in ACTIVE_ALPHA_MODELS}
        for segment in ("LISTED", "OTC", "UNKNOWN")
    }
    for row in rows:
        symbol = str(row.get("symbol") or "")
        prediction = copy.deepcopy(outputs.get(symbol) or {})
        stock_meta = (row.get("forecast_data") or {}).get("stock_meta") or {}
        segment = str(stock_meta.get("market_segment") or "UNKNOWN").upper()
        ic_weights = weights_by_segment.get(segment, weights_by_segment["UNKNOWN"])
        attach_ensemble_v2(prediction, model_status, ic_weights, dampening, ev2_cfg)
        ensemble = prediction.get("ensemble_v2")
        row["formal_layer3_contract"] = prediction.get("formal_layer3_contract")
        if isinstance(ensemble, dict):
            row["ensemble_v2"] = ensemble
            row["forecast_data"]["ensemble_v2"] = ensemble
            row["confidence"] = ensemble.get("confidence")
    return {
        "source": "point_in_time_35d_daily_cross_sectional_ic_reapplied_to_model_outputs",
        "used_pool": True,
        "model_pool_last_updated": (pool or {}).get("last_updated"),
        "model_status": model_status,
        "artifact_versions": artifact_versions,
        "artifact_target_semantics": artifact_target_semantics,
        "rank_normalization": rank_normalization,
        "rank_distribution_before": rank_distribution_before,
        "rank_distribution_after": rank_distribution_after,
        "ic_window": {"start_date": start_date, "end_date": run_date, "min_dates": 10},
        "ic_results": ic_result,
        "ic_weights_by_segment": weights_by_segment,
        "degraded_dampening": dampening,
    }


def _ensemble_rank_comparison(rows: list[dict[str, Any]]) -> dict[str, Any]:
    pairs: list[dict[str, Any]] = []
    for row in rows:
        old_rank = _finite((row.get("historical_ensemble_v2") or {}).get("avg_rank"))
        new_rank = _finite((row.get("ensemble_v2") or {}).get("avg_rank"))
        if old_rank is None or new_rank is None:
            continue
        pairs.append({
            "symbol": str(row.get("symbol") or ""),
            "score_v2": _finite(row.get("score")),
            "old_avg_rank": old_rank,
            "new_avg_rank": new_rank,
            "delta": round(new_rank - old_rank, 6),
        })
    old_values = [item["old_avg_rank"] for item in pairs]
    new_values = [item["new_avg_rank"] for item in pairs]
    old_mean = sum(old_values) / len(old_values) if old_values else None
    new_mean = sum(new_values) / len(new_values) if new_values else None
    covariance = (
        sum((old - old_mean) * (new - new_mean) for old, new in zip(old_values, new_values))
        if old_mean is not None and new_mean is not None
        else 0.0
    )
    old_ss = sum((value - old_mean) ** 2 for value in old_values) if old_mean is not None else 0.0
    new_ss = sum((value - new_mean) ** 2 for value in new_values) if new_mean is not None else 0.0
    correlation = covariance / math.sqrt(old_ss * new_ss) if old_ss > 0 and new_ss > 0 else None
    return {
        "sample_count": len(pairs),
        "pearson_rank_score_correlation": round(correlation, 6) if correlation is not None else None,
        "old_mean": round(old_mean, 6) if old_mean is not None else None,
        "new_mean": round(new_mean, 6) if new_mean is not None else None,
        "top_new_rank": sorted(pairs, key=lambda item: item["new_avg_rank"], reverse=True)[:15],
        "largest_absolute_shifts": sorted(pairs, key=lambda item: abs(item["delta"]), reverse=True)[:15],
    }


def _load_return_history(run_date: str, symbols: list[str]) -> dict[str, list[float]]:
    if not symbols:
        return {}
    rows = d1_client.query(
        """
        SELECT s.symbol, date(sp.date) AS price_date, sp.adj_close
        FROM stock_prices sp
        JOIN stocks s ON s.id = sp.stock_id
        WHERE date(sp.date) <= date(?)
          AND date(sp.date) >= date(?, '-120 days')
        ORDER BY s.symbol ASC, date(sp.date) ASC
        """,
        [run_date, run_date],
    )
    wanted = set(symbols)
    closes: dict[str, list[float]] = defaultdict(list)
    for row in rows:
        symbol = str(row.get("symbol") or "").strip()
        close = _finite(row.get("adj_close"))
        if symbol in wanted and close is not None and close > 0:
            closes[symbol].append(close)
    return {
        symbol: [values[index] / values[index - 1] - 1.0 for index in range(1, len(values))]
        for symbol, values in closes.items()
        if len(values) >= 2
    }


def _base_policy(config: dict[str, Any]) -> dict[str, Any]:
    policy = copy.deepcopy(config.get("alphaFramework") or config.get("alpha_framework") or {})
    allocation = policy.setdefault("allocation", {})
    allocation["engine"] = "sparse_tangent_inverse_risk"
    allocation["controller"] = "OnlinePortfolioBandit"
    for key in ("allocatorEvFusion", "allocator_ev_fusion", "allocatorEVFusion", "allocationEvFusion"):
        policy.pop(key, None)
        allocation.pop(key, None)
    return policy


def _prod_l4(config: dict[str, Any]) -> dict[str, Any] | None:
    ev2 = config.get("ensemble_v2") if isinstance(config.get("ensemble_v2"), dict) else {}
    for value in (
        config.get("l4AlphaEv"),
        config.get("l4_alpha_ev"),
        ev2.get("l4AlphaEv"),
        ev2.get("l4_alpha_ev"),
    ):
        if isinstance(value, dict):
            return value
    return None


def _force_shadow_fusion_for_scoring(artifact: dict[str, Any]) -> dict[str, Any]:
    forced = copy.deepcopy(artifact)
    forced["validation_packet"] = {
        **(forced.get("validation_packet") or {}),
        "decision": "PASS",
        "shadow_forced_scoring_only": True,
    }
    forced["approval_state"] = "production_approved"
    forced["promotion_state"] = "production_primary"
    forced["promotion_tier"] = "primary"
    forced["primary_expected_return_allowed"] = True
    forced["assistive_expected_return_allowed"] = True
    return forced


def _force_shadow_l4_for_scoring(artifact: dict[str, Any]) -> dict[str, Any]:
    forced = copy.deepcopy(artifact)
    forced["validation_packet"] = {
        **(forced.get("validation_packet") or {}),
        "decision": "PASS",
        "shadow_forced_scoring_only": True,
    }
    forced["approval_state"] = "production_approved"
    forced["promotion_state"] = "production_primary"
    forced["promotion_tier"] = "primary"
    return forced


def _allocation_detail(row: dict[str, Any]) -> dict[str, Any]:
    allocation = row.get("alpha_allocation") if isinstance(row.get("alpha_allocation"), dict) else {}
    resolver = allocation.get("allocator_edge_resolver") if isinstance(allocation.get("allocator_edge_resolver"), dict) else {}
    l4 = allocation.get("l4_alpha_ev") if isinstance(allocation.get("l4_alpha_ev"), dict) else {}
    fusion = allocation.get("allocator_ev_fusion") if isinstance(allocation.get("allocator_ev_fusion"), dict) else {}
    sparse = allocation.get("alpha_utility") if isinstance(allocation.get("alpha_utility"), dict) else {}
    return {
        "symbol": str(row.get("symbol") or ""),
        "name": row.get("name"),
        "signal": row.get("signal"),
        "score_v2": _finite(row.get("score")),
        "ml_edge": _finite((row.get("score_components") or {}).get("components", {}).get("mlEdge")),
        "technical": _finite((row.get("score_components") or {}).get("components", {}).get("technicalStructure")),
        "fundamental": _finite((row.get("score_components") or {}).get("components", {}).get("fundamentalQuality")),
        "confidence": _finite(row.get("confidence")),
        "expected_return": _finite(allocation.get("expected_return")),
        "expected_return_owner": allocation.get("expected_return_owner"),
        "expected_return_source": allocation.get("expected_return_source"),
        "l4_expected_return": _finite(l4.get("expected_return")),
        "l4_status": l4.get("status"),
        "l4_model_version": l4.get("model_version"),
        "l4_blockers": l4.get("blockers") if isinstance(l4.get("blockers"), list) else [],
        "fusion_selection_ev": _finite(fusion.get("selection_expected_return")),
        "fusion_status": fusion.get("status"),
        "fusion_model_version": fusion.get("model_version"),
        "fusion_blockers": fusion.get("blockers") if isinstance(fusion.get("blockers"), list) else [],
        "fusion_execution_probability": _finite(fusion.get("execution_probability")),
        "fusion_execution_adjustment": _finite(fusion.get("execution_residual_adjustment")),
        "s12_execution_model_applied": fusion.get("s12_execution_model_applied"),
        "allocation_weight": _finite(row.get("allocation_weight") or allocation.get("allocation_weight")),
        "allocation_rank": allocation.get("allocation_rank"),
        "eligible_for_sparse": allocation.get("eligible_for_sparse"),
        "potential_buy": allocation.get("potential_buy"),
        "selection_reason": allocation.get("selection_reason"),
        "marginal_utility": _finite(sparse.get("marginal_utility")),
        "edge_quality": _finite(resolver.get("allocator_edge_quality_score")),
    }


def _run_variant(
    label: str,
    rows: list[dict[str, Any]],
    *,
    ranking: dict[str, Any],
    policy: dict[str, Any],
    return_history: dict[str, list[float]],
    reward_ledger: list[dict[str, Any]],
) -> dict[str, Any]:
    materialized_rows = copy.deepcopy(rows)
    for row in materialized_rows:
        prediction = {
            "ensemble_v2": row.get("ensemble_v2"),
            "alpha_context": row.get("alpha_context"),
        }
        l4_payload = materialize_l4_alpha_ev(row, prediction=prediction, policy=policy)
        if isinstance(l4_payload, dict):
            row["l4_alpha_ev"] = l4_payload
    output = apply_sparse_tangent_allocation(
        materialized_rows,
        ranking,
        alpha_policy=policy,
        return_history=return_history,
        opb_reward_ledger=reward_ledger,
    )
    details = [_allocation_detail(row) for row in output]
    selected = [detail for detail in details if (detail.get("allocation_weight") or 0.0) > 0.0]
    potential = [
        detail for detail in details
        if detail.get("signal") == "POTENTIAL_BUY" or detail.get("potential_buy") is True
    ]
    positive_unselected = [
        detail for detail in details
        if detail.get("eligible_for_sparse") is True
        and not (detail.get("allocation_weight") or 0.0) > 0.0
        and (detail.get("expected_return") or 0.0) > 0.0
    ]
    potential.sort(key=lambda item: (item.get("expected_return") or -99.0, item.get("score_v2") or 0.0), reverse=True)
    positive_unselected.sort(key=lambda item: (item.get("expected_return") or -99.0, item.get("score_v2") or 0.0), reverse=True)
    owners = Counter(str(detail.get("expected_return_owner") or "missing") for detail in details)
    finite_expected_returns = [
        float(detail["expected_return"])
        for detail in details
        if detail.get("expected_return") is not None
    ]
    expected_return_counts = Counter(
        "missing"
        if detail.get("expected_return") is None
        else "positive"
        if float(detail["expected_return"]) > 0.0
        else "negative"
        if float(detail["expected_return"]) < 0.0
        else "zero"
        for detail in details
    )
    eligibility_counts = Counter(
        "eligible"
        if detail.get("eligible_for_sparse") is True
        else "ineligible"
        if detail.get("eligible_for_sparse") is False
        else "missing"
        for detail in details
    )
    signal_counts = Counter(str(detail.get("signal") or "missing") for detail in details)
    selection_reason_counts = Counter(str(detail.get("selection_reason") or "missing") for detail in details)
    top_by_expected_return = sorted(
        (detail for detail in details if detail.get("expected_return") is not None),
        key=lambda item: (float(item["expected_return"]), item.get("score_v2") or 0.0),
        reverse=True,
    )[:15]
    top_by_score_v2 = sorted(
        details,
        key=lambda item: (item.get("score_v2") or -99.0, item.get("expected_return") or -99.0),
        reverse=True,
    )[:15]
    return {
        "label": label,
        "row_count": len(output),
        "buy_count": len(selected),
        "buy_symbols": [item["symbol"] for item in selected],
        "selected": selected,
        "potential_buy_count": len(potential),
        "top_potential": potential[:15],
        "positive_ev_eligible_zero_weight_count": len(positive_unselected),
        "top_positive_ev_eligible_zero_weight": positive_unselected[:15],
        "owner_counts": dict(owners),
        "expected_return_counts": dict(expected_return_counts),
        "expected_return_summary": {
            "minimum": min(finite_expected_returns) if finite_expected_returns else None,
            "maximum": max(finite_expected_returns) if finite_expected_returns else None,
            "mean": (
                sum(finite_expected_returns) / len(finite_expected_returns)
                if finite_expected_returns
                else None
            ),
        },
        "eligibility_counts": dict(eligibility_counts),
        "signal_counts": dict(signal_counts),
        "selection_reason_counts": dict(selection_reason_counts),
        "top_by_expected_return": top_by_expected_return,
        "top_by_score_v2": top_by_score_v2,
    }


def _historical_actual_variant(rows: list[dict[str, Any]], *, run_date: str) -> dict[str, Any]:
    selected = []
    potential = []
    for row in rows:
        allocation = row.get("historical_alpha_allocation") if isinstance(row.get("historical_alpha_allocation"), dict) else {}
        detail = {
            "symbol": str(row.get("symbol") or ""),
            "name": row.get("name"),
            "signal": row.get("historical_signal"),
            "score_v2": _finite(row.get("score")),
            "allocation_weight": _finite(row.get("historical_allocation_weight") or allocation.get("allocation_weight")),
            "allocation_rank": allocation.get("allocation_rank"),
            "expected_return": _finite(allocation.get("expected_return")),
            "expected_return_owner": allocation.get("expected_return_owner"),
            "selection_reason": allocation.get("selection_reason"),
        }
        if (detail["allocation_weight"] or 0.0) > 0.0:
            selected.append(detail)
        elif detail["signal"] == "POTENTIAL_BUY" or allocation.get("potential_buy") is True:
            potential.append(detail)
    return {
        "label": "historical_prod_actual",
        "row_count": len(rows),
        "buy_count": len(selected),
        "buy_symbols": [item["symbol"] for item in selected],
        "selected": selected,
        "potential_buy_count": len(potential),
        "top_potential": sorted(
            potential,
            key=lambda item: (item.get("expected_return") or -99.0, item.get("score_v2") or 0.0),
            reverse=True,
        )[:15],
        "source": f"persisted_{run_date}_daily_recommendations",
    }


def _closure_audit(
    *,
    candidate_count: int,
    active8_count: int,
    l4_lineage_audit: dict[str, Any],
    l4_result: dict[str, Any],
    fusion_result: dict[str, Any],
    opb_prior_results: dict[str, dict[str, Any]],
    opb_samples: int,
    variants: list[dict[str, Any]],
    snapshot_dry_run: dict[str, Any],
) -> dict[str, Any]:
    l4_validation = l4_result.get("validation_packet") if isinstance(l4_result.get("validation_packet"), dict) else {}
    l4_samples = l4_validation.get("sample_audit") if isinstance(l4_validation.get("sample_audit"), dict) else {}
    fusion_validation = (
        fusion_result.get("validation_packet")
        if isinstance(fusion_result.get("validation_packet"), dict)
        else {}
    )
    fusion_samples = (
        fusion_validation.get("sample_audit")
        if isinstance(fusion_validation.get("sample_audit"), dict)
        else {}
    )
    lineage_accepted = int(l4_lineage_audit.get("accepted_rows") or 0)
    data_contract_closed = all((
        candidate_count > 0,
        active8_count > 0,
        lineage_accepted > 0,
        int(l4_samples.get("sample_count") or 0) > 0,
        int(fusion_samples.get("sample_count") or 0) > 0,
        int(fusion_samples.get("invalid_rows") or 0) == 0,
    ))
    l4_ready = str(l4_validation.get("decision") or "").upper() == "PASS"
    fusion_ready = str(fusion_validation.get("decision") or "").upper() == "PASS"
    active_owner = "allocator_ev_fusion" if fusion_ready else "l4_alpha_ev"
    active_opb_prior = opb_prior_results.get(active_owner) or {}
    active_opb_artifact = (
        active_opb_prior.get("artifact")
        if isinstance(active_opb_prior.get("artifact"), dict)
        else {}
    )
    active_opb_validation = (
        active_opb_artifact.get("validation")
        if isinstance(active_opb_artifact.get("validation"), dict)
        else {}
    )
    opb_prior_ready = str(active_opb_validation.get("decision") or "").upper() == "PASS"
    adaptive_learning_closed = opb_samples > 0 or opb_prior_ready
    snapshot_candidates = int(snapshot_dry_run.get("candidate_rows") or 0)
    snapshot_built = int(snapshot_dry_run.get("snapshots_built") or 0)
    snapshot_rejected = int(snapshot_dry_run.get("rejected_lineage_rows") or 0)
    snapshot_reconstructed = int(snapshot_dry_run.get("reconstructed_lineage_rows") or 0)
    native_snapshot_closed = (
        snapshot_candidates > 0
        and snapshot_built == snapshot_candidates
        and snapshot_rejected == 0
        and snapshot_reconstructed == 0
    )
    guarded_variants = {
        str(item.get("label")): {
            "buy_count": int(item.get("buy_count") or 0),
            "buy_symbols": list(item.get("buy_symbols") or []),
            "potential_buy_count": int(item.get("potential_buy_count") or 0),
        }
        for item in variants
        if str(item.get("label") or "").endswith("_guarded")
    }
    blockers: list[str] = []
    blockers.extend(f"l4:{value}" for value in (l4_validation.get("failed_gates") or []))
    blockers.extend(f"fusion:{value}" for value in (fusion_validation.get("failed_gates") or []))
    if not native_snapshot_closed:
        blockers.append(
            "snapshot:native_cohort_incomplete:"
            f"built={snapshot_built}:candidates={snapshot_candidates}:"
            f"reconstructed={snapshot_reconstructed}:rejected={snapshot_rejected}"
        )
    if not adaptive_learning_closed:
        blockers.append("opb:live_reward_ledger_empty_as_of_run_date")
        blockers.extend(
            f"opb_prior:{value}"
            for value in (active_opb_validation.get("failed_checks") or [])
        )
    return {
        "schema_version": "local-evening-chain-closure-audit-v1",
        "data_contract_closed": data_contract_closed,
        "l4_production_ready": l4_ready,
        "fusion_production_ready": fusion_ready,
        "adaptive_learning_closed": adaptive_learning_closed,
        "native_snapshot_closed": native_snapshot_closed,
        "active_expected_return_owner_for_opb": active_owner,
        "opb_counterfactual_prior_ready": opb_prior_ready,
        "production_learning_chain_closed": (
            data_contract_closed and l4_ready and fusion_ready and adaptive_learning_closed
        ),
        "guarded_recommendations": guarded_variants,
        "blockers": list(dict.fromkeys(blockers)),
        "stage_counts": {
            "source_candidates": candidate_count,
            "active8_complete": active8_count,
            "snapshot_candidates": snapshot_candidates,
            "snapshot_built": snapshot_built,
            "snapshot_reconstructed": snapshot_reconstructed,
            "snapshot_rejected": snapshot_rejected,
            "l4_lineage_input": int(l4_lineage_audit.get("input_rows") or 0),
            "l4_lineage_accepted": lineage_accepted,
            "l4_training_samples": int(l4_samples.get("sample_count") or 0),
            "l4_training_dates": int(l4_samples.get("date_count") or 0),
            "fusion_training_samples": int(fusion_samples.get("sample_count") or 0),
            "fusion_training_dates": int(fusion_samples.get("date_count") or 0),
            "fusion_execution_samples": int(fusion_samples.get("execution_sample_count") or 0),
            "fusion_execution_dates": int(fusion_samples.get("execution_date_count") or 0),
            "fusion_l4_available_samples": int(fusion_samples.get("l4_available_count") or 0),
            "fusion_s12_available_samples": int(fusion_samples.get("s12_available_count") or 0),
            "opb_live_reward_samples": opb_samples,
            "opb_counterfactual_input_rows": int(active_opb_prior.get("rows_loaded") or 0),
            "opb_counterfactual_price_rows": int(active_opb_prior.get("price_rows_loaded") or 0),
            "opb_counterfactual_missing_owner_rows": int(active_opb_artifact.get("missing_owner_rows") or 0),
        },
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-date", default="2026-07-09")
    parser.add_argument("--training-end-date", default="2026-07-02")
    parser.add_argument("--next-session-date")
    parser.add_argument("--upstream-mode", choices=("frozen", "current-reensemble"), default="frozen")
    parser.add_argument("--s12-structure-overlay")
    parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)

    config = load_merged_trading_config(prefer_worker=True, allow_offline_defaults=False)
    all_rows, frozen_lineage_audit = _load_candidate_rows(
        args.run_date,
        next_session_date=args.next_session_date,
    )
    if not all_rows:
        raise RuntimeError(f"no recommendations for {args.run_date}")
    historical_rows = copy.deepcopy(all_rows)
    active_model_outputs = _load_active_model_outputs(args.run_date)
    ensemble_replay = (
        _attach_current_active8_ensemble(all_rows, active_model_outputs, config, args.run_date)
        if args.upstream_mode == "current-reensemble"
        else {
            "source": "frozen_same_run_ensemble_v2",
            "used_pool": False,
            "counterfactual_reensemble": False,
        }
    )
    rows, active8_excluded = _active8_eligible_rows(all_rows, active_model_outputs)
    if not rows:
        blocker_counts = Counter(
            blocker
            for item in active8_excluded
            for blocker in item.get("lineage_blockers") or []
        )
        missing_model_counts = Counter(
            model
            for item in active8_excluded
            for model in item.get("missing_models") or []
        )
        report = {
            "schema_version": "evening-chain-ev-version-comparison-v2",
            "run_date": args.run_date,
            "training_end_date": args.training_end_date,
            "common_input": {
                "candidate_count": len(all_rows),
                "active8_complete_candidate_count": 0,
                "active8_excluded_count": len(active8_excluded),
                "active8_lineage_blocker_counts": dict(blocker_counts),
                "active8_missing_model_counts": dict(missing_model_counts),
                "active8_excluded": active8_excluded,
                "ensemble_replay": ensemble_replay,
                "frozen_lineage_audit": frozen_lineage_audit,
                "ensemble_rank_comparison": _ensemble_rank_comparison(all_rows),
            },
            "variants": [_historical_actual_variant(historical_rows, run_date=args.run_date)],
            "closure_audit": {
                "status": "blocked",
                "reason": "no_contract_complete_active8_candidates",
                "production_cutover_allowed": False,
            },
        }
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({
            "output": str(output),
            "status": "blocked",
            "candidate_count": len(all_rows),
            "active8_complete_candidate_count": 0,
            "active8_lineage_blocker_counts": dict(blocker_counts),
            "historical_actual": report["variants"][0],
        }, ensure_ascii=False, indent=2))
        return 0
    s12_overlay_audit = (
        _apply_s12_structure_overlay(
            rows,
            run_date=args.run_date,
            overlay_path=args.s12_structure_overlay,
        )
        if args.s12_structure_overlay
        else None
    )
    return_history = _load_return_history(args.run_date, [str(row.get("symbol")) for row in rows])
    reward_ledger = load_online_portfolio_bandit_reward_ledger(as_of_date=args.run_date)
    snapshot_dry_run = build_allocator_ev_feature_snapshots_for_date(
        snapshot_date=args.run_date,
        next_session_date=args.next_session_date,
        dry_run=True,
        candidate_limit=1000,
        l4_min_samples=500,
        l4_min_dates=20,
    )
    ranking = copy.deepcopy(config.get("ranking") or {"enabled": True})

    l4_training = load_l4_alpha_ev_training_rows(
        d1_client.query,
        end_date=args.training_end_date,
        knowledge_cutoff_date=args.run_date,
        lookback_days=90,
        limit=6000,
    )
    l4_generated_values = sorted(
        str(row.get("prediction_generated_at") or "").strip()
        for row in l4_training
        if str(row.get("prediction_generated_at") or "").strip()
    )
    l4_history_start = (
        l4_generated_values[0]
        if l4_generated_values
        else f"{args.training_end_date}T00:00:00Z"
    )
    l4_history_end = (
        l4_generated_values[-1]
        if l4_generated_values
        else f"{args.training_end_date}T23:59:59Z"
    )
    l4_champion_events, l4_champion_history_load = load_model_champion_history(
        d1_client.query,
        start_at=l4_history_start,
        end_at=l4_history_end,
    )
    l4_lineage_training, l4_lineage_audit = reconstruct_rows_with_point_in_time_lineage(
        l4_training,
        champion_events=l4_champion_events,
    )
    l4_result = build_l4_alpha_ev_artifact_from_rows(
        l4_lineage_training,
        trained_until=args.training_end_date,
        lookback_days=90,
        min_samples=500,
        min_dates=20,
    )
    canonical_l4 = l4_result.get("artifact") or {}

    fusion_training = load_allocator_ev_fusion_training_rows(
        d1_client.query,
        end_date=args.training_end_date,
        knowledge_cutoff_date=args.run_date,
        lookback_days=90,
        limit=6000,
    )
    fusion_result = build_allocator_ev_fusion_artifact_from_rows(
        fusion_training,
        trained_until=args.training_end_date,
        lookback_days=90,
        min_samples=500,
        min_dates=20,
    )
    fusion_shadow = fusion_result.get("artifact") or {}

    opb_counterfactual_rows, opb_price_rows = load_opb_counterfactual_inputs(
        end_date=args.training_end_date,
        lookback_days=120,
        limit=10000,
    )
    opb_prior_results: dict[str, dict[str, Any]] = {}
    for owner in ("l4_alpha_ev", "allocator_ev_fusion"):
        prior_result = build_opb_arm_prior_artifact(
            opb_counterfactual_rows,
            opb_price_rows,
            expected_return_owner=owner,
            trained_until=args.training_end_date,
            min_dates=20,
        )
        opb_prior_results[owner] = {
            **prior_result,
            "rows_loaded": len(opb_counterfactual_rows),
            "price_rows_loaded": len(opb_price_rows),
        }

    prod_policy = _base_policy(config)
    prod_artifact = _prod_l4(config)
    if not isinstance(prod_artifact, dict):
        raise RuntimeError("production L4 artifact missing")
    prod_policy["l4_alpha_ev"] = prod_artifact

    canonical_policy = _base_policy(config)
    canonical_policy["l4_alpha_ev"] = canonical_l4

    canonical_shadow_policy = _base_policy(config)
    canonical_shadow_policy["l4_alpha_ev"] = _force_shadow_l4_for_scoring(canonical_l4)

    fusion_policy = _base_policy(config)
    fusion_policy["l4_alpha_ev"] = _force_shadow_l4_for_scoring(canonical_l4)
    fusion_policy["allocator_ev_fusion"] = _force_shadow_fusion_for_scoring(fusion_shadow)

    guarded_fusion_policy = _base_policy(config)
    guarded_fusion_policy["l4_alpha_ev"] = prod_artifact
    guarded_fusion_policy["allocator_ev_fusion"] = fusion_shadow

    variants = [
        _historical_actual_variant(rows, run_date=args.run_date),
        _run_variant("current_prod_guarded", rows, ranking=ranking, policy=prod_policy, return_history=return_history, reward_ledger=reward_ledger),
        _run_variant("fusion_v11_guarded", rows, ranking=ranking, policy=guarded_fusion_policy, return_history=return_history, reward_ledger=reward_ledger),
        _run_variant("canonical_l4_guarded", rows, ranking=ranking, policy=canonical_policy, return_history=return_history, reward_ledger=reward_ledger),
        _run_variant("canonical_l4_math_shadow", rows, ranking=ranking, policy=canonical_shadow_policy, return_history=return_history, reward_ledger=reward_ledger),
        _run_variant("fusion_v11_math_shadow", rows, ranking=ranking, policy=fusion_policy, return_history=return_history, reward_ledger=reward_ledger),
    ]
    opb_samples = sum(int(row.get("samples") or 0) for row in reward_ledger)

    report = {
        "schema_version": "evening-chain-ev-version-comparison-v2",
        "run_date": args.run_date,
        "training_end_date": args.training_end_date,
        "common_input": {
            "candidate_count": len(rows),
            "source_candidate_count": len(all_rows),
            "active8_complete_candidate_count": len(rows),
            "active8_excluded_count": len(active8_excluded),
            "active8_excluded": active8_excluded,
            "return_history_symbols": len(return_history),
            "opb_live_ledger_samples": opb_samples,
            "allocator": "OnlinePortfolioBandit+sparse_tangent_inverse_risk",
            "ensemble_replay": ensemble_replay,
            "frozen_lineage_audit": frozen_lineage_audit,
            "s12_structure_overlay": s12_overlay_audit,
            "ensemble_rank_comparison": _ensemble_rank_comparison(rows),
        },
        "artifacts": {
            "prod": {
                "model_version": prod_artifact.get("model_version"),
                "validation": (prod_artifact.get("validation_packet") or {}).get("decision"),
                "promotion_state": prod_artifact.get("promotion_state") or prod_artifact.get("approval_state"),
            },
            "canonical_l4": {
                "model_version": canonical_l4.get("model_version"),
                "validation": (l4_result.get("validation_packet") or {}).get("decision"),
                "validation_packet": l4_result.get("validation_packet"),
                "raw_rows": len(l4_training),
                "lineage_rows": len(l4_lineage_training),
                "lineage_reconstruction": l4_lineage_audit,
                "champion_history_load": l4_champion_history_load,
            },
            "fusion_v11": {
                "model_version": fusion_shadow.get("model_version"),
                "validation": (fusion_result.get("validation_packet") or {}).get("decision"),
                "validation_packet": fusion_result.get("validation_packet"),
                "rows": len(fusion_training),
                "scoring_mode": "forced_shadow_math_only_not_promotion_eligible",
            },
            "opb_counterfactual_priors": opb_prior_results,
            "native_snapshot_dry_run": snapshot_dry_run,
        },
        "variants": variants,
        "closure_audit": _closure_audit(
            candidate_count=len(all_rows),
            active8_count=len(rows),
            l4_lineage_audit=l4_lineage_audit,
            l4_result=l4_result,
            fusion_result=fusion_result,
            opb_prior_results=opb_prior_results,
            opb_samples=opb_samples,
            variants=variants,
            snapshot_dry_run=snapshot_dry_run,
        ),
    }
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "output": str(output),
        "variants": [
            {"label": item["label"], "buy_count": item["buy_count"], "buy_symbols": item["buy_symbols"]}
            for item in report["variants"]
        ],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
