"""R33 monthly readiness preflight.

Read-only: GCS reads and D1 SELECTs only. It dispatches no Modal, Cloud Run or
prep work and writes no GCS/D1/KV object. Every check reuses the owner the
monthly lifecycle itself calls, in its dry-run/read form, so the verdict is the
lifecycle's own admission, not a parallel re-implementation.
"""
from __future__ import annotations

import ast
import inspect
import os
import statistics
from typing import Any, Callable

SCHEMA_VERSION = "r33-readiness-v1"


def _check(name: str, status: str, **evidence: Any) -> dict[str, Any]:
    return {"name": name, "status": status, **evidence}


def check_profile_roster() -> dict[str, Any]:
    from routers.walk_forward import R33_OOF_TEST_SESSIONS, _oof_test_sessions, _oof_training_min_folds
    from services.active8_release_model_profiles import model_profiles
    from services.alpha_model_roster import R33_MODELS, model_order
    from services.formal_feature_contract import PROFILES131, R33_PROFILE

    order = list(model_order(model_profiles(schema_version=R33_PROFILE), complete=True))
    ok = (order == list(R33_MODELS) and len(order) == 7 and R33_PROFILE in PROFILES131
          and _oof_test_sessions(R33_PROFILE) == R33_OOF_TEST_SESSIONS)
    return _check("profile_roster", "pass" if ok else "fail", profile=R33_PROFILE, models=order,
                  model_count=len(order), test_sessions=_oof_test_sessions(R33_PROFILE),
                  min_folds=_oof_training_min_folds(R33_PROFILE))


def check_sequence_selection(plan: dict | None, pending: Exception | None) -> dict[str, Any]:
    from services.active8_prep_lifecycle import _r33_required_price_sessions

    required = _r33_required_price_sessions()
    if plan is None:
        reason = getattr(pending, "reason", str(pending))
        evidence = getattr(pending, "evidence", {})
        if reason == "r33_sequence_history_insufficient":
            return _check("sequence_selection", "fail", reason=reason, required_price_sessions=required,
                          receipt=evidence)
        return _check("sequence_selection", "blocked", reason=f"upstream:{reason}",
                      required_price_sessions=required, evidence=evidence)
    receipt = plan.get("r33_sequence_selection") or {}
    selected = receipt.get("selected_sequence_gcs_prefix")
    chosen = [c for c in receipt.get("candidates") or [] if c.get("sequence_gcs_prefix") == selected]
    sessions = (chosen[0].get("price_sessions") or 0) if len(chosen) == 1 else 0
    ok = bool(selected) and receipt.get("required_price_sessions") == required and sessions >= required
    return _check("sequence_selection", "pass" if ok else "fail", required_price_sessions=required,
                  selected_sequence_gcs_prefix=selected, selected_price_sessions=sessions,
                  selected_capture_id=receipt.get("selected_capture_id"), receipt=receipt)


def check_prep_reuse(bucket, plan: dict | None) -> dict[str, Any]:
    if plan is None:
        return _check("prep_plan", "blocked", reason="prep_plan_unavailable")
    from routers.retrain_trigger import _verified_prep_only_receipt
    from routers.walk_forward import _latest_canonical_prep_prefix
    from services.formal_feature_contract import R33_PROFILE, semantic_for_profile
    from services.training_policy import R33_PREP_SUFFIX

    semantic = semantic_for_profile(R33_PROFILE)
    try:
        sealed = _verified_prep_only_receipt(bucket, plan["source_gcs_prefix"], plan["business_date"],
                                             expected_feature_semantic=semantic)
    except Exception as exc:  # noqa: BLE001 - an invalid seal is rejected by the real prep too.
        return _check("prep_plan", "fail", reason=f"source_prep_receipt_invalid:{exc}",
                      source_gcs_prefix=plan["source_gcs_prefix"])
    latest_adjusted = _latest_canonical_prep_prefix(bucket, expanded_history=True, expected_feature_semantic=semantic,
                                                    required_suffix=R33_PREP_SUFFIX)
    return _check("prep_plan", "pass", business_date=plan["business_date"],
                  source_gcs_prefix=plan["source_gcs_prefix"],
                  source_prep="reuse_sealed" if sealed else "build",
                  adjusted_gcs_prefix=plan["output_gcs_prefix"],
                  latest_r33_adjusted_prefix=latest_adjusted,
                  adjusted_prep="reuse_latest" if latest_adjusted == plan["output_gcs_prefix"] else "build",
                  sequence_gcs_prefix=plan["sequence_gcs_prefix"], snapshot_id=plan.get("snapshot_id"))


def check_capture_inventory(bucket, plan: dict | None, prep: dict) -> dict[str, Any]:
    if plan is None:
        return _check("capture_inventory", "blocked", reason="prep_plan_unavailable")
    from services.capture_inventory import inspect_capture_inventory

    try:
        inventory = inspect_capture_inventory(bucket, sequence_gcs_prefix=plan["sequence_gcs_prefix"],
                                              run_date=plan["business_date"], inference_only=False,
                                              per_field_auxiliary=True, require_aligned_history=True)
    except Exception as exc:  # noqa: BLE001 - the real prep rejects an unreadable inventory.
        inventory = {"status": "unreadable", "issues": [{"code": "prep_source_inventory_unreadable",
                                                          "detail": str(exc)[:500]}]}
    if inventory.get("status") == "inventory_ready":
        status = "pass"
    else:
        # A sealed source prep is reused before the inventory gate runs (retrain_trigger).
        status = "warn" if prep.get("source_prep") == "reuse_sealed" else "fail"
    return _check("capture_inventory", status, guards=["per_field_auxiliary", "require_aligned_history"],
                  inventory=inventory)


def _planned_prediction_dates(cutoff: str, query_fn: Callable, sessions_needed: int) -> list[str]:
    """Mature market sessions the next R33 cohort predicts (D1 SELECT only)."""
    from services.active8_oof_release_validation import LABEL_HORIZON_SESSIONS

    rows = query_fn(
        "SELECT substr(date, 1, 10) trading_date, COUNT(*) price_rows FROM stock_prices "
        "WHERE substr(date, 1, 10) BETWEEN date(?, '-400 days') AND date(?) "
        "GROUP BY substr(date, 1, 10) ORDER BY trading_date", [cutoff, cutoff])
    counts = [int(r.get("price_rows") or 0) for r in rows or []]
    if not counts:
        return []
    threshold = max(100, int(statistics.median(counts) * 0.20))
    sessions = [str(r["trading_date"])[:10] for r in rows if int(r.get("price_rows") or 0) >= threshold]
    mature = sessions[:-LABEL_HORIZON_SESSIONS] if len(sessions) > LABEL_HORIZON_SESSIONS else []
    return mature[-sessions_needed:]


def check_l2_pool(cutoff: str, market_query: Callable, ops_query: Callable, roster: dict) -> dict[str, Any]:
    from services.r33_calibration_job import POOL_SOURCE, load_l2_pool

    needed = int(roster["test_sessions"]) * int(roster["min_folds"])
    dates = _planned_prediction_dates(cutoff, market_query, needed)
    if len(dates) < needed:
        return _check("l2_pool", "fail", reason="market_session_calendar_short", source=POOL_SOURCE,
                      planned_prediction_sessions=len(dates), required_sessions=needed)
    pool, receipt = load_l2_pool(ops_query, start=dates[0], end=dates[-1])
    missing = [d for d in dates if d not in pool]
    # A day without a pool silently leaves calibration (pool_score_table semi-join).
    status = "pass" if not missing else ("fail" if len(missing) == len(dates) else "warn")
    return _check("l2_pool", status, source=POOL_SOURCE, calendar_source="d1_market_stock_prices_planned",
                  planned_start=dates[0], planned_end=dates[-1], required_sessions=needed,
                  covered_sessions=needed - len(missing), missing_dates=missing,
                  receipt={k: receipt[k] for k in ("days", "rows", "decisions", "multi_run_days", "membership_sha256")})


def check_tabpack_closure_skipped() -> dict[str, Any]:
    """The R33 manifest branch returns before native L4/TabPack refresh, P3 and monthly closure."""
    from routers import walk_forward
    from services import r33_monthly_lifecycle

    source = inspect.getsource(walk_forward.run_walk_forward_oof_lifecycle)
    r33 = source.find("return await run_r33_monthly_lifecycle(")
    later = {name: source.find(name) for name in ("materialize_native_base(", "refresh_family(",
                                                  "materialize_walk_forward_oof(")}
    tree = ast.parse(inspect.getsource(r33_monthly_lifecycle))
    if tree.body and isinstance(tree.body[0], ast.Expr) and isinstance(getattr(tree.body[0], "value", None), ast.Constant):
        tree.body = tree.body[1:]  # the docstring names what the owner must not do
    tokens = " ".join(
        str(getattr(node, "id", None) or getattr(node, "attr", None) or getattr(node, "name", None)
            or (node.value if isinstance(node, ast.Constant) and isinstance(node.value, str) else ""))
        for node in ast.walk(tree)).lower()
    leaks = [name for name in ("tabpack", "materialize_native_base", "refresh_family", "monthly_training_closure",
                               "active8_ensemble_pointer", "model_champion_pointers") if name in tokens]
    ok = r33 >= 0 and all(pos > r33 for pos in later.values()) and not leaks
    return _check("tabpack_closure_skipped", "pass" if ok else "fail",
                  r33_branch_offset=r33, later_owner_offsets=later, r33_owner_forbidden_references=leaks)


def check_challenger_slots(roster: dict) -> dict[str, Any]:
    from routers.walk_forward import _r33_challenger_models

    override = _r33_challenger_models()
    overlap = sorted(set(override) & set(roster["models"]))
    return _check("challenger_slots", "fail" if overlap else "pass",
                  resolution="controller_override" if override else "modal_lifecycle_slots",
                  override_env="R33_OOF_CHALLENGER_MODELS", override=override, overlap_with_release=overlap,
                  note=("Unset override: the Modal orchestrator resolves app.challenger_models.LIFECYCLE_SLOTS "
                        "(PR #71); without that module R33 runs no challenger. Unknown override names are "
                        "reported as unsupported challenger metrics and never block the release folds."))


async def run_r33_readiness(*, end_date: str | None, bucket, market_query: Callable | None = None,
                            ops_query: Callable | None = None) -> dict[str, Any]:
    from datetime import datetime, timedelta, timezone

    from services.active8_prep_lifecycle import Active8PrepDependencyPending, ensure_active8_daily_prep
    from services.d1_domain_client import D1DataDomain, client_proxy_for_domain
    from services.formal_feature_contract import R33_PROFILE

    cutoff = end_date or (datetime.now(timezone.utc) + timedelta(hours=8)).date().isoformat()
    market_query = market_query or client_proxy_for_domain(D1DataDomain.MARKET).query
    ops_query = ops_query or client_proxy_for_domain(D1DataDomain.OPS).query
    roster = check_profile_roster()
    plan, pending = None, None
    try:
        # dry_run=True: returns the plan before any prep dispatch or receipt write.
        plan = await ensure_active8_daily_prep(end_date=cutoff, dry_run=True, query_fn=market_query,
                                               model_profile_schema_version=R33_PROFILE)
    except Active8PrepDependencyPending as exc:
        pending = exc
    prep = check_prep_reuse(bucket, plan)
    checks = [
        roster,
        check_sequence_selection(plan, pending),
        prep,
        check_capture_inventory(bucket, plan, prep),
        check_l2_pool(cutoff, market_query, ops_query, roster),
        check_tabpack_closure_skipped(),
        check_challenger_slots(roster),
    ]
    blocking = [c["name"] for c in checks if c["status"] in {"fail", "blocked"}]
    return {"schema_version": SCHEMA_VERSION, "profile": R33_PROFILE, "cutoff": cutoff,
            "verdict": "not_ready" if blocking else "ready", "blocking_checks": blocking,
            "warnings": [c["name"] for c in checks if c["status"] == "warn"],
            "prep_pending_reason": getattr(pending, "reason", None),
            "dispatched": False, "writes": [], "source_sha": os.environ.get("STOCKVISION_SOURCE_SHA", ""),
            "checks": checks}
