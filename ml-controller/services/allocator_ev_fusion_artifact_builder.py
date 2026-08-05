"""Build allocator EV fusion artifacts from verified recommendation outcomes."""
from __future__ import annotations

import hashlib
import json
import math
from datetime import date, datetime, timezone
from typing import Any, Callable

from scipy.stats import t as student_t

from services.evidence_contracts import (
    ALLOCATOR_EV_ARTIFACT_CONTRACT_VERSION,
    CANONICAL_ROUNDTRIP_COST_RATE,
    ALLOCATOR_EV_FEATURE_SEMANTIC_VERSION,
    LABEL_SCHEMA_VERSION,
)
from services.ev_lineage_contract import ev_feature_lineage_blockers

from services.allocator_ev_fusion import (
    _s12_execution_ready,
    _s12_multiplier,
    _s12_structure_features,
    _target_quality_numeric,
    _target_quality_state,
)
from services.l4_alpha_ev_resolver import (
    PURGED_OOF_USAGE_SCOPE,
    SNAPSHOT_BACKFILL_AS_OF_GUARD,
    SNAPSHOT_BACKFILL_SOURCE,
    SNAPSHOT_BACKFILL_USAGE_SCOPE,
    extract_l4_alpha_ev,
)
from services.s12_trade_ev import extract_s12_trade_ev
from services.price_horizon_projection_contract import (
    OOF_PRICE_HORIZON_SOURCE,
    PRICE_HORIZONS_CTE,
    PRICE_HORIZON_SOURCE,
    expected_price_horizon_source,
)
from services.fusion_market_context import (
    EXECUTION_MARKET_CONTEXT_FEATURE_NAMES,
    MARKET_CONTEXT_FEATURE_NAMES,
    market_context_feature_values,
    market_regime_bucket,
)
from services.pit_sector_alpha import SECTOR_ALPHA_FEATURE_NAMES, sector_alpha_feature_values


SELECTION_FEATURE_NAMES = [
    "l4_expected_return",
    "l4_available",
    "ml_edge_norm",
    "fundamental_quality_norm",
    "chip_flow_norm",
    "technical_structure_norm",
    "ensemble_directional_margin",
    "score_v2_available",
    "ensemble_rank_available",
    *SECTOR_ALPHA_FEATURE_NAMES,
    *MARKET_CONTEXT_FEATURE_NAMES,
]
EXECUTION_FEATURE_NAMES = [
    *SELECTION_FEATURE_NAMES,
    "s12_trade_expected_return",
    "s12_available",
    "s12_execution_ready",
    "s12_context_multiplier",
    "s12_target_quality_score",
    "s12_structure_available",
    "s12_risk_pct",
    "s12_target1_r",
    "s12_target2_r",
    "s12_equity_mutation_score",
    "s12_vwap_fast_acceptance",
    "s12_htf_hard_block",
    "s12_full_reaction_ready",
    "s12_limited_takeover_ready",
    "l4_s12_edge_agreement",
    *EXECUTION_MARKET_CONTEXT_FEATURE_NAMES,
]
FEATURE_NAMES = list(dict.fromkeys([*SELECTION_FEATURE_NAMES, *EXECUTION_FEATURE_NAMES]))

TEMPORAL_TRAIN_FRACTION = 0.75
PRIMARY_MIN_DATES = 40
PRIMARY_MIN_OOS_DATES = 10
PRIMARY_MIN_SAMPLES = 1500
PRIMARY_MIN_S12_AVAILABLE_SAMPLES = 300
PRIMARY_MIN_S12_AVAILABLE_DATES = 10
PRIMARY_MIN_L4_PIT_SAMPLES = 300
PRIMARY_MIN_L4_PIT_DATES = 10
PRIMARY_MIN_S12_STRUCTURE_SAMPLES = 300
PRIMARY_MIN_S12_STRUCTURE_DATES = 10
PRIMARY_MIN_MARKET_CONTEXT_SAMPLES = 300
PRIMARY_MIN_MARKET_CONTEXT_DATES = 10
PRIMARY_MIN_SECTOR_ALPHA_SAMPLES = 300
PRIMARY_MIN_SECTOR_ALPHA_DATES = 8
ASSISTIVE_MIN_DATES = 20
ASSISTIVE_MIN_OOS_DATES = 5
ASSISTIVE_MIN_SAMPLES = 500
ASSISTIVE_MIN_EXPERT_SAMPLES = 100
ASSISTIVE_MIN_EXPERT_DATES = 10
CANONICAL_SCORE_FEATURE_VERSION = "score_v2"
CANONICAL_SCORE_SEMANTIC_VERSION = "score-v2-active8-components-v3"
CANONICAL_ENSEMBLE_SEMANTIC_VERSION = "active8-ic-weighted-rank-v4"
CANONICAL_ADJUSTMENT_FACTOR_SOURCE = PRICE_HORIZON_SOURCE
MIN_CROSS_SECTION_SAMPLES_PER_DATE = 20
LABEL_PURGE_DATE_GROUPS = 5
ARTIFACT_CONTRACT_VERSION = ALLOCATOR_EV_ARTIFACT_CONTRACT_VERSION
FEATURE_SEMANTIC_VERSION = ALLOCATOR_EV_FEATURE_SEMANTIC_VERSION


def _float_or_none(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return number


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


def _mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _corr(xs: list[float], ys: list[float]) -> float | None:
    if len(xs) < 3 or len(xs) != len(ys):
        return None
    xm = _mean(xs)
    ym = _mean(ys)
    xv = sum((x - xm) ** 2 for x in xs)
    yv = sum((y - ym) ** 2 for y in ys)
    if xv <= 0 or yv <= 0:
        return None
    cov = sum((x - xm) * (y - ym) for x, y in zip(xs, ys, strict=True))
    return cov / math.sqrt(xv * yv)


def _row_for_extractors(row: dict[str, Any]) -> dict[str, Any]:
    out = dict(row)
    allocation = _loads(row.get("alpha_allocation"))
    forecast_data = _loads(row.get("forecast_data"))
    for source in (allocation, forecast_data):
        for key in ("l4_alpha_ev", "alpha_ev", "alpha_ev_prediction", "s12_trade_ev"):
            if isinstance(source.get(key), dict) and key not in out:
                out[key] = source[key]
        fusion = source.get("allocator_ev_fusion") if isinstance(source.get("allocator_ev_fusion"), dict) else {}
        if fusion:
            if isinstance(fusion.get("l4_alpha_ev"), dict) and "l4_alpha_ev" not in out:
                out["l4_alpha_ev"] = fusion["l4_alpha_ev"]
            if isinstance(fusion.get("s12_trade_ev"), dict) and "s12_trade_ev" not in out:
                out["s12_trade_ev"] = fusion["s12_trade_ev"]
    return out


def _market_heat(row: dict[str, Any]) -> float:
    allocation = _loads(row.get("alpha_allocation"))
    alpha_context = _loads(row.get("alpha_context"))
    forecast_data = _loads(row.get("forecast_data"))
    for value in (
        row.get("market_heat_expected_return"),
        allocation.get("market_heat_expected_return"),
        alpha_context.get("market_heat_expected_return"),
        forecast_data.get("market_heat_expected_return"),
    ):
        number = _float_or_none(value)
        if number is not None:
            return number
    return 0.0


def _component(score_components: dict[str, Any], name: str) -> float | None:
    components = score_components.get("components")
    if not isinstance(components, dict):
        return None
    return _float_or_none(components.get(name))


def _score_feature_era(row: dict[str, Any]) -> str:
    version = str(_loads(row.get("score_components")).get("version") or "").strip().lower()
    return version or "legacy_unversioned"


def _selection_raw_features(row: dict[str, Any]) -> dict[str, float]:
    score_components = _loads(row.get("score_components"))
    forecast_data = _loads(row.get("forecast_data"))
    ev2 = forecast_data.get("ensemble_v2") if isinstance(forecast_data.get("ensemble_v2"), dict) else {}
    final_score = _float_or_none(
        score_components.get("finalScore")
        or score_components.get("total")
        or row.get("score")
    )
    ml_edge = _component(score_components, "mlEdge")
    fundamental = _component(score_components, "fundamentalQuality")
    chip = _component(score_components, "chipFlow")
    technical = _component(score_components, "technicalStructure")
    avg_rank = _float_or_none(ev2.get("avg_rank"))
    score_values = (final_score, ml_edge, fundamental, chip, technical)
    return {
        "ml_edge_norm": (ml_edge / 25.0) if ml_edge is not None else 0.0,
        "fundamental_quality_norm": (fundamental / 25.0) if fundamental is not None else 0.0,
        "chip_flow_norm": (chip / 25.0) if chip is not None else 0.0,
        "technical_structure_norm": (technical / 25.0) if technical is not None else 0.0,
        "ensemble_directional_margin": (avg_rank - 0.5) if avg_rank is not None else 0.0,
        "score_v2_available": 1.0 if all(value is not None for value in score_values) else 0.0,
        "ensemble_rank_available": 1.0 if avg_rank is not None else 0.0,
        **sector_alpha_feature_values(row),
    }


def _l4_usage_scope(row: dict[str, Any]) -> str:
    if str(row.get("generation_mode") or "").strip() == "purged_oof":
        return PURGED_OOF_USAGE_SCOPE
    if (
        str(row.get("allocator_ev_feature_snapshot_source") or "").strip() == SNAPSHOT_BACKFILL_SOURCE
        and str(row.get("allocator_ev_feature_snapshot_guard") or "").strip()
        == SNAPSHOT_BACKFILL_AS_OF_GUARD
    ):
        return SNAPSHOT_BACKFILL_USAGE_SCOPE
    return "production"


def _date_strictly_before(left: Any, right: Any) -> bool:
    try:
        return date.fromisoformat(str(left)[:10]) < date.fromisoformat(str(right)[:10])
    except (TypeError, ValueError):
        return False


def _resolve_l4_feature(
    row: dict[str, Any],
) -> tuple[float | None, dict[str, Any] | None, list[str]]:
    extractor_row = _row_for_extractors(row)
    usage_scope = _l4_usage_scope(row)
    l4_value, l4_source, l4_payload = extract_l4_alpha_ev(
        extractor_row,
        usage_scope=usage_scope,
    )
    blockers = [
        str(value).strip()
        for value in ((l4_payload or {}).get("blockers") or [])
        if str(value).strip()
    ]
    signal_date = str(
        row.get("prediction_date") or row.get("snapshot_date") or row.get("date") or ""
    )[:10]
    l4_point_in_time = False
    if l4_value is not None and isinstance(l4_payload, dict):
        l4_point_in_time = _date_strictly_before(
            l4_payload.get("trained_until"),
            signal_date,
        )
        if usage_scope in {SNAPSHOT_BACKFILL_USAGE_SCOPE, PURGED_OOF_USAGE_SCOPE}:
            lineage = (
                l4_payload.get("point_in_time_prediction_lineage")
                if isinstance(l4_payload.get("point_in_time_prediction_lineage"), dict)
                else {}
            )
            l4_point_in_time = (
                l4_point_in_time
                and lineage.get("schema_version") == "l4-point-in-time-prediction-lineage-v1"
                and str(lineage.get("prediction_date") or "")[:10] == signal_date
                and _date_strictly_before(lineage.get("trained_until"), signal_date)
            )
    if l4_value is not None and not l4_point_in_time:
        blockers.append("l4_point_in_time_lineage_invalid")
    if l4_value is None and not blockers:
        blockers.append(str(l4_source or "l4_alpha_ev_missing"))
    return (
        l4_value if l4_point_in_time else None,
        l4_payload,
        list(dict.fromkeys(blockers)),
    )


def _feature_vector(
    row: dict[str, Any],
    *,
    l4_state: tuple[float | None, dict[str, Any] | None, list[str]] | None = None,
) -> dict[str, float] | None:
    if _score_feature_era(row) != CANONICAL_SCORE_FEATURE_VERSION:
        return None
    score_payload = _loads(row.get("score_components"))
    forecast_payload = _loads(row.get("forecast_data"))
    ensemble_payload = forecast_payload.get("ensemble_v2") if isinstance(forecast_payload.get("ensemble_v2"), dict) else {}
    if ev_feature_lineage_blockers(row):
        return None
    extractor_row = _row_for_extractors(row)
    l4_value, _l4_payload, _l4_blockers = l4_state or _resolve_l4_feature(row)
    s12_value, _s12_source, s12_payload = extract_s12_trade_ev(extractor_row)
    l4_available = 1.0 if l4_value is not None else 0.0
    if l4_value is None:
        l4_value = 0.0
    s12_available = 1.0
    if s12_value is None:
        s12_value = 0.0
        s12_available = 0.0
    target_state = _target_quality_state(s12_payload)
    return {
        **_selection_raw_features(row),
        "l4_expected_return": float(l4_value),
        "l4_available": l4_available,
        "l4_point_in_time_available": l4_available,
        "s12_trade_expected_return": float(s12_value),
        "s12_available": s12_available,
        "s12_execution_ready": _s12_execution_ready(s12_payload),
        "s12_context_multiplier": _s12_multiplier(s12_payload),
        "s12_target_quality_score": _target_quality_numeric(target_state),
        "market_heat_expected_return": _market_heat(row),
        "l4_s12_edge_agreement": 1.0 if (l4_value > 0 and s12_value > 0) or (l4_value <= 0 and s12_value <= 0) else 0.0,
        **_s12_structure_features(s12_payload),
        **market_context_feature_values(
            row,
            l4_value=l4_value,
            s12_value=s12_value,
        ),
    }


def _bounded_return(row: dict[str, Any], key: str) -> float | None:
    value = _float_or_none(row.get(key))
    return value if value is not None and -1.0 < value < 1.0 else None


def _s12_replay_observation_kind(row: dict[str, Any]) -> str:
    explicit = str(row.get("s12_replay_observation_kind") or "").strip().lower()
    if explicit in {"executed", "not_executed", "unavailable"}:
        return explicit
    status = str(row.get("s12_replay_status") or "").strip().lower()
    reason = str(row.get("s12_replay_archetype") or "").strip().lower()
    if status == "executed" or _bounded_return(row, "s12_replay_pnl_pct") is not None:
        return "executed"
    if status == "setup_only":
        return "not_executed"
    if status == "skipped":
        if reason in {
            "missing_intraday_bars",
            "missing_entry_session_bars",
            "missing_post_entry_bars",
        }:
            return "unavailable"
        return "not_executed"
    # Historical rows used "not_triggered" before observation_kind existed.
    if status == "not_triggered":
        return "not_executed"
    return "unavailable"


def _samples(
    rows: list[dict[str, Any]],
    *,
    execution_cost_bps: float = 0.0,
    min_cross_section_samples_per_date: int = MIN_CROSS_SECTION_SAMPLES_PER_DATE,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    out: list[dict[str, Any]] = []
    invalid = 0
    missing_features = 0
    rejected_feature_era_rows = 0
    feature_era_counts: dict[str, int] = {}
    lineage_blocker_counts: dict[str, int] = {}
    adjustment_lineage_counts: dict[str, int] = {}
    l4_resolver_blocker_counts: dict[str, int] = {}
    invalid_reason_counts: dict[str, int] = {}
    for row in rows:
        feature_era = _score_feature_era(row)
        feature_era_counts[feature_era] = feature_era_counts.get(feature_era, 0) + 1
        if feature_era != CANONICAL_SCORE_FEATURE_VERSION:
            rejected_feature_era_rows += 1
        lineage_blockers = ev_feature_lineage_blockers(row)
        for blocker in lineage_blockers:
            lineage_blocker_counts[blocker] = lineage_blocker_counts.get(blocker, 0) + 1
        adjustment_source = str(row.get("label_adjustment_source") or "missing")
        adjustment_lineage_counts[adjustment_source] = adjustment_lineage_counts.get(adjustment_source, 0) + 1
        generation_mode = str(row.get("generation_mode") or "native").strip().lower()
        expected_adjustment_source = expected_price_horizon_source(generation_mode)
        l4_state = _resolve_l4_feature(row)
        for blocker in l4_state[2]:
            l4_resolver_blocker_counts[blocker] = l4_resolver_blocker_counts.get(blocker, 0) + 1
        features = _feature_vector(row, l4_state=l4_state)
        selection_gross_target = (
            _bounded_return(row, "l4_executable_return_pct")
            if adjustment_source == expected_adjustment_source
            else None
        )
        selection_target = (
            selection_gross_target - max(0.0, execution_cost_bps) / 10000.0
            if selection_gross_target is not None
            else None
        )
        if features is None:
            missing_features += 1
            invalid += 1
            reason = (
                "feature_era_incompatible"
                if feature_era != CANONICAL_SCORE_FEATURE_VERSION
                else "feature_lineage_blocked"
                if lineage_blockers
                else "feature_vector_missing_or_invalid"
            )
            invalid_reason_counts[reason] = invalid_reason_counts.get(reason, 0) + 1
            continue
        if selection_target is None:
            invalid += 1
            reason = (
                f"adjustment_source_mismatch:{generation_mode}"
                if adjustment_source != expected_adjustment_source
                else "target_missing_or_out_of_bounds"
            )
            invalid_reason_counts[reason] = invalid_reason_counts.get(reason, 0) + 1
            continue
        day = str(
            row.get("prediction_date")
            or row.get("snapshot_date")
            or row.get("date")
            or ""
        )[:10] or "unknown"
        replay_target = _bounded_return(row, "s12_replay_pnl_pct")
        actual_trade_target = _bounded_return(row, "trade_pnl_pct")
        trade_target = replay_target
        replay_status = str(row.get("s12_replay_status") or "").strip().lower()
        replay_archetype = str(row.get("s12_replay_archetype") or "").strip().lower()
        observation_kind = _s12_replay_observation_kind(row)
        execution_observed = observation_kind in {"executed", "not_executed"}
        s12_available = float(features.get("s12_available") or 0.0) > 0.0
        execution_target = (
            trade_target - max(0.0, execution_cost_bps) / 10000.0
            if trade_target is not None
            else None
        )
        realized_trade_ev_target = (
            execution_target
            if execution_target is not None
            else 0.0
            if execution_observed
            else None
        )
        out.append({
            "date": day,
            "symbol": row.get("symbol"),
            "market_segment": str(row.get("market_segment") or "UNKNOWN").strip() or "UNKNOWN",
            "sector": str(row.get("sector") or "UNKNOWN").strip() or "UNKNOWN",
            "regime_bucket": market_regime_bucket(row),
            "features": features,
            "target": selection_target,
            "actual_return_target": selection_target,
            "selection_target": selection_target,
            "trade_target": trade_target,
            "execution_target": execution_target,
            "realized_trade_ev_target": realized_trade_ev_target,
            "execution_probability_target": (
                1.0 if observation_kind == "executed" else 0.0
            ) if execution_observed else None,
            "execution_observation_kind": observation_kind,
            "execution_label_source": (
                "s12_replay_trade_outcomes"
                if observation_kind == "executed"
                else "s12_replay_non_execution"
                if observation_kind == "not_executed"
                else None
            ),
            "execution_archetype": replay_archetype or None,
            "actual_trade_target_audit_only": actual_trade_target,
        })
    raw_day_counts: dict[str, int] = {}
    for sample in out:
        raw_day_counts[sample["date"]] = raw_day_counts.get(sample["date"], 0) + 1
    minimum_day_samples = max(1, int(min_cross_section_samples_per_date))
    sparse_dates = sorted(day for day, count in raw_day_counts.items() if count < minimum_day_samples)
    sparse_date_set = set(sparse_dates)
    sparse_date_rows_rejected = sum(raw_day_counts[day] for day in sparse_dates)
    if sparse_date_set:
        out = [sample for sample in out if sample["date"] not in sparse_date_set]
        invalid += sparse_date_rows_rejected
    by_day: dict[str, list[dict[str, Any]]] = {}
    by_day_segment: dict[tuple[str, str], list[dict[str, Any]]] = {}
    by_day_sector: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for sample in out:
        by_day.setdefault(sample["date"], []).append(sample)
        by_day_segment.setdefault((sample["date"], sample["market_segment"]), []).append(sample)
        by_day_sector.setdefault((sample["date"], sample["sector"]), []).append(sample)
    for day, day_samples in by_day.items():
        day_mean = _mean([float(sample["actual_return_target"]) for sample in day_samples])
        for sample in day_samples:
            segment_samples = by_day_segment.get((day, sample["market_segment"]), [])
            sector_samples = by_day_sector.get((day, sample["sector"]), [])
            benchmark = (
                _mean([float(item["actual_return_target"]) for item in sector_samples])
                if sample["sector"] != "UNKNOWN" and len(sector_samples) >= 5
                else _mean([float(item["actual_return_target"]) for item in segment_samples])
                if sample["market_segment"] != "UNKNOWN" and len(segment_samples) >= 5
                else day_mean
            )
            sample["selection_target"] = float(sample["actual_return_target"]) - benchmark
            sample["target"] = sample["selection_target"]
        ranked = sorted(day_samples, key=lambda item: (float(item["selection_target"]), str(item.get("symbol") or "")))
        denominator = max(1, len(ranked) - 1)
        for idx, sample in enumerate(ranked):
            sample["selection_rank_target"] = (idx / denominator) - 0.5 if len(ranked) > 1 else 0.0
    s12_ready_count = sum(
        1
        for sample in out
        if float(sample["features"].get("s12_execution_ready") or 0.0) > 0.0
    )
    s12_available_count = sum(
        1
        for sample in out
        if float(sample["features"].get("s12_available") or 0.0) > 0.0
    )
    l4_available_samples = [
        sample for sample in out
        if float(sample["features"].get("l4_available") or 0.0) > 0.0
    ]
    s12_structure_samples = [
        sample for sample in out
        if float(sample["features"].get("s12_structure_available") or 0.0) > 0.0
    ]
    full_reaction_samples = [
        sample for sample in out
        if float(sample["features"].get("s12_full_reaction_ready") or 0.0) > 0.0
    ]
    limited_takeover_samples = [
        sample for sample in out
        if float(sample["features"].get("s12_limited_takeover_ready") or 0.0) > 0.0
    ]
    execution_samples = [sample for sample in out if sample["execution_target"] is not None]
    execution_observation_samples = [
        sample for sample in out if sample["execution_probability_target"] is not None
    ]
    market_context_samples = [
        sample for sample in out
        if float(sample["features"].get("market_context_available") or 0.0) > 0.0
    ]
    regime_surface_samples = [
        sample for sample in out
        if float(sample["features"].get("regime_surface_available") or 0.0) > 0.0
    ]
    sector_alpha_samples = [
        sample for sample in out
        if float(sample["features"].get("sector_alpha_available") or 0.0) > 0.0
    ]
    return out, {
        "input_rows": len(rows),
        "sample_count": len(out),
        "invalid_rows": invalid,
        "missing_feature_rows": missing_features,
        "accepted_feature_era": CANONICAL_SCORE_FEATURE_VERSION,
        "feature_era_counts": dict(sorted(feature_era_counts.items())),
        "rejected_feature_era_rows": rejected_feature_era_rows,
        "lineage_blocker_counts": dict(sorted(lineage_blocker_counts.items())),
        "l4_resolver_blocker_counts": dict(sorted(l4_resolver_blocker_counts.items())),
        "required_adjustment_factor_source": CANONICAL_ADJUSTMENT_FACTOR_SOURCE,
        "required_adjustment_factor_sources": {
            "native": PRICE_HORIZON_SOURCE,
            "purged_oof": OOF_PRICE_HORIZON_SOURCE,
        },
        "adjustment_lineage_counts": dict(sorted(adjustment_lineage_counts.items())),
        "invalid_reason_counts": dict(sorted(invalid_reason_counts.items())),
        "feature_era_policy": {
            "mode": "strict_canonical_only",
            "accepted_versions": [CANONICAL_SCORE_FEATURE_VERSION],
            "legacy_direct_training_allowed": False,
            "counterfactual_rebuild_requires_explicit_versioned_snapshot": True,
        },
        "min_cross_section_samples_per_date": minimum_day_samples,
        "sparse_dates_rejected": sparse_dates,
        "sparse_date_rows_rejected": sparse_date_rows_rejected,
        "raw_date_counts": dict(sorted(raw_day_counts.items())),
        "date_count": len({row["date"] for row in out}),
        "oof_min_date": min((row["date"] for row in out), default=None),
        "oof_max_date": max((row["date"] for row in out), default=None),
        "s12_ready_count": s12_ready_count,
        "s12_available_count": s12_available_count,
        "s12_available_date_count": len({row["date"] for row in out if row["features"]["s12_available"] > 0.0}),
        "l4_available_count": len(l4_available_samples),
        "l4_available_date_count": len({row["date"] for row in l4_available_samples}),
        "l4_available_coverage": round(len(l4_available_samples) / len(out), 8) if out else 0.0,
        "l4_point_in_time_available_count": len(l4_available_samples),
        "l4_point_in_time_available_date_count": len({row["date"] for row in l4_available_samples}),
        "s12_structure_available_count": len(s12_structure_samples),
        "s12_structure_available_date_count": len({row["date"] for row in s12_structure_samples}),
        "s12_structure_available_coverage": round(len(s12_structure_samples) / len(out), 8) if out else 0.0,
        "s12_full_reaction_count": len(full_reaction_samples),
        "s12_full_reaction_date_count": len({row["date"] for row in full_reaction_samples}),
        "s12_limited_takeover_count": len(limited_takeover_samples),
        "s12_limited_takeover_date_count": len({row["date"] for row in limited_takeover_samples}),
        "execution_sample_count": len(execution_samples),
        "execution_date_count": len({row["date"] for row in execution_samples}),
        "execution_observation_count": len(execution_observation_samples),
        "execution_observation_date_count": len({row["date"] for row in execution_observation_samples}),
        "market_context_available_count": len(market_context_samples),
        "market_context_available_date_count": len({row["date"] for row in market_context_samples}),
        "market_context_available_coverage": round(len(market_context_samples) / len(out), 8) if out else 0.0,
        "regime_surface_available_count": len(regime_surface_samples),
        "regime_surface_available_date_count": len({row["date"] for row in regime_surface_samples}),
        "regime_surface_available_coverage": round(len(regime_surface_samples) / len(out), 8) if out else 0.0,
        "sector_alpha_available_count": len(sector_alpha_samples),
        "sector_alpha_available_date_count": len({row["date"] for row in sector_alpha_samples}),
        "sector_alpha_available_coverage": round(len(sector_alpha_samples) / len(out), 8) if out else 0.0,
        "regime_bucket_counts": {
            bucket: sum(1 for row in out if row.get("regime_bucket") == bucket)
            for bucket in sorted({str(row.get("regime_bucket")) for row in out})
        },
        "execution_observation_kind_counts": {
            kind: sum(1 for row in out if row.get("execution_observation_kind") == kind)
            for kind in sorted({str(row.get("execution_observation_kind")) for row in out if row.get("execution_observation_kind")})
        },
        "execution_label_source_counts": {
            source: sum(1 for row in out if row.get("execution_label_source") == source)
            for source in sorted({str(row.get("execution_label_source")) for row in out if row.get("execution_label_source")})
        },
        "execution_archetype_counts": {
            archetype: sum(1 for row in out if row.get("execution_archetype") == archetype)
            for archetype in sorted({str(row.get("execution_archetype")) for row in out if row.get("execution_archetype")})
        },
        "s12_ready_coverage": round(s12_ready_count / len(out), 8) if out else 0.0,
        "s12_available_coverage": round(s12_available_count / len(out), 8) if out else 0.0,
        "target_policy": {
            "selection": "same_date_sector_or_segment_or_market_cross_section_residual_of_five_session_net_return",
            "selection_absolute_audit": "next_session_adjusted_open_to_fifth_session_adjusted_close_net_of_costs",
            "final_trade_ev": "absolute_s12_realized_trade_ev_net_of_costs_not_cross_section_rank",
            "selection_label_schema_version": LABEL_SCHEMA_VERSION,
            "execution_trade_return": "five_session_canonical_s12_lifecycle_pnl_net_of_roundtrip_cost_when_executed",
            "full_trade_ev": "zero_only_for_observed_non_execution;unavailable_excluded;executed_uses_multisession_canonical_replay_net_pnl",
            "execution_label_availability": "replay_execution_outcome_independent_of_prior_s12_ev_availability",
            "execution_probability": "canonical_s12_replay_execution_indicator",
            "label_known_at": "replay_exit_ms_strictly_before_as_of_date",
            "actual_trade_outcome_role": "audit_only_not_training_label",
            "rowwise_label_coalesce": False,
        },
    }


def _solve_linear_system(a: list[list[float]], b: list[float]) -> list[float] | None:
    n = len(b)
    mat = [row[:] + [b[idx]] for idx, row in enumerate(a)]
    for col in range(n):
        pivot = max(range(col, n), key=lambda r: abs(mat[r][col]))
        if abs(mat[pivot][col]) < 1e-12:
            return None
        mat[col], mat[pivot] = mat[pivot], mat[col]
        scale = mat[col][col]
        mat[col] = [value / scale for value in mat[col]]
        for row in range(n):
            if row == col:
                continue
            factor = mat[row][col]
            if abs(factor) <= 1e-18:
                continue
            mat[row] = [value - factor * mat[col][idx] for idx, value in enumerate(mat[row])]
    return [mat[row][-1] for row in range(n)]


def _fit_ridge(
    samples: list[dict[str, Any]],
    *,
    l2: float,
    feature_names: list[str],
    target_key: str = "target",
) -> tuple[float, dict[str, float]]:
    p = len(feature_names) + 1
    xtx = [[0.0 for _ in range(p)] for _ in range(p)]
    xty = [0.0 for _ in range(p)]
    for sample in samples:
        x = [1.0, *[float(sample["features"][name]) for name in feature_names]]
        y = float(sample[target_key])
        for i in range(p):
            xty[i] += x[i] * y
            for j in range(p):
                xtx[i][j] += x[i] * x[j]
    for i in range(1, p):
        xtx[i][i] += l2
    solved = _solve_linear_system(xtx, xty)
    if solved is None:
        raise ValueError("allocator_ev_fusion_ridge_fit_singular_matrix")
    return solved[0], {name: solved[idx + 1] for idx, name in enumerate(feature_names)}


def _predict(sample: dict[str, Any], intercept: float, coefs: dict[str, float]) -> float:
    return intercept + sum(coef * float(sample["features"][name]) for name, coef in coefs.items())


def _linear_calibration_from_pairs(
    pairs: list[tuple[float, float]],
    *,
    l2: float,
) -> tuple[float, float]:
    xs = [pair[0] for pair in pairs]
    ys = [pair[1] for pair in pairs]
    xm = _mean(xs)
    ym = _mean(ys)
    covariance = sum((x - xm) * (y - ym) for x, y in zip(xs, ys, strict=True))
    variance = sum((x - xm) ** 2 for x in xs) + max(0.0, l2)
    slope = covariance / variance if variance > 1e-12 else 0.0
    return ym - slope * xm, slope


def _expanding_oof_pairs(
    samples: list[dict[str, Any]],
    *,
    feature_names: list[str],
    rank_target_key: str,
    calibration_target_key: str,
    l2: float,
    folds: int = 4,
) -> list[tuple[float, float]]:
    dates = sorted({str(sample["date"]) for sample in samples})
    if len(dates) < 3:
        return []
    first_test_idx = max(1, len(dates) // (folds + 1))
    test_date_groups = [group for group in _split_date_groups(dates[first_test_idx:], folds) if group]
    pairs: list[tuple[float, float]] = []
    for test_dates_list in test_date_groups:
        first_test_date = test_dates_list[0]
        first_test_index = dates.index(first_test_date)
        train_dates = set(dates[:max(0, first_test_index - LABEL_PURGE_DATE_GROUPS)])
        test_dates = set(test_dates_list)
        train = [sample for sample in samples if sample["date"] in train_dates]
        test = [sample for sample in samples if sample["date"] in test_dates]
        if len(train) < len(feature_names) + 2 or not test:
            continue
        intercept, coefs = _fit_ridge(
            train,
            l2=l2,
            feature_names=feature_names,
            target_key=rank_target_key,
        )
        pairs.extend(
            (_predict(sample, intercept, coefs), float(sample[calibration_target_key]))
            for sample in test
        )
    return pairs


def _training_fit_calibration_pairs(
    samples: list[dict[str, Any]],
    *,
    feature_names: list[str],
    rank_target_key: str,
    calibration_target_key: str,
    l2: float,
) -> list[tuple[float, float]]:
    """Fit calibration on past training data; outer temporal OOS remains untouched."""
    if len(samples) < len(feature_names) + 2:
        return []
    intercept, coefs = _fit_ridge(
        samples,
        l2=l2,
        feature_names=feature_names,
        target_key=rank_target_key,
    )
    return [
        (_predict(sample, intercept, coefs), float(sample[calibration_target_key]))
        for sample in samples
    ]


def _calibration_pairs(
    samples: list[dict[str, Any]],
    *,
    feature_names: list[str],
    rank_target_key: str,
    calibration_target_key: str,
    l2: float,
) -> tuple[list[tuple[float, float]], str]:
    pairs = _expanding_oof_pairs(
        samples,
        feature_names=feature_names,
        rank_target_key=rank_target_key,
        calibration_target_key=calibration_target_key,
        l2=l2,
    )
    if pairs:
        return pairs, "expanding_window_oof_rank_score_linear_ev_calibration"
    return (
        _training_fit_calibration_pairs(
            samples,
            feature_names=feature_names,
            rank_target_key=rank_target_key,
            calibration_target_key=calibration_target_key,
            l2=l2,
        ),
        "past_train_fit_rank_score_linear_ev_calibration_outer_temporal_oos",
    )


def _split_date_groups(dates: list[str], groups: int) -> list[list[str]]:
    if not dates:
        return []
    group_count = max(1, min(groups, len(dates)))
    chunk_size = math.ceil(len(dates) / group_count)
    return [dates[idx:idx + chunk_size] for idx in range(0, len(dates), chunk_size)]


def _compose_calibrated_model(
    intercept: float,
    coefs: dict[str, float],
    calibration_intercept: float,
    calibration_slope: float,
) -> tuple[float, dict[str, float]]:
    return (
        calibration_intercept + calibration_slope * intercept,
        {name: calibration_slope * value for name, value in coefs.items()},
    )


def _metrics(
    samples: list[dict[str, Any]],
    intercept: float,
    coefs: dict[str, float],
    *,
    target_key: str = "target",
) -> dict[str, Any]:
    if not samples:
        return {"samples": 0}
    pairs = [(_predict(sample, intercept, coefs), float(sample[target_key])) for sample in samples]
    preds = [item[0] for item in pairs]
    targets = [item[1] for item in pairs]
    errors = [pred - target for pred, target in pairs]
    by_date: dict[str, list[tuple[float, float]]] = {}
    for sample, pair in zip(samples, pairs, strict=True):
        by_date.setdefault(str(sample["date"]), []).append(pair)
    daily_top: list[float] = []
    daily_bottom: list[float] = []
    daily_spreads: list[float] = []
    daily_corrs: list[float] = []
    for day_pairs in by_date.values():
        ranked = sorted(day_pairs, key=lambda item: item[0])
        bucket = max(1, len(ranked) // 5)
        top_mean = _mean([target for _, target in ranked[-bucket:]])
        bottom_mean = _mean([target for _, target in ranked[:bucket]])
        daily_top.append(top_mean)
        daily_bottom.append(bottom_mean)
        daily_spreads.append(top_mean - bottom_mean)
        day_corr = _corr(
            [prediction for prediction, _ in day_pairs],
            [target for _, target in day_pairs],
        )
        if day_corr is not None:
            daily_corrs.append(day_corr)

    spread = _mean(daily_spreads)
    corr = _mean(daily_corrs) if daily_corrs else None
    corr_lcb = _date_cluster_lcb90(daily_corrs)
    spread_lcb = _date_cluster_lcb90(daily_spreads)
    return {
        "samples": len(samples),
        "mean_target": round(_mean(targets), 8),
        "mean_prediction": round(_mean(preds), 8),
        "mae": round(_mean([abs(err) for err in errors]), 8),
        "rmse": round(math.sqrt(_mean([err * err for err in errors])), 8),
        "prediction_target_corr": None if corr is None else round(corr, 8),
        "prediction_target_corr_lcb90": None if corr_lcb is None else round(corr_lcb, 8),
        "oos_date_count": len(by_date),
        "top_quintile_mean_return": round(_mean(daily_top), 8),
        "bottom_quintile_mean_return": round(_mean(daily_bottom), 8),
        "top_bottom_spread": round(spread, 8),
        "top_bottom_spread_lcb90": None if spread_lcb is None else round(spread_lcb, 8),
        "uncertainty_unit": "prediction_date",
    }


def _sample_variance(values: list[float]) -> float:
    if len(values) < 2:
        return 0.0
    mean = _mean(values)
    return sum((value - mean) ** 2 for value in values) / (len(values) - 1)


def _date_cluster_lcb90(values: list[float]) -> float | None:
    if len(values) < 2:
        return None
    standard_error = math.sqrt(_sample_variance(values) / len(values))
    critical_value = float(student_t.ppf(0.95, df=len(values) - 1))
    return _mean(values) - critical_value * standard_error


def _benchmark_panel_contract(
    samples: list[dict[str, Any]],
    *,
    cost_model_bps: float,
    expected_panel_id: str | None,
) -> dict[str, Any]:
    rows = [
        {
            "date": str(sample.get("date") or ""),
            "symbol": str(sample.get("symbol") or ""),
            "selection_target": round(float(sample.get("selection_target") or 0.0), 10),
            "execution_target": (
                None if sample.get("execution_target") is None
                else round(float(sample["execution_target"]), 10)
            ),
            "execution_probability_target": sample.get("execution_probability_target"),
        }
        for sample in sorted(
            samples,
            key=lambda item: (str(item.get("date") or ""), str(item.get("symbol") or "")),
        )
    ]
    payload = {
        "schema_version": "allocator-ev-fusion-benchmark-panel-v1",
        "label_schema_version": LABEL_SCHEMA_VERSION,
        "feature_semantic_version": FEATURE_SEMANTIC_VERSION,
        "cost_model_bps": round(float(cost_model_bps), 8),
        "rows": rows,
    }
    checksum = hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    computed_id = f"fusion-panel-v1:{checksum}"
    return {
        "schema_version": "allocator-ev-fusion-benchmark-panel-v1",
        "panel_id": computed_id,
        "expected_panel_id": expected_panel_id,
        "locked": expected_panel_id in {None, computed_id},
        "comparison_scope": "same_dates_symbols_labels_costs_and_feature_semantics",
        "row_count": len(rows),
        "date_count": len({row["date"] for row in rows}),
        "label_schema_version": LABEL_SCHEMA_VERSION,
        "feature_semantic_version": FEATURE_SEMANTIC_VERSION,
        "cost_model_bps": round(float(cost_model_bps), 8),
    }


def _multiple_testing_gate(
    search_trial_count: int,
    evidence: dict[str, Any] | None,
) -> dict[str, Any]:
    trials = max(1, int(search_trial_count))
    record = evidence if isinstance(evidence, dict) else {}
    method = str(record.get("method") or "").strip().lower()
    allowed_methods = {"white_reality_check", "hansen_spa", "deflated_sharpe_ratio"}
    adjusted_p_value = _float_or_none(record.get("adjusted_p_value"))
    passed = (
        trials == 1
        or (
            method in allowed_methods
            and record.get("passed") is True
            and (adjusted_p_value is None or adjusted_p_value <= 0.10)
        )
    )
    failed_gates: list[str] = []
    if trials > 1 and method not in allowed_methods:
        failed_gates.append("approved_correction_missing")
    if trials > 1 and record.get("passed") is not True:
        failed_gates.append("corrected_test_not_passed")
    if trials > 1 and adjusted_p_value is not None and adjusted_p_value > 0.10:
        failed_gates.append("adjusted_p_value_gt_0_10")
    return {
        "schema_version": "fusion-multiple-testing-gate-v1",
        "decision": "PASS" if passed else "FAIL",
        "failed_gates": sorted(set(failed_gates)),
        "search_trial_count": trials,
        "method": method or ("not_required_single_trial" if trials == 1 else None),
        "adjusted_p_value": adjusted_p_value,
        "passed": passed,
    }


def _date_cluster_ucb90(values: list[float]) -> float | None:
    if len(values) < 2:
        return None
    standard_error = math.sqrt(_sample_variance(values) / len(values))
    critical_value = float(student_t.ppf(0.95, df=len(values) - 1))
    return _mean(values) + critical_value * standard_error


def _supported_feature_names(
    samples: list[dict[str, Any]],
    feature_names: list[str],
    *,
    min_nonzero_samples: int,
    min_nonzero_dates: int,
) -> tuple[list[str], dict[str, str]]:
    supported: list[str] = []
    dropped: dict[str, str] = {}
    for name in feature_names:
        values = [float(sample["features"].get(name) or 0.0) for sample in samples]
        distinct = {round(value, 12) for value in values}
        if len(distinct) < 2:
            dropped[name] = "constant_in_training_window"
            continue
        nonzero_rows = [
            sample for sample, value in zip(samples, values, strict=True)
            if abs(value) > 1e-12
        ]
        if len(nonzero_rows) < min_nonzero_samples:
            dropped[name] = f"nonzero_samples_below_{min_nonzero_samples}"
            continue
        nonzero_dates = {str(sample["date"]) for sample in nonzero_rows}
        if len(nonzero_dates) < min_nonzero_dates:
            dropped[name] = f"nonzero_dates_below_{min_nonzero_dates}"
            continue
        supported.append(name)
    return supported, dropped


def _paired_canonical_l4_comparison(
    samples: list[dict[str, Any]],
    *,
    fusion_intercept: float,
    fusion_coefficients: dict[str, float],
) -> dict[str, Any]:
    """Compare Fusion and canonical L4 on identical OOS dates and candidates."""

    dates = sorted({str(sample["date"]) for sample in samples})
    split_idx = max(1, round(len(dates) * TEMPORAL_TRAIN_FRACTION)) if dates else 0
    test_dates = set(dates[split_idx:])
    test = [
        sample for sample in samples
        if sample["date"] in test_dates
        and float(sample["features"].get("l4_available") or 0.0) > 0.0
    ]
    by_date: dict[str, list[dict[str, Any]]] = {}
    for sample in test:
        by_date.setdefault(str(sample["date"]), []).append(sample)

    correlation_deltas: list[float] = []
    spread_deltas: list[float] = []
    prediction_correlations: list[float] = []
    daily: list[dict[str, Any]] = []
    for day, rows in sorted(by_date.items()):
        if len(rows) < 3:
            continue
        targets = [float(row["selection_target"]) for row in rows]
        fusion_predictions = [_predict(row, fusion_intercept, fusion_coefficients) for row in rows]
        canonical_predictions = [float(row["features"]["l4_expected_return"]) for row in rows]
        fusion_corr = _corr(fusion_predictions, targets)
        canonical_corr = _corr(canonical_predictions, targets)
        prediction_corr = _corr(fusion_predictions, canonical_predictions)
        if prediction_corr is not None:
            prediction_correlations.append(prediction_corr)

        def spread(predictions: list[float]) -> float:
            ranked = sorted(zip(predictions, targets, strict=True), key=lambda item: item[0])
            bucket = max(1, len(ranked) // 5)
            return _mean([target for _prediction, target in ranked[-bucket:]]) - _mean(
                [target for _prediction, target in ranked[:bucket]]
            )

        fusion_spread = spread(fusion_predictions)
        canonical_spread = spread(canonical_predictions)
        spread_delta = fusion_spread - canonical_spread
        spread_deltas.append(spread_delta)
        correlation_delta = None
        if fusion_corr is not None and canonical_corr is not None:
            correlation_delta = fusion_corr - canonical_corr
            correlation_deltas.append(correlation_delta)
        daily.append({
            "date": day,
            "samples": len(rows),
            "fusion_corr": None if fusion_corr is None else round(fusion_corr, 8),
            "canonical_l4_corr": None if canonical_corr is None else round(canonical_corr, 8),
            "fusion_l4_prediction_corr": None if prediction_corr is None else round(prediction_corr, 8),
            "corr_delta": None if correlation_delta is None else round(correlation_delta, 8),
            "fusion_spread": round(fusion_spread, 8),
            "canonical_l4_spread": round(canonical_spread, 8),
            "spread_delta": round(spread_delta, 8),
        })

    corr_delta_lcb90 = _date_cluster_lcb90(correlation_deltas)
    spread_delta_lcb90 = _date_cluster_lcb90(spread_deltas)
    minimum_oos_dates = PRIMARY_MIN_OOS_DATES
    blockers: list[str] = []
    if len(daily) < minimum_oos_dates:
        blockers.append("paired_oos_dates_insufficient")
    if corr_delta_lcb90 is None or corr_delta_lcb90 < 0.0:
        blockers.append("fusion_corr_delta_lcb90_inferior_to_canonical_l4")
    if spread_delta_lcb90 is None or spread_delta_lcb90 < 0.0:
        blockers.append("fusion_spread_delta_lcb90_inferior_to_canonical_l4")
    return {
        "schema_version": "allocator-ev-fusion-champion-comparison-v1",
        "champion": "canonical_l4",
        "challenger": "allocator_ev_fusion_v12_selection_model",
        "comparison_unit": "paired_prediction_date_same_candidates",
        "decision": "PASS" if not blockers else "FAIL",
        "failed_gates": blockers,
        "samples": len(test),
        "oos_date_count": len(daily),
        "minimum_oos_dates": minimum_oos_dates,
        "fusion_l4_prediction_corr_mean": round(_mean(prediction_correlations), 8) if prediction_correlations else None,
        "corr_delta_mean": round(_mean(correlation_deltas), 8) if correlation_deltas else None,
        "corr_delta_lcb90": None if corr_delta_lcb90 is None else round(corr_delta_lcb90, 8),
        "spread_delta_mean": round(_mean(spread_deltas), 8) if spread_deltas else None,
        "spread_delta_lcb90": None if spread_delta_lcb90 is None else round(spread_delta_lcb90, 8),
        "daily": daily,
    }


def _paired_final_trade_ev_comparison(
    samples: list[dict[str, Any]],
    *,
    execution_model: dict[str, Any],
    execution_probability_model: dict[str, Any],
) -> dict[str, Any]:
    blockers: list[str] = []
    if execution_model.get("decision") != "PASS":
        blockers.append("conditional_execution_expert_not_validated")
    if execution_probability_model.get("decision") != "PASS":
        blockers.append("execution_probability_expert_not_validated")
    if blockers:
        return {
            "schema_version": "allocator-ev-fusion-final-champion-comparison-v1",
            "champion": "canonical_l4",
            "challenger": "allocator_ev_fusion_v12_final_trade_ev",
            "comparison_target": "realized_multisession_trade_ev_net_of_costs",
            "decision": "FAIL",
            "failed_gates": blockers,
            "samples": 0,
            "oos_date_count": 0,
            "daily": [],
        }

    dates = sorted({str(sample["date"]) for sample in samples})
    split_idx = max(1, round(len(dates) * TEMPORAL_TRAIN_FRACTION)) if dates else 0
    test_dates = set(dates[split_idx:])
    test = [
        sample for sample in samples
        if sample["date"] in test_dates
        and sample.get("realized_trade_ev_target") is not None
        and float(sample["features"].get("l4_available") or 0.0) > 0.0
    ]
    execution_validation_model = (
        execution_model.get("validation_model")
        if isinstance(execution_model.get("validation_model"), dict)
        else execution_model
    )
    probability_validation_model = (
        execution_probability_model.get("validation_model")
        if isinstance(execution_probability_model.get("validation_model"), dict)
        else execution_probability_model
    )
    execution_intercept = float(execution_validation_model.get("intercept") or 0.0)
    execution_coefs = {
        str(name): float(value)
        for name, value in (execution_validation_model.get("coefficients") or {}).items()
    }
    probability_intercept = float(probability_validation_model.get("intercept") or 0.0)
    probability_coefs = {
        str(name): float(value)
        for name, value in (probability_validation_model.get("coefficients") or {}).items()
    }

    by_date: dict[str, list[dict[str, Any]]] = {}
    for sample in test:
        by_date.setdefault(str(sample["date"]), []).append(sample)
    correlation_deltas: list[float] = []
    spread_deltas: list[float] = []
    daily_top_trade_ev: list[float] = []
    daily: list[dict[str, Any]] = []

    def spread(predictions: list[float], targets: list[float]) -> float:
        ranked = sorted(zip(predictions, targets, strict=True), key=lambda item: item[0])
        bucket = max(1, len(ranked) // 5)
        return _mean([target for _prediction, target in ranked[-bucket:]]) - _mean(
            [target for _prediction, target in ranked[:bucket]]
        )

    for day, rows in sorted(by_date.items()):
        if len(rows) < 3:
            continue
        targets = [float(row["realized_trade_ev_target"]) for row in rows]
        conditional = [_predict(row, execution_intercept, execution_coefs) for row in rows]
        probability_logits = [_predict(row, probability_intercept, probability_coefs) for row in rows]
        probabilities = [1.0 / (1.0 + math.exp(-max(-40.0, min(40.0, value)))) for value in probability_logits]
        fusion_predictions = [probability * value for probability, value in zip(probabilities, conditional, strict=True)]
        canonical_predictions = [float(row["features"]["l4_expected_return"]) for row in rows]
        fusion_corr = _corr(fusion_predictions, targets)
        canonical_corr = _corr(canonical_predictions, targets)
        fusion_spread = spread(fusion_predictions, targets)
        canonical_spread = spread(canonical_predictions, targets)
        ranked_trade_ev = sorted(
            zip(fusion_predictions, targets, strict=True),
            key=lambda item: item[0],
        )
        top_bucket = max(1, len(ranked_trade_ev) // 5)
        top_trade_ev = _mean([target for _prediction, target in ranked_trade_ev[-top_bucket:]])
        daily_top_trade_ev.append(top_trade_ev)
        regime_buckets = {str(row.get("regime_bucket") or "unclassified") for row in rows}
        regime_bucket = next(iter(regime_buckets)) if len(regime_buckets) == 1 else "mixed"
        spread_delta = fusion_spread - canonical_spread
        spread_deltas.append(spread_delta)
        correlation_delta = None
        if fusion_corr is not None and canonical_corr is not None:
            correlation_delta = fusion_corr - canonical_corr
            correlation_deltas.append(correlation_delta)
        daily.append({
            "date": day,
            "samples": len(rows),
            "fusion_corr": None if fusion_corr is None else round(fusion_corr, 8),
            "canonical_l4_corr": None if canonical_corr is None else round(canonical_corr, 8),
            "corr_delta": None if correlation_delta is None else round(correlation_delta, 8),
            "fusion_spread": round(fusion_spread, 8),
            "canonical_l4_spread": round(canonical_spread, 8),
            "spread_delta": round(spread_delta, 8),
            "fusion_top_trade_ev_mean": round(top_trade_ev, 8),
            "regime_bucket": regime_bucket,
        })

    minimum_oos_dates = PRIMARY_MIN_OOS_DATES
    corr_delta_lcb90 = _date_cluster_lcb90(correlation_deltas)
    spread_delta_lcb90 = _date_cluster_lcb90(spread_deltas)
    top_trade_ev_lcb90 = _date_cluster_lcb90(daily_top_trade_ev)
    regime_slices: dict[str, dict[str, Any]] = {}
    regime_blockers: list[str] = []
    minimum_supported_regime_dates = 3
    for regime in sorted({str(row.get("regime_bucket") or "unclassified") for row in daily}):
        values = [
            float(row["fusion_top_trade_ev_mean"])
            for row in daily
            if row.get("regime_bucket") == regime
        ]
        supported = regime not in {"unclassified", "mixed"} and len(values) >= minimum_supported_regime_dates
        lcb90 = _date_cluster_lcb90(values)
        ucb90 = _date_cluster_ucb90(values)
        confidently_negative = bool(supported and ucb90 is not None and ucb90 <= 0.0)
        if confidently_negative:
            regime_blockers.append(f"supported_regime_top_trade_ev_confidently_negative:{regime}")
        regime_slices[regime] = {
            "date_count": len(values),
            "supported": supported,
            "top_trade_ev_mean": round(_mean(values), 8) if values else None,
            "top_trade_ev_lcb90": None if lcb90 is None else round(lcb90, 8),
            "top_trade_ev_ucb90": None if ucb90 is None else round(ucb90, 8),
            "confidently_negative": confidently_negative,
        }
    if len(daily) < minimum_oos_dates:
        blockers.append("paired_oos_dates_insufficient")
    if corr_delta_lcb90 is None or corr_delta_lcb90 < 0.0:
        blockers.append("fusion_corr_delta_lcb90_inferior_to_canonical_l4")
    if spread_delta_lcb90 is None or spread_delta_lcb90 < 0.0:
        blockers.append("fusion_spread_delta_lcb90_inferior_to_canonical_l4")
    if top_trade_ev_lcb90 is None or top_trade_ev_lcb90 <= 0.0:
        blockers.append("fusion_top_trade_ev_lcb90_not_positive")
    blockers.extend(regime_blockers)
    return {
        "schema_version": "allocator-ev-fusion-final-champion-comparison-v1",
        "champion": "canonical_l4",
        "challenger": "allocator_ev_fusion_v12_final_trade_ev",
        "comparison_target": "realized_multisession_trade_ev_net_of_costs",
        "comparison_unit": "paired_prediction_date_same_candidates",
        "decision": "PASS" if not blockers else "FAIL",
        "failed_gates": blockers,
        "samples": len(test),
        "oos_date_count": len(daily),
        "minimum_oos_dates": minimum_oos_dates,
        "corr_delta_mean": round(_mean(correlation_deltas), 8) if correlation_deltas else None,
        "corr_delta_lcb90": None if corr_delta_lcb90 is None else round(corr_delta_lcb90, 8),
        "spread_delta_mean": round(_mean(spread_deltas), 8) if spread_deltas else None,
        "spread_delta_lcb90": None if spread_delta_lcb90 is None else round(spread_delta_lcb90, 8),
        "top_trade_ev_mean": round(_mean(daily_top_trade_ev), 8) if daily_top_trade_ev else None,
        "top_trade_ev_lcb90": None if top_trade_ev_lcb90 is None else round(top_trade_ev_lcb90, 8),
        "regime_stability": {
            "method": "date_clustered_one_sided_90pct_interval",
            "minimum_supported_regime_dates": minimum_supported_regime_dates,
            "unsupported_regimes_are_diagnostic_only": True,
            "decision": "FAIL" if regime_blockers else "PASS",
            "failed_gates": regime_blockers,
            "slices": regime_slices,
        },
        "daily": daily,
    }


def _walk_forward(
    samples: list[dict[str, Any]],
    *,
    folds: int,
    l2: float,
    feature_names: list[str],
    target_key: str = "target",
    calibration_target_key: str | None = None,
) -> dict[str, Any]:
    dates = sorted({str(sample["date"]) for sample in samples})
    if len(dates) < folds + 1:
        return {"passed": False, "reason": "insufficient_dates", "folds": []}
    rows: list[dict[str, Any]] = []
    for fold in range(1, folds + 1):
        split_idx = max(1, round(len(dates) * fold / (folds + 1)))
        next_idx = max(split_idx + 1, round(len(dates) * (fold + 1) / (folds + 1)))
        train_dates = set(dates[:max(0, split_idx - LABEL_PURGE_DATE_GROUPS)])
        test_dates = set(dates[split_idx:next_idx])
        train = [sample for sample in samples if sample["date"] in train_dates]
        test = [sample for sample in samples if sample["date"] in test_dates]
        if len(train) < len(feature_names) + 2 or not test:
            continue
        intercept, coefs = _fit_ridge(train, l2=l2, feature_names=feature_names, target_key=target_key)
        metrics_target_key = target_key
        if calibration_target_key:
            calibration_pairs, calibration_method = _calibration_pairs(
                train,
                feature_names=feature_names,
                rank_target_key=target_key,
                calibration_target_key=calibration_target_key,
                l2=l2,
            )
            if not calibration_pairs:
                continue
            calibration_intercept, calibration_slope = _linear_calibration_from_pairs(
                calibration_pairs,
                l2=l2,
            )
            intercept, coefs = _compose_calibrated_model(
                intercept,
                coefs,
                calibration_intercept,
                calibration_slope,
            )
            metrics_target_key = calibration_target_key
        rows.append({
            "fold": fold,
            "calibration_method": calibration_method if calibration_target_key else None,
            **_metrics(test, intercept, coefs, target_key=metrics_target_key),
        })
    if not rows:
        return {"passed": False, "reason": "no_valid_folds", "folds": []}
    positive_spread = sum(1 for row in rows if float(row.get("top_bottom_spread") or 0.0) > 0.0)
    positive_corr = sum(1 for row in rows if (row.get("prediction_target_corr") or 0.0) > 0.0)
    passed = positive_spread >= max(1, math.ceil(len(rows) * 0.5)) and positive_corr >= max(1, math.ceil(len(rows) * 0.5))
    return {
        "passed": passed,
        "reason": "ok" if passed else "walk_forward_not_stable",
        "fold_count": len(rows),
        "positive_spread_folds": positive_spread,
        "positive_corr_folds": positive_corr,
        "folds": rows,
    }


def _fit_expert(
    samples: list[dict[str, Any]],
    *,
    feature_names: list[str],
    target_key: str,
    min_samples: int,
    min_dates: int,
    l2: float,
    minimum_spread: float = 0.0,
    calibration_target_key: str | None = None,
    min_feature_support_samples: int = 2,
    min_feature_support_dates: int = 2,
) -> dict[str, Any]:
    dates = sorted({sample["date"] for sample in samples})
    split_idx = max(1, round(len(dates) * TEMPORAL_TRAIN_FRACTION)) if dates else 0
    train_dates = set(dates[:max(0, split_idx - LABEL_PURGE_DATE_GROUPS)])
    test_dates = set(dates[split_idx:])
    train = [sample for sample in samples if sample["date"] in train_dates]
    test = [sample for sample in samples if sample["date"] in test_dates]
    requested_feature_names = list(feature_names)
    feature_names, dropped_features = _supported_feature_names(
        train,
        requested_feature_names,
        min_nonzero_samples=min_feature_support_samples,
        min_nonzero_dates=min_feature_support_dates,
    )
    blockers: list[str] = []
    if len(samples) < min_samples:
        blockers.append("insufficient_samples")
    if len(dates) < min_dates:
        blockers.append("insufficient_dates")
    if len(train) < len(feature_names) + 2 or not test:
        blockers.append("insufficient_train_test_split")
    if not feature_names:
        blockers.append("no_supported_features")
    intercept = 0.0
    coefs = {name: 0.0 for name in feature_names}
    rank_intercept: float | None = None
    rank_coefs: dict[str, float] | None = None
    train_metrics: dict[str, Any] = {"samples": len(train)}
    oos_metrics: dict[str, Any] = {"samples": len(test)}
    walk_forward: dict[str, Any] = {"passed": False, "reason": "not_run", "folds": []}
    validation_intercept = intercept
    validation_coefs = dict(coefs)
    deployment_fit: dict[str, Any] = {
        "method": "full_known_sample_refit_after_purged_oos_validation",
        "samples": 0,
        "dates": 0,
        "performed": False,
    }
    if not blockers:
        rank_intercept, rank_coefs = _fit_ridge(
            train,
            l2=l2,
            feature_names=feature_names,
            target_key=target_key,
        )
        intercept, coefs = rank_intercept, rank_coefs
        metrics_target_key = target_key
        calibration_model = None
        if calibration_target_key:
            calibration_pairs, calibration_method = _calibration_pairs(
                train,
                feature_names=feature_names,
                rank_target_key=target_key,
                calibration_target_key=calibration_target_key,
                l2=l2,
            )
            if not calibration_pairs:
                blockers.append("insufficient_oof_calibration_samples")
            else:
                calibration_intercept, calibration_slope = _linear_calibration_from_pairs(
                    calibration_pairs,
                    l2=l2,
                )
                intercept, coefs = _compose_calibrated_model(
                    rank_intercept,
                    rank_coefs,
                    calibration_intercept,
                    calibration_slope,
                )
                metrics_target_key = calibration_target_key
                calibration_model = {
                    "method": calibration_method,
                    "intercept": round(calibration_intercept, 10),
                    "slope": round(calibration_slope, 10),
                    "target": calibration_target_key,
                    "oof_samples": len(calibration_pairs),
                }
        train_metrics = _metrics(train, intercept, coefs, target_key=metrics_target_key)
        oos_metrics = _metrics(test, intercept, coefs, target_key=metrics_target_key)
        walk_forward = _walk_forward(
            samples,
            folds=4,
            l2=l2,
            feature_names=feature_names,
            target_key=target_key,
            calibration_target_key=calibration_target_key,
        )
        if (oos_metrics.get("prediction_target_corr_lcb90") or 0.0) <= 0.0:
            blockers.append("oos_prediction_target_corr_lcb90_not_positive")
        if float(oos_metrics.get("top_bottom_spread_lcb90") or 0.0) <= minimum_spread:
            blockers.append("oos_top_bottom_spread_lcb90_not_economic")
        if not walk_forward.get("passed"):
            blockers.append("walk_forward_not_stable")
        validation_intercept = intercept
        validation_coefs = dict(coefs)
        if not blockers:
            full_rank_intercept, full_rank_coefs = _fit_ridge(
                samples,
                l2=l2,
                feature_names=feature_names,
                target_key=target_key,
            )
            intercept, coefs = full_rank_intercept, full_rank_coefs
            if calibration_target_key:
                full_calibration_pairs, full_calibration_method = _calibration_pairs(
                    samples,
                    feature_names=feature_names,
                    rank_target_key=target_key,
                    calibration_target_key=calibration_target_key,
                    l2=l2,
                )
                full_calibration_intercept, full_calibration_slope = _linear_calibration_from_pairs(
                    full_calibration_pairs,
                    l2=l2,
                )
                intercept, coefs = _compose_calibrated_model(
                    full_rank_intercept,
                    full_rank_coefs,
                    full_calibration_intercept,
                    full_calibration_slope,
                )
            deployment_fit = {
                "method": "full_known_sample_refit_after_purged_oos_validation",
                "samples": len(samples),
                "dates": len(dates),
                "performed": True,
                "validation_coefficients_are_not_served": True,
                "calibration_method": full_calibration_method if calibration_target_key else None,
            }
    result = {
        "status": "fitted" if not blockers else "shadow",
        "decision": "PASS" if not blockers else "FAIL",
        "failed_gates": blockers,
        "sample_count": len(samples),
        "date_count": len(dates),
        "feature_names": feature_names,
        "requested_feature_names": requested_feature_names,
        "dropped_features": dropped_features,
        "target": target_key,
        "calibration_target": calibration_target_key,
        "promotion_confidence_level": 0.90,
        "minimum_economic_spread": round(minimum_spread, 8),
        "intercept": round(intercept, 10),
        "coefficients": {name: round(value, 10) for name, value in coefs.items()},
        "train_metrics": train_metrics,
        "oos_metrics": oos_metrics,
        "walk_forward": walk_forward,
        "validation_model": {
            "intercept": round(validation_intercept, 10),
            "coefficients": {name: round(value, 10) for name, value in validation_coefs.items()},
        },
        "deployment_fit": deployment_fit,
    }
    if calibration_target_key and rank_intercept is not None and rank_coefs is not None:
        result["rank_model"] = {
            "intercept": round(rank_intercept, 10),
            "coefficients": {name: round(value, 10) for name, value in rank_coefs.items()},
            "target": target_key,
        }
        result["calibration_model"] = calibration_model
    return result


def _fit_execution_probability_expert(
    samples: list[dict[str, Any]],
    *,
    l2: float,
    min_samples: int,
    min_dates: int,
) -> dict[str, Any]:
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score
    from sklearn.preprocessing import StandardScaler

    targets = [float(sample["execution_probability_target"]) for sample in samples]
    dates = sorted({sample["date"] for sample in samples})
    split_idx = max(1, round(len(dates) * TEMPORAL_TRAIN_FRACTION)) if dates else 0
    train_dates = set(dates[:max(0, split_idx - LABEL_PURGE_DATE_GROUPS)])
    test_dates = set(dates[split_idx:])
    train = [sample for sample in samples if sample["date"] in train_dates]
    test = [sample for sample in samples if sample["date"] in test_dates]
    feature_names, dropped_features = _supported_feature_names(
        train,
        EXECUTION_FEATURE_NAMES,
        min_nonzero_samples=30,
        min_nonzero_dates=3,
    )
    blockers: list[str] = []
    if len(samples) < min_samples:
        blockers.append("insufficient_samples")
    if len(dates) < min_dates:
        blockers.append("insufficient_dates")
    if not train or not test:
        blockers.append("insufficient_train_test_split")
    if not feature_names:
        blockers.append("no_supported_features")
    train_targets = [int(sample["execution_probability_target"]) for sample in train]
    if len(set(train_targets)) < 2:
        blockers.append("train_target_has_no_class_variation")

    intercept = 0.0
    coefs = {name: 0.0 for name in feature_names}
    train_metrics: dict[str, Any] = {"samples": len(train)}
    oos_metrics: dict[str, Any] = {"samples": len(test)}
    validation_intercept = intercept
    validation_coefs = dict(coefs)
    deployment_fit: dict[str, Any] = {
        "method": "full_known_sample_refit_after_purged_oos_validation",
        "samples": 0,
        "dates": 0,
        "performed": False,
    }
    if not blockers:
        train_x = [[float(sample["features"][name]) for name in feature_names] for sample in train]
        test_x = [[float(sample["features"][name]) for name in feature_names] for sample in test]
        scaler = StandardScaler().fit(train_x)
        model = LogisticRegression(C=1.0 / max(l2, 1e-6), max_iter=2000, solver="lbfgs")
        model.fit(scaler.transform(train_x), train_targets)
        raw_coefs = model.coef_[0] / scaler.scale_
        intercept = float(model.intercept_[0] - sum(raw_coefs * scaler.mean_))
        coefs = {name: float(raw_coefs[idx]) for idx, name in enumerate(feature_names)}

        def probability_metrics(rows: list[dict[str, Any]], matrix: list[list[float]]) -> dict[str, Any]:
            ys = [int(sample["execution_probability_target"]) for sample in rows]
            probabilities = [
                max(1e-12, min(1.0 - 1e-12, float(value)))
                for value in model.predict_proba(scaler.transform(matrix))[:, 1]
            ]
            prevalence = max(1e-6, min(1.0 - 1e-6, _mean(train_targets)))
            baseline = [prevalence] * len(ys)
            daily_advantages: list[float] = []
            for day in sorted({str(sample["date"]) for sample in rows}):
                indices = [idx for idx, sample in enumerate(rows) if str(sample["date"]) == day]
                model_losses = [
                    -(ys[idx] * math.log(probabilities[idx]) + (1 - ys[idx]) * math.log(1.0 - probabilities[idx]))
                    for idx in indices
                ]
                baseline_losses = [
                    -(ys[idx] * math.log(prevalence) + (1 - ys[idx]) * math.log(1.0 - prevalence))
                    for idx in indices
                ]
                daily_advantages.append(_mean(baseline_losses) - _mean(model_losses))
            brier = float(brier_score_loss(ys, probabilities))
            brier_baseline = float(brier_score_loss(ys, baseline))
            logloss = float(log_loss(ys, probabilities, labels=[0, 1]))
            logloss_baseline = float(log_loss(ys, baseline, labels=[0, 1]))
            logloss_lcb90 = _date_cluster_lcb90(daily_advantages)
            return {
                "samples": len(rows),
                "dates": len({str(sample["date"]) for sample in rows}),
                "mean_target": round(_mean(ys), 8),
                "training_prevalence": round(prevalence, 8),
                "base_rate_drift_abs": round(abs(_mean(ys) - prevalence), 8),
                "brier_score": round(brier, 8),
                "brier_climatology": round(brier_baseline, 8),
                "brier_skill_score": round(1.0 - (brier / brier_baseline), 8) if brier_baseline > 0 else None,
                "log_loss": round(logloss, 8),
                "log_loss_climatology": round(logloss_baseline, 8),
                "log_loss_advantage_mean": round(_mean(daily_advantages), 8) if daily_advantages else None,
                "log_loss_advantage_lcb90": None if logloss_lcb90 is None else round(logloss_lcb90, 8),
                "proper_score_primary": "date_clustered_log_loss_advantage_vs_training_prevalence",
                "roc_auc": round(float(roc_auc_score(ys, probabilities)), 8) if len(set(ys)) > 1 else None,
            }

        train_metrics = probability_metrics(train, train_x)
        oos_metrics = probability_metrics(test, test_x)
        if (
            oos_metrics.get("log_loss_advantage_lcb90") is None
            or float(oos_metrics["log_loss_advantage_lcb90"]) <= 0.0
        ):
            blockers.append("oos_log_loss_advantage_lcb90_not_positive")
        validation_intercept = intercept
        validation_coefs = dict(coefs)
        if not blockers:
            full_x = [[float(sample["features"][name]) for name in feature_names] for sample in samples]
            full_targets = [int(sample["execution_probability_target"]) for sample in samples]
            full_scaler = StandardScaler().fit(full_x)
            full_model = LogisticRegression(C=1.0 / max(l2, 1e-6), max_iter=2000, solver="lbfgs")
            full_model.fit(full_scaler.transform(full_x), full_targets)
            full_raw_coefs = full_model.coef_[0] / full_scaler.scale_
            intercept = float(full_model.intercept_[0] - sum(full_raw_coefs * full_scaler.mean_))
            coefs = {name: float(full_raw_coefs[idx]) for idx, name in enumerate(feature_names)}
            deployment_fit = {
                "method": "full_known_sample_refit_after_purged_oos_validation",
                "samples": len(samples),
                "dates": len(dates),
                "performed": True,
                "validation_coefficients_are_not_served": True,
            }

    return {
        "status": "fitted" if not blockers else "shadow",
        "decision": "PASS" if not blockers else "FAIL",
        "failed_gates": blockers,
        "sample_count": len(samples),
        "date_count": len(dates),
        "feature_names": feature_names,
        "requested_feature_names": EXECUTION_FEATURE_NAMES,
        "dropped_features": dropped_features,
        "target": "execution_probability_target",
        "model_family": "logistic_regression",
        "link_function": "logit",
        "intercept": round(intercept, 10),
        "coefficients": {name: round(value, 10) for name, value in coefs.items()},
        "train_metrics": train_metrics,
        "oos_metrics": oos_metrics,
        "benchmark": "training_prevalence_climatology",
        "validation_model": {
            "intercept": round(validation_intercept, 10),
            "coefficients": {name: round(value, 10) for name, value in validation_coefs.items()},
        },
        "deployment_fit": deployment_fit,
    }


def _promotion_tier(
    *,
    decision: str,
    diagnostics: dict[str, Any],
    oos_metrics: dict[str, Any],
    walk_forward: dict[str, Any],
    execution_model: dict[str, Any],
    execution_probability_model: dict[str, Any],
    selection_champion_comparison: dict[str, Any],
    champion_comparison: dict[str, Any],
    min_dates: int,
    min_samples: int,
) -> tuple[str, list[str]]:
    blockers: list[str] = []
    sample_count = int(diagnostics.get("sample_count") or 0)
    date_count = int(diagnostics.get("date_count") or 0)
    execution_sample_count = int(diagnostics.get("execution_sample_count") or 0)
    execution_date_count = int(diagnostics.get("execution_date_count") or 0)
    l4_available_count = int(diagnostics.get("l4_point_in_time_available_count") or 0)
    l4_available_date_count = int(diagnostics.get("l4_point_in_time_available_date_count") or 0)
    structure_count = int(diagnostics.get("s12_structure_available_count") or 0)
    structure_date_count = int(diagnostics.get("s12_structure_available_date_count") or 0)
    market_context_count = int(diagnostics.get("market_context_available_count") or 0)
    market_context_date_count = int(diagnostics.get("market_context_available_date_count") or 0)
    sector_alpha_count = int(diagnostics.get("sector_alpha_available_count") or 0)
    sector_alpha_date_count = int(diagnostics.get("sector_alpha_available_date_count") or 0)
    top_mean = float(oos_metrics.get("top_quintile_mean_return") or 0.0)
    spread = float(oos_metrics.get("top_bottom_spread") or 0.0)
    corr = float(oos_metrics.get("prediction_target_corr") or 0.0)

    if decision != "PASS":
        return "shadow", ["validation_not_pass"]

    if sample_count < max(min_samples, PRIMARY_MIN_SAMPLES):
        blockers.append("primary_insufficient_samples")
    if date_count < max(min_dates, PRIMARY_MIN_DATES):
        blockers.append("primary_insufficient_dates")
    if execution_sample_count < PRIMARY_MIN_S12_AVAILABLE_SAMPLES:
        blockers.append("primary_execution_samples_low")
    if execution_date_count < PRIMARY_MIN_S12_AVAILABLE_DATES:
        blockers.append("primary_execution_dates_low")
    if execution_model.get("decision") != "PASS":
        blockers.append("primary_s12_execution_expert_not_validated")
    if execution_probability_model.get("decision") != "PASS":
        blockers.append("primary_s12_execution_probability_not_validated")
    if l4_available_count < PRIMARY_MIN_L4_PIT_SAMPLES:
        blockers.append("primary_l4_pit_samples_low")
    if l4_available_date_count < PRIMARY_MIN_L4_PIT_DATES:
        blockers.append("primary_l4_pit_dates_low")
    if structure_count < PRIMARY_MIN_S12_STRUCTURE_SAMPLES:
        blockers.append("primary_s12_structure_samples_low")
    if structure_date_count < PRIMARY_MIN_S12_STRUCTURE_DATES:
        blockers.append("primary_s12_structure_dates_low")
    if market_context_count < PRIMARY_MIN_MARKET_CONTEXT_SAMPLES:
        blockers.append("primary_market_context_samples_low")
    if market_context_date_count < PRIMARY_MIN_MARKET_CONTEXT_DATES:
        blockers.append("primary_market_context_dates_low")
    if sector_alpha_count < PRIMARY_MIN_SECTOR_ALPHA_SAMPLES:
        blockers.append("primary_sector_alpha_samples_low")
    if sector_alpha_date_count < PRIMARY_MIN_SECTOR_ALPHA_DATES:
        blockers.append("primary_sector_alpha_dates_low")
    if champion_comparison.get("decision") != "PASS":
        blockers.append("primary_not_superior_to_canonical_l4")
    if top_mean <= 0.0:
        blockers.append("primary_top_bucket_not_positive")
    if spread <= 0.0:
        blockers.append("primary_top_bottom_spread_not_positive")
    if corr <= 0.0:
        blockers.append("primary_oos_corr_not_positive")
    if not walk_forward.get("passed"):
        blockers.append("primary_walk_forward_not_stable")

    if not blockers:
        return "primary", []

    selection_corr_lcb = _float_or_none(selection_champion_comparison.get("corr_delta_lcb90"))
    selection_spread_lcb = _float_or_none(selection_champion_comparison.get("spread_delta_lcb90"))
    prediction_corr = _float_or_none(selection_champion_comparison.get("fusion_l4_prediction_corr_mean"))
    final_top_trade_lcb = _float_or_none(champion_comparison.get("top_trade_ev_lcb90"))
    s12_execution_coefficient = abs(
        float((execution_model.get("coefficients") or {}).get("s12_trade_expected_return") or 0.0)
    )
    assistive_noninferior = (
        int(selection_champion_comparison.get("oos_date_count") or 0) >= ASSISTIVE_MIN_OOS_DATES
        and selection_corr_lcb is not None
        and selection_corr_lcb >= -0.05
        and selection_spread_lcb is not None
        and selection_spread_lcb >= -0.005
    )
    assistive_diverse = (
        (prediction_corr is not None and abs(prediction_corr) <= 0.995)
        or s12_execution_coefficient > 1e-9
    )
    assistive_economic_utility = final_top_trade_lcb is not None and final_top_trade_lcb > 0.0
    assistive_ok = (
        sample_count >= ASSISTIVE_MIN_SAMPLES
        and date_count >= ASSISTIVE_MIN_DATES
        and top_mean > 0.0
        and spread > 0.0
        and corr > 0.0
        and bool(walk_forward.get("passed"))
        and l4_available_count >= ASSISTIVE_MIN_EXPERT_SAMPLES
        and l4_available_date_count >= ASSISTIVE_MIN_EXPERT_DATES
        and structure_count >= ASSISTIVE_MIN_EXPERT_SAMPLES
        and structure_date_count >= ASSISTIVE_MIN_EXPERT_DATES
        and market_context_count >= ASSISTIVE_MIN_EXPERT_SAMPLES
        and market_context_date_count >= ASSISTIVE_MIN_EXPERT_DATES
        and sector_alpha_count >= ASSISTIVE_MIN_EXPERT_SAMPLES
        and sector_alpha_date_count >= ASSISTIVE_MIN_EXPERT_DATES
        and execution_model.get("decision") == "PASS"
        and execution_probability_model.get("decision") == "PASS"
        and assistive_noninferior
        and assistive_diverse
        and assistive_economic_utility
    )
    if assistive_ok:
        return "assistive", blockers
    if not assistive_noninferior:
        blockers.append("assistive_not_noninferior_to_canonical_l4")
    if not assistive_diverse:
        blockers.append("assistive_diversity_not_demonstrated")
    if not assistive_economic_utility:
        blockers.append("assistive_portfolio_utility_not_positive")
    return "shadow", blockers


def build_allocator_ev_fusion_artifact_from_rows(
    rows: list[dict[str, Any]],
    *,
    trained_until: str,
    lookback_days: int = 90,
    min_samples: int = 500,
    min_dates: int = 20,
    l2: float = 0.25,
    cost_model_bps: float = 18.0,
    knowledge_cutoff_date: str | None = None,
    generation_mode: str = "native",
    cohort_id: str | None = None,
    search_trial_count: int = 1,
    multiple_testing_evidence: dict[str, Any] | None = None,
    benchmark_panel_id: str | None = None,
) -> dict[str, Any]:
    if generation_mode not in {"native", "purged_oof"}:
        raise ValueError("fusion_generation_mode_invalid")
    if generation_mode == "purged_oof":
        if not cohort_id:
            raise ValueError("fusion_oof_cohort_id_missing")
        if any(
            str(row.get("generation_mode") or "") != "purged_oof"
            or str(row.get("cohort_id") or "") != cohort_id
            for row in rows
        ):
            raise ValueError("fusion_oof_mixed_or_missing_cohort_lineage")
    samples, diagnostics = _samples(rows, execution_cost_bps=cost_model_bps)
    benchmark_panel = _benchmark_panel_contract(
        samples,
        cost_model_bps=cost_model_bps,
        expected_panel_id=benchmark_panel_id,
    )
    multiple_testing = _multiple_testing_gate(search_trial_count, multiple_testing_evidence)
    selection_model = _fit_expert(
        samples,
        feature_names=SELECTION_FEATURE_NAMES,
        target_key="selection_rank_target",
        min_samples=ASSISTIVE_MIN_SAMPLES,
        min_dates=ASSISTIVE_MIN_DATES,
        l2=l2,
        minimum_spread=max(0.0, cost_model_bps) / 10000.0,
        calibration_target_key="selection_target",
    )
    execution_samples = [sample for sample in samples if sample["execution_target"] is not None]
    execution_observation_samples = [
        sample for sample in samples if sample["execution_probability_target"] is not None
    ]
    execution_probability_model = _fit_execution_probability_expert(
        execution_observation_samples,
        l2=l2,
        min_samples=ASSISTIVE_MIN_EXPERT_SAMPLES,
        min_dates=ASSISTIVE_MIN_EXPERT_DATES,
    )
    execution_model = _fit_expert(
        execution_samples,
        feature_names=EXECUTION_FEATURE_NAMES,
        target_key="execution_target",
        min_samples=ASSISTIVE_MIN_EXPERT_SAMPLES,
        min_dates=ASSISTIVE_MIN_EXPERT_DATES,
        l2=l2,
        min_feature_support_samples=30,
        min_feature_support_dates=3,
    )
    selection_champion_comparison = _paired_canonical_l4_comparison(
        samples,
        fusion_intercept=float(
            (
                selection_model.get("validation_model")
                if isinstance(selection_model.get("validation_model"), dict)
                else selection_model
            ).get("intercept")
            or 0.0
        ),
        fusion_coefficients={
            str(name): float(value)
            for name, value in (
                (
                    selection_model.get("validation_model")
                    if isinstance(selection_model.get("validation_model"), dict)
                    else selection_model
                ).get("coefficients")
                or {}
            ).items()
        },
    )
    champion_comparison = _paired_final_trade_ev_comparison(
        samples,
        execution_model=execution_model,
        execution_probability_model=execution_probability_model,
    )
    component_failed_gates = [
        f"{component}:{gate}"
        for component, model in (
            ("selection", selection_model),
            ("execution", execution_model),
            ("execution_probability", execution_probability_model),
        )
        for gate in (model.get("failed_gates") or [])
    ]
    data_validity_failed_gates: list[str] = []
    if int(diagnostics.get("sample_count") or 0) < ASSISTIVE_MIN_SAMPLES:
        data_validity_failed_gates.append("sample_count_below_assistive_floor")
    if int(diagnostics.get("date_count") or 0) < ASSISTIVE_MIN_DATES:
        data_validity_failed_gates.append("date_count_below_assistive_floor")
    if not benchmark_panel["locked"]:
        data_validity_failed_gates.append("benchmark_panel_identity_mismatch")
    statistical_failed_gates = [
        f"multiple_testing:{gate}" for gate in multiple_testing["failed_gates"]
    ]
    economic_utility_failed_gates = [
        f"{component}:{gate}"
        for component, model in (
            ("selection_champion", selection_champion_comparison),
            ("final_champion", champion_comparison),
        )
        for gate in (model.get("failed_gates") or [])
    ]
    failed_gates = [
        *[f"data_validity:{gate}" for gate in data_validity_failed_gates],
        *component_failed_gates,
        *statistical_failed_gates,
        *economic_utility_failed_gates,
    ]
    decision = (
        "PASS"
        if not data_validity_failed_gates
        and not component_failed_gates
        and not statistical_failed_gates
        else "FAIL"
    )
    promotion_tier, promotion_blockers = _promotion_tier(
        decision=decision,
        diagnostics=diagnostics,
        oos_metrics=selection_model["oos_metrics"],
        walk_forward=selection_model["walk_forward"],
        execution_model=execution_model,
        execution_probability_model=execution_probability_model,
        selection_champion_comparison=selection_champion_comparison,
        champion_comparison=champion_comparison,
        min_dates=min_dates,
        min_samples=min_samples,
    )
    if decision != "PASS":
        promotion_blockers = [*data_validity_failed_gates, *component_failed_gates, *statistical_failed_gates]
    validation_packet = {
        "schema_version": "allocator-ev-fusion-validation-packet-v13",
        "decision": decision,
        "failed_gates": failed_gates,
        "gate_layers": {
            "data_validity": {
                "decision": "PASS" if not data_validity_failed_gates else "FAIL",
                "failed_gates": data_validity_failed_gates,
                "hard_fail": True,
            },
            "forecast_skill": {
                "decision": "PASS" if not component_failed_gates else "FAIL",
                "failed_gates": component_failed_gates,
                "primary_probability_score": "date_clustered_log_loss_advantage_lcb90",
            },
            "statistical_validity": multiple_testing,
            "economic_utility": {
                "decision": "PASS" if not economic_utility_failed_gates else "FAIL",
                "failed_gates": economic_utility_failed_gates,
                "primary_requires_superiority": True,
                "assistive_requires_noninferiority_diversity_and_positive_utility": True,
            },
        },
        "benchmark_panel": benchmark_panel,
        "multiple_testing": multiple_testing,
        "primary_champion_failed_gates": champion_comparison.get("failed_gates") or [],
        "validation_scope": {
            "owner": "allocator_ev_fusion",
            "selection_target": "same_date_cross_section_residual_of_five_session_net_return",
            "label_schema_version": LABEL_SCHEMA_VERSION,
            "execution_probability_target": "next_session_canonical_execution_indicator_by_archetype",
            "execution_target": "five_session_canonical_lifecycle_net_pnl_when_executed",
            "rowwise_label_coalesce": False,
            "method": "date_clustered_temporal_oos_plus_walk_forward",
            "effective_sample_unit": "prediction_date",
            "temporal_train_fraction": TEMPORAL_TRAIN_FRACTION,
            "primary_minimum_oos_dates": PRIMARY_MIN_OOS_DATES,
            "assistive_minimum_oos_dates": ASSISTIVE_MIN_OOS_DATES,
            "lookback_days": lookback_days,
            "feature_era": CANONICAL_SCORE_FEATURE_VERSION,
            "point_in_time_features_required": True,
            "purged_signal_date_groups": LABEL_PURGE_DATE_GROUPS,
        },
        "sample_audit": diagnostics,
        "train_metrics": selection_model["train_metrics"],
        "oos_metrics": selection_model["oos_metrics"],
        "walk_forward": selection_model["walk_forward"],
        "selection_model": selection_model,
        "execution_model": execution_model,
        "execution_probability_model": execution_probability_model,
        "selection_champion_comparison": selection_champion_comparison,
        "champion_comparison": champion_comparison,
        "promotion": {
            "schema_version": "allocator-ev-fusion-promotion-v4",
            "tier": promotion_tier,
            "automatic": True,
            "failed_gates": promotion_blockers,
            "primary_requirements": {
                "min_dates": max(min_dates, PRIMARY_MIN_DATES),
                "min_oos_dates": PRIMARY_MIN_OOS_DATES,
                "effective_sample_unit": "prediction_date",
                "min_samples": max(min_samples, PRIMARY_MIN_SAMPLES),
                "min_execution_samples": PRIMARY_MIN_S12_AVAILABLE_SAMPLES,
                "min_execution_dates": PRIMARY_MIN_S12_AVAILABLE_DATES,
                "s12_coverage_is_diagnostic_only": True,
                "min_l4_point_in_time_samples": PRIMARY_MIN_L4_PIT_SAMPLES,
                "min_l4_point_in_time_dates": PRIMARY_MIN_L4_PIT_DATES,
                "min_s12_structure_samples": PRIMARY_MIN_S12_STRUCTURE_SAMPLES,
                "min_s12_structure_dates": PRIMARY_MIN_S12_STRUCTURE_DATES,
                "min_market_context_samples": PRIMARY_MIN_MARKET_CONTEXT_SAMPLES,
                "min_market_context_dates": PRIMARY_MIN_MARKET_CONTEXT_DATES,
                "min_sector_alpha_samples": PRIMARY_MIN_SECTOR_ALPHA_SAMPLES,
                "min_sector_alpha_dates": PRIMARY_MIN_SECTOR_ALPHA_DATES,
                "execution_expert_validation_passed": True,
                "final_top_trade_ev_lcb90_positive": True,
                "supported_regime_upper_bound_not_negative": True,
                "execution_probability_validation_passed": True,
                "paired_canonical_l4_champion_comparison_passed": True,
                "top_bucket_return_positive": True,
                "top_bottom_spread_positive": True,
                "oos_corr_positive": True,
                "walk_forward_passed": True,
            },
        },
    }
    artifact = {
        "schema_version": "allocator-ev-fusion-artifact-v13",
        "artifact_contract_version": ARTIFACT_CONTRACT_VERSION,
        "feature_semantic_version": FEATURE_SEMANTIC_VERSION,
        "label_schema_version": LABEL_SCHEMA_VERSION,
        "expected_return_owner": "allocator_ev_fusion",
        "promotion_state": (
            "offline_quality_passed_operational_parity_required"
            if generation_mode == "purged_oof" and promotion_tier in {"primary", "assistive"}
            else "production_primary" if promotion_tier == "primary"
            else "production_assistive" if promotion_tier == "assistive"
            else "shadow"
        ),
        "promotion_tier": promotion_tier,
        "primary_expected_return_allowed": promotion_tier == "primary" and generation_mode == "native",
        "assistive_expected_return_allowed": False,
        "assistive_learning_signal_allowed": promotion_tier in {"assistive", "primary"},
        "operational_parity_required": generation_mode == "purged_oof",
        "promotion_blockers": promotion_blockers,
        "validation_packet": validation_packet,
        "resolver_method": "sector_market_conditioned_cross_fitted_rank_two_part_trade_ev_fusion",
        "model_version": (
            f"allocator-ev-fusion-cross-fit-v13-sector-{trained_until.replace('-', '')}"
            if generation_mode == "native"
            else "allocator-ev-fusion-cross-fit-v13-sector-"
            f"{trained_until.replace('-', '')}-oof-"
            f"{hashlib.sha256(str(cohort_id or '').encode('utf-8')).hexdigest()[:10]}"
        ),
        "feature_snapshot_version": "allocator-ev-fusion-feature-snapshot-v13-pit-sector-market-context",
        "expected_return_semantic": "execution_probability_times_conditional_replay_net_return",
        "trained_until": trained_until,
        "horizon_days": 5,
        "cost_model_bps": cost_model_bps,
        "output_is_net_of_costs": True,
        "feature_names": FEATURE_NAMES,
        "selection_model": selection_model,
        "execution_model": execution_model,
        "execution_probability_model": execution_probability_model,
        "intercept": selection_model["intercept"],
        "coefficients": {
            **selection_model["coefficients"],
            **{name: 0.0 for name in EXECUTION_FEATURE_NAMES if name not in SELECTION_FEATURE_NAMES},
        },
        "output_clip": {"min": -0.08, "max": 0.08},
        "training_data": {
            "source": "as-of ScoreV2/L4/S12 snapshots joined to executable adjusted five-session net labels and canonical replay outcomes",
            "trained_until": trained_until,
            "knowledge_cutoff_date": knowledge_cutoff_date or trained_until,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            **diagnostics,
            "generation_mode": generation_mode,
            "cohort_id": cohort_id,
            "benchmark_panel_id": benchmark_panel["panel_id"],
            "search_trial_count": multiple_testing["search_trial_count"],
            "multiple_testing_method": multiple_testing["method"],
            "efficacy_evidence_mode": "purged_oof" if generation_mode == "purged_oof" else "native",
        },
    }
    return {
        "status": "ok" if decision == "PASS" else "failed_validation",
        "artifact": artifact,
        "validation_packet": validation_packet,
    }


def load_allocator_ev_fusion_oof_training_rows(
    query_fn: Callable[[str, list[Any]], list[dict[str, Any]]],
    *,
    cohort_id: str,
    knowledge_cutoff_date: str,
    limit: int = 20000,
    bucket: Any | None = None,
) -> list[dict[str, Any]]:
    """Load one homogeneous OOF cohort with cross-fitted L4 and S12 labels."""

    cohort_rows = query_fn(
        """
        SELECT status, prediction_storage_mode, artifact_manifest_checksum
        FROM active8_oof_cohorts
        WHERE cohort_id = ?
        """,
        [cohort_id],
    )
    if len(cohort_rows) != 1 or str(cohort_rows[0].get("status") or "") != "ready":
        raise ValueError("allocator_ev_fusion_oof_cohort_not_ready")
    cohort = cohort_rows[0]
    storage_mode = str(cohort.get("prediction_storage_mode") or "d1_full_v1")
    if storage_mode == "gcs_indexed_v1":
        if bucket is None:
            raise ValueError("allocator_ev_fusion_oof_gcs_bucket_missing")
        manifest_checksum = str(cohort.get("artifact_manifest_checksum") or "")
        index_rows = query_fn(
            """
            SELECT artifact_kind, source_manifest_checksum
            FROM active8_oof_materialized_artifacts
            WHERE cohort_id = ?
              AND artifact_kind IN ('allocator_ev_snapshots', 'l4_predictions')
            """,
            [cohort_id],
        )
        index_by_kind = {
            str(row.get("artifact_kind") or ""): row for row in index_rows
        }
        if set(index_by_kind) != {"allocator_ev_snapshots", "l4_predictions"}:
            raise ValueError("allocator_ev_fusion_oof_artifact_indexes_incomplete")
        if len(manifest_checksum) != 64 or any(
            str(row.get("source_manifest_checksum") or "") != manifest_checksum
            for row in index_by_kind.values()
        ):
            raise ValueError("allocator_ev_fusion_oof_manifest_lineage_mismatch")

        # Imported lazily to keep native refreshes independent of OOF storage.
        from services.active8_oof_cohort_materializer import (
            build_fusion_oof_rows,
            load_oof_materialized_rows,
        )

        snapshot_rows = load_oof_materialized_rows(
            bucket=bucket,
            cohort_id=cohort_id,
            artifact_kind="allocator_ev_snapshots",
            query_fn=query_fn,
        )
        l4_rows = load_oof_materialized_rows(
            bucket=bucket,
            cohort_id=cohort_id,
            artifact_kind="l4_predictions",
            query_fn=query_fn,
        )
        eligible_snapshots = [
            row for row in snapshot_rows
            if str(row.get("generation_mode") or "") == "purged_oof"
            and str(row.get("source_manifest_checksum") or "") == manifest_checksum
            and len(str(row.get("label_known_date") or "")[:10]) == 10
            and str(row.get("label_known_date") or "")[:10] <= knowledge_cutoff_date
        ]
        eligible_l4 = [
            row for row in l4_rows
            if int(row.get("eligible_for_efficacy") or 0) == 1
            and len(str(row.get("trained_until") or "")[:10]) == 10
            and len(str(row.get("prediction_date") or "")[:10]) == 10
            and str(row.get("trained_until") or "")[:10]
            < str(row.get("prediction_date") or "")[:10]
        ]
        if not eligible_snapshots or not eligible_l4:
            raise ValueError("allocator_ev_fusion_oof_indexed_rows_empty")
        rows = build_fusion_oof_rows(
            eligible_snapshots,
            eligible_l4,
            knowledge_cutoff_date=knowledge_cutoff_date,
            query_fn=query_fn,
        )
        if not rows:
            raise ValueError("allocator_ev_fusion_oof_joined_rows_empty")
        by_date: dict[str, list[dict[str, Any]]] = {}
        for row in rows:
            prediction_date = str(
                row.get("prediction_date") or row.get("snapshot_date") or ""
            )[:10]
            if len(prediction_date) != 10:
                raise ValueError("allocator_ev_fusion_oof_prediction_date_invalid")
            by_date.setdefault(prediction_date, []).append(row)
        selected_dates: list[str] = []
        selected_rows = 0
        for prediction_date in sorted(by_date, reverse=True):
            date_rows = by_date[prediction_date]
            if len(date_rows) > int(limit):
                raise ValueError("allocator_ev_fusion_oof_single_date_exceeds_limit")
            if selected_rows + len(date_rows) > int(limit):
                continue
            selected_dates.append(prediction_date)
            selected_rows += len(date_rows)
        if not selected_dates:
            raise ValueError("allocator_ev_fusion_oof_complete_date_cohort_empty")
        selected = set(selected_dates)
        return sorted(
            (
                row
                for row in rows
                if str(
                    row.get("prediction_date") or row.get("snapshot_date") or ""
                )[:10] in selected
            ),
            key=lambda row: (
                str(row.get("prediction_date") or row.get("snapshot_date") or ""),
                str(row.get("symbol") or ""),
            ),
        )
    if storage_mode != "d1_full_v1":
        raise ValueError("allocator_ev_fusion_oof_storage_mode_unsupported")

    rows = query_fn(
        f"""
        WITH {PRICE_HORIZONS_CTE}
        SELECT
          fs.cohort_id,
          fs.fold_id,
          fs.generation_mode,
          fs.stock_id,
          fs.symbol,
          fs.snapshot_date prediction_date,
          fs.forecast_data,
          fs.score,
          fs.score_components,
          fs.alpha_context,
          fs.alpha_allocation,
          fs.market_heat_expected_return,
          fs.market_segment,
          st.sector,
          fs.recommendation_lane,
          fs.label_known_date,
          'allocator_ev_oof_snapshots' allocator_ev_feature_snapshot_source,
          'purged_oof_label_known_date_strict' allocator_ev_feature_snapshot_guard,
          ph.source label_adjustment_source,
          ((ph.exit_raw_close * ph.exit_adjustment_factor)
            / (ph.entry_raw_open * ph.entry_adjustment_factor)) - 1.0 - {CANONICAL_ROUNDTRIP_COST_RATE:.8f} l4_executable_return_pct,
          NULL trade_pnl_pct,
          l4.prediction_json l4_prediction_json,
          (
            SELECT o.pnl_pct
            FROM s12_replay_trade_outcomes o
            WHERE o.symbol = fs.symbol
              AND date(o.signal_date) = date(fs.snapshot_date)
              AND o.source = 's12_multisession_structure_replay_v3'
              AND date(json_extract(o.detail_json, '$.replay_diagnostics.outcome_known_date')) <= date(?)
              AND o.sample_eligible = 1
              AND o.pnl_pct IS NOT NULL
            ORDER BY o.created_at DESC, o.id DESC LIMIT 1
          ) s12_replay_pnl_pct,
          (
            SELECT json_extract(o.detail_json, '$.status')
            FROM s12_replay_trade_outcomes o
            WHERE o.symbol = fs.symbol
              AND date(o.signal_date) = date(fs.snapshot_date)
              AND o.source = 's12_multisession_structure_replay_v3'
              AND date(json_extract(o.detail_json, '$.replay_diagnostics.outcome_known_date')) <= date(?)
            ORDER BY o.sample_eligible DESC, o.created_at DESC, o.id DESC LIMIT 1
          ) s12_replay_status,
          (
            SELECT json_extract(o.detail_json, '$.status_reason')
            FROM s12_replay_trade_outcomes o
            WHERE o.symbol = fs.symbol
              AND date(o.signal_date) = date(fs.snapshot_date)
              AND o.source = 's12_multisession_structure_replay_v3'
              AND date(json_extract(o.detail_json, '$.replay_diagnostics.outcome_known_date')) <= date(?)
            ORDER BY o.sample_eligible DESC, o.created_at DESC, o.id DESC LIMIT 1
          ) s12_replay_archetype
        FROM allocator_ev_oof_snapshots fs
        JOIN active8_oof_cohorts cohort
          ON cohort.cohort_id = fs.cohort_id
         AND cohort.status = 'ready'
        JOIN l4_oof_predictions l4
          ON l4.cohort_id = fs.cohort_id
         AND l4.fold_id = fs.fold_id
         AND l4.prediction_date = fs.snapshot_date
         AND l4.symbol = fs.symbol
         AND l4.market_segment = fs.market_segment
         AND l4.eligible_for_efficacy = 1
         AND l4.trained_until < fs.snapshot_date
        JOIN stocks st ON st.id = fs.stock_id
        JOIN price_horizons ph
          ON ph.stock_id = fs.stock_id
         AND ph.price_date = fs.snapshot_date
        WHERE fs.cohort_id = ?
          AND fs.generation_mode = 'purged_oof'
          AND ph.entry_raw_open > 0
          AND ph.exit_raw_close > 0
          AND ph.entry_adjustment_factor > 0
          AND ph.exit_adjustment_factor > 0
          AND date(ph.exit_date) <= date(?)
          AND date(fs.label_known_date) <= date(?)
        ORDER BY fs.snapshot_date, fs.symbol
        LIMIT ?
        """,
        [
            knowledge_cutoff_date,
            knowledge_cutoff_date,
            knowledge_cutoff_date,
            cohort_id,
            knowledge_cutoff_date,
            knowledge_cutoff_date,
            int(limit),
        ],
    )
    for row in rows:
        payload = _loads(row.pop("l4_prediction_json", None))
        if payload:
            row["l4_alpha_ev"] = payload
    return rows


def load_allocator_ev_fusion_training_rows(
    query_fn: Callable[[str, list[Any]], list[dict[str, Any]]],
    *,
    end_date: str,
    lookback_days: int = 90,
    limit: int = 6000,
    knowledge_cutoff_date: str | None = None,
) -> list[dict[str, Any]]:
    outcome_cutoff = knowledge_cutoff_date or end_date
    snapshot_rows: list[dict[str, Any]] = []
    snapshot_available = False
    try:
        snapshot_rows = query_fn(
            f"""
            WITH {PRICE_HORIZONS_CTE}
            SELECT
                fs.stock_id,
                fs.symbol,
                date(fs.snapshot_date) AS prediction_date,
                fs.forecast_data,
                ph.source AS label_adjustment_source,
                ((ph.exit_raw_close * ph.exit_adjustment_factor)
                  / (ph.entry_raw_open * ph.entry_adjustment_factor)) - 1.0 - {CANONICAL_ROUNDTRIP_COST_RATE:.8f} AS l4_executable_return_pct,
                p.trade_pnl_pct,
                (
                    SELECT o.pnl_pct
                    FROM s12_replay_trade_outcomes o
                    WHERE o.symbol = fs.symbol
                      AND date(o.signal_date) = date(fs.snapshot_date)
                      AND o.source = 's12_multisession_structure_replay_v3'
                      AND date(json_extract(o.detail_json, '$.replay_diagnostics.outcome_known_date')) <= date(?)
                      AND o.sample_eligible = 1
                      AND o.pnl_pct IS NOT NULL
                    ORDER BY o.created_at DESC, o.id DESC
                    LIMIT 1
                ) AS s12_replay_pnl_pct,
                (
                    SELECT json_extract(o.detail_json, '$.status')
                    FROM s12_replay_trade_outcomes o
                    WHERE o.symbol = fs.symbol
                      AND date(o.signal_date) = date(fs.snapshot_date)
                      AND o.source = 's12_multisession_structure_replay_v3'
                      AND date(json_extract(o.detail_json, '$.replay_diagnostics.outcome_known_date')) <= date(?)
                    ORDER BY o.sample_eligible DESC, o.created_at DESC, o.id DESC
                    LIMIT 1
                ) AS s12_replay_status,
                (
                    SELECT json_extract(o.detail_json, '$.status_reason')
                    FROM s12_replay_trade_outcomes o
                    WHERE o.symbol = fs.symbol
                      AND date(o.signal_date) = date(fs.snapshot_date)
                      AND o.source = 's12_multisession_structure_replay_v3'
                      AND date(json_extract(o.detail_json, '$.replay_diagnostics.outcome_known_date')) <= date(?)
                    ORDER BY o.sample_eligible DESC, o.created_at DESC, o.id DESC
                    LIMIT 1
                ) AS s12_replay_archetype,
                fs.score,
                fs.score_components,
                fs.alpha_context,
                fs.alpha_allocation,
                fs.market_heat_expected_return,
                fs.market_segment,
                st.sector,
                fs.recommendation_lane,
                fs.snapshot_source AS allocator_ev_feature_snapshot_source,
                fs.as_of_guard AS allocator_ev_feature_snapshot_guard
            FROM allocator_ev_feature_snapshots fs
            LEFT JOIN predictions p
              ON p.stock_id = fs.stock_id
             AND p.prediction_date = fs.snapshot_date
             AND p.model_name = 'ensemble'
            JOIN stocks st
              ON st.id = fs.stock_id
            JOIN price_horizons ph
              ON ph.stock_id = fs.stock_id
             AND ph.price_date = date(fs.snapshot_date)
            WHERE ph.entry_raw_open > 0
              AND ph.exit_raw_close > 0
              AND ph.entry_adjustment_factor > 0
              AND ph.exit_adjustment_factor > 0
              AND date(ph.exit_date) <= date(?)
              AND fs.snapshot_source = ?
              AND fs.as_of_guard = ?
              AND fs.alpha_allocation IS NOT NULL
              AND date(fs.snapshot_date) <= date(?)
              AND date(fs.snapshot_date) >= date(?, ?)
            ORDER BY date(fs.snapshot_date) ASC, fs.symbol ASC
            LIMIT ?
            """,
            [
                outcome_cutoff,
                outcome_cutoff,
                outcome_cutoff,
                outcome_cutoff,
                SNAPSHOT_BACKFILL_SOURCE,
                SNAPSHOT_BACKFILL_AS_OF_GUARD,
                end_date,
                end_date,
                f"-{max(1, int(lookback_days))} days",
                int(limit),
            ],
        )
        snapshot_available = True
    except Exception as exc:  # noqa: BLE001 - migration may not be deployed yet.
        message = str(exc).lower()
        if "no such table" not in message or "allocator_ev_feature_snapshots" not in message:
            raise

    if snapshot_available:
        return snapshot_rows

    return query_fn(
        f"""
        WITH {PRICE_HORIZONS_CTE}
        SELECT
            p.stock_id,
            s.symbol,
            date(p.prediction_date) AS prediction_date,
            p.forecast_data,
            ph.source AS label_adjustment_source,
            ((ph.exit_raw_close * ph.exit_adjustment_factor)
              / (ph.entry_raw_open * ph.entry_adjustment_factor)) - 1.0 - {CANONICAL_ROUNDTRIP_COST_RATE:.8f} AS l4_executable_return_pct,
            p.trade_pnl_pct,
            (
                SELECT o.pnl_pct
                FROM s12_replay_trade_outcomes o
                WHERE o.symbol = s.symbol
                  AND date(o.signal_date) = date(p.prediction_date)
                  AND o.source = 's12_multisession_structure_replay_v3'
                  AND date(json_extract(o.detail_json, '$.replay_diagnostics.outcome_known_date')) <= date(?)
                  AND o.sample_eligible = 1
                  AND o.pnl_pct IS NOT NULL
                ORDER BY o.created_at DESC, o.id DESC
                LIMIT 1
            ) AS s12_replay_pnl_pct,
            (
                SELECT json_extract(o.detail_json, '$.status')
                FROM s12_replay_trade_outcomes o
                WHERE o.symbol = s.symbol
                  AND date(o.signal_date) = date(p.prediction_date)
                  AND o.source = 's12_multisession_structure_replay_v3'
                  AND date(json_extract(o.detail_json, '$.replay_diagnostics.outcome_known_date')) <= date(?)
                ORDER BY o.sample_eligible DESC, o.created_at DESC, o.id DESC
                LIMIT 1
            ) AS s12_replay_status,
            (
                SELECT json_extract(o.detail_json, '$.status_reason')
                FROM s12_replay_trade_outcomes o
                WHERE o.symbol = s.symbol
                  AND date(o.signal_date) = date(p.prediction_date)
                  AND o.source = 's12_multisession_structure_replay_v3'
                  AND date(json_extract(o.detail_json, '$.replay_diagnostics.outcome_known_date')) <= date(?)
                ORDER BY o.sample_eligible DESC, o.created_at DESC, o.id DESC
                LIMIT 1
            ) AS s12_replay_archetype,
            dr.score,
            dr.score_components,
            dr.alpha_context,
            dr.alpha_allocation,
            NULL AS market_heat_expected_return,
            dr.market_segment,
            s.sector,
            dr.recommendation_lane
        FROM predictions p
        JOIN daily_recommendations dr
          ON dr.stock_id = p.stock_id
         AND dr.date = p.prediction_date
        JOIN stocks s
          ON s.id = p.stock_id
        JOIN price_horizons ph
          ON ph.stock_id = p.stock_id
         AND ph.price_date = date(p.prediction_date)
        WHERE p.model_name = 'ensemble'
          AND ph.entry_raw_open > 0
          AND ph.exit_raw_close > 0
          AND ph.entry_adjustment_factor > 0
          AND ph.exit_adjustment_factor > 0
          AND date(ph.exit_date) <= date(?)
          AND dr.alpha_allocation IS NOT NULL
          AND date(p.prediction_date) <= date(?)
          AND date(p.prediction_date) >= date(?, ?)
        ORDER BY date(p.prediction_date) ASC, s.symbol ASC
        LIMIT ?
        """,
        [
            outcome_cutoff,
            outcome_cutoff,
            outcome_cutoff,
            outcome_cutoff,
            end_date,
            end_date,
            f"-{max(1, int(lookback_days))} days",
            int(limit),
        ],
    )
