import asyncio

import pandas as pd
import pytest

from services import active8_prep_lifecycle, capture_inventory, r33_readiness
from routers import retrain_trigger, walk_forward

SESSIONS = [d.date().isoformat() for d in pd.bdate_range("2026-01-02", "2026-10-23")]
PREFIX = "universal/sequence_long/r33"


class NoWriteBlob:
    def __init__(self, name):
        self.name = name

    def exists(self):
        return False

    def __getattr__(self, attr):
        if attr.startswith(("upload", "delete", "patch", "compose", "rewrite")):
            raise AssertionError(f"readiness_wrote_gcs:{attr}:{self.name}")
        raise AttributeError(attr)


class NoWriteBucket:
    name = "stockvision-models"

    def blob(self, name):
        return NoWriteBlob(name)

    def list_blobs(self, prefix=""):
        return []


def _select_only(rows):
    def query(sql, params=None):
        assert sql.lstrip().upper().startswith("SELECT"), sql
        return rows(sql)
    return query


def _market(sql):
    return [{"trading_date": d, "price_rows": 2000} for d in SESSIONS]


def _ops(skip=()):
    def rows(sql):
        return [{"date": d, "run_id": f"run-{d}", "symbol": s, "decision": "selected", "created_at": f"{d}T09:00"}
                for d in SESSIONS if d not in skip for s in ("2330", "2317")]
    return rows


def _plan():
    required = active8_prep_lifecycle._r33_required_price_sessions()
    return {"status": "dry_run", "business_date": "2026-10-23", "snapshot_id": "snap-1",
            "source_gcs_prefix": "universal/prep/src-r33", "output_gcs_prefix": "universal/prep/adj-r33",
            "sequence_gcs_prefix": PREFIX,
            "r33_sequence_selection": {"required_price_sessions": required, "selected_sequence_gcs_prefix": PREFIX,
                                       "selected_capture_id": "cap-1",
                                       "candidates": [{"sequence_gcs_prefix": PREFIX, "price_sessions": required}]}}


def _patch(monkeypatch, *, plan=None, pending=None, inventory="inventory_ready", sealed=None):
    calls = {}

    async def prep(**kwargs):
        calls["prep"] = kwargs
        if pending is not None:
            raise pending
        return plan or _plan()

    monkeypatch.setattr(active8_prep_lifecycle, "ensure_active8_daily_prep", prep)
    monkeypatch.setattr(retrain_trigger, "_verified_prep_only_receipt", lambda *a, **k: sealed)
    monkeypatch.setattr(walk_forward, "_latest_canonical_prep_prefix", lambda *a, **k: "universal/prep/adj-r33")

    def inspect_inventory(bucket, **kwargs):
        calls["inventory"] = kwargs
        return {"status": inventory, "issues": [] if inventory == "inventory_ready" else [{"code": "x"}]}

    monkeypatch.setattr(capture_inventory, "inspect_capture_inventory", inspect_inventory)
    monkeypatch.delenv("R33_OOF_CHALLENGER_MODELS", raising=False)
    return calls


def _run(ops_skip=()):
    return asyncio.run(r33_readiness.run_r33_readiness(
        end_date="2026-10-23", bucket=NoWriteBucket(),
        market_query=_select_only(_market), ops_query=_select_only(_ops(ops_skip))))


def _by_name(report):
    return {check["name"]: check for check in report["checks"]}


def test_ready_verdict_uses_dry_run_owners_and_never_writes(monkeypatch):
    calls = _patch(monkeypatch)
    report = _run()
    checks = _by_name(report)
    assert report["verdict"] == "ready" and report["dispatched"] is False and report["writes"] == []
    assert calls["prep"]["dry_run"] is True
    assert calls["inventory"] == {"sequence_gcs_prefix": PREFIX, "run_date": "2026-10-23", "inference_only": False,
                                  "per_field_auxiliary": True, "require_aligned_history": True}
    assert set(checks) == {"profile_roster", "sequence_selection", "prep_plan", "capture_inventory", "l2_pool",
                           "tabpack_closure_skipped", "challenger_slots"}
    assert checks["profile_roster"]["model_count"] == 7
    assert checks["sequence_selection"]["required_price_sessions"] == 1532
    assert checks["prep_plan"]["source_prep"] == "build" and checks["prep_plan"]["adjusted_prep"] == "reuse_latest"
    assert checks["l2_pool"]["required_sessions"] == 21 * 7 and checks["l2_pool"]["missing_dates"] == []
    assert checks["tabpack_closure_skipped"]["r33_owner_forbidden_references"] == []
    assert checks["challenger_slots"]["resolution"] == "modal_lifecycle_slots"


def test_short_sequence_fails_with_selection_receipt(monkeypatch):
    receipt = {"required_price_sessions": 1532, "candidates": [{"price_sessions": 1200}]}
    _patch(monkeypatch, pending=active8_prep_lifecycle.Active8PrepDependencyPending(
        "r33_sequence_history_insufficient", receipt))
    report = _run()
    checks = _by_name(report)
    assert report["verdict"] == "not_ready"
    assert checks["sequence_selection"]["status"] == "fail" and checks["sequence_selection"]["receipt"] == receipt
    assert {"prep_plan", "capture_inventory"} <= set(report["blocking_checks"])


def test_inventory_blocks_new_prep_but_warns_when_sealed_prep_is_reused(monkeypatch):
    _patch(monkeypatch, inventory="blocked")
    assert "capture_inventory" in _run()["blocking_checks"]
    _patch(monkeypatch, inventory="blocked", sealed={"status": "ready"})
    report = _run()
    assert report["verdict"] == "ready" and report["warnings"] == ["capture_inventory"]


def test_missing_pool_days_warn_and_challenger_overlap_fails(monkeypatch):
    _patch(monkeypatch)
    skipped = SESSIONS[-10]
    report = _run(ops_skip={skipped})
    assert _by_name(report)["l2_pool"]["missing_dates"] == [skipped] and report["warnings"] == ["l2_pool"]
    monkeypatch.setenv("R33_OOF_CHALLENGER_MODELS", "TimeXer,linear_neutral")
    report = _run()
    assert _by_name(report)["challenger_slots"]["overlap_with_release"] == ["TimeXer"]
    assert "challenger_slots" in report["blocking_checks"]


def test_readiness_route_is_registered():
    assert any(getattr(route, "path", "") == "/walk_forward/oof/r33-readiness" for route in walk_forward.router.routes)
