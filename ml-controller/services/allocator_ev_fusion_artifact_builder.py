"""Build allocator EV fusion artifacts from verified recommendation outcomes."""
from __future__ import annotations

import json
import math
from datetime import date, datetime, timezone
from typing import Any, Callable

from scipy.stats import t as student_t

from services.allocator_ev_fusion import (
    _s12_execution_ready,
    _s12_multiplier,
    _s12_structure_features,
    _target_quality_numeric,
    _target_quality_state,
)
from services.l4_alpha_ev_resolver import (
    SNAPSHOT_BACKFILL_AS_OF_GUARD,
    SNAPSHOT_BACKFILL_SOURCE,
    SNAPSHOT_BACKFILL_USAGE_SCOPE,
    extract_l4_alpha_ev,
)
from services.s12_trade_ev import extract_s12_trade_ev


SELECTION_FEATURE_NAMES = [
    "l4_expected_return",
    "l4_available",
    "market_heat_expected_return",
    "ml_edge_norm",
    "fundamental_quality_norm",
    "chip_flow_norm",
    "technical_structure_norm",
    "ensemble_directional_margin",
    "score_v2_available",
    "ensemble_rank_available",
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
]
FEATURE_NAMES = list(dict.fromkeys([*SELECTION_FEATURE_NAMES, *EXECUTION_FEATURE_NAMES]))

PRIMARY_MIN_DATES = 20
PRIMARY_MIN_SAMPLES = 1500
PRIMARY_MIN_S12_AVAILABLE_SAMPLES = 300
PRIMARY_MIN_S12_AVAILABLE_DATES = 8
PRIMARY_MIN_L4_OOF_SAMPLES = 300
PRIMARY_MIN_L4_OOF_DATES = 8
PRIMARY_MIN_S12_STRUCTURE_SAMPLES = 300
PRIMARY_MIN_S12_STRUCTURE_DATES = 8
ASSISTIVE_MIN_DATES = 5
ASSISTIVE_MIN_SAMPLES = 500
ASSISTIVE_MIN_EXPERT_SAMPLES = 100
ASSISTIVE_MIN_EXPERT_DATES = 5
CANONICAL_SCORE_FEATURE_VERSION = "score_v2"
CANONICAL_SCORE_SEMANTIC_VERSION = "score-v2-active8-components-v3"
CANONICAL_ENSEMBLE_SEMANTIC_VERSION = "active8-ic-weighted-rank-v3"
MIN_CROSS_SECTION_SAMPLES_PER_DATE = 20
LABEL_PURGE_DATE_GROUPS = 5
ARTIFACT_CONTRACT_VERSION = "allocator-ev-fusion-contract-v8"
FEATURE_SEMANTIC_VERSION = "allocator-ev-fusion-directional-components-v2-lineage-bound"
LABEL_SCHEMA_VERSION = "next-session-raw-open-to-fifth-session-raw-close-factor-stable-net-v2"


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
    }


def _l4_usage_scope(row: dict[str, Any]) -> str:
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


def _feature_vector(row: dict[str, Any]) -> dict[str, float] | None:
    if _score_feature_era(row) != CANONICAL_SCORE_FEATURE_VERSION:
        return None
    score_payload = _loads(row.get("score_components"))
    forecast_payload = _loads(row.get("forecast_data"))
    ensemble_payload = forecast_payload.get("ensemble_v2") if isinstance(forecast_payload.get("ensemble_v2"), dict) else {}
    if str(score_payload.get("semanticVersion") or "").strip() != CANONICAL_SCORE_SEMANTIC_VERSION:
        return None
    if str(ensemble_payload.get("semantic_version") or "").strip() != CANONICAL_ENSEMBLE_SEMANTIC_VERSION:
        return None
    if not str(ensemble_payload.get("model_set_signature") or "").strip():
        return None
    extractor_row = _row_for_extractors(row)
    usage_scope = _l4_usage_scope(row)
    l4_value, _l4_source, _l4_payload = extract_l4_alpha_ev(
        extractor_row,
        usage_scope=usage_scope,
    )
    if (
        usage_scope == SNAPSHOT_BACKFILL_USAGE_SCOPE
        and isinstance(_l4_payload, dict)
        and not _date_strictly_before(_l4_payload.get("trained_until"), row.get("prediction_date"))
    ):
        return None
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
        "s12_trade_expected_return": float(s12_value),
        "s12_available": s12_available,
        "s12_execution_ready": _s12_execution_ready(s12_payload),
        "s12_context_multiplier": _s12_multiplier(s12_payload),
        "s12_target_quality_score": _target_quality_numeric(target_state),
        "market_heat_expected_return": _market_heat(row),
        "l4_s12_edge_agreement": 1.0 if (l4_value > 0 and s12_value > 0) or (l4_value <= 0 and s12_value <= 0) else 0.0,
        **_s12_structure_features(s12_payload),
    }


def _bounded_return(row: dict[str, Any], key: str) -> float | None:
    value = _float_or_none(row.get(key))
    return value if value is not None and -1.0 < value < 1.0 else None


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
    for row in rows:
        feature_era = _score_feature_era(row)
        feature_era_counts[feature_era] = feature_era_counts.get(feature_era, 0) + 1
        if feature_era != CANONICAL_SCORE_FEATURE_VERSION:
            rejected_feature_era_rows += 1
        features = _feature_vector(row)
        selection_gross_target = _bounded_return(row, "l4_executable_return_pct")
        selection_target = (
            selection_gross_target - max(0.0, execution_cost_bps) / 10000.0
            if selection_gross_target is not None
            else None
        )
        if features is None:
            missing_features += 1
            invalid += 1
            continue
        if selection_target is None:
            invalid += 1
            continue
        day = str(row.get("prediction_date") or row.get("date") or "")[:10] or "unknown"
        replay_target = _bounded_return(row, "s12_replay_pnl_pct")
        actual_trade_target = _bounded_return(row, "trade_pnl_pct")
        trade_target = replay_target
        replay_status = str(row.get("s12_replay_status") or "").strip().lower()
        replay_archetype = str(row.get("s12_replay_archetype") or "").strip().lower()
        execution_observed = bool(replay_status) or replay_target is not None
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
            "features": features,
            "target": selection_target,
            "actual_return_target": selection_target,
            "selection_target": selection_target,
            "trade_target": trade_target,
            "execution_target": execution_target,
            "realized_trade_ev_target": realized_trade_ev_target,
            "execution_probability_target": (
                1.0 if trade_target is not None else 0.0
            ) if execution_observed else None,
            "execution_label_source": (
                "s12_replay_trade_outcomes"
                if replay_target is not None
                else "s12_replay_non_execution"
                if replay_status
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
    return out, {
        "input_rows": len(rows),
        "sample_count": len(out),
        "invalid_rows": invalid,
        "missing_feature_rows": missing_features,
        "accepted_feature_era": CANONICAL_SCORE_FEATURE_VERSION,
        "feature_era_counts": dict(sorted(feature_era_counts.items())),
        "rejected_feature_era_rows": rejected_feature_era_rows,
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
        "s12_ready_count": s12_ready_count,
        "s12_available_count": s12_available_count,
        "s12_available_date_count": len({row["date"] for row in out if row["features"]["s12_available"] > 0.0}),
        "l4_available_count": len(l4_available_samples),
        "l4_available_date_count": len({row["date"] for row in l4_available_samples}),
        "l4_available_coverage": round(len(l4_available_samples) / len(out), 8) if out else 0.0,
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
            "selection": "next_session_raw_open_to_fifth_session_raw_close_factor_stable_net_of_costs",
            "selection_label_schema_version": LABEL_SCHEMA_VERSION,
            "execution_trade_return": "five_session_canonical_s12_lifecycle_pnl_net_of_roundtrip_cost_when_executed",
            "full_trade_ev": "zero_when_not_executed_else_multisession_canonical_replay_net_pnl",
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
    split_idx = max(1, round(len(dates) * 0.8)) if dates else 0
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
    daily: list[dict[str, Any]] = []
    for day, rows in sorted(by_date.items()):
        if len(rows) < 3:
            continue
        targets = [float(row["selection_target"]) for row in rows]
        fusion_predictions = [_predict(row, fusion_intercept, fusion_coefficients) for row in rows]
        canonical_predictions = [float(row["features"]["l4_expected_return"]) for row in rows]
        fusion_corr = _corr(fusion_predictions, targets)
        canonical_corr = _corr(canonical_predictions, targets)

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
            "corr_delta": None if correlation_delta is None else round(correlation_delta, 8),
            "fusion_spread": round(fusion_spread, 8),
            "canonical_l4_spread": round(canonical_spread, 8),
            "spread_delta": round(spread_delta, 8),
        })

    corr_delta_lcb90 = _date_cluster_lcb90(correlation_deltas)
    spread_delta_lcb90 = _date_cluster_lcb90(spread_deltas)
    minimum_oos_dates = max(4, math.ceil(PRIMARY_MIN_DATES * 0.2))
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
        "challenger": "allocator_ev_fusion_v8_selection_model",
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
            "challenger": "allocator_ev_fusion_v8_final_trade_ev",
            "comparison_target": "realized_multisession_trade_ev_net_of_costs",
            "decision": "FAIL",
            "failed_gates": blockers,
            "samples": 0,
            "oos_date_count": 0,
            "daily": [],
        }

    dates = sorted({str(sample["date"]) for sample in samples})
    split_idx = max(1, round(len(dates) * 0.8)) if dates else 0
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
        })

    minimum_oos_dates = max(4, math.ceil(PRIMARY_MIN_DATES * 0.2))
    corr_delta_lcb90 = _date_cluster_lcb90(correlation_deltas)
    spread_delta_lcb90 = _date_cluster_lcb90(spread_deltas)
    if len(daily) < minimum_oos_dates:
        blockers.append("paired_oos_dates_insufficient")
    if corr_delta_lcb90 is None or corr_delta_lcb90 < 0.0:
        blockers.append("fusion_corr_delta_lcb90_inferior_to_canonical_l4")
    if spread_delta_lcb90 is None or spread_delta_lcb90 < 0.0:
        blockers.append("fusion_spread_delta_lcb90_inferior_to_canonical_l4")
    return {
        "schema_version": "allocator-ev-fusion-final-champion-comparison-v1",
        "champion": "canonical_l4",
        "challenger": "allocator_ev_fusion_v8_final_trade_ev",
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
            calibration_pairs = _expanding_oof_pairs(
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
        rows.append({"fold": fold, **_metrics(test, intercept, coefs, target_key=metrics_target_key)})
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
    split_idx = max(1, round(len(dates) * 0.8)) if dates else 0
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
            calibration_pairs = _expanding_oof_pairs(
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
                    "method": "expanding_window_oof_rank_score_linear_ev_calibration",
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
                full_calibration_pairs = _expanding_oof_pairs(
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
) -> dict[str, Any]:
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score
    from sklearn.preprocessing import StandardScaler

    targets = [float(sample["execution_probability_target"]) for sample in samples]
    dates = sorted({sample["date"] for sample in samples})
    split_idx = max(1, round(len(dates) * 0.8)) if dates else 0
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
    if len(samples) < PRIMARY_MIN_S12_AVAILABLE_SAMPLES:
        blockers.append("insufficient_samples")
    if len(dates) < PRIMARY_MIN_S12_AVAILABLE_DATES:
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
            probabilities = model.predict_proba(scaler.transform(matrix))[:, 1]
            prevalence = max(1e-6, min(1.0 - 1e-6, _mean(train_targets)))
            baseline = [prevalence] * len(ys)
            return {
                "samples": len(rows),
                "mean_target": round(_mean(ys), 8),
                "brier_score": round(float(brier_score_loss(ys, probabilities)), 8),
                "brier_climatology": round(float(brier_score_loss(ys, baseline)), 8),
                "log_loss": round(float(log_loss(ys, probabilities, labels=[0, 1])), 8),
                "log_loss_climatology": round(float(log_loss(ys, baseline, labels=[0, 1])), 8),
                "roc_auc": round(float(roc_auc_score(ys, probabilities)), 8) if len(set(ys)) > 1 else None,
            }

        train_metrics = probability_metrics(train, train_x)
        oos_metrics = probability_metrics(test, test_x)
        if float(oos_metrics["brier_score"]) >= float(oos_metrics["brier_climatology"]):
            blockers.append("oos_brier_not_better_than_climatology")
        if float(oos_metrics["log_loss"]) >= float(oos_metrics["log_loss_climatology"]):
            blockers.append("oos_log_loss_not_better_than_climatology")
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
    champion_comparison: dict[str, Any],
    min_dates: int,
    min_samples: int,
) -> tuple[str, list[str]]:
    blockers: list[str] = []
    sample_count = int(diagnostics.get("sample_count") or 0)
    date_count = int(diagnostics.get("date_count") or 0)
    execution_sample_count = int(diagnostics.get("execution_sample_count") or 0)
    execution_date_count = int(diagnostics.get("execution_date_count") or 0)
    l4_available_count = int(diagnostics.get("l4_available_count") or 0)
    l4_available_date_count = int(diagnostics.get("l4_available_date_count") or 0)
    structure_count = int(diagnostics.get("s12_structure_available_count") or 0)
    structure_date_count = int(diagnostics.get("s12_structure_available_date_count") or 0)
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
    if l4_available_count < PRIMARY_MIN_L4_OOF_SAMPLES:
        blockers.append("primary_l4_oof_samples_low")
    if l4_available_date_count < PRIMARY_MIN_L4_OOF_DATES:
        blockers.append("primary_l4_oof_dates_low")
    if structure_count < PRIMARY_MIN_S12_STRUCTURE_SAMPLES:
        blockers.append("primary_s12_structure_samples_low")
    if structure_date_count < PRIMARY_MIN_S12_STRUCTURE_DATES:
        blockers.append("primary_s12_structure_dates_low")
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

    assistive_ok = (
        sample_count >= min(min_samples, ASSISTIVE_MIN_SAMPLES)
        and date_count >= min(min_dates, ASSISTIVE_MIN_DATES)
        and top_mean > 0.0
        and spread > 0.0
        and corr > 0.0
        and bool(walk_forward.get("passed"))
        and l4_available_count >= ASSISTIVE_MIN_EXPERT_SAMPLES
        and l4_available_date_count >= ASSISTIVE_MIN_EXPERT_DATES
        and structure_count >= ASSISTIVE_MIN_EXPERT_SAMPLES
        and structure_date_count >= ASSISTIVE_MIN_EXPERT_DATES
        and execution_model.get("decision") == "PASS"
        and execution_probability_model.get("decision") == "PASS"
        and champion_comparison.get("decision") == "PASS"
    )
    if assistive_ok:
        return "assistive", blockers
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
) -> dict[str, Any]:
    samples, diagnostics = _samples(rows, execution_cost_bps=cost_model_bps)
    selection_model = _fit_expert(
        samples,
        feature_names=SELECTION_FEATURE_NAMES,
        target_key="selection_rank_target",
        min_samples=min_samples,
        min_dates=min_dates,
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
    )
    execution_model = _fit_expert(
        execution_samples,
        feature_names=EXECUTION_FEATURE_NAMES,
        target_key="execution_target",
        min_samples=PRIMARY_MIN_S12_AVAILABLE_SAMPLES,
        min_dates=PRIMARY_MIN_S12_AVAILABLE_DATES,
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
    failed_gates = [
        f"{component}:{gate}"
        for component, model in (
            ("selection", selection_model),
            ("execution", execution_model),
            ("execution_probability", execution_probability_model),
            ("final_champion", champion_comparison),
        )
        for gate in (model.get("failed_gates") or [])
    ]
    decision = "PASS" if not failed_gates else "FAIL"
    promotion_tier, promotion_blockers = _promotion_tier(
        decision=decision,
        diagnostics=diagnostics,
        oos_metrics=selection_model["oos_metrics"],
        walk_forward=selection_model["walk_forward"],
        execution_model=execution_model,
        execution_probability_model=execution_probability_model,
        champion_comparison=champion_comparison,
        min_dates=min_dates,
        min_samples=min_samples,
    )
    if decision != "PASS":
        promotion_blockers = failed_gates
    validation_packet = {
        "schema_version": "allocator-ev-fusion-validation-packet-v8",
        "decision": decision,
        "failed_gates": failed_gates,
        "validation_scope": {
            "owner": "allocator_ev_fusion",
            "selection_target": "next_session_raw_open_to_fifth_session_raw_close_factor_stable_net_of_costs",
            "label_schema_version": LABEL_SCHEMA_VERSION,
            "execution_probability_target": "next_session_canonical_execution_indicator_by_archetype",
            "execution_target": "five_session_canonical_lifecycle_net_pnl_when_executed",
            "rowwise_label_coalesce": False,
            "method": "date_split_oos_plus_walk_forward",
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
            "schema_version": "allocator-ev-fusion-promotion-v3",
            "tier": promotion_tier,
            "automatic": True,
            "failed_gates": promotion_blockers,
            "primary_requirements": {
                "min_dates": max(min_dates, PRIMARY_MIN_DATES),
                "min_samples": max(min_samples, PRIMARY_MIN_SAMPLES),
                "min_execution_samples": PRIMARY_MIN_S12_AVAILABLE_SAMPLES,
                "min_execution_dates": PRIMARY_MIN_S12_AVAILABLE_DATES,
                "s12_coverage_is_diagnostic_only": True,
                "min_l4_oof_samples": PRIMARY_MIN_L4_OOF_SAMPLES,
                "min_l4_oof_dates": PRIMARY_MIN_L4_OOF_DATES,
                "min_s12_structure_samples": PRIMARY_MIN_S12_STRUCTURE_SAMPLES,
                "min_s12_structure_dates": PRIMARY_MIN_S12_STRUCTURE_DATES,
                "execution_expert_validation_passed": True,
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
        "schema_version": "allocator-ev-fusion-artifact-v8",
        "artifact_contract_version": ARTIFACT_CONTRACT_VERSION,
        "feature_semantic_version": FEATURE_SEMANTIC_VERSION,
        "label_schema_version": LABEL_SCHEMA_VERSION,
        "expected_return_owner": "allocator_ev_fusion",
        "promotion_state": (
            "production_primary" if promotion_tier == "primary"
            else "production_assistive" if promotion_tier == "assistive"
            else "shadow"
        ),
        "promotion_tier": promotion_tier,
        "primary_expected_return_allowed": promotion_tier == "primary",
        "assistive_expected_return_allowed": promotion_tier in {"assistive", "primary"},
        "promotion_blockers": promotion_blockers,
        "validation_packet": validation_packet,
        "resolver_method": "cross_fitted_rank_two_part_trade_ev_fusion",
        "model_version": f"allocator-ev-fusion-cross-fit-v8-{trained_until.replace('-', '')}",
        "feature_snapshot_version": "allocator-ev-fusion-feature-snapshot-v9-directional-executable-label",
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
        },
    }
    return {
        "status": "ok" if decision == "PASS" else "failed_validation",
        "artifact": artifact,
        "validation_packet": validation_packet,
    }


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
            """
            WITH price_horizons AS (
                SELECT
                    sp.stock_id,
                    date(sp.date) AS price_date,
                    LEAD(sp.open, 1) OVER (PARTITION BY sp.stock_id ORDER BY date(sp.date)) AS entry_raw_open,
                    LEAD(
                        CASE WHEN sp.close > 0 AND sp.adj_close > 0 THEN sp.adj_close / sp.close END,
                        1
                    ) OVER (PARTITION BY sp.stock_id ORDER BY date(sp.date)) AS entry_adjustment_factor,
                    LEAD(date(sp.date), 5) OVER (PARTITION BY sp.stock_id ORDER BY date(sp.date)) AS exit_date,
                    LEAD(sp.close, 5) OVER (PARTITION BY sp.stock_id ORDER BY date(sp.date)) AS exit_raw_close,
                    LEAD(
                        CASE WHEN sp.close > 0 AND sp.adj_close > 0 THEN sp.adj_close / sp.close END,
                        5
                    ) OVER (PARTITION BY sp.stock_id ORDER BY date(sp.date)) AS exit_adjustment_factor
                FROM stock_prices sp
                WHERE date(sp.date) >= date(?, ?, '-10 days')
                  AND date(sp.date) <= date(?)
            )
            SELECT
                p.stock_id,
                fs.symbol,
                date(p.prediction_date) AS prediction_date,
                fs.forecast_data,
                (ph.exit_raw_close / ph.entry_raw_open) - 1.0 AS l4_executable_return_pct,
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
            JOIN predictions p
              ON p.stock_id = fs.stock_id
             AND p.prediction_date = fs.snapshot_date
             AND p.model_name = 'ensemble'
            JOIN stocks st
              ON st.id = fs.stock_id
            JOIN price_horizons ph
              ON ph.stock_id = p.stock_id
             AND ph.price_date = date(p.prediction_date)
            WHERE ph.entry_raw_open > 0
              AND ph.exit_raw_close > 0
              AND ph.entry_adjustment_factor > 0
              AND ph.exit_adjustment_factor > 0
              AND ABS((ph.exit_adjustment_factor / ph.entry_adjustment_factor) - 1.0) <= 0.02
              AND date(ph.exit_date) <= date(?)
              AND fs.snapshot_source = ?
              AND fs.as_of_guard = ?
              AND fs.alpha_allocation IS NOT NULL
              AND date(p.prediction_date) <= date(?)
              AND date(p.prediction_date) >= date(?, ?)
            ORDER BY date(p.prediction_date) ASC, fs.symbol ASC
            LIMIT ?
            """,
            [
                end_date,
                f"-{max(1, int(lookback_days))} days",
                outcome_cutoff,
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
        if "allocator_ev_feature_snapshots" not in str(exc):
            raise

    if snapshot_available:
        return snapshot_rows

    return query_fn(
        """
        WITH price_horizons AS (
            SELECT
                sp.stock_id,
                date(sp.date) AS price_date,
                LEAD(sp.open, 1) OVER (PARTITION BY sp.stock_id ORDER BY date(sp.date)) AS entry_raw_open,
                LEAD(
                    CASE WHEN sp.close > 0 AND sp.adj_close > 0 THEN sp.adj_close / sp.close END,
                    1
                ) OVER (PARTITION BY sp.stock_id ORDER BY date(sp.date)) AS entry_adjustment_factor,
                LEAD(date(sp.date), 5) OVER (PARTITION BY sp.stock_id ORDER BY date(sp.date)) AS exit_date,
                LEAD(sp.close, 5) OVER (PARTITION BY sp.stock_id ORDER BY date(sp.date)) AS exit_raw_close,
                LEAD(
                    CASE WHEN sp.close > 0 AND sp.adj_close > 0 THEN sp.adj_close / sp.close END,
                    5
                ) OVER (PARTITION BY sp.stock_id ORDER BY date(sp.date)) AS exit_adjustment_factor
            FROM stock_prices sp
            WHERE date(sp.date) >= date(?, ?, '-10 days')
              AND date(sp.date) <= date(?)
        )
        SELECT
            p.stock_id,
            s.symbol,
            date(p.prediction_date) AS prediction_date,
            p.forecast_data,
            (ph.exit_raw_close / ph.entry_raw_open) - 1.0 AS l4_executable_return_pct,
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
          AND ABS((ph.exit_adjustment_factor / ph.entry_adjustment_factor) - 1.0) <= 0.02
          AND date(ph.exit_date) <= date(?)
          AND dr.alpha_allocation IS NOT NULL
          AND date(p.prediction_date) <= date(?)
          AND date(p.prediction_date) >= date(?, ?)
        ORDER BY date(p.prediction_date) ASC, s.symbol ASC
        LIMIT ?
        """,
        [
            end_date,
            f"-{max(1, int(lookback_days))} days",
            outcome_cutoff,
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
