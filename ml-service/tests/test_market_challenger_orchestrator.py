"""The real walk_forward_orchestrator wiring of the market challengers, on fake Modal functions (no Modal, no cost).

Scaled timeline per window w: tree, TabM, PatchTST, iTransformer 0.05 s; GNN 0.1 + 0.1w s; TimeXer 0.8 + 0.1w s;
each TabM challenger fold 0.2 s. The gate opens with the last GNN and one L4 challenger runs at a time; once the
last TimeXer is done every window's champion results are final, the rest run TAIL_GPU_PARALLEL at a time, and
whatever is left at the tail cap is cancelled. A failed challenger call is sent once more.
"""
import asyncio
import copy
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
SEVEN = [{"window_id": w, "train_start": DAYS[0], "train_end": DAYS[39], "test_start": DAYS[45],
          "test_end": DAYS[59]} for w in range(7)]
WINDOWS = SEVEN[:3]
ORDER = mc.ARMS  # the L4 challengers' arm order
FIRST = ORDER[0]
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
    """Every fake call on one clock: starts and ends, TabM challenger spawns with the inputs then in flight,
    cancels, TimeXer stats probes, and when each window's fold readiness was assessed."""

    def __init__(self):
        self.t0, self.calls, self.spawns, self.cancels, self.probes = time.monotonic(), [], [], [], []
        self.active, self.assessed, self.final, self.windows = 0, [], None, 0

    def now(self):
        return time.monotonic() - self.t0

    def snapshot(self):
        """At the first challenger spawn once every window is assessed: the windows' champion results."""
        if self.final is None and len(self.assessed) == self.windows:
            self.final = {r["window_id"]: copy.deepcopy(r) for _, r in self.assessed}


def champion(clock, name, seconds, fail=lambda payload: False, backlog=lambda clock: 0):
    async def aio(payload):
        start = clock.now()
        await asyncio.sleep(seconds(payload) if callable(seconds) else seconds)
        clock.calls.append((name, payload.get("window_id"), start, clock.now()))
        if fail(payload):
            raise RuntimeError(f"{name} failed")
        return {"error": "fake_fold"}

    async def stats():
        clock.probes.append(clock.now())
        return SimpleNamespace(backlog=backlog(clock))
    return SimpleNamespace(remote=SimpleNamespace(aio=aio), get_current_stats=SimpleNamespace(aio=stats))


def challenger(clock, name, seconds, failures=None, counted=False, cancel_hangs=False):
    """failures[key] lists how the key's first calls fail at once: "raise" (a lost input) or "error" (OOM);
    cancel_hangs: the cancel RPC never answers (a hung control plane)."""
    failures = {key: list(kinds) for key, kinds in (failures or {}).items()}

    async def spawn(payload):
        key = (payload["oof_model_alias"], payload["window_id"])
        start, state, failure = clock.now(), {"open": True}, (failures.get(key) or [None]).pop(0)
        clock.snapshot()
        if counted:
            clock.active += 1
            clock.spawns.append((start, key, clock.active))

        def close():
            if state["open"] and counted:
                clock.active -= 1
            state["open"] = False

        async def get():
            if failure is None:
                await asyncio.sleep(seconds(key) if callable(seconds) else seconds)
            close()
            clock.calls.append((name, key, start, clock.now()))
            if failure == "raise":
                raise RuntimeError("challenger exploded")
            if failure == "error":
                return {"error": "CUDA out of memory"}
            return {"model": payload["oof_model_alias"], "oof_artifact": {"path": "p"}}

        async def cancel(terminate_containers=False):
            close()
            clock.cancels.append((name, key, terminate_containers, clock.now()))
            if cancel_hangs:
                await asyncio.Event().wait()
        clock.calls.append((name + ":spawn", key, start, start))
        return SimpleNamespace(get=SimpleNamespace(aio=get), cancel=SimpleNamespace(aio=cancel))
    return SimpleNamespace(spawn=SimpleNamespace(aio=spawn))


def install(monkeypatch, clock, *, windows=WINDOWS, tabm_failures=None, tree_failures=None,
            gnn_fail=lambda payload: False, backlog=lambda clock: 0, tree_seconds=0.01, cap=1.0, cancel_hangs=False):
    import google.cloud.storage as storage
    import modal_app
    import app.oof_artifact_recovery as recovery
    import app.oof_forward_source_contract as contract
    import app.oof_manifest_publisher as publisher
    bucket, published = Bucket(sealed_inputs()), {}
    clock.windows = len(windows)
    monkeypatch.setenv("STOCKVISION_SOURCE_SHA", SHA)
    monkeypatch.setattr(storage, "Client", lambda *a, **k: SimpleNamespace(bucket=lambda name: bucket))
    monkeypatch.setattr(modal_app, "_setup_env", lambda: None)
    monkeypatch.setattr(modal_app, "_get_gcs_bucket_name", lambda: "b")
    monkeypatch.setattr(modal_app, "_load_verified_oof_resume_windows", lambda *a, **k: ({}, None))
    monkeypatch.setattr(recovery, "recover_completed_oof_windows", lambda **k: {})
    monkeypatch.setattr(mc, "BACKLOG_POLL_S", 0.01)
    monkeypatch.setattr(mc, "TAIL_CAP_S", cap)
    real_assess = contract.assess_fold_forward_sources

    def assess(result, **kw):
        clock.assessed.append((clock.now(), result))
        return real_assess(result, **kw)
    monkeypatch.setattr(contract, "assess_fold_forward_sources", assess)

    def publish(bucket, manifest):
        published.update(manifest=json.loads(json.dumps(manifest, default=str)), at=clock.now())
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
             "train_timexer_universal": champion(clock, "train_timexer_universal", lambda p: 0.8 + 0.1 * p["window_id"],
                                                 backlog=backlog),
             "train_wf_tree_market_challenger": challenger(clock, "tree_challenger", tree_seconds, tree_failures,
                                                                cancel_hangs=cancel_hangs),
             "train_tabm_market_challenger": challenger(clock, "tabm_challenger", 0.2, tabm_failures, counted=True),
             "build_market_conditioner_block": SimpleNamespace(remote=SimpleNamespace(aio=blocks))}
    for name, fake in fakes.items():
        monkeypatch.setattr(modal_app, name, fake)
    return published


def run(windows=WINDOWS, **extra):
    import modal_app
    return _raw(modal_app.walk_forward_orchestrator)({
        "windows": windows, "market_env": {"history": {}}, "batch_count": 1, "concurrent_windows": len(windows),
        "model_profile_schema_version": R33_PROFILE, "start_date": DAYS[0], "end_date": DAYS[59], "cohort_id": "c",
        "knowledge_cutoff_date": DAYS[59], "prep_gcs_prefix": "universal", "sequence_gcs_prefix": "seq",
        "sequence_batch_count": 1, **extra})


def ends(clock, names):
    return [end for name, _, _, end in clock.calls if name in names]


def champion_end(clock):
    return max(ends(clock, {"hmm", "tree", "train_timexer_universal", *GATED_GPU}))


def challenger_metrics(manifest):
    return {(w["window_id"], name): m for w in manifest["windows"] for name, m in w["challenger_metrics"].items()}


def without_challengers(manifest):
    """The manifest as the champion alone writes it: no challenger metrics, no challenger roster, no wall clock."""
    def coverage(value):
        return {k: v for k, v in value.items() if k != "challenger_models"}
    windows = [{**{k: v for k, v in w.items() if k != "challenger_metrics"}, "model_coverage": coverage(w["model_coverage"])}
               for w in manifest["windows"]]
    aggregate = {**{k: v for k, v in manifest["aggregate"].items() if k != "elapsed_s"},
                 "model_coverage": coverage(manifest["aggregate"]["model_coverage"])}
    rest = {k: v for k, v in manifest.items() if k not in ("windows", "aggregate")}
    return json.dumps({**rest, "windows": windows, "aggregate": aggregate}, sort_keys=True)


def rank(key):
    return ORDER.index(key[0].split("_")[1].lower()), key[1]


def test_one_l4_challenger_at_a_time_until_the_champion_is_final_then_the_tail_completes_every_slot(monkeypatch):
    clock = Clock()
    lost, oom, tree_lost = (f"TabM_{FIRST.upper()}", 1), (f"TabM_{ORDER[1].upper()}", 4), (f"ExtraTrees_{ORDER[-1].upper()}", 3)
    published = install(monkeypatch, clock, windows=SEVEN, tabm_failures={lost: ["raise", "raise"], oom: ["error"]},
                        tree_failures={tree_lost: ["raise"]},
                        gnn_fail=lambda payload: payload["window_id"] == 2)  # a failed GPU call is done all the same
    run(SEVEN)
    gated, timexer, done = max(ends(clock, GATED_GPU)), max(ends(clock, {"train_timexer_universal"})), champion_end(clock)
    # The gate opens once the last non-TimeXer GPU call (GNN w6; w2 failed) is done, while TimeXer still runs.
    assert clock.spawns[0][0] >= gated - 0.005 and gated < timexer - 0.3 and done == timexer
    mid = [(start, key, active) for start, key, active in clock.spawns if start < done]
    assert mid and max(active for *_, active in mid) == 1  # one L4 challenger while the champion runs
    assert 1 < max(active for *_, active in clock.spawns) <= mc.TAIL_GPU_PARALLEL  # parallel in the tail
    order, ranked = [key for _, key, _ in clock.spawns], sorted((key for _, key, _ in clock.spawns), key=rank)
    assert order[:len(mid)] == ranked[:len(mid)]  # whole arms first
    assert all(ranked.index(key) < i + mc.TAIL_GPU_PARALLEL for i, key in enumerate(order))
    # Every slot of every window finishes inside the cap; nothing is cancelled. A failed call is sent once more.
    metrics = challenger_metrics(published["manifest"])
    assert len(metrics) == len(mc.LIFECYCLE_SLOTS) * len(SEVEN) == (len(clock.spawns) - 2) * 3  # two TabM resends
    assert metrics.pop((1, f"tabm_{FIRST}")) == {"status": "failed", "reason": "challenger exploded", "attempts": 2}
    resent = [metrics.pop((4, f"tabm_{ORDER[1]}")), metrics.pop((3, f"et_{ORDER[-1]}"))]
    assert [(m["status"], m["attempts"]) for m in resent] == [("ready", 2), ("ready", 2)]
    assert {m["status"] for m in metrics.values()} == {"ready"} and {m["attempts"] for m in metrics.values()} == {1}
    finished = {key for name, key, *_ in clock.calls if name in ("tabm_challenger", "tree_challenger")}
    assert not [c for c in clock.cancels if c[1] not in finished] and clock.active == 0  # (a failed get is cancelled too)
    assert 0 < published["at"] - done < mc.TAIL_CAP_S


def test_the_tail_cap_cancels_what_is_left_and_the_cohort_publishes(monkeypatch):
    slow = (f"ExtraTrees_{ORDER[-1].upper()}", 1)
    clock = Clock()
    published = install(monkeypatch, clock, tree_seconds=lambda key: 30 if key == slow else 0.01, cap=0.3,
                        tree_failures={slow: ["error"]})  # the resend is the call still running at the cap
    run()
    done = champion_end(clock)
    metrics = challenger_metrics(published["manifest"])
    assert metrics.pop((1, f"et_{ORDER[-1]}")) == {
        "status": "unsupported", "reason": "market_challenger_budget_exceeded:running:tail_cap", "attempts": 2}
    assert {m["status"] for m in metrics.values()} == {"ready"}
    [cancel] = clock.cancels
    assert cancel[:3] == ("tree_challenger", slow, True) and abs(cancel[3] - done - 0.3) < SLACK
    assert abs(published["at"] - done - 0.3) < SLACK and clock.active == 0


def test_a_hung_cancel_rpc_still_lets_the_cohort_publish(monkeypatch):
    """Minor-G1: modal sets no deadline on a cancel RPC; the cap plus CANCEL_TIMEOUT_S still bounds the publish."""
    slow = (f"ExtraTrees_{ORDER[-1].upper()}", 1)
    clock = Clock()
    published = install(monkeypatch, clock, tree_seconds=lambda key: 30 if key == slow else 0.01, cap=0.3,
                        cancel_hangs=True)
    monkeypatch.setattr(mc, "CANCEL_TIMEOUT_S", 0.2)
    finished = threading.Event()
    threading.Thread(target=lambda: (run(), finished.set()), daemon=True).start()
    assert finished.wait(10), "the orchestrator hung on a cancel RPC"
    done = champion_end(clock)
    assert challenger_metrics(published["manifest"])[(1, f"et_{ORDER[-1]}")] == {
        "status": "unsupported", "reason": "market_challenger_budget_exceeded:running:tail_cap", "attempts": 1}
    assert abs(published["at"] - done - 0.3 - 0.2) < SLACK


def test_champion_results_are_final_before_the_tail_and_identical_to_the_kill_switch_run(monkeypatch):
    gnn_fail = lambda payload: payload["window_id"] == 2  # noqa: E731
    clock = Clock()
    published = install(monkeypatch, clock, tabm_failures={(f"TabM_{FIRST.upper()}", 0): ["raise", "error"],
                                                           (f"TabM_{FIRST.upper()}", 1): ["raise"]},
                        tree_failures={(f"LightGBM_{FIRST.upper()}", 2): ["error"]},
                        gnn_fail=gnn_fail, tree_seconds=1.3)  # tree challengers run on past the champion
    run()
    done = champion_end(clock)
    # Every window's fold readiness is decided as soon as its champion calls are done, never after a challenger.
    assert len(clock.assessed) == len(WINDOWS) and max(t for t, _ in clock.assessed) < done + SLACK
    assert max(ends(clock, {"tree_challenger"})) > done + 0.2 and clock.final is not None
    # What the windows held when the tail started is what is published, challenger metrics aside.
    windows = {w["window_id"]: {k: v for k, v in w.items() if k != "challenger_metrics"}
               for w in published["manifest"]["windows"]}
    assert json.dumps(windows, sort_keys=True, default=str) == json.dumps(clock.final, sort_keys=True, default=str)
    assert all("oof_fold_ready" in w for w in clock.final.values())
    with_challengers = published["manifest"]
    published = install(monkeypatch, Clock(), gnn_fail=gnn_fail)
    run(challenger_models_disabled=True)
    assert all("challenger_metrics" in w for w in with_challengers["windows"])
    assert not any("challenger_metrics" in w for w in published["manifest"]["windows"])
    assert without_challengers(with_challengers) == without_challengers(published["manifest"])
    assert with_challengers["windows"][2]["GNN_result"] == {"error": "train_gnn_graphsage_universal failed"}


def test_the_tail_starts_when_the_windows_return_even_if_a_watcher_missed_one(monkeypatch):
    clock = Clock()
    published = install(monkeypatch, clock)
    real_track = mc.GpuGate.track
    monkeypatch.setattr(mc.GpuGate, "track", lambda self, wid, gpu=(): None if wid == 2 else real_track(self, wid, gpu))
    done = threading.Event()
    threading.Thread(target=lambda: (run(), done.set()), daemon=True).start()
    assert done.wait(10), "the orchestrator hung on its deferred challengers"
    assert {m["status"] for m in challenger_metrics(published["manifest"]).values()} == {"ready"}
    assert clock.spawns[0][0] >= champion_end(clock) - 0.005  # gpu_free never came: nothing before the champion


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


def test_a_queued_timexer_input_holds_the_next_spawn_until_it_has_an_l4(monkeypatch):
    def backlog(clock):  # another workspace job held the L4 one TimeXer input waits for, 0.2 s past the gate
        return 1 if clock.now() < max(ends(clock, GATED_GPU)) + 0.2 else 0
    clock = Clock()
    install(monkeypatch, clock, backlog=backlog)
    run()
    gated, done = max(ends(clock, GATED_GPU)), champion_end(clock)
    mid = [start for start, *_ in clock.spawns if start < done]
    assert mid and mid[0] >= gated + 0.2 and max(active for start, _, active in clock.spawns if start < done) == 1
    assert len([t for t in clock.probes if t < gated + 0.2]) > 1  # re-checked while waiting, not spawned
    assert len(clock.probes) >= len(mid)  # every spawn while the champion runs was preceded by a check


def test_unknown_timexer_stats_hold_the_challengers_until_the_champion_is_final(monkeypatch):
    def backlog(clock):
        raise RuntimeError("stats unavailable")
    clock = Clock()
    published = install(monkeypatch, clock, backlog=backlog)
    run()
    held = published["manifest"]
    assert clock.probes and clock.spawns[0][0] >= champion_end(clock) - 0.005
    assert {m["status"] for m in challenger_metrics(held).values()} == {"ready"}
    published = install(monkeypatch, Clock())
    run(challenger_models_disabled=True)
    assert without_challengers(held) == without_challengers(published["manifest"])
