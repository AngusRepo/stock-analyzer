"""Read-only presentation metadata. Never dispatches or mutates lifecycle state."""
from __future__ import annotations

import json
import re
from datetime import date, datetime, timezone
from typing import Any


def cohort_progress(receipt: dict[str, Any], cohort_id: str, source: str) -> dict[str, Any]:
    if receipt.get("cohort_id") != cohort_id or receipt.get("cadence") != "daily":
        raise ValueError("cohort_receipt_identity_mismatch")
    calendar = receipt.get("calendar") or {}
    physical = receipt.get("physical_prediction_coverage") or {}
    covered = physical.get("base_max_date")
    mature = calendar.get("mature_max_date")
    # A frontier at/before the materialized base proves zero new dates. A later
    # frontier alone cannot prove how many trading sessions exist between them.
    pending = None
    if covered and mature:
        covered_date = date.fromisoformat(covered)
        mature_date = date.fromisoformat(mature)
        pending = 0 if mature_date <= covered_date else None
    return {
        "status": "observed", "source": source,
        "as_of": receipt.get("knowledge_cutoff_date"),
        "completed_at": receipt.get("completed_at"),
        "phase": receipt.get("status"),
        "covered_through": covered, "mature_through": mature,
        "pending_mature_dates": pending, "required_dates": 10,
        "reason": "no_new_mature_dates" if pending == 0 else "exact_new_date_count_not_reported",
    }


def load_model_pool_overview(bundle: dict[str, Any], bucket: Any) -> dict[str, Any]:
    observed = bundle.get("observability") or {}
    fit = observed.get("fit") or {}
    coefficients = fit.get("coefficients") or []
    names = observed.get("feature_names") or []
    rank_coefficients = {
        name.removesuffix(".rank"): coefficients[index]
        for index, name in enumerate(names)
        if name.endswith(".rank") and index < len(coefficients)
    }
    cohort = {"status": "unavailable", "pending_mature_dates": None, "required_dates": 10}
    cohort_id = bundle.get("cohort_id")
    if cohort_id and re.fullmatch(r"[A-Za-z0-9_-]+", cohort_id):
        prefix = f"walk_forward/oof_cohorts/{cohort_id}/lifecycle/"
        try:
            blobs = list(bucket.list_blobs(prefix=prefix, max_results=101, timeout=10))
            # Avoid claiming latest evidence from a truncated listing.
            if len(blobs) > 100:
                raise ValueError("cohort_receipt_listing_truncated")
            daily = [b for b in blobs if re.fullmatch(r"\d{4}-\d{2}-\d{2}\.daily\.json", b.name.removeprefix(prefix))]
            if daily:
                latest = max(daily, key=lambda b: b.name)
                receipt = json.loads(latest.download_as_text(timeout=10))
                cohort = cohort_progress(receipt, cohort_id, latest.name)
        except Exception as exc:
            cohort["reason"] = "cohort_receipt_unavailable"
            # Do not expose backend paths or credential-bearing exception text.
            cohort["error_type"] = type(exc).__name__
    validation = observed.get("validation") or {}
    return {
        "status": "ok", "generated_at": datetime.now(timezone.utc).isoformat(),
        "bundle_artifact_id": bundle.get("artifact_id"), "cohort_id": cohort_id,
        "knowledge_cutoff_date": observed.get("knowledge_cutoff_date"),
        "rank_coefficients": rank_coefficients,
        "validation": {key: validation.get(key) for key in (
            "decision", "validation_start_date", "validation_end_date",
            "rank_ic_equal_date_market_mean", "rank_ic_equal_date_market_lcb90",
            "top_bottom_net_return_spread", "top_bottom_net_return_spread_lcb90",
        )},
        "cohort": cohort,
    }
