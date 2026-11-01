"""The real walk_forward_orchestrator wiring of the L4 challenger gate, on fake Modal functions (no Modal, no cost).

Scaled timeline per window w: tree, TabM, PatchTST, iTransformer 0.05 s; GNN 0.1 + 0.1w s; TimeXer 0.8 + 0.1w s;
each TabM challenger fold 0.2 s. The gate opens at 0.3 s (the last GNN), one challenger runs at a time, and what
is left when the last TimeXer ends (1.0 s) is cancelled without extending the cohort.
"""
import asyncio
import hashlib
import io
import json
import threading
import time
from types import SimpleNamespace

import numpy as np
import pytest

from app import market_conditioner as mc
from app.formal_feature_contract import R33_PROFILE, semantic_for_profile
from tests.test_market_conditioner import DAYS, _raw, history_block

TARGET = "next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4"
SHA = "f" * 40
WINDOWS = [{"window_id": w, "train_start": DAYS[0], "train_end": DAYS[39], "test_start": DAYS[45],
            "test_end": DAYS[59]} for w in (0, 1, 2)]
GATED_GPU = ("train_tabm_universal", "train_gnn_graphsage_universal", "train_patchtst_universal",
             "train_itransformer_universal")
SLACK = 0.05


class Bucket:
    def __init__(self, values):
        self.values, self.name = values, "b"

    def blob(self, name):
        values = self.values
        return SimpleNamespace(download_as_bytes=lambda **kw: values[name],
                               download_as_text=lambda **kw: values[name].decode(),
                               exists=lambda **kw: name in values)


def _npz(**arrays):
    out = io.BytesIO()
    np.savez(out, **arrays)
    return out.getvalue()


def sealed_inputs():
    from app.features import FEATURE_IMPUTATION_SEMANTIC_VERSION
    batch = _npz(X=np.zeros((4, 131)), y=np.zeros(4), target_returns=np.zeros(4), dates=np.array(DAYS[:4]),
                 symbols=np.array(["1101"] * 4), markets=np.array(["LISTED"] * 4), label_known_dates=np.array(DAYS[:4]))
    manifest = {"schema_version": "active8-canonical-adjusted-prep-v3", "status": "ready",
                "feature_semantic_version": semantic_for_profile(R33_PROFILE),
                "feature_imputation_semantic": FEATURE_IMPUTATION_SEMANTIC_VERSION, "producer_source_sha": SHA,
                "output_gcs_prefix": "universal", "target_semantic_version": TARGET, "roundtrip_cost_bps": 18.0,
                "batch_rows": [4], "output_rows": 4,
                "output_checksums": {"universal/prep/batch_0.npz": hashlib.sha256(batch).hexdigest()}}
    manifest["manifest_checksum"] = hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()
    records = np.empty(10, dtype=object)
    for i in range(10):
        records[i] = {"symbol": str(1101 + i), "dates": DAYS[:3], "open": [1, 2, 3], "close": [1, 2, 3],
                      "target_semantic_version": TARGET}
    sequence = {"contract": "sequence_records_v3", "target_semantic_version": TARGET, "output_gcs_prefix": "seq"}
    return {"universal/prep/manifest.json": json.dumps(manifest).encode(), "universal/prep/batch_0.npz": batch,
            "seq/prep/sequence_manifest.json": json.dumps(sequence).encode(),
            "seq/prep/batch_0.npz": _npz(sequence_records=records)}


class Clock:
    """Start and end of every fake call on one clock; in-flight and peak TabM challenger inputs; cancels."""

    def __init__(self):
        self.t0, self.calls, self.cancels = time.monotonic(), [], []
        self.active, self.peak = 0, 0

    def now(self):
        return time.monotonic() - self.t0


def champion(clock, name, seconds, fail=lambda payload: False):
    async def aio(payload):
        start = clock.now()
        await asyncio.sleep(seconds(payload) if callable(seconds) else seconds)
        clock.calls.append((name, payload.get("window_id"), start, clock.now()))
        if fail(payload):
            raise RuntimeError(f"{name} failed")
        return {"error": "fake_fold"}
    return SimpleNamespace(remote=SimpleNamespace(aio=aio))


def challenger(clock, name, seconds, raise_for=(), counted=False):
    async def spawn(payload):
        key = (payload["oof_model_alias"], payload["window_id"])
        start, state = clock.now(), {"open": True}
        if counted:
            clock.active += 1
            clock.peak = max(clock.peak, clock.active)

        def close():
            if state["open"] and counted:
                clock.active -= 1
            state["open"] = False

        async def get():
            await asyncio.sleep(seconds)
            close()
            clock.calls.append((name, key, start, clock.now()))
            if key in raise_for:
                raise RuntimeError("challenger exploded")
            return {"model": payload["oof_model_alias"], "oof_artifact": {"path": "p"}}

        async def cancel(terminate_containers=False):
            close()
            clock.cancels.append((name, key, terminate_containers, clock.now()))
        clock.calls.append((name + ":spawn", key, start, start))
        return SimpleNamespace(get=SimpleNamespace(aio=get), cancel=SimpleNamespace(aio=cancel))
    return SimpleNamespace(spawn=SimpleNamespace(aio=spawn))


def install(monkeypatch, clock, *, tabm_raise=(), gnn_fail=lambda payload: False):
    import google.cloud.storage as storage
    import modal_app
    import app.oof_artifact_recovery as recovery
    import app.oof_manifest_publisher as publisher
    bucket, published = Bucket(sealed_inputs()), {}
    monkeypatch.setenv("STOCKVISION_SOURCE_SHA", SHA)
    monkeypatch.setattr(storage, "Client", lambda *a, **k: SimpleNamespace(bucket=lambda name: bucket))
    monkeypatch.setattr(modal_app, "_setup_env", lambda: None)
    monkeypatch.setattr(modal_app, "_get_gcs_bucket_name", lambda: "b")
    monkeypatch.setattr(modal_app, "_load_verified_oof_resume_windows", lambda *a, **k: ({}, None))
    monkeypatch.setattr(recovery, "recover_completed_oof_windows", lambda **k: {})

    def publish(bucket, manifest):
        published.update(manifest=manifest, at=clock.now())
        return {"manifest": {**manifest, "manifest_checksum": "c"}, "path": "m.json", "publication_mode": "test"}
    monkeypatch.setattr(publisher, "publish_oof_manifest", publish)

    async def blocks(payload):
        return {"history": history_block()}
    fakes = {"train_wf_hmm_window": champion(clock, "hmm", 0.0),
             "train_wf_tree_window": champion(clock, "tree", 0.05),
             "train_tabm_universal": champion(clock, "train_tabm_universal", 0.05),
             "train_gnn_graphsage_universal": champion(clock, "train_gnn_graphsage_universal",
                                                       lambda p: 0.1 + 0.1 * p["window_id"], fail=gnn_fail),
             "train_patchtst_universal": champion(clock, "train_patchtst_universal", 0.05),
             "train_itransformer_universal": champion(clock, "train_itransformer_universal", 0.05),
             "train_timexer_universal": champion(clock, "train_timexer_universal", lambda p: 0.8 + 0.1 * p["window_id"]),
             "train_wf_tree_market_challenger": challenger(clock, "tree_challenger", 0.01),
             "train_tabm_market_challenger": challenger(clock, "tabm_challenger", 0.2, tabm_raise, counted=True),
             "build_market_conditioner_block": SimpleNamespace(remote=SimpleNamespace(aio=blocks))}
    for name, fake in fakes.items():
        monkeypatch.setattr(modal_app, name, fake)
    return published


def run(**extra):
    import modal_app
    return _raw(modal_app.walk_forward_orchestrator)({
        "windows": WINDOWS, "market_env": {"history": {}}, "batch_count": 1, "concurrent_windows": len(WINDOWS),
        "model_profile_schema_version": R33_PROFILE, "start_date": DAYS[0], "end_date": DAYS[59], "cohort_id": "c",
        "knowledge_cutoff_date": DAYS[59], "prep_gcs_prefix": "universal", "sequence_gcs_prefix": "seq",
        "sequence_batch_count": 1, **extra})


def ends(clock, names):
    return [end for name, _, _, end in clock.calls if name in names]


CHAMPION_FIELDS = ("model_metrics", "missing_oof_models", "oof_fold_ready", "fold_blockers", "tree_result",
                   "TabM_result", "GNN_result", "TimeXer_result", "PatchTST_result", "iTransformer_result")


def champion_view(manifest):
    return {w["window_id"]: {k: w.get(k) for k in CHAMPION_FIELDS} for w in manifest["windows"]}


def test_gate_opens_after_non_timexer_gpu_runs_one_challenger_and_never_extends_the_cohort(monkeypatch):
    clock = Clock()
    published = install(monkeypatch, clock, tabm_raise={("TabM_MKT9", 1)},
                        gnn_fail=lambda payload: payload["window_id"] == 2)  # a failed GPU call is done all the same
    run()
    gated, timexer = max(ends(clock, GATED_GPU)), max(ends(clock, {"train_timexer_universal"}))
    champion_end = max(ends(clock, {"tree", "hmm", "train_timexer_universal", *GATED_GPU}))
    spawns = [(start, key) for name, key, start, _ in clock.calls if name == "tabm_challenger:spawn"]
    # The gate opens once the last non-TimeXer GPU call (GNN w2, failed) is done, while TimeXer still runs.
    assert spawns and min(start for start, _ in spawns) >= gated - 0.005 and gated < timexer - 0.3
    # One L4 challenger at a time, whole arms first.
    assert clock.peak == 1
    assert [key for _, key in sorted(spawns)] == sorted(
        (key for _, key in spawns), key=lambda k: (mc.ARMS.index(k[0].split("_")[1].lower()), k[1]))
    # The input still running when the last TimeXer ends is cancelled with its container; no later spawn.
    finished = {key for name, key, *_ in clock.calls if name == "tabm_challenger"}
    cancels = [c for c in clock.cancels if c[0] == "tabm_challenger" and c[1] not in finished]
    assert [c[2] for c in cancels] == [True] and abs(cancels[0][3] - timexer) < SLACK
    assert max(start for start, _ in spawns) < timexer and clock.active == 0
    # No extension: the champion ends with the last TimeXer and the manifest is published right after.
    assert champion_end == timexer and published["at"] - champion_end < SLACK
    windows = {w["window_id"]: w for w in published["manifest"]["windows"]}
    tabm = {(wid, name): m for wid, w in windows.items() for name, m in w["challenger_metrics"].items()
            if name.startswith("tabm_")}
    assert len(tabm) == 2 * len(WINDOWS) and tabm[(0, "tabm_mkt9")]["status"] == "ready"
    assert tabm[(1, "tabm_mkt9")] == {"status": "failed", "reason": "challenger exploded"}
    reasons = sorted(m.get("reason", "") for m in tabm.values() if m["status"] == "unsupported")
    assert reasons and all(r.endswith(":champion_done") for r in reasons)
    assert "market_challenger_budget_exceeded:running:champion_done" in reasons
    assert len(spawns) + reasons.count("market_challenger_budget_exceeded:waiting_for_champion_gpu:champion_done") \
        == 2 * len(WINDOWS)


def test_challenger_failures_never_reach_champion_results_or_fold_readiness(monkeypatch):
    gnn_fail = lambda payload: payload["window_id"] == 2  # noqa: E731
    published = install(monkeypatch, Clock(), tabm_raise={("TabM_MKT9", 0), ("TabM_MKT9", 1)}, gnn_fail=gnn_fail)
    run()
    with_challengers = published["manifest"]
    published = install(monkeypatch, Clock(), gnn_fail=gnn_fail)
    run(challenger_models_disabled=True)
    assert all("challenger_metrics" in w for w in with_challengers["windows"])
    assert not any("challenger_metrics" in w for w in published["manifest"]["windows"])
    assert champion_view(with_challengers) == champion_view(published["manifest"])
    assert with_challengers["aggregate"]["oof_failed_folds"] == published["manifest"]["aggregate"]["oof_failed_folds"]
    assert champion_view(with_challengers)[2]["GNN_result"] == {"error": "train_gnn_graphsage_universal failed"}


def test_the_orchestrator_never_waits_on_a_watcher_that_missed_a_window(monkeypatch):
    """The windows' return closes the gate even if a watcher never settles, so deferred challengers end."""
    clock = Clock()
    published = install(monkeypatch, clock)
    real_track = mc.GpuGate.track
    monkeypatch.setattr(mc.GpuGate, "track", lambda self, wid, gpu=(), champion=():
                        None if wid == 2 else real_track(self, wid, gpu, champion))
    done = threading.Event()
    threading.Thread(target=lambda: (run(), done.set()), daemon=True).start()
    assert done.wait(10), "the orchestrator hung on its deferred challengers"
    tabm = [m for w in published["manifest"]["windows"] for name, m in w["challenger_metrics"].items()
            if name.startswith("tabm_")]
    assert len(tabm) == 2 * len(WINDOWS) and all(
        m["reason"] == "market_challenger_budget_exceeded:waiting_for_champion_gpu:champion_done" for m in tabm)
    assert not [c for c in clock.calls if c[0] == "tabm_challenger:spawn"]


def test_a_window_that_raises_fails_the_cohort_and_leaves_no_challenger_input_running(monkeypatch):
    import app.oof_forward_source_contract as contract
    clock = Clock()
    install(monkeypatch, clock)
    real = contract.assess_fold_forward_sources

    def assess(result, **kw):
        if result["window_id"] == 0:  # ends at 0.8 s, while a challenger input is running
            raise RuntimeError("window exploded")
        return real(result, **kw)
    monkeypatch.setattr(contract, "assess_fold_forward_sources", assess)
    with pytest.raises(RuntimeError, match="window exploded"):
        run()
    spawned = [key for name, key, *_ in clock.calls if name == "tabm_challenger:spawn"]
    finished = [key for name, key, *_ in clock.calls if name == "tabm_challenger"]
    cancelled = [(key, terminate) for name, key, terminate, _ in clock.cancels if name == "tabm_challenger"]
    assert spawned and clock.active == 0
    assert sorted(finished + [key for key, _ in cancelled]) == sorted(spawned)
    assert cancelled and all(terminate for _, terminate in cancelled)
