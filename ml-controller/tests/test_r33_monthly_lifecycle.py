"""R33 monthly candidate lifecycle: gate, skipped steps, full-fit cutoff, pointers, captures."""
from __future__ import annotations

import asyncio
import hashlib
import io
import json
from pathlib import Path

import numpy as np
import pytest

from services.alpha_model_roster import R33_MODELS

ROOT = Path(__file__).resolve().parents[1]
POINTER_TABLES = ("model_champion_pointers", "active8_ensemble_pointer_v1")


class Blob:
    def __init__(self, store, name):
        self.store, self.name = store, name

    def exists(self):
        return self.name in self.store

    def upload_from_string(self, data, content_type=None, if_generation_match=None):
        if if_generation_match == 0 and self.name in self.store:
            from google.api_core.exceptions import PreconditionFailed
            raise PreconditionFailed("exists")
        self.store[self.name] = data.encode() if isinstance(data, str) else data

    def download_as_bytes(self):
        return self.store[self.name]

    def download_as_text(self):
        return self.store[self.name].decode()


class Bucket:
    name = "bucket"

    def __init__(self, store=None):
        self.store = {} if store is None else store

    def blob(self, name):
        return Blob(self.store, name)

    def list_blobs(self, prefix="", match_glob=None):
        import fnmatch
        return [Blob(self.store, n) for n in sorted(self.store)
                if n.startswith(prefix) and (match_glob is None or fnmatch.fnmatchcase(n, match_glob))]


class Recorder:
    def __init__(self):
        self.sql = []

    def execute(self, sql, params=None, *args, **kwargs):
        self.sql.append(sql)
        return {"success": True}

    def query(self, sql, params=None, *args, **kwargs):
        self.sql.append(sql)
        return []


def _rows(run_id="run-1"):
    return [{"artifact_id": f"{name}:v1", "model_name": name, "version": "v1", "candidate_type": "oof_full_fit_release",
             "state": "offline_passed", "artifact_path": f"gs://b/{name}.bin", "metadata_path": f"gs://b/{name}.json",
             "checksum": "c" * 64, "training_run_id": run_id, "promotion_decision": "not_evaluated",
             "approval_state": "not_required"} for name in R33_MODELS]


def _assert_no_pointer_write(sqls):
    assert not [sql for sql in sqls if any(table in sql for table in POINTER_TABLES)]


def test_register_candidates_marks_seven_rows_for_wei_without_pointer_write(monkeypatch):
    from services import model_artifact_registry
    from services.r33_monthly_lifecycle import PROMOTION_DECISION, candidate_registry_complete, register_candidates
    recorder = Recorder()
    monkeypatch.setattr(model_artifact_registry, "d1_client", recorder)
    registry = register_candidates(_rows(), release_models=R33_MODELS, expected_run_id="run-1")
    assert registry["ensemble_candidate"] is None and set(registry["artifacts"]) == set(R33_MODELS)
    assert len(recorder.sql) == 7 and all("INSERT INTO model_artifact_registry" in sql for sql in recorder.sql)
    _assert_no_pointer_write(recorder.sql)
    assert candidate_registry_complete(registry, R33_MODELS)
    assert not candidate_registry_complete({"status": "materialized"}, R33_MODELS)
    captured = []
    register_candidates(_rows(), release_models=R33_MODELS, expected_run_id="run-1", upsert=captured.append)
    assert {row["promotion_decision"] for row in captured} == {PROMOTION_DECISION}
    assert {row["candidate_type"] for row in captured} == {"oof_full_fit_release"}  # no new candidate_type
    with pytest.raises(RuntimeError, match="r33_candidate_sources_invalid"):
        register_candidates(_rows("other-run"), release_models=R33_MODELS, expected_run_id="run-1", upsert=captured.append)


def _plan():
    return {"status": "ready", "tree_models": [], "release_models": sorted(R33_MODELS), "promotion_eligible_models": [],
            "artifact_lifecycle_targets": [], "train_model_groups": ["tree"],
            "model_profile_schema_version": "active8-release-model-profiles-v7-r33-exo131", "promotion_evidence": {}}


def _patch_dispatch(monkeypatch):
    import routers.walk_forward as wf
    from services import active8_full_fit_reuse
    monkeypatch.setattr(wf, "build_oof_full_fit_dispatch_plan", lambda manifest: _plan())
    monkeypatch.setattr(active8_full_fit_reuse, "find_prior_full_fit_receipt", lambda **kwargs: None)
    monkeypatch.setattr(active8_full_fit_reuse, "full_fit_input_identity", lambda manifest, plan: {"id": 1})

    def aliases(**kwargs):
        raise AssertionError("candidate-only must not build the P3 ensemble or aliases")
    monkeypatch.setattr(wf, "_materialize_completed_oof_release_aliases", aliases)
    return wf


def test_candidate_only_full_fit_uses_latest_mature_signal_cutoff(monkeypatch):
    wf = _patch_dispatch(monkeypatch)
    from routers import retrain_trigger
    from services import training_source_preflight
    monkeypatch.setattr(training_source_preflight, "require_single_adjustment_capture", lambda bucket, **kw: {})
    seen = {}

    async def trigger(req, request=None):
        seen["request"] = req
        return {"status": "triggered", "run_id": "run-1"}
    monkeypatch.setattr(retrain_trigger, "trigger_universal_retrain", trigger)
    manifest = {"cohort_id": "c-r33", "end_date": "2026-10-20", "manifest_checksum": "m"}
    result = asyncio.run(wf.dispatch_oof_full_fit_training(
        manifest=manifest, knowledge_cutoff_date="2026-10-30", bucket=Bucket(), lifecycle_cadence="monthly",
        signal_date_max="2026-10-23", candidate_only=True))
    assert result["status"] == "dispatched" and result["retry_required"] is True
    assert seen["request"].signal_date_max == "2026-10-23"
    assert seen["request"].label_known_at_max == "2026-10-30"


def test_candidate_only_completion_registers_candidates_not_ensemble(monkeypatch):
    wf = _patch_dispatch(monkeypatch)
    from services import model_artifact_registry
    recorder = Recorder()
    monkeypatch.setattr(model_artifact_registry, "d1_client", recorder)

    class Learning:
        def query(self, sql, params=None, *args, **kwargs):
            recorder.sql.append(sql)
            return _rows()
    monkeypatch.setattr(wf, "LEARNING_D1_CLIENT", Learning())
    monkeypatch.setattr(wf, "OPS_D1_CLIENT", Recorder())
    bucket = Bucket()
    bucket.blob("walk_forward/oof_cohorts/c-r33/full_fit/2026-10-30.json").upload_from_string(json.dumps(
        {"run_id": "run-1", "attempt": 1, "status": "dispatched", "cohort_id": "c-r33",
         "knowledge_cutoff_date": "2026-10-30"}))
    result = asyncio.run(wf.dispatch_oof_full_fit_training(
        manifest={"cohort_id": "c-r33", "end_date": "2026-10-23"}, knowledge_cutoff_date="2026-10-30", bucket=bucket,
        lifecycle_cadence="monthly", candidate_only=True))
    assert result["status"] == "completed"
    assert result["release_registry"]["promotion_decision"] == "r33_candidate_pending_wei"
    _assert_no_pointer_write(recorder.sql)
    # The immutable receipt short-circuits a replay without re-registering.
    again = asyncio.run(wf.dispatch_oof_full_fit_training(
        manifest={"cohort_id": "c-r33", "end_date": "2026-10-23"}, knowledge_cutoff_date="2026-10-30", bucket=bucket,
        lifecycle_cadence="monthly", candidate_only=True))
    assert again["reason"] == "immutable_full_fit_receipt_complete"


def _manifest():
    return {"cohort_id": "c-r33", "model_set": list(R33_MODELS), "test_window_days": 21, "end_date": "2026-10-23",
            "manifest_checksum": "m" * 64, "sequence_gcs_prefix": "seq", "windows": []}


FEES = {"commission": 0.001425, "tax": 0.003, "dayTradeTax": 0.0015, "minCommission": 20}


def _trading_config(*, degraded=False, fees=FEES, source="worker_admin_config"):
    from services.trading_config_loader import TradingConfigContract, TradingConfigLoadResult
    config = {} if fees is None else {"fees": fees}
    return TradingConfigLoadResult(config=config, contract=TradingConfigContract(
        source=source, raw_present=True, degraded=degraded, missing_sections=[], defaulted_sections=[]))


def _patch_lifecycle(monkeypatch, *, checks_status="pass", full_fit=None, manifest=None, trading_config=None):
    from services import active8_oof_cohort_materializer as mat, l4_oof_index_receipt, l4_oof_lifecycle
    from services import r33_calibration_job, r33_monthly_lifecycle as life, r33_oof_checks, training_source_preflight
    from services import trading_config_loader
    import polars as pl
    import routers.walk_forward as wf
    calls = {"dispatch": [], "persist": 0}
    monkeypatch.setattr(mat, "load_verified_oof_manifest", lambda path, **kw: (manifest or _manifest(), b""))
    monkeypatch.setattr(training_source_preflight, "require_oof_training_sources", lambda bucket, manifest: {})
    preds = [{"prediction_date": "2026-10-20", "symbol": "2330", "market_segment": "TWSE", "model_name": m,
              "raw_score": 0.1, "target_return": 0.01, "label_known_date": "2026-10-27", "fold_id": "w0"} for m in R33_MODELS]
    monkeypatch.setattr(mat, "load_oof_prediction_rows", lambda manifest, bucket: preds)
    monkeypatch.setattr(l4_oof_index_receipt, "reuse_index", lambda manifest, bucket, client: None)
    monkeypatch.setattr(l4_oof_index_receipt, "seal_index", lambda manifest, index, bucket, client: None)

    def persist(**kwargs):
        calls["persist"] += 1
        return {"status": "ready", "prediction_dates": 1, "min_date": "2026-10-20", "max_date": "2026-10-23"}
    monkeypatch.setattr(l4_oof_lifecycle, "persist_base_index", persist)
    monkeypatch.setattr(life, "load_raw_open_close", lambda bucket, prefix, start: (
        pl.DataFrame({"date": ["2026-10-20", "2026-10-21"], "symbol": ["2330", "2330"], "open": [100.0, 111.0],
                      "close": [100.0, 110.0]}), {"rows": 2}))
    monkeypatch.setattr(life, "fold_receipts", lambda manifest, bucket: [{"fold_id": "w0", "train_label_known_max": "2026-10-01", "test_start": "2026-10-02"}])
    monkeypatch.setattr(r33_calibration_job, "load_l2_pool", lambda query, start, end: ({"2026-10-20": {"2330"}}, {"days": 1}))
    loaded = trading_config or _trading_config()
    monkeypatch.setattr(trading_config_loader, "load_merged_trading_config_with_contract", lambda: loaded)
    seen_oof = {}

    from services import pit_certification
    receipt = {"receipt": {"capture": "c", "contract_version": "pit-availability-contract-v1"}, "receipt_sha256": "r" * 64}

    def checks(**kwargs):
        seen_oof["frame"] = kwargs["oof"]
        seen_oof["round_trip_cost"] = kwargs["round_trip_cost"]
        seen_oof["pit_certification"] = kwargs["pit_certification"]
        seen_oof["checks_runs"] = seen_oof.get("checks_runs", 0) + 1
        # Same contract as r33_oof_checks: no receipt or a binding reason fails pit_vintage.
        attached = kwargs["pit_certification"]
        passed = attached is not None and not kwargs.get("pit_binding_reasons")
        result = {**{name: {"passed": checks_status == "pass"} for name in ("leakage", "inversion", "tail_guard")},
                  "pit_vintage": {"passed": passed, "receipt_sha256": (attached or {}).get("receipt_sha256")}}
        return {"schema_version": r33_oof_checks.SCHEMA,
                "status": "pass" if all(c["passed"] for c in result.values()) else "fail", "checks": result}
    monkeypatch.setattr(r33_oof_checks, "run_checks", checks)
    def bound(bucket, *, sequence_gcs_prefix, prep_gcs_prefixes=(), contract=None):
        seen_oof["pit_bound"] = {"sequence": sequence_gcs_prefix, "preps": list(prep_gcs_prefixes)}
        if seen_oof.get("unreadable"):
            raise ValueError("Expecting value: line 1 column 1 (char 0)")
        attached, extra = seen_oof["receipt"], list(seen_oof.get("binding_reasons") or ())
        if attached is None:
            return {"certified": False, "reasons": ["receipt_missing"], "attached": None}
        return {"certified": not extra, "reasons": extra, "binding_reasons": extra,
                "receipt_sha256": attached["receipt_sha256"], "attached": attached}
    monkeypatch.setattr(pit_certification, "verify_bound_receipt", bound)
    seen_oof["receipt"] = receipt
    monkeypatch.setattr(r33_calibration_job, "fit_calibration",
                        lambda **kw: {"schema": "cal", "cost": kw["round_trip_cost"], "min_block_weight": kw["min_block_weight"]})

    async def dispatch(**kwargs):
        calls["dispatch"].append(kwargs)
        return full_fit
    monkeypatch.setattr(wf, "dispatch_oof_full_fit_training", dispatch)
    return calls, seen_oof


def _run(bucket, cadence="monthly", poll_only=False, calendar=None):
    from services.r33_monthly_lifecycle import run_r33_monthly_lifecycle
    return asyncio.run(run_r33_monthly_lifecycle(
        manifest_path="walk_forward/oof_cohorts/c-r33/manifest.json", cohort_id="c-r33", as_of="2026-10-30",
        cadence=cadence, calendar={"mature_max_date": "2026-10-23"} if calendar is None else calendar, dry_run=False, poll_only=poll_only,
        bucket=bucket, client=Recorder(), ops_query=lambda *a: []))


def test_non_monthly_cadence_is_skipped_without_work(monkeypatch):
    calls, _ = _patch_lifecycle(monkeypatch)
    result = _run(Bucket(), cadence="daily")
    assert result["status"] == "skipped" and result["training_dispatched"] is False
    assert calls == {"dispatch": [], "persist": 0}


def test_failed_oof_checks_never_dispatch_full_fit(monkeypatch):
    calls, seen = _patch_lifecycle(monkeypatch, checks_status="fail")
    bucket = Bucket()
    result = _run(bucket)
    assert result["status"] == "failed" and result["reason"] == "r33_oof_checks_failed"
    assert calls["dispatch"] == [] and result["training_dispatched"] is False
    assert seen["frame"].filter(seen["frame"]["entry_limit_up"]).height == len(R33_MODELS)  # 111/100 open gap
    assert "r33/monthly_candidates/c-r33/oof_checks.json" in bucket.store
    assert "r33/monthly_candidates/c-r33/bundle.json" not in bucket.store


def _pit_scope(**changes):
    return {"dataset": {"deployment_fit": {"input_scope": {
        "point_in_time_vintage_certified": True, "pit_certification_sha256": "r" * 64,
        "pit_contract_version": "pit-availability-contract-v1", **changes}}}}


def _registry_with_metadata(bucket, **per_model):
    artifacts = {m: {"artifact_id": f"{m}:v1", "checksum": "c" * 64, "metadata_path": f"meta/{m}.json"}
                 for m in R33_MODELS}
    for m in R33_MODELS:
        bucket.store[f"meta/{m}.json"] = json.dumps(per_model.get(m, _pit_scope())).encode()
    return {"status": "r33_candidates_registered", "promotion_decision": "r33_candidate_pending_wei",
            "training_run_id": "run-1", "artifacts": artifacts, "ensemble_candidate": None}


def test_passing_checks_seal_a_candidate_bundle(monkeypatch):
    from services.r33_monthly_lifecycle import ROUND_TRIP_COST
    bucket = Bucket()
    registry = _registry_with_metadata(bucket)
    artifacts = registry["artifacts"]
    calls, _ = _patch_lifecycle(monkeypatch, full_fit={"status": "completed", "retry_required": False, "release_registry": registry})
    result = _run(bucket)
    assert result["status"] == "materialized" and result["promoted"] is False and result["serving_pointer_changed"] is False
    assert calls["dispatch"][0]["signal_date_max"] == "2026-10-23"
    assert calls["dispatch"][0]["candidate_only"] is True and calls["dispatch"][0]["allow_new_dispatch"] is True
    bundle = json.loads(bucket.store["r33/monthly_candidates/c-r33/bundle.json"])
    assert bundle["status"] == "sealed" and bundle["calibration"]["cost"] == ROUND_TRIP_COST
    assert bundle["calibration"]["min_block_weight"] == bundle["calibration_contract"]["min_block_days"] == 1.0
    assert bundle["artifacts"] == artifacts and bundle["serving_pointer_changed"] is False
    assert bundle["full_fit_signal_date_max"] == bundle["mature_max_date"] == "2026-10-23"
    assert result["r33_candidate_bundle"]["checksum"] == hashlib.sha256(bucket.store["r33/monthly_candidates/c-r33/bundle.json"]).hexdigest()
    assert result["physical_prediction_coverage"]["max_date"] == "2026-10-23"
    # Replays reuse both write-once receipts.
    assert _run(bucket)["r33_candidate_bundle"] == result["r33_candidate_bundle"]
    # The full-fit carries the PIT receipt the checks verified (C28-02 C6).
    assert calls["dispatch"][0]["pit_certification"]["receipt_sha256"] == "r" * 64
    # The bundle records the gate that admitted it and the receipt it was verified against.
    assert bundle["oof_checks"]["status"] == "pass" and bundle["oof_checks"]["pit_certification_sha256"] == "r" * 64


@pytest.mark.parametrize("metadata", [{}, _pit_scope(point_in_time_vintage_certified=False),
                                      _pit_scope(pit_certification_sha256="s" * 64), _pit_scope(pit_contract_version=None),
                                      {"a": _pit_scope(), "b": _pit_scope(pit_contract_version="v0")}, None])
def test_a_full_fit_artifact_without_the_pit_binding_is_not_sealed(monkeypatch, metadata):
    # e.g. an older trainer image that dropped pit_certification / pit_contract_version.
    bucket = Bucket()
    first = sorted(R33_MODELS)[0]
    registry = _registry_with_metadata(bucket, **{first: metadata})
    if metadata is None:
        bucket.store[f"meta/{first}.json"] = b"not json"
    _patch_lifecycle(monkeypatch, full_fit={"status": "completed", "retry_required": False, "release_registry": registry})
    result = _run(bucket)
    assert result["status"] == "failed" and result["reason"] == "r33_full_fit_pit_metadata_missing"
    assert result["full_fit_dispatch"]["pit_metadata_missing"] == [first]
    assert "r33/monthly_candidates/c-r33/bundle.json" not in bucket.store


@pytest.mark.parametrize("sealed", [{}, {"pit_vintage": {"passed": True}},
                                    {"leakage": {"passed": True}, "inversion": {"passed": True}}])
def test_sealed_checks_missing_a_required_check_fail_closed(monkeypatch, sealed):
    from services import r33_oof_checks
    calls, _ = _patch_lifecycle(monkeypatch, full_fit={"status": "completed", "retry_required": False})
    bucket = Bucket()
    bucket.store["r33/monthly_candidates/c-r33/oof_checks.json"] = json.dumps(
        {"manifest_checksum": _manifest()["manifest_checksum"], "gate_cost": {"round_trip_cost": 0.00585},
         "result": {"schema_version": r33_oof_checks.SCHEMA, "status": "pass", "checks": sealed}}).encode()
    result = _run(bucket)
    assert result["status"] == "failed" and result["reason"] == "r33_oof_checks_failed" and calls["dispatch"] == []


@pytest.mark.parametrize("change", ["missing", "unbound", "unreadable", "replaced", "pre_gate_checks"])
def test_the_pit_gate_is_reverified_on_every_run(monkeypatch, change):
    from services import r33_oof_checks
    calls, seen = _patch_lifecycle(monkeypatch, full_fit={"status": "completed", "retry_required": False})
    bucket = Bucket()
    # Checks sealed earlier (current schema, so the cost line is in them): without a pit_vintage
    # entry, or against the original receipt. Receipts older than the cost line are stale (X11).
    gate = {name: {"passed": True} for name in ("leakage", "inversion", "tail_guard")}
    if change != "pre_gate_checks":
        gate["pit_vintage"] = {"passed": True, "receipt_sha256": "r" * 64}
    bucket.store["r33/monthly_candidates/c-r33/oof_checks.json"] = json.dumps(
        {"manifest_checksum": _manifest()["manifest_checksum"], "gate_cost": {"round_trip_cost": 0.00585},
         "result": {"schema_version": r33_oof_checks.SCHEMA, "status": "pass", "checks": gate}}).encode()
    if change == "missing":
        seen["receipt"] = None
    if change == "unbound":
        seen["binding_reasons"] = ["lane_manifest_changed:daily_price"]
    if change == "unreadable":  # a stored receipt that is not JSON fails the gate, not the job
        seen["unreadable"] = True
    if change == "replaced":  # a regenerated receipt for the same capture
        seen["receipt"] = {"receipt": {"capture": "c", "contract_version": "pit-availability-contract-v1", "generated_at": "later"},
                           "receipt_sha256": "s" * 64}
    result = _run(bucket)
    assert result["r33_oof_checks"]["pit_certified"] is (change in ("replaced", "pre_gate_checks"))
    if change in ("missing", "unbound", "unreadable"):
        assert result["status"] == "failed" and result["reason"] == "r33_pit_certification_unbound"
        assert calls["dispatch"] == [] and result["training_dispatched"] is False
        assert result["r33_oof_checks"]["status"] == "fail" and result["r33_oof_checks"]["sealed_status"] == "pass"
        if change == "unreadable":
            assert result["pit_certification"]["reasons"] == [
                "receipt_unreadable:ValueError:Expecting value: line 1 column 1 (char 0)"]
    else:
        # The full-fit carries the receipt verified now, not the one recorded at seal time.
        assert calls["dispatch"][0]["pit_certification"] == seen["receipt"]
    assert "checks_runs" not in seen  # sealed checks are never re-run



@pytest.mark.parametrize("missing", ["receipt", "binding"])
def test_a_failed_pit_check_is_sealed_and_recovers_once_the_receipt_binds(monkeypatch, missing):
    windows = [{"source_prep_gcs_prefix": "universal/prep/w0"}, {"source_prep_gcs_prefix": "universal/prep/w1"}]
    calls, seen = _patch_lifecycle(monkeypatch, full_fit={"status": "completed", "retry_required": False},
                                   manifest={**_manifest(), "prep_gcs_prefix": "universal/prep/full", "windows": windows})
    if missing == "receipt":
        seen["receipt"] = None
    else:
        seen["binding_reasons"] = ["prep_not_built_under_contract:universal/prep/w0"]
    bucket = Bucket()
    result = _run(bucket)
    assert result["status"] == "failed" and result["reason"] == "r33_pit_certification_unbound"
    assert calls["dispatch"] == [] and result["r33_oof_checks"]["pit_certified"] is False
    # The OOF checks are sealed regardless, so leakage/inversion/tail-guard cannot be re-rolled.
    sealed = bucket.store["r33/monthly_candidates/c-r33/oof_checks.json"]
    assert result["r33_oof_checks"]["checksum"] == hashlib.sha256(sealed).hexdigest()
    # Every prep the cohort trained on is bound: the full-fit prep and each window's source prep.
    assert seen["pit_bound"] == {"sequence": "seq", "preps": ["universal/prep/full", "universal/prep/w0", "universal/prep/w1"]}
    seen["receipt"], seen["binding_reasons"] = {"receipt": {"capture": "c", "contract_version": "pit-availability-contract-v1"},
                                                "receipt_sha256": "r" * 64}, []
    result = _run(bucket)
    assert bucket.store["r33/monthly_candidates/c-r33/oof_checks.json"] == sealed and seen["checks_runs"] == 1
    assert calls["dispatch"][0]["pit_certification"]["receipt_sha256"] == "r" * 64
    # The file still says fail (its pit_vintage is from seal time); the gate applied now passed.
    assert result["r33_oof_checks"]["sealed_status"] == "fail" and result["r33_oof_checks"]["status"] == "pass"
    assert result["r33_oof_checks"]["pit_certification_sha256"] == "r" * 64


def test_checks_cost_line_reads_trading_config_fees_not_the_calibration_constant(monkeypatch):
    from services.r33_monthly_lifecycle import GATE_COST_OWNER, ROUND_TRIP_COST
    _, seen = _patch_lifecycle(monkeypatch, checks_status="fail")
    bucket = Bucket()
    _run(bucket)
    assert seen["round_trip_cost"] == pytest.approx(0.00585) and seen["round_trip_cost"] != ROUND_TRIP_COST
    report = json.loads(bucket.store["r33/monthly_candidates/c-r33/oof_checks.json"])
    assert report["gate_cost"] == {"round_trip_cost": pytest.approx(0.00585), "owner": GATE_COST_OWNER,
                                   "source": "worker_admin_config", "commission": 0.001425, "tax": 0.003}
    # A different KV fee schedule moves the cost line with it (no copy of 0.585% in code).
    _, seen = _patch_lifecycle(monkeypatch, checks_status="fail",
                               trading_config=_trading_config(fees={"commission": 0.0005, "tax": 0.0015}))
    _run(Bucket())
    assert seen["round_trip_cost"] == pytest.approx(0.0025)


@pytest.mark.parametrize("trading_config,reason", [
    (dict(degraded=True, source="direct_kv_worker_fallback"), "r33_gate_cost_contract_degraded:direct_kv_worker_fallback"),
    (dict(fees=None), "r33_gate_cost_fees_missing"),
    (dict(fees={"commission": 0.001425}), "r33_gate_cost_fees_missing"),
    (dict(fees={"commission": "0.001425", "tax": 0.003}), "r33_gate_cost_fees_invalid"),
    (dict(fees={"commission": True, "tax": 0.003}), "r33_gate_cost_fees_invalid"),
    (dict(fees={"commission": -0.001, "tax": 0.008}), "r33_gate_cost_fees_invalid"),
    (dict(fees={"commission": float("nan"), "tax": 0.003}), "r33_gate_cost_fees_invalid"),
    (dict(fees={"commission": 0.0, "tax": 0.0}), "r33_round_trip_cost_invalid"),
    (dict(fees={"commission": 0.4, "tax": 0.3}), "r33_round_trip_cost_invalid"),
])
def test_unusable_cost_owner_fails_closed_before_checks_are_sealed(monkeypatch, trading_config, reason):
    calls, seen = _patch_lifecycle(monkeypatch, full_fit={"status": "completed", "retry_required": False},
                                   trading_config=_trading_config(**trading_config))
    bucket = Bucket()
    with pytest.raises(ValueError, match="^" + reason.replace(".", r"\.") + "$"):
        _run(bucket)
    assert "frame" not in seen and calls["dispatch"] == []
    assert "r33/monthly_candidates/c-r33/oof_checks.json" not in bucket.store


@pytest.mark.parametrize("calendar", [{}, {"mature_max_date": None}, {"oof_max_date": "2026-10-23"}])
def test_missing_mature_max_date_fails_closed_before_full_fit(monkeypatch, calendar):
    calls, _ = _patch_lifecycle(monkeypatch, full_fit={"status": "completed", "retry_required": False})
    bucket = Bucket()
    result = _run(bucket, calendar=calendar)
    assert result["status"] == "failed" and result["reason"] == "r33_mature_max_date_missing"
    assert calls["dispatch"] == [] and result["training_dispatched"] is False
    assert "r33/monthly_candidates/c-r33/bundle.json" not in bucket.store


def test_pending_full_fit_requests_continuation(monkeypatch):
    calls, _ = _patch_lifecycle(monkeypatch, full_fit={"status": "pending", "retry_required": True, "reason": "modal_full_fit_still_running"})
    result = _run(Bucket(), poll_only=True)
    assert result["status"] == "pending" and result["dependency_retry_required"] is True
    assert calls["dispatch"][0]["allow_new_dispatch"] is False


def test_fold_receipts_require_every_model_attestation():
    from services.r33_monthly_lifecycle import fold_receipts
    store, metrics = {}, {}
    for name in R33_MODELS:
        split = {"train_end": "2026-09-30", "train_label_known_max": "2026-09-30"} if name in ("PatchTST", "iTransformer") else (
            {"training_label_known_max": "2026-10-01"} if name == "TimeXer" else {"train_label_known_max": "2026-10-02"})
        buf = io.BytesIO()
        np.savez(buf, metadata=np.array(json.dumps({"model_name": name, "split_metadata": split})))
        store[f"a/{name}"] = buf.getvalue()
        metrics[name] = {"oof_artifact": f"a/{name}", "artifact_checksum": hashlib.sha256(buf.getvalue()).hexdigest()}
    manifest = {"model_set": list(R33_MODELS), "windows": [{"window_id": 3, "test_range": ["2026-10-09", "2026-10-30"], "model_metrics": metrics}]}
    receipts = fold_receipts(manifest, Bucket(store))
    assert receipts[0]["fold_id"] == "w3" and receipts[0]["train_label_known_max"] == "2026-10-02"
    buf = io.BytesIO()
    np.savez(buf, metadata=np.array(json.dumps({"model_name": "TabM", "split_metadata": {}})))
    store["a/TabM"] = buf.getvalue()
    metrics["TabM"]["artifact_checksum"] = hashlib.sha256(buf.getvalue()).hexdigest()
    assert fold_receipts(manifest, Bucket(store)) == []  # unattested fold: leakage check fails it
    for name, split in (("TabM", {"train_label_known_max": "2026-10-02"}), ("PatchTST", {"train_end": "2026-09-30"})):
        buf = io.BytesIO()
        np.savez(buf, metadata=np.array(json.dumps({"model_name": name, "split_metadata": split})))
        store[f"a/{name}"] = buf.getvalue()
        metrics[name]["artifact_checksum"] = hashlib.sha256(buf.getvalue()).hexdigest()
    assert fold_receipts(manifest, Bucket(store)) == []  # NF train_end alone is not an attestation


def test_r33_routing_gates_in_walk_forward():
    import routers.walk_forward as wf
    from services.formal_feature_contract import EXO131_PROFILE, R33_PROFILE
    assert wf._oof_test_sessions(R33_PROFILE) == 21 and wf._oof_test_sessions(EXO131_PROFILE) == wf.OOF_TEST_SESSIONS
    source = (ROOT / "routers" / "walk_forward.py").read_text(encoding="utf-8")
    assert source.count("(TIMEXER_EXO_PROFILE_SCHEMA, EXO131_PROFILE, R33_PROFILE)") == 2  # single_b gates
    gate = source.index('"reason": "r33_cohort_monthly_owner_only"')
    assert source.index("parent_manifest = parent[1] if parent is not None else {}") < gate < source.index("cohort_version = OOF_COHORT_ID_VERSION")
    r33_branch = source.index("from services.r33_monthly_lifecycle import run_r33_monthly_lifecycle")
    assert r33_branch < source.index("if new_distribution or uses_native_l4(manifest):")
    assert 'if manifest.get("model_profile_schema_version") == R33_PROFILE:' in source[r33_branch - 300:r33_branch]


def test_latest_manifest_hides_r33_unless_requested(monkeypatch):
    import routers.walk_forward as wf
    from services.formal_feature_contract import R33_PROFILE
    monkeypatch.setattr(wf, "_oof_forward_parent_contract", lambda *a, **k: {"ready": True})
    sha = "a" * 40
    common = {"status": "ready", "generation_mode": "purged_oof", "prep_manifest": {"producer_source_sha": sha}}
    store = {"walk_forward/oof_cohorts/old/manifest.json": json.dumps({**common, "end_date": "2026-10-01"}).encode(),
             "walk_forward/oof_cohorts/r33/manifest.json": json.dumps({**common, "end_date": "2026-10-23",
                                                                       "model_profile_schema_version": R33_PROFILE}).encode()}
    assert wf._latest_ready_oof_manifest(Bucket(store))[0].endswith("old/manifest.json")
    assert wf._latest_ready_oof_manifest(Bucket(store), model_profile_schema_version=R33_PROFILE)[0].endswith("r33/manifest.json")


def test_r33_prep_prefix_never_mixes_with_exo131(monkeypatch):
    import routers.walk_forward as wf
    from services.training_policy import R33_PREP_SUFFIX
    monkeypatch.setattr(wf, "_runtime_source_sha", lambda: "s")
    base = {"schema_version": next(iter(wf._OOF_PREP_SCHEMAS)), "status": "ready", "target_semantic_version": wf._OOF_TARGET_SEMANTIC_VERSION,
            "feature_semantic_version": "f", "feature_imputation_semantic": wf.OOF_FEATURE_IMPUTATION_SEMANTIC_VERSION,
            "producer_source_sha": "s", "roundtrip_cost_bps": 18.0}
    store = {"universal/canonical_adjusted/a/prep/manifest.json": json.dumps({**base, "signal_date_max": "2026-10-20", "output_gcs_prefix": "p-expanded1280"}).encode(),
             "universal/canonical_adjusted/b/prep/manifest.json": json.dumps({**base, "signal_date_max": "2026-10-23", "output_gcs_prefix": "p-expanded1280" + R33_PREP_SUFFIX}).encode()}
    assert wf._latest_canonical_prep_prefix(Bucket(store), expanded_history=True, expected_feature_semantic="f") == "p-expanded1280"
    assert wf._latest_canonical_prep_prefix(Bucket(store), expanded_history=True, expected_feature_semantic="f",
                                            required_suffix=R33_PREP_SUFFIX) == "p-expanded1280" + R33_PREP_SUFFIX


def _aux_manifest(capture, end, fields, sealed=True, sha=None):
    payload = {"schema_version": "finlab-training-auxiliary-single-capture-v1", "capture_id": capture, "end_date": end,
               "fields": {f: {"sha256": sha or hashlib.sha256(f"{capture}{f}".encode()).hexdigest()} for f in fields}}
    if sealed:
        payload["sealed_raw_source_sha256"] = "d" * 64
    return json.dumps(payload).encode()


AUX_ROOT = "raw/finlab"
PRICE = {"capture_manifest_path": f"{AUX_ROOT}/cap-p/raw/daily_price_full_vintage/manifest.json"}


def _aux_path(capture):
    return f"{AUX_ROOT}/{capture}/raw/training_auxiliary_full_vintage/manifest.json"


def test_each_auxiliary_field_uses_its_latest_content_addressed_capture():
    from services.training_auxiliary_capture import FIELDS, select_field_captures
    store = {_aux_path("cap-a"): _aux_manifest("cap-a", "2026-10-01", FIELDS),
             _aux_path("cap-b"): _aux_manifest("cap-b", "2026-10-29", ("margin_balance", "pe")),
             _aux_path("cap-c"): _aux_manifest("cap-c", "2026-10-30", ("revenue",), sealed=False),
             _aux_path("cap-d"): _aux_manifest("cap-d", "2026-11-02", FIELDS)}
    selected = select_field_captures(Bucket(store), price_capture=PRICE, run_date="2026-10-30")
    assert selected["margin_balance"]["capture_id"] == "cap-b" and selected["pe"]["capture_id"] == "cap-b"
    # Unsealed manifests qualify by per-field sha256; the sealed receipt is recorded, not required.
    assert selected["revenue"]["capture_id"] == "cap-c" and selected["revenue"]["sealed_raw_source_sha256"] is None
    assert selected["eps"]["capture_id"] == "cap-a" and selected["eps"]["sealed_raw_source_sha256"] == "d" * 64
    assert selected["eps"]["capture_manifest_sha256"] == hashlib.sha256(store[_aux_path("cap-a")]).hexdigest()
    assert all(v["end_date"] <= "2026-10-30" for v in selected.values())  # future cap-d ignored
    with pytest.raises(ValueError, match="root_auxiliary_field_capture_missing:short_balance"):
        select_field_captures(Bucket({_aux_path("cap-b"): store[_aux_path("cap-b")]}), price_capture=PRICE, run_date="2026-10-30")


def test_price_capture_own_auxiliary_wins_same_day_tie():
    from services.training_auxiliary_capture import FIELDS, select_field_captures
    # A root-level capture (not under the backfill parent) is still found via its own path.
    own = "r25-full/raw/training_auxiliary_full_vintage/manifest.json"
    price = {"capture_manifest_path": "r25-full/raw/daily_price_full_vintage/manifest.json"}
    store = {own: _aux_manifest("zz-full", "2026-10-30", FIELDS, sealed=False)}
    assert {v["capture_id"] for v in select_field_captures(Bucket(store), price_capture=price, run_date="2026-10-30").values()} == {"zz-full"}
    store = {_aux_path("cap-p"): _aux_manifest("a-full", "2026-10-30", FIELDS, sealed=False),
             _aux_path("finlab-v4-daily-z"): _aux_manifest("finlab-v4-daily-z", "2026-10-30", ("margin_balance", "pe"))}
    selected = select_field_captures(Bucket(store), price_capture=PRICE, run_date="2026-10-30")
    assert {v["capture_id"] for v in selected.values()} == {"a-full"}


def test_corrupt_latest_field_checksum_fails_closed_without_older_fallback():
    from services.training_auxiliary_capture import FIELDS, select_field_captures
    store = {_aux_path("cap-a"): _aux_manifest("cap-a", "2026-10-01", FIELDS),
             _aux_path("cap-b"): _aux_manifest("cap-b", "2026-10-29", ("revenue",), sha="not-a-sha")}
    with pytest.raises(ValueError, match="root_auxiliary_field_checksum_invalid:revenue"):
        select_field_captures(Bucket(store), price_capture=PRICE, run_date="2026-10-30")


def test_loader_rejects_field_parquet_bytes_that_mismatch_selected_sha():
    from services.training_auxiliary_capture import FIELDS, load_training_auxiliary_capture, select_field_captures
    store = {_aux_path("cap-a"): _aux_manifest("cap-a", "2026-10-01", FIELDS, sealed=False),
             f"{AUX_ROOT}/cap-a/raw/training_auxiliary_full_vintage/margin_balance.parquet": b"tampered"}
    bucket = Bucket(store)
    selected = select_field_captures(bucket, price_capture=PRICE, run_date="2026-10-30")
    with pytest.raises(ValueError, match="root_auxiliary_checksum_mismatch:margin_balance"):
        load_training_auxiliary_capture(bucket, price_capture={**PRICE, "capture_id": "cap-p"}, stock_rows=[],
                                        prices_map={"2330": [{"date": "2026-10-30"}]}, prior_ts={}, prior_chips={},
                                        run_date="2026-10-30", field_captures=selected)


def _per_field_proof(store, run_date="2026-10-30"):
    from services.training_auxiliary_capture import select_field_captures
    selected = select_field_captures(Bucket(store), price_capture=PRICE, run_date=run_date)
    keys = ("capture_id", "capture_manifest_path", "capture_manifest_sha256", "sealed_raw_source_sha256", "end_date")
    return {"schema_version": "training-auxiliary-capture-binding-v2-per-field", "capture_id": "cap-p",
            "field_captures": {k: {key: v[key] for key in keys} for k, v in selected.items()},
            "fields": {k: {"sha256": v["meta"]["sha256"]} for k, v in selected.items()}}


def test_v2_per_field_preflight_accepts_unsealed_and_rejects_tampering():
    from services.training_auxiliary_capture import FIELDS
    from services.training_source_preflight import verify_per_field_auxiliary
    store = {_aux_path("cap-a"): _aux_manifest("cap-a", "2026-10-01", FIELDS),
             _aux_path("cap-b"): _aux_manifest("cap-b", "2026-10-29", ("margin_balance", "pe"), sealed=False)}
    proof = _per_field_proof(store)
    verify_per_field_auxiliary(Bucket(store), proof, capture_id="cap-p")
    assert proof["field_captures"]["pe"]["sealed_raw_source_sha256"] is None

    def rejects(mutate, code, bucket_store=store):
        bad = json.loads(json.dumps(proof))
        mutate(bad)
        with pytest.raises(ValueError, match=code):
            verify_per_field_auxiliary(Bucket(bucket_store), bad, capture_id="cap-p")

    rejects(lambda p: p.update(capture_id="other"), "training_source_auxiliary_binding_required")
    rejects(lambda p: p["field_captures"].pop("eps"), "training_source_auxiliary_binding_required")
    # One field's bound sha differs from its own latest capture manifest.
    rejects(lambda p: p["fields"]["pe"].update(sha256="e" * 64), "training_source_auxiliary_field_binding_required:pe")
    rejects(lambda p: p["field_captures"]["pe"].update(capture_manifest_sha256="0" * 64), "training_source_auxiliary_manifest_mismatch:pe")
    rejects(lambda p: p["field_captures"]["pe"].update(sealed_raw_source_sha256="d" * 64), "training_source_auxiliary_owner_identity_mismatch:pe")
    rejects(lambda p: p["field_captures"]["eps"].update(end_date="2026-10-30"), "training_source_auxiliary_owner_identity_mismatch:eps")
    # The manifest bytes changed after binding (e.g. rewritten capture): manifest sha no longer matches.
    rewritten = {**store, _aux_path("cap-b"): _aux_manifest("cap-b", "2026-10-29", ("margin_balance", "pe"), sha="f" * 64)}
    rejects(lambda p: None, "training_source_auxiliary_manifest_mismatch:margin_balance", rewritten)


def _seal_r33_sequence(store, run, *, date_max, start, sessions, created, source_rows=None):
    """Seal a sequence plus its price capture manifest; `sessions` is the official-calendar count."""
    from services.active8_prep_lifecycle import SEQUENCE_PREFIX, _manifest_checksum
    prefix = SEQUENCE_PREFIX + run
    batch = f"{prefix}/prep/batch_0.npz"
    store[batch] = run.encode()
    price_root = f"finlab/v4/backfill/{run}/raw/daily_price_full_vintage"
    store[price_root + "/manifest.json"] = json.dumps({"capture_id": run, "end_date": date_max,
                                                      "sessions": sessions, "start": start}).encode()
    manifest = {"status": "ready", "contract": "sequence_records_v3", "output_gcs_prefix": prefix, "batch_count": 1,
                "created_at": created, "summary": {"date_min": start, "date_max": date_max},
                "lane_reports": [{"lane": "daily_price", "source_rows": source_rows or sessions,
                                  "source_uri": {"capture_id": run, "close": f"gs://bucket/{price_root}/adj_close.parquet"}}],
                "output_checksums": {batch: hashlib.sha256(run.encode()).hexdigest()}}
    manifest["manifest_checksum"] = _manifest_checksum(manifest)
    store[f"{prefix}/prep/sequence_manifest.json"] = json.dumps(manifest).encode()
    return prefix


@pytest.fixture
def official_calendar(monkeypatch):
    """Stand-in for verify_training_calendar: reads the counts sealed in the fake price manifest."""
    from services import training_session_calendar

    def verify(bucket, *, price_capture):
        raw = bucket.blob(price_capture["capture_manifest_path"]).download_as_bytes()
        assert hashlib.sha256(raw).hexdigest() == price_capture["capture_manifest_sha256"]
        meta = json.loads(raw)
        if meta.get("sessions") is None:
            raise ValueError("training_calendar_official_required")
        assert meta["capture_id"] == price_capture["capture_id"]
        return {"start": meta["start"], "end": meta["end_date"], "sessions": meta["sessions"], "calendar_sha256": "c" * 64}
    monkeypatch.setattr(training_session_calendar, "verify_training_calendar", verify)


def test_r33_required_history_is_the_full_consumed_window():
    from services import active8_prep_lifecycle as lifecycle
    # resolve_history 1280 rows + 252 warmup; 464 = 252 + 60 + 21 x 7 + 5 stays as a documented floor.
    assert lifecycle._r33_required_price_sessions() == 1532
    assert lifecycle._r33_minimum_runnable_price_sessions() == 464


def test_r33_long_vintage_wins_and_daily_or_r25_length_fail_closed(official_calendar):
    from services import active8_prep_lifecycle as lifecycle
    store = {}
    _seal_r33_sequence(store, "finlab-v4-daily-20261030-1", date_max="2026-10-30", start="2023-10-31",
                       sessions=729, created="2026-10-30T12:00:00+00:00")
    _seal_r33_sequence(store, "r25-like-20261030", date_max="2026-10-30", start="2023-04-06",
                       sessions=855, created="2026-10-30T13:00:00+00:00")
    _seal_r33_sequence(store, "finlab-v4-daily-20261029-1", date_max="2026-10-29", start="2019-01-02",
                       sessions=1900, created="2026-10-31T12:00:00+00:00")
    with pytest.raises(lifecycle.Active8PrepDependencyPending) as exc:
        lifecycle._r33_sequence_selection(Bucket(store), "2026-11-01")
    assert exc.value.reason == "r33_sequence_history_insufficient"
    seen = {c["capture_id"]: c["price_sessions"] for c in exc.value.evidence["candidates"]}
    assert seen["finlab-v4-daily-20261030-1"] == 729 and seen["r25-like-20261030"] == 855
    assert seen["finlab-v4-daily-20261029-1"] is None  # stale: never evaluated, never selected
    full = _seal_r33_sequence(store, "finlab-v4-3y-r33full-20261030", date_max="2026-10-30", start="2020-05-04",
                              sessions=1576, created="2026-10-30T08:00:00+00:00")
    prefix, _, evidence = lifecycle._r33_sequence_selection(Bucket(store), "2026-11-01")
    assert prefix == evidence["selected_sequence_gcs_prefix"] == full
    assert evidence["selected_capture_id"] == "finlab-v4-3y-r33full-20261030"
    assert evidence["required_price_sessions"] == 1532 and evidence["minimum_runnable_price_sessions"] == 464
    by_id = {c["capture_id"]: c for c in evidence["candidates"]}
    assert (by_id["finlab-v4-3y-r33full-20261030"]["price_start_date"], by_id["finlab-v4-3y-r33full-20261030"]["price_sessions"]) == ("2020-05-04", 1576)
    # The non-R33 selector is untouched: newest created_at on the same date wins.
    assert lifecycle._latest_immutable_sequence(Bucket(store), "2026-11-01")[0].endswith("r25-like-20261030")


def test_r33_session_count_comes_from_official_calendar_not_source_rows(official_calendar):
    from services import active8_prep_lifecycle as lifecycle
    store = {}
    # Wide frame has extra non-session rows: 1540 rows but only 1531 verified sessions.
    _seal_r33_sequence(store, "short-by-one", date_max="2026-10-30", start="2020-08-01",
                       sessions=1531, source_rows=1540, created="2026-10-30T00:00:00+00:00")
    with pytest.raises(lifecycle.Active8PrepDependencyPending):
        lifecycle._r33_sequence_selection(Bucket(store), "2026-11-01")
    exact = _seal_r33_sequence(store, "exact", date_max="2026-10-30", start="2020-07-31",
                               sessions=1532, source_rows=1532, created="2026-10-29T00:00:00+00:00")
    assert lifecycle._r33_sequence_selection(Bucket(store), "2026-11-01")[0] == exact
    # A capture whose calendar cannot be verified is ineligible, never estimated from source_rows.
    store2 = {}
    _seal_r33_sequence(store2, "no-calendar", date_max="2026-10-30", start="2019-01-02",
                       sessions=None, source_rows=1900, created="2026-10-30T00:00:00+00:00")
    with pytest.raises(lifecycle.Active8PrepDependencyPending) as exc:
        lifecycle._r33_sequence_selection(Bucket(store2), "2026-11-01")
    assert "training_calendar_official_required" in exc.value.evidence["candidates"][0]["calendar_error"]


def test_r33_never_falls_back_to_long_stale_capture(official_calendar):
    from services import active8_prep_lifecycle as lifecycle
    store = {}
    _seal_r33_sequence(store, "full-1029", date_max="2026-10-29", start="2019-01-02", sessions=1900, created="2026-10-29T00:00:00+00:00")
    _seal_r33_sequence(store, "daily-1030", date_max="2026-10-30", start="2023-10-31", sessions=729, created="2026-10-30T00:00:00+00:00")
    with pytest.raises(lifecycle.Active8PrepDependencyPending) as exc:
        lifecycle._r33_sequence_selection(Bucket(store), "2026-11-01")
    assert exc.value.evidence["latest_date_max"] == "2026-10-30"
    assert "selected_sequence_gcs_prefix" not in exc.value.evidence


def test_r33_corrupt_long_falls_back_only_within_same_date_max(official_calendar):
    from services import active8_prep_lifecycle as lifecycle
    store = {}
    full = _seal_r33_sequence(store, "full-1030", date_max="2026-10-30", start="2020-05-04", sessions=1576, created="2026-10-30T01:00:00+00:00")
    other = _seal_r33_sequence(store, "full-1030-b", date_max="2026-10-30", start="2020-05-04", sessions=1576, created="2026-10-30T00:00:00+00:00")
    store[f"{full}/prep/batch_0.npz"] = b"corrupt"
    assert lifecycle._r33_sequence_selection(Bucket(store), "2026-11-01")[0] == other


def test_r33_prep_wiring_is_profile_gated():
    source = (ROOT / "routers" / "retrain_trigger.py").read_text(encoding="utf-8")
    assert "r33_prep = req.prep_only and not req.inference_only and req.model_profile_schema_version == R33_PROFILE" in source
    assert source.count("feature_warmup_rows") == 2 and source.count("if r33_prep:") >= 4
    assert '**({"per_field_auxiliary": True, "require_aligned_history": True} if r33_prep else {})' in source
    assert '**({"historical_broker": True} if r33_prep else {}))' in source
    # C28-02: both prep paths build under the contract, the receipt binds it, rows carry the
    # venue's listing date and the capture sidecar joins the roster.
    assert source.count('prep_payload["pit_contract_version"] = PIT_CONTRACT_VERSION') == 1
    assert source.count("payload['pit_contract_version'] = PIT_CONTRACT_VERSION") == 1
    assert 'source_bindings["pit_contract_version"]=PIT_CONTRACT_VERSION' in source
    assert 'source_bindings["pit_contract_sha256"]=contract_content_sha256(load_contract())' in source
    # ml-service refuses another contract file and each batch reports what it applied.
    assert 'prep_payload["pit_contract_sha256"] = source_bindings["pit_contract_sha256"]' in source
    assert "payload['pit_contract_sha256'] = source_bindings['pit_contract_sha256']" in source
    assert "unapplied = prep_batches_not_under_contract(prep_results, source_bindings)" in source
    events = (ROOT / "services" / "pipeline_input_events.py").read_text(encoding="utf-8")
    assert "if prep_batches_not_under_contract(results, template):" in events
    assert 'source_bindings["roster_sidecar"]=roster_sidecar' in source
    assert '**({"market_since": row["listed_date"]} if r33_prep and row.get("listed_date") else {}),' in source
    assert 'start_date=metadata["start_date"], end_date=metadata["end_date"], with_listed_date=True)' in source
    assert "stock_rows = [*stock_rows, *sidecar_rows]" in source
    from services.training_policy import R33_FEATURE_WARMUP_SESSIONS
    assert R33_FEATURE_WARMUP_SESSIONS == 252
    job = (ROOT / "oof_materialize_job_main.py").read_text(encoding="utf-8")
    assert job.index("'r33_monthly_candidate'") < job.index("result.get('materialization_owner') == 'native_l3_new_l4'")


@pytest.mark.parametrize("stale", [{"result_schema": "r33-oof-checks-v1"}, {"drop_gate_cost": True}])
def test_receipt_sealed_without_the_cost_line_never_admits_full_fit(monkeypatch, stale):
    from services import r33_oof_checks
    calls, _ = _patch_lifecycle(monkeypatch, full_fit={"status": "completed", "retry_required": False})
    bucket = Bucket()
    report = {"schema_version": "r33-monthly-oof-checks-receipt-v1", "cohort_id": "c-r33", "manifest_checksum": "m" * 64,
              "gate_cost": {"round_trip_cost": 0.00585},
              "result": {"schema_version": stale.get("result_schema", r33_oof_checks.SCHEMA), "status": "pass"}}
    if stale.get("drop_gate_cost"):
        report.pop("gate_cost")
    bucket.store["r33/monthly_candidates/c-r33/oof_checks.json"] = json.dumps(report).encode()
    with pytest.raises(ValueError, match="^r33_oof_checks_schema_stale$"):
        _run(bucket)
    assert calls["dispatch"] == []
