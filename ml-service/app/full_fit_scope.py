"""Explicit full-fit sample admission; immutable archive provenance stays unchanged."""
from datetime import date
import numpy as np
from .deployment_refit import requested


def bounds(payload):
    signal, known = payload.get("signal_date_max"), payload.get("label_known_at_max")
    if signal is None and known is None:
        return None
    if not requested(payload):
        raise ValueError("full_fit_scope_requires_deployment_refit")
    for value in (signal, known):
        if not isinstance(value, str) or date.fromisoformat(value).isoformat() != value:
            raise ValueError("full_fit_scope_dates_required")
    if signal >= known or known != (payload.get("as_of_date") or payload.get("run_date")):
        raise ValueError("full_fit_scope_cutoff_mismatch")
    return {"signal_date_max": signal, "label_known_at_max": known,
            "scope": "explicit_full_fit_samples", "point_in_time_vintage_certified": False}


def row_mask(payload, signals, known):
    scope = bounds(payload)
    signals, known = np.asarray(signals).astype(str), np.asarray(known).astype(str)
    if scope is None:
        return np.ones(len(signals), dtype=bool)
    if signals.ndim != 1 or signals.shape != known.shape or not len(signals):
        raise ValueError("full_fit_scope_row_lineage_invalid")
    for value in set(signals.tolist() + known.tolist()):
        if date.fromisoformat(value).isoformat() != value:
            raise ValueError("full_fit_scope_row_date_invalid")
    if np.any(known <= signals):
        raise ValueError("full_fit_scope_invalid_label")
    mask = (signals <= scope["signal_date_max"]) & (known <= scope["label_known_at_max"])
    if not mask.any():
        raise ValueError("full_fit_scope_empty")
    return mask


def sequence_records(payload, records, *, horizon):
    scope = bounds(payload)
    if scope is None:
        return records, None
    from .neuralforecast_sequence_runtime import _canonical_sequence_calendar
    calendar = _canonical_sequence_calendar(records)
    eligible = [i for i, day in enumerate(calendar) if day <= scope["signal_date_max"]
                and i + horizon < len(calendar)
                and calendar[i + horizon] <= scope["label_known_at_max"]]
    if not eligible:
        raise ValueError("full_fit_scope_sequence_empty")
    # A forecasting window's final target may be at most horizon sessions after
    # its last input day. Limit training history to the last eligible target.
    last_signal = eligible[-1]
    last_observation = calendar[last_signal + horizon]
    output = []
    original_rows = 0
    for record in records:
        days = record.get("dates") or []
        if len(set(days)) != len(days) or days != sorted(days):
            raise ValueError("full_fit_scope_sequence_dates_invalid")
        for day in days:
            if date.fromisoformat(day).isoformat() != day:
                raise ValueError("full_fit_scope_sequence_dates_invalid")
        original_rows += len(days)
        indices = [i for i, day in enumerate(days) if day <= last_observation]
        if not indices:
            continue
        item = {}
        for name, value in record.items():
            if name in {"open", "close"} and len(value) != len(days):
                raise ValueError("full_fit_scope_sequence_alignment_invalid")
            item[name] = [value[i] for i in indices] if isinstance(value, list) and len(value) == len(days) else value
        output.append(item)
    # This bounds the input archive, not the learner's windows. NeuralForecast
    # can admit partial horizons after this signal unless its window mask also
    # requires every target. The trainer certifies actual bounds separately.
    return output, {**scope, "complete_horizon_signal_date_max": calendar[last_signal],
                    "admitted_observation_date_max": last_observation,
                    "archive_observation_max": calendar[-1],
                    "archive_rows": original_rows,
                    "admitted_rows": sum(len(r["dates"]) for r in output)}


def complete_nf_window_scope(scope, panel, *, horizon):
    """Bind a complete-horizon window policy to the actual aligned panel."""
    if (not scope or not panel or not isinstance(horizon, int) or horizon <= 0
            or panel.get("last_complete_training_signal_date") != scope.get("complete_horizon_signal_date_max")
            or panel.get("calendar_end") != scope.get("admitted_observation_date_max")
            or panel["last_complete_training_signal_date"] > scope["signal_date_max"]
            or panel["calendar_end"] > scope["label_known_at_max"]
            or panel.get("unique_training_windows", 0) <= 0):
        raise ValueError("full_fit_nf_window_scope_mismatch")
    return {**scope,
            "actual_signal_date_max": panel["last_complete_training_signal_date"],
            "actual_label_known_at_max": panel["calendar_end"],
            "window_admission": {
                "policy": "complete_horizon_only",
                "horizon": horizon,
                "minimum_outsample_fraction": 1.0,
                "start_padding_enabled": False,
                "eligible_symbol_windows": panel["unique_training_windows"],
                "support_kind": "possible_windows_not_sampled_window_ids",
            }}
