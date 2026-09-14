"""Final deployment-fit boundary, independent of validation/promotion decisions."""
from datetime import date

import numpy as np


def requested(payload):
    enabled = (
        str(payload.get("generation_mode") or "").strip().lower()
        in {"oof_full_fit_release", "local_full_fit"}
        or payload.get("candidate_type") == "oof_full_fit_release"
    )
    if enabled and any(payload.get(key) for key in ("train_start", "train_end", "test_start", "test_end")):
        raise ValueError("deployment_refit_cannot_use_outer_test_split")
    return enabled


def validate_full_history(*, signal_dates, label_known_dates, cutoff):
    if not isinstance(cutoff, str) or date.fromisoformat(cutoff).isoformat() != cutoff:
        raise ValueError("deployment_refit_cutoff_required")
    signals = np.asarray(signal_dates).astype(str).reshape(-1)
    known = np.asarray(label_known_dates).astype(str).reshape(-1)
    if not len(signals) or len(signals) != len(known):
        raise ValueError("deployment_refit_row_lineage_incomplete")
    for value in set(signals.tolist() + known.tolist()):
        if date.fromisoformat(value).isoformat() != value:
            raise ValueError("deployment_refit_date_invalid")
    if np.any(known <= signals) or np.any(known > cutoff):
        raise ValueError("deployment_refit_future_or_invalid_label")
    return {
        "method": "full_known_history_refit_after_validation",
        "rows": len(signals),
        "train_range": [min(signals), max(signals)],
        "label_known_date_max": max(known),
        "knowledge_cutoff_date": cutoff,
        "validation_models_are_not_served": True,
    }


def row_limit(payload, *, full_fit, default):
    value = payload.get("max_rows")
    if value is None:
        value = (payload.get("data_slice") or {}).get("max_rows")
    return int(value if value is not None else (0 if full_fit else default))
