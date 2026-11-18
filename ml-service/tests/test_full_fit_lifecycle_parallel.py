"""Journal-backed full-fit lifecycle children start with the tree group but are collected/written
in order; without a journal the lifecycle stays serial."""
import json
from copy import deepcopy
from types import SimpleNamespace

import pytest
from google.api_core.exceptions import NotFound, PreconditionFailed

import modal_app
from app import training_call_journal
from app.lifecycle_dispatch import LifecycleDispatch
from app.training_call_journal import TrainingCallJournal


class Bucket:
    def __init__(self, log):
        self.records, self.log = {}, log

    def blob(self, key):
        store = self

        class Blob:
            def reload(self):
                if key not in store.records:
                    raise NotFound(key)
                self.generation = store.records[key][0]

            def download_as_bytes(self, if_generation_match):
                generation, raw = store.records[key]
                if generation != if_generation_match:
                    raise PreconditionFailed(key)
                return raw

            def upload_from_string(self, raw, content_type, if_generation_match):
                old = store.records.get(key, (0, b""))
                if old[0] != if_generation_match:
                    raise PreconditionFailed(key)
                row = json.loads(raw)
                store.log.append(("journal", row.get("stage"), row.get("state")))
                store.records[key] = (old[0] + 1, raw)

        return Blob()


class Modal:
    """Fake Modal: spawn returns a call ID; get/cancel are logged per child."""

    def __init__(self, results):
        self.log, self.results, self.calls, self.payloads = [], results, {}, {}

    def function(self, name):
        def spawn(payload):
            self.log.append(("spawn", name))
            self.payloads[name] = deepcopy(payload)
            call_id = f"fc-{name}"
            self.calls[call_id] = name
            return SimpleNamespace(object_id=call_id, get=lambda: self.get(call_id),
                                   cancel=lambda: self.log.append(("cancel", name)))
        return SimpleNamespace(spawn=spawn, remote=lambda payload: spawn(payload).get())

    def get(self, call_id):
        name = self.calls[call_id]
        self.log.append(("get", name))
        outcome = self.results[name]
        if callable(outcome):
            outcome = outcome()
        if isinstance(outcome, BaseException):
            raise outcome
        return deepcopy(outcome)

    def from_id(self, call_id):
        return SimpleNamespace(get=lambda: self.get(call_id))


def _child(model):
    return {"status": "ok", "model": model, "version": "v1", "checksum": "sha256:" + "a" * 64,
            "metadata": {"version": "v1"}, "elapsed_s": 5.0, "container_elapsed_s": 6.0}


def _no_timing(value):
    return {k: v for k, v in value.items() if k not in ("elapsed_s", "wall_since_dispatch_s")}


PAYLOAD = {"run_id": "fullfit-run", "run_date": "2026-11-09", "gcs_prefix": "universal", "batch_count": 1,
           "candidate_version": "v1", "train_model_groups": ["tree"],
           "artifact_lifecycle_targets": ["GNN", "TabM"], "shap_audit_mode": "skip"}


def _run(monkeypatch, results, *, journal_backed, fake=None, bucket=None, **overrides):
    fake = fake or Modal(results)
    bucket = bucket or Bucket(fake.log)
    journal = (TrainingCallJournal(bucket, run_id="fullfit-run", source_sha="a" * 40, scope="orchestrator",
                                   from_id=fake.from_id) if journal_backed else None)
    monkeypatch.setattr(modal_app, "_setup_env", lambda: None)
    monkeypatch.setattr(modal_app, "_get_gcs_bucket_name", lambda: "")
    monkeypatch.setattr(modal_app, "_prewarm_training_input_cache", lambda *a, **kw: {"status": "disabled"})
    monkeypatch.setattr(training_call_journal, "release_journal", lambda *a, **kw: journal)
    monkeypatch.setattr(modal_app, "_tree_group_function", lambda *a: fake.function("tree"))
    monkeypatch.setattr(modal_app, "train_gnn_graphsage_universal", fake.function("GNN"))
    monkeypatch.setattr(modal_app, "train_tabm_universal", fake.function("TabM"))
    monkeypatch.setattr(modal_app, "train_patchtst_universal", fake.function("PatchTST"))
    monkeypatch.setattr(modal_app, "train_itransformer_universal", fake.function("iTransformer"))
    raw = getattr(modal_app.retrain_orchestrator, "get_raw_f", None)
    orchestrate = raw() if raw else modal_app.retrain_orchestrator._raw_f_
    return orchestrate(deepcopy({**PAYLOAD, **overrides})), fake


def _journal_rows(bucket):
    """stage -> latest journal row (lifecycle/* and group/* records)."""
    rows = (json.loads(raw) for _, raw in bucket.records.values())
    return {row["stage"]: row for row in rows if row.get("stage")}


SERIAL_GNN_TABM = [("spawn", "tree"), ("get", "tree"), ("spawn", "GNN"), ("get", "GNN"),
                   ("spawn", "TabM"), ("get", "TabM")]


@pytest.mark.parametrize("journal_backed", [True, False])
def test_children_start_with_tree_and_are_written_in_target_order(monkeypatch, journal_backed):
    result, fake = _run(monkeypatch, {"tree": {"results": {}, "elapsed_s": 1.0},
                                      "GNN": _child("GNN"), "TabM": _child("TabM")}, journal_backed=journal_backed)
    calls = [event for event in fake.log if event[0] in ("spawn", "get")]
    # Early dispatch is journal-only; without a journal nothing starts before the tree returns.
    assert calls == ([("spawn", "tree"), ("spawn", "GNN"), ("spawn", "TabM"),
                      ("get", "tree"), ("get", "GNN"), ("get", "TabM")] if journal_backed else SERIAL_GNN_TABM)
    lifecycle = result["stages"]["artifact_lifecycle"]
    assert ("wall_since_dispatch_s" in lifecycle["results"]["GNN"]) is journal_backed
    assert lifecycle["status"] == "ok" and list(lifecycle["results"]) == ["GNN", "TabM"]
    assert _no_timing(lifecycle["results"]["TabM"]) == _no_timing(_child("TabM"))
    assert lifecycle["model_pool_write_mode"] == "sequential"
    if journal_backed:
        completed = [e[1] for e in fake.log if e[0] == "journal" and e[2] == "completed"]
        assert completed == ["group/tree", "lifecycle/GNN", "lifecycle/TabM"]
    # Payloads are those of the serial path; nothing about the children's spec changes.
    assert fake.payloads["TabM"]["output_model_version"] == "v1"
    assert fake.payloads["GNN"]["batch_count"] == fake.payloads["TabM"]["batch_count"]


def test_tree_error_payload_still_adopts_lifecycle_like_serial(monkeypatch):
    result, fake = _run(monkeypatch, {"tree": {"error": "child_timeout"}, "GNN": _child("GNN"),
                                      "TabM": _child("TabM")}, journal_backed=True)
    assert result["stages"]["train"]["group_coverage"]["tree"]["status"] == "error"
    assert list(result["stages"]["artifact_lifecycle"]["results"]) == ["GNN", "TabM"]
    assert ("cancel", "GNN") not in fake.log


@pytest.mark.parametrize("journal_backed", [True, False])
def test_tree_exception_adopts_nothing(monkeypatch, journal_backed):
    fake = Modal({"tree": RuntimeError("tree_call_failed"), "GNN": _child("GNN"), "TabM": _child("TabM")})
    bucket = Bucket(fake.log)
    result, _ = _run(monkeypatch, None, journal_backed=journal_backed, fake=fake, bucket=bucket)
    assert result["stages"]["train"] == {"status": "error", "error": "tree_call_failed"}
    assert result["stages"]["artifact_lifecycle"]["status"] == "planned"
    assert "results" not in result["stages"]["artifact_lifecycle"]
    assert ("get", "GNN") not in fake.log and ("get", "TabM") not in fake.log
    telemetry = {e["function_name"] for e in result["durable_followup_payload"]["modal_telemetry"]}
    assert not telemetry & {"train_gnn_graphsage_universal", "train_tabm_universal"}
    # cancel() does not stop a queued call, so nothing relies on it.
    assert not [e for e in fake.log if e[0] == "cancel"]
    spawned = [e[1] for e in fake.log if e[0] == "spawn"]
    if not journal_backed:
        # Identical to serial: no lifecycle child exists that could write an orphan artifact.
        assert spawned == ["tree"]
        return
    assert spawned == ["tree", "GNN", "TabM"]
    # The early children stay recorded under this run_id, dispatched and never completed:
    # the journal ties whatever they write to the failed run and their results are not adopted.
    rows = _journal_rows(bucket)
    for model in ("GNN", "TabM"):
        row = rows["lifecycle/" + model]
        assert (row["state"], row["call_id"]) == ("dispatched", f"fc-{model}") and "result" not in row
    assert not [e for e in fake.log if e[0] == "journal" and e[2] == "completed"]


def test_resume_after_tree_wait_crash_reattaches_without_new_paid_jobs(monkeypatch):
    fake = Modal({"tree": {"results": {}}, "GNN": _child("GNN"), "TabM": _child("TabM")})
    bucket = Bucket(fake.log)

    def journal():
        return TrainingCallJournal(bucket, run_id="fullfit-run", source_sha="a" * 40, scope="orchestrator",
                                   from_id=fake.from_id)
    dispatch = LifecycleDispatch(lambda m, f, p: journal().spawn("lifecycle/" + m, f.spawn, p), journal_backed=True)
    dispatch.dispatch(["GNN", "TabM"], lambda t: (t, fake.function(t), {"v": 1}))
    # The coordinator dies here (before any get); a fresh one replays the same dispatch.
    resumed = LifecycleDispatch(lambda m, f, p: journal().spawn("lifecycle/" + m, f.spawn, p), journal_backed=True)
    resumed.dispatch(["GNN", "TabM"], lambda t: (t, fake.function(t), {"v": 1}))
    assert [resumed.collect(t)["model"] for t in ("GNN", "TabM")] == ["GNN", "TabM"]
    assert [e for e in fake.log if e[0] == "spawn"] == [("spawn", "GNN"), ("spawn", "TabM")]


def test_dispatch_error_surfaces_at_that_targets_collection():
    log = []

    def spawn(model, function, payload):
        if model == "GNN":
            raise RuntimeError("training_dispatch_outcome_unknown_reconcile_before_retry")
        log.append(model)
        return SimpleNamespace(get=lambda: {"model": model})
    dispatch = LifecycleDispatch(spawn, journal_backed=True)
    dispatch.dispatch(["GNN", "TabM", "TimesFM", "", "TabM"], lambda t: None if t == "TimesFM" else (t, None, {}))
    assert log == ["TabM"] and not dispatch.dispatched("TimesFM")
    with pytest.raises(RuntimeError, match="outcome_unknown"):
        dispatch.collect("GNN")
    assert dispatch.collect("TabM") == {"model": "TabM"}
    assert dispatch.abandon() == []


@pytest.mark.parametrize("full_fit", [False, True])
def test_tabm_stage_timings_are_reported_without_touching_the_artifact(monkeypatch, full_fit):
    pytest.importorskip("tabm")
    import torch
    from app import tabm_training as tabm
    from tests.test_deployment_refit import panel
    torch.set_num_threads(2)
    saved = []
    monkeypatch.setattr(tabm, "_get_bucket", lambda: object())
    monkeypatch.setattr(tabm, "collect_prep_lineage", lambda *a, **k: {})
    monkeypatch.setattr(tabm, "load_tabular_dataset", lambda _: panel())
    monkeypatch.setattr(tabm, "_save_artifact", lambda *, metadata, **kw: saved.append(metadata) or {
        "artifact_path": "local.pt", "metadata_path": "local.json", "checksum": "local", "metadata": metadata})
    args = {"epochs": 1, "batch_size": 256, "run_date": "2026-03-10", "seed": 42,
            **({"generation_mode": "local_full_fit"} if full_fit else {})}
    result = tabm.train_tabm_universal(args)
    expected = ["load_s", "holdout_fit_s", "holdout_predict_s", *(["full_refit_s"] if full_fit else []), "save_s"]
    assert list(result["stage_timings"]) == expected
    assert all(isinstance(v, float) and v >= 0 for v in result["stage_timings"].values())
    # Timings live in the terminal result only: persisted metadata, metrics and attestation input are unchanged.
    assert "stage_timings" not in saved[0] and "stage_timings" not in result["metrics"]


def _slow_tree():
    import time
    time.sleep(0.3)
    return {"results": {}}


def test_billed_time_is_the_childs_container_time_not_the_tree_wait(monkeypatch):
    # The tree wait is 0.3 s; children report less, and their in-trainer time (0.05 s) less still.
    ok = {m: {**_child(m), "elapsed_s": 0.05, "container_elapsed_s": 0.2} for m in ("GNN", "TabM")}
    gnn_error = RuntimeError("cuda_oom")
    gnn_error.container_elapsed_s = 0.1
    tabm_error = {"error": "nan_loss", "type": "train_tabm_universal", "container_elapsed_s": 0.15}
    for gnn, tabm, expected in ((ok["GNN"], ok["TabM"], (0.2, 0.2)), (gnn_error, tabm_error, (0.1, 0.15))):
        result, _ = _run(monkeypatch, {"tree": _slow_tree, "GNN": gnn, "TabM": tabm}, journal_backed=True)
        rows = result["stages"]["artifact_lifecycle"]["results"]
        assert (rows["GNN"]["elapsed_s"], rows["TabM"]["elapsed_s"]) == expected
        assert rows["GNN"]["wall_since_dispatch_s"] >= 0.3
        billed = {e["function_name"]: e["compute_sec"] for e in result["durable_followup_payload"]["modal_telemetry"]}
        assert (billed["train_gnn_graphsage_universal"], billed["train_tabm_universal"]) == expected


def test_without_a_reported_container_time_wall_since_dispatch_is_the_bound(monkeypatch):
    killed = {k: v for k, v in _child("TabM").items() if k != "container_elapsed_s"}
    result, _ = _run(monkeypatch, {"tree": _slow_tree, "GNN": RuntimeError("container_killed"), "TabM": killed},
                     journal_backed=True)
    rows = result["stages"]["artifact_lifecycle"]["results"]
    assert rows["GNN"]["elapsed_s"] >= 0.3 and rows["TabM"]["elapsed_s"] >= 0.3


def test_dispatch_failure_bills_only_the_failed_dispatch():
    ticks = iter([100.0, 100.5, 900.0])
    dispatch = LifecycleDispatch(lambda *a: None, journal_backed=True, clock=lambda: next(ticks))
    dispatch.dispatch(["iTransformer"], lambda t: (_ for _ in ()).throw(RuntimeError("missing_sequence_records_artifact")))
    assert dispatch.elapsed_s("iTransformer") == 0.5


def test_orchestrator_resume_after_coordinator_lost_tree_result(monkeypatch):
    calls = {"tree": 0}

    def tree_once_lost():
        calls["tree"] += 1
        return RuntimeError("coordinator_interrupted") if calls["tree"] == 1 else {"results": {}}
    fake = Modal({"tree": tree_once_lost, "GNN": _child("GNN"), "TabM": _child("TabM")})
    bucket = Bucket(fake.log)
    first, _ = _run(monkeypatch, None, journal_backed=True, fake=fake, bucket=bucket)
    assert first["stages"]["train"]["status"] == "error"
    second, _ = _run(monkeypatch, None, journal_backed=True, fake=fake, bucket=bucket)
    assert [e for e in fake.log if e[0] == "spawn"] == [("spawn", "tree"), ("spawn", "GNN"), ("spawn", "TabM")]
    assert list(second["stages"]["artifact_lifecycle"]["results"]) == ["GNN", "TabM"]
    assert second["stages"]["artifact_lifecycle"]["status"] == "ok"
    completed = [e[1] for e in fake.log if e[0] == "journal" and e[2] == "completed"]
    assert completed == ["group/tree", "lifecycle/GNN", "lifecycle/TabM"]


SEQUENCE = {"sequence_records": [{"symbol": "2330", "dates": ["2026-11-02"], "close": [1.0]}],
            "sequence_seq_len": 8}


@pytest.mark.parametrize("journal_backed", [True, False])
def test_only_gnn_and_tabm_start_early_sequence_targets_stay_serial(monkeypatch, journal_backed):
    children = {m: _child(m) for m in ("GNN", "TabM", "PatchTST", "iTransformer")}
    result, fake = _run(monkeypatch, {"tree": {"results": {}}, **children}, journal_backed=journal_backed,
                        artifact_lifecycle_targets=["GNN", "iTransformer", "TabM", "PatchTST"], **SEQUENCE)
    calls = [event for event in fake.log if event[0] in ("spawn", "get")]
    serial = [("spawn", "tree"), ("get", "tree"), ("spawn", "GNN"), ("get", "GNN"), ("spawn", "iTransformer"),
              ("get", "iTransformer"), ("spawn", "TabM"), ("get", "TabM"), ("spawn", "PatchTST"), ("get", "PatchTST")]
    assert calls == ([("spawn", "tree"), ("spawn", "GNN"), ("spawn", "TabM"), ("get", "tree"),
                      ("get", "GNN"), ("spawn", "iTransformer"), ("get", "iTransformer"),
                      ("get", "TabM"), ("spawn", "PatchTST"), ("get", "PatchTST")] if journal_backed else serial)
    results = result["stages"]["artifact_lifecycle"]["results"]
    assert list(results) == ["GNN", "iTransformer", "TabM", "PatchTST"]
    # Serial targets keep the serial timing fields (no dispatch wall time).
    assert "wall_since_dispatch_s" not in results["iTransformer"]
    assert ("wall_since_dispatch_s" in results["GNN"]) is journal_backed
    assert fake.payloads["iTransformer"]["seq_len"] == 8 and fake.payloads["iTransformer"]["sequence_records"]


def test_sequence_target_without_records_fails_in_place_without_spawning(monkeypatch):
    result, fake = _run(monkeypatch, {"tree": {"results": {}}, "GNN": _child("GNN"), "TabM": _child("TabM")},
                        journal_backed=True, artifact_lifecycle_targets=["GNN", "iTransformer", "TabM"])
    lifecycle = result["stages"]["artifact_lifecycle"]
    assert lifecycle["errors"] == {"iTransformer": "missing_sequence_records_artifact"}
    assert list(lifecycle["results"]) == ["GNN", "iTransformer", "TabM"]
    assert ("spawn", "iTransformer") not in fake.log


@pytest.mark.parametrize("journal_backed", [True, False])
def test_interrupted_orchestrator_propagates_and_starts_no_unjournaled_children(monkeypatch, journal_backed):
    fake = Modal({"tree": KeyboardInterrupt(), "GNN": _child("GNN"), "TabM": _child("TabM")})
    with pytest.raises(KeyboardInterrupt):
        _run(monkeypatch, None, journal_backed=journal_backed, fake=fake)
    assert [e[1] for e in fake.log if e[0] == "spawn"] == (["tree", "GNN", "TabM"] if journal_backed else ["tree"])
    assert not [e for e in fake.log if e[0] in ("cancel", "get") and e[1] != "tree"]


def test_dispatch_without_a_journal_spawns_nothing():
    spawned = []
    dispatch = LifecycleDispatch(lambda *spec: spawned.append(spec), journal_backed=False)
    dispatch.dispatch(["GNN", "TabM"], lambda t: (t, None, {}))
    assert spawned == [] and not dispatch.dispatched("GNN") and not dispatch.dispatched("TabM")
    assert dispatch.abandon() == []


def test_abandon_leaves_journal_calls_running_and_names_them():
    log = []
    handle = lambda m: SimpleNamespace(get=lambda: log.append(("get", m)), cancel=lambda: log.append(("cancel", m)))
    dispatch = LifecycleDispatch(lambda m, f, p: handle(m), journal_backed=True)
    dispatch.dispatch(["TabM", "GNN"], lambda t: (t, None, {}))
    assert dispatch.abandon() == ["GNN", "TabM"] and log == []
    assert dispatch.abandon() == []


def test_container_billing_starts_at_cold_start_then_at_previous_input_end(monkeypatch):
    monkeypatch.setattr(modal_app, "_CONTAINER_STARTED_AT", 100.0)
    monkeypatch.setattr(modal_app, "_container_idle_since", None)
    now = {"t": 130.0}
    monkeypatch.setattr(modal_app, "_now", lambda: now["t"])
    first = modal_app._input_billing_start()
    assert modal_app._container_elapsed_s(first) == 30.0  # cold start included
    assert modal_app._input_billing_start() == 130.0      # warm container: previous input's end
    now["t"] = 175.0
    assert modal_app._container_elapsed_s(130.0) == 45.0


@pytest.mark.parametrize("name", ["train_tabm_universal", "train_gnn_graphsage_universal"])
def test_failure_before_training_still_raises_and_ends_container_time(monkeypatch, name):
    monkeypatch.setattr(modal_app, "_container_idle_since", None)
    monkeypatch.setattr(modal_app, "_setup_env", lambda: (_ for _ in ()).throw(OSError("secret_mount_missing")))
    with pytest.raises(OSError, match="secret_mount_missing") as caught:
        _wrapper(name)({})
    assert caught.value.container_elapsed_s >= 0
    # The next input on this container starts where this one ended, not at the earlier input.
    assert modal_app._container_idle_since is not None


def _wrapper(name):
    function = getattr(modal_app, name)
    return function.get_raw_f() if hasattr(function, "get_raw_f") else function._raw_f_


def test_tabm_wrapper_reports_container_time_on_error_result(monkeypatch):
    from app import tabm_training
    monkeypatch.setattr(modal_app, "_setup_env", lambda: None)
    monkeypatch.setattr(modal_app, "_prepare_training_input_cache_for_payload", lambda payload: {"status": "skipped"})
    monkeypatch.setattr(tabm_training, "train_tabm_universal", lambda payload: (_ for _ in ()).throw(ValueError("nan_loss")))
    result = _wrapper("train_tabm_universal")({})
    assert result["error"] == "nan_loss" and result["type"] == "train_tabm_universal"
    assert isinstance(result["container_elapsed_s"], float) and result["container_elapsed_s"] >= 0


def test_gnn_wrapper_still_raises_and_carries_container_time_through_pickle(monkeypatch):
    import pickle
    from app import gnn_training
    monkeypatch.setattr(modal_app, "_setup_env", lambda: None)
    monkeypatch.setattr(modal_app, "_prepare_training_input_cache_for_payload", lambda payload: {"status": "skipped"})
    monkeypatch.setattr(gnn_training, "train_graphsage_universal", lambda payload: (_ for _ in ()).throw(RuntimeError("cuda_oom")))
    with pytest.raises(RuntimeError, match="cuda_oom") as caught:
        _wrapper("train_gnn_graphsage_universal")({})
    # Modal ships a raised exception to the caller pickled; the attribute is instance state.
    assert pickle.loads(pickle.dumps(caught.value)).container_elapsed_s >= 0


def test_champion_tabm_oof_is_unchanged_through_the_modal_wrapper(monkeypatch):
    from app import tabm_training
    from tests.test_market_conditioner import Bucket as OofBucket, CHAMPION_TABM_OOF, DAYS, _oof_digest, panel
    from app.formal_feature_contract import FEATURE131_SEMANTIC, FEATURES131
    bucket = OofBucket()
    monkeypatch.setattr(tabm_training, "_get_bucket", lambda: bucket)
    monkeypatch.setattr(tabm_training, "collect_prep_lineage", lambda *a, **k: {})
    monkeypatch.setattr(modal_app, "_setup_env", lambda: None)
    monkeypatch.setattr(modal_app, "_prepare_training_input_cache_for_payload", lambda payload: {"status": "skipped"})
    monkeypatch.setenv("STOCKVISION_SOURCE_SHA", "f" * 40)
    data = panel()
    result = _wrapper("train_tabm_universal")({
        "window_id": 1, "train_start": DAYS[0], "train_end": DAYS[39], "test_start": DAYS[45], "test_end": DAYS[59],
        "feature_semantic_version": FEATURE131_SEMANTIC, "generation_mode": "purged_oof", "cohort_id": "c",
        "fold_id": "w1", "output_model_version": "c-w1", "gcs_prefix": "universal", "epochs": 1,
        "feature_release_mode": "approved_full131_v1",
        "tabular_dataset": {**{k: data[k] for k in ("X", "y", "target_returns", "dates", "symbols", "markets",
                                                    "label_known_dates", "sectors")}, "feature_names": list(FEATURES131)}})
    assert not result.get("error"), result
    assert _oof_digest(bucket.values["universal/oof/c/w1/tabm.npz"]) == CHAMPION_TABM_OOF
    assert result["container_elapsed_s"] >= 0
