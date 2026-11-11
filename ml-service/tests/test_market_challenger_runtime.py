"""W4(a) challenger runtime: cancelled at the budget or the tail cap; L4 challengers one at a time after the
champion's non-TimeXer GPU calls while no TimeXer input waits for an L4, then in parallel once it is final; a
failed call is sent once more."""
import asyncio
import re
from pathlib import Path
from types import SimpleNamespace

import pytest

from app import market_conditioner as mc
from tests.test_market_conditioner import extra_block, history_block

MODAL_APP = Path(__file__).resolve().parents[1] / "modal_app.py"


class FakeTrainer:
    """Records spawns and cancels; each call finishes only when the test says so. failures[name] lists how its
    first calls fail ("raise" or "error"); hang names the RPCs that never answer ("spawn", "cancel")."""

    def __init__(self, failures=None, hang=()):
        self.log, self.calls = [], {}
        self.failures, self.hang = {name: list(kinds) for name, kinds in (failures or {}).items()}, set(hang)
        self.spawn = SimpleNamespace(aio=self._spawn)

    async def _spawn(self, payload):
        name = f"{payload['market_conditioner_arm']}:w{payload['window_id']}"
        finish, log, hang = asyncio.Event(), self.log, self.hang
        failure = (self.failures.get(name) or [None]).pop(0)
        if "spawn" in hang:
            log.append(("spawn_hung", name))
            await asyncio.Event().wait()

        async def get():
            if failure == "raise":
                raise RuntimeError("input preempted")
            if failure == "error":
                return {"error": "CUDA out of memory"}
            await finish.wait()
            return done(name)

        async def cancel(terminate_containers=False):
            log.append(("cancel", name, terminate_containers))
            if "cancel" in hang:
                await asyncio.Event().wait()
        self.calls[name] = SimpleNamespace(finish=finish, get=SimpleNamespace(aio=get), cancel=SimpleNamespace(aio=cancel))
        log.append(("spawn", name))
        return self.calls[name]

    def spawned(self):
        return [name for kind, name, *_ in self.log if kind == "spawn"]


def payload(arm, wid):
    return {"market_conditioner_arm": arm, "window_id": wid}


def done(name, attempts=None):
    return {"model": name, "oof_artifact": {"path": name}, **({"attempts": attempts} if attempts else {})}


async def ready_blocks():
    return {"history": history_block(), "capture_extra": extra_block()}


async def no_backlog():
    return 0


async def settle():
    for _ in range(200):
        await asyncio.sleep(0)


def test_l4_challengers_start_after_every_gated_gpu_call_one_at_a_time_in_arm_order():
    async def scenario():
        loop = asyncio.get_running_loop()
        trainer, gate = FakeTrainer(), mc.GpuGate(2, backlog=no_backlog)
        blocks = asyncio.ensure_future(ready_blocks())
        gpu = {w: loop.create_future() for w in (1, 2)}
        for w in (1, 2):
            gate.track(w, gpu=[gpu[w]])
        tasks = [asyncio.ensure_future(mc.run_challenger(
            trainer, payload(arm, w), blocks, budget_s=None, gate=gate,
            ticket=gate.ticket((mc.GPU_ARM_ORDER.index(arm), w))))
            for w in (1, 2) for arm in ("mkt0", "mkt9", "mkt16")]
        await settle()
        assert trainer.spawned() == []
        gpu[1].set_result(None)  # window 1's GPU calls are done, window 2's are not: cohort-wide gate holds
        await settle()
        assert trainer.spawned() == [] and not gate.gpu_free.is_set()
        gpu[2].set_exception(RuntimeError("gnn failed"))  # a failed champion call has released its GPU too
        await settle()
        # Whole arms first, in Wei's order mkt16 -> mkt9 -> mkt0.
        order = ["mkt16:w1", "mkt16:w2", "mkt9:w1", "mkt9:w2", "mkt0:w1", "mkt0:w2"]
        for step, name in enumerate(order):
            assert trainer.spawned() == order[:step + 1]  # the next input waits until this one settles
            trainer.calls[name].finish.set()
            await settle()
        results = await asyncio.gather(*tasks)
        assert [r["model"] for r in results] == ["mkt0:w1", "mkt9:w1", "mkt16:w1", "mkt0:w2", "mkt9:w2", "mkt16:w2"]
        assert not any(kind == "cancel" for kind, *_ in trainer.log)
    asyncio.run(scenario())


def test_once_the_champion_is_final_the_tail_runs_in_parallel_until_the_cap(monkeypatch):
    monkeypatch.setattr(mc, "TAIL_GPU_PARALLEL", 2)
    monkeypatch.setattr(mc, "TAIL_CAP_S", 0.2)

    async def scenario():
        loop = asyncio.get_running_loop()
        trainer, gate = FakeTrainer(), mc.GpuGate(1, backlog=no_backlog)
        gpu = loop.create_future()
        gate.track(1, gpu=[gpu])
        tasks = [asyncio.ensure_future(mc.run_challenger(
            trainer, payload(arm, w), asyncio.ensure_future(ready_blocks()), budget_s=None, gate=gate,
            ticket=gate.ticket((rank, w)))) for rank, arm in enumerate(("mkt9", "mkt0")) for w in (1, 2)]
        gpu.set_result(None)
        await settle()
        assert trainer.spawned() == ["mkt9:w1"]  # one input in flight while the champion runs
        gate.champion_done.set()  # the windows returned: the champion results are final
        await settle()
        assert trainer.spawned() == ["mkt9:w1", "mkt9:w2"]  # up to TAIL_GPU_PARALLEL from here
        trainer.calls["mkt9:w2"].finish.set()
        await settle()
        assert trainer.spawned() == ["mkt9:w1", "mkt9:w2", "mkt0:w1"]
        results = await asyncio.wait_for(asyncio.gather(*tasks), timeout=1)  # nothing else finishes: the cap
        assert results == [{"unsupported": "market_challenger_budget_exceeded:running:tail_cap", "attempts": 1},
                           done("mkt9:w2", 1),
                           {"unsupported": "market_challenger_budget_exceeded:running:tail_cap", "attempts": 1},
                           {"unsupported": "market_challenger_budget_exceeded:waiting_for_gpu:tail_cap", "attempts": 0}]
        assert [entry for entry in trainer.log if entry[0] == "cancel"] == [
            ("cancel", "mkt9:w1", True), ("cancel", "mkt0:w1", True)]
        assert trainer.spawned() == ["mkt9:w1", "mkt9:w2", "mkt0:w1"]
    asyncio.run(scenario())


def test_no_l4_challenger_starts_before_the_gpus_are_free_unless_the_champion_is_final():
    async def scenario():
        trainer, gate = FakeTrainer(), mc.GpuGate(2, backlog=no_backlog)
        gate.track(1, gpu=[])  # window 2's GPU calls are never tracked; the windows return regardless
        task = asyncio.ensure_future(mc.run_challenger(
            trainer, payload("mkt9", 1), asyncio.ensure_future(ready_blocks()), budget_s=None, gate=gate,
            ticket=gate.ticket((0, 1))))
        await settle()
        assert trainer.spawned() == [] and not gate.gpu_free.is_set()
        gate.champion_done.set()
        await settle()
        assert trainer.spawned() == ["mkt9:w1"]
        trainer.calls["mkt9:w1"].finish.set()
        assert (await asyncio.wait_for(task, timeout=1)) == done("mkt9:w1", 1)
    asyncio.run(scenario())


def test_no_spawn_while_a_timexer_input_waits_for_an_l4(monkeypatch):
    """Minor-T2: another workspace GPU job can leave a TimeXer input queued when the gate opens."""
    monkeypatch.setattr(mc, "BACKLOG_POLL_S", 0.01)

    async def scenario():
        queued = {"n": 2}

        async def backlog():
            return queued["n"]
        trainer, gate = FakeTrainer(), mc.GpuGate(1, backlog=backlog)
        gate.track(1, gpu=[])
        task = asyncio.ensure_future(mc.run_challenger(
            trainer, payload("mkt9", 1), asyncio.ensure_future(ready_blocks()), budget_s=None, gate=gate,
            ticket=gate.ticket((0, 1))))
        await asyncio.sleep(0.1)
        assert gate.gpu_free.is_set() and trainer.spawned() == []
        queued["n"] = 0  # the TimeXer input got its L4
        await asyncio.sleep(0.1)
        assert trainer.spawned() == ["mkt9:w1"]
        trainer.calls["mkt9:w1"].finish.set()
        assert (await asyncio.wait_for(task, timeout=1)) == done("mkt9:w1", 1)
    asyncio.run(scenario())


def test_an_unknown_backlog_holds_the_challenger_only_while_the_champion_runs(monkeypatch):
    monkeypatch.setattr(mc, "BACKLOG_POLL_S", 0.01)

    async def scenario():
        async def backlog():
            raise RuntimeError("stats unavailable")
        trainer, gate = FakeTrainer(), mc.GpuGate(1, backlog=backlog)
        gate.track(1, gpu=[])
        task = asyncio.ensure_future(mc.run_challenger(
            trainer, payload("mkt9", 1), asyncio.ensure_future(ready_blocks()), budget_s=None, gate=gate,
            ticket=gate.ticket((0, 1))))
        await asyncio.sleep(0.1)
        assert trainer.spawned() == []  # fail closed for the challenger
        gate.champion_done.set()  # the champion's L4s are free; a TimeXer backlog no longer matters
        await settle()
        assert trainer.spawned() == ["mkt9:w1"]
        trainer.calls["mkt9:w1"].finish.set()
        assert (await asyncio.wait_for(task, timeout=1)) == done("mkt9:w1", 1)
    asyncio.run(scenario())


def test_budget_cancels_the_remote_input():
    async def scenario():
        trainer = FakeTrainer()
        result = await mc.run_challenger(trainer, payload("mkt9", 3), asyncio.ensure_future(ready_blocks()),
                                         budget_s=0.05)
        assert result == {"unsupported": "market_challenger_budget_exceeded:running:budget", "attempts": 1}
        assert trainer.log == [("spawn", "mkt9:w3"), ("cancel", "mkt9:w3", True)]
        # The orchestrator loop shutting down also cancels the remote input.
        task = asyncio.ensure_future(mc.run_challenger(
            trainer, payload("mkt0", 4), asyncio.ensure_future(ready_blocks()), budget_s=None))
        await settle()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert trainer.log[-1] == ("cancel", "mkt0:w4", True)
    asyncio.run(scenario())


def test_a_failed_call_is_sent_once_more_under_the_same_ticket(monkeypatch):
    """Wei 11/2: preemption, OOM or an error result costs one more call inside the cap; a second failure is final."""
    monkeypatch.setattr(mc, "BACKLOG_POLL_S", 0.01)

    async def scenario():
        probes = []

        async def backlog():
            probes.append(len(trainer.log))
            return 0
        trainer = FakeTrainer(failures={"mkt9:w1": ["raise"], "mkt9:w2": ["error", "raise"]})
        gate = mc.GpuGate(1, backlog=backlog)
        gate.track(1, gpu=[])
        tasks = [asyncio.ensure_future(mc.run_challenger(
            trainer, payload(arm, w), asyncio.ensure_future(ready_blocks()), budget_s=None, gate=gate,
            ticket=gate.ticket((rank, w)))) for rank, arm, w in ((0, "mkt9", 1), (1, "mkt9", 2), (2, "mkt0", 1))]
        await settle()
        # Still one L4 challenger while the champion runs: the resend keeps the ticket and is checked like a spawn.
        assert trainer.spawned() == ["mkt9:w1", "mkt9:w1"] and len(probes) == 2
        trainer.calls["mkt9:w1"].finish.set()
        await settle()
        assert trainer.spawned() == ["mkt9:w1", "mkt9:w1", "mkt9:w2", "mkt9:w2", "mkt0:w1"]
        trainer.calls["mkt0:w1"].finish.set()
        results = await asyncio.wait_for(asyncio.gather(*tasks), timeout=1)
        assert results == [done("mkt9:w1", 2), {"error": "input preempted", "attempts": 2}, done("mkt0:w1", 1)]
        assert len(probes) == len(trainer.spawned())
    asyncio.run(scenario())


def test_a_resend_is_still_cancelled_at_the_tail_cap(monkeypatch):
    monkeypatch.setattr(mc, "TAIL_CAP_S", 0.1)

    async def scenario():
        trainer, gate = FakeTrainer(failures={"mkt9:w1": ["error"]}), mc.GpuGate(1, backlog=no_backlog)
        gate.track(1, gpu=[])
        gate.champion_done.set()
        result = await asyncio.wait_for(mc.run_challenger(
            trainer, payload("mkt9", 1), asyncio.ensure_future(ready_blocks()), budget_s=None, gate=gate,
            ticket=gate.ticket((0, 1))), timeout=1)
        assert result == {"unsupported": "market_challenger_budget_exceeded:running:tail_cap", "attempts": 2}
        assert trainer.log == [("spawn", "mkt9:w1"), ("spawn", "mkt9:w1"), ("cancel", "mkt9:w1", True)]
        assert not gate._inflight
    asyncio.run(scenario())


@pytest.mark.parametrize("rpc, stage", [("cancel", "running"), ("spawn", "spawning")])
def test_a_hung_modal_rpc_does_not_hold_the_tail_cap_open(monkeypatch, rpc, stage):
    """Minor-G1: modal sets no deadline on a single RPC; past the cap the challenger still returns."""
    monkeypatch.setattr(mc, "TAIL_CAP_S", 0.05)
    monkeypatch.setattr(mc, "CANCEL_TIMEOUT_S", 0.05)

    async def scenario():
        trainer, gate = FakeTrainer(hang={rpc}), mc.GpuGate(1, backlog=no_backlog)
        gate.track(1, gpu=[])
        gate.champion_done.set()
        loop = asyncio.get_running_loop()
        start = loop.time()
        result = await asyncio.wait_for(mc.run_challenger(
            trainer, payload("mkt9", 1), asyncio.ensure_future(ready_blocks()), budget_s=None, gate=gate,
            ticket=gate.ticket((0, 1))), timeout=1)
        assert result == {"unsupported": f"market_challenger_budget_exceeded:{stage}:tail_cap", "attempts": 1}
        assert loop.time() - start < 0.05 + 0.05 + 0.05 and not gate._inflight
        assert trainer.log[-1] == (("cancel", "mkt9:w1", True) if rpc == "cancel" else ("spawn_hung", "mkt9:w1"))
    asyncio.run(scenario())


class RpcTrainer:
    """Spawn behaves like a real RPC: the request is sent on its first step and the handle arrives later, once
    `handle_after` is set (10 ms after it). `cancel_after` holds every cancel RPC until it is set (None: answers at once)."""

    def __init__(self, handle_after, cancel_after=None, get_raises_first=False):
        self.log, self.n = [], 0
        self.handle_after, self.cancel_after, self.get_raises_first = handle_after, cancel_after, get_raises_first
        self.spawn = SimpleNamespace(aio=self._spawn)

    async def _spawn(self, payload):
        self.n += 1
        k, log = self.n, self.log
        log.append(("sent", k))
        await self.handle_after.wait()
        await asyncio.sleep(0.01)  # the network round trip: the handle arrives 10 ms after the event
        log.append(("handle", k))
        raises, cancel_after = self.get_raises_first and k == 1, self.cancel_after

        async def get():
            if raises:
                raise RuntimeError("input preempted")
            await asyncio.Event().wait()

        async def cancel(terminate_containers=False):
            log.append(("cancel", k, terminate_containers))
            if cancel_after is not None:
                await cancel_after.wait()
                await asyncio.sleep(0)
        return SimpleNamespace(get=SimpleNamespace(aio=get), cancel=SimpleNamespace(aio=cancel))


def _tail_gate():
    gate = mc.GpuGate(1, backlog=no_backlog)
    gate.track(1, gpu=[])
    gate.champion_done.set()
    return gate


def test_no_spawn_rpc_is_sent_once_the_tail_cap_has_closed(monkeypatch):
    """Minor-G4-1 (2): attempt 1 raises before the cap and its cancel RPC spans the cap; the resend sends nothing."""
    monkeypatch.setattr(mc, "TAIL_CAP_S", 0.05)

    async def scenario():
        gate = _tail_gate()
        handle_now = asyncio.Event()
        handle_now.set()
        trainer = RpcTrainer(handle_now, cancel_after=gate.closed, get_raises_first=True)
        result = await asyncio.wait_for(mc.run_challenger(
            trainer, payload("mkt9", 1), asyncio.ensure_future(ready_blocks()), budget_s=None, gate=gate,
            ticket=gate.ticket((0, 1))), timeout=1)
        assert gate.closed.is_set() and not gate._inflight
        assert trainer.log == [("sent", 1), ("handle", 1), ("cancel", 1, True)]
        assert result == {"unsupported": "market_challenger_budget_exceeded:waiting_for_gpu:tail_cap", "attempts": 1}
    asyncio.run(scenario())


@pytest.mark.parametrize("cancel_hangs", [False, True])
def test_a_spawn_in_flight_at_the_tail_cap_is_cancelled_once_its_handle_arrives(monkeypatch, cancel_hangs):
    """Minor-G4-1 (1): the request reached Modal before the cap and its handle arrives after it. The input is
    cancelled through that handle; the publish waits at most the cap + 2 x CANCEL_TIMEOUT_S (handle, cancel)."""
    monkeypatch.setattr(mc, "TAIL_CAP_S", 0.05)
    monkeypatch.setattr(mc, "CANCEL_TIMEOUT_S", 0.1)

    async def scenario():
        gate = _tail_gate()
        trainer = RpcTrainer(gate.closed, cancel_after=asyncio.Event() if cancel_hangs else None)
        loop = asyncio.get_running_loop()
        start = loop.time()
        result = await asyncio.wait_for(mc.run_challenger(
            trainer, payload("mkt9", 1), asyncio.ensure_future(ready_blocks()), budget_s=None, gate=gate,
            ticket=gate.ticket((0, 1))), timeout=1)
        elapsed = loop.time() - start
        assert trainer.log == [("sent", 1), ("handle", 1), ("cancel", 1, True)]
        assert result == {"unsupported": "market_challenger_budget_exceeded:spawning:tail_cap", "attempts": 1}
        assert not gate._inflight
        # The handle arrives 10 ms after the cap; a hung cancel RPC adds CANCEL_TIMEOUT_S at most.
        assert elapsed < 0.05 + 0.01 + (0.1 if cancel_hangs else 0) + 0.04
    asyncio.run(scenario())


def test_unsupported_arm_is_never_spawned():
    async def scenario():
        trainer = FakeTrainer()

        async def failed():
            return {"history": {"error": "x"}}
        result = await mc.run_challenger(trainer, payload("mkt9", 1), asyncio.ensure_future(failed()))
        assert result["unsupported"].startswith("market_conditioner_block_unavailable:history:")
        assert trainer.log == []
    asyncio.run(scenario())


def _decorators():
    source = MODAL_APP.read_text()
    return {name: args for args, name in re.findall(r"@app\.function\((.*?)\)\n(?:@[^\n]*\n)*def (\w+)", source, re.S)}


def test_gpu_sets_match_the_modal_decorators():
    specs = _decorators()
    champion_families = ["train_tabm_universal", "train_gnn_graphsage_universal", "train_dlinear_universal",
                         "train_timexer_universal", "train_patchtst_universal", "train_itransformer_universal"]
    # gate.track counts every family task as GPU work; the tree window is CPU.
    assert all("gpu=" in specs[name] for name in champion_families) and "gpu=" not in specs["train_wf_tree_window"]
    challengers = {spec["modal_function"] for spec in mc.LIFECYCLE_SLOTS.values()}
    assert mc.GPU_CHALLENGER_FUNCTIONS == {name for name in challengers if "gpu=" in specs[name]}
    assert "gpu=" not in specs[mc.BLOCK_FUNCTION]


def test_orchestrator_pools_stay_under_the_workspace_container_limit():
    specs = _decorators()

    def pool(name):
        return int(re.search(r"max_containers\s*=\s*(\d+)", specs[name])[1])
    champion = ["walk_forward_orchestrator", "feature_selection_per_window", "train_wf_hmm_window",
                "train_wf_tree_window", "train_tabm_universal", "train_gnn_graphsage_universal",
                "train_dlinear_universal", "train_timexer_universal", "train_patchtst_universal",
                "train_itransformer_universal"]
    challenger = [mc.BLOCK_FUNCTION, mc.TREE_FUNCTION, mc.TABM_FUNCTION]
    # Workspace limit 100 concurrent containers; the 30-day peak of everything else was 16.
    assert sum(map(pool, champion)) + sum(map(pool, challenger)) + 16 <= 100
    assert "memory=16384" in specs[mc.TREE_FUNCTION]  # the R33 mkt16 fold peaked at 12.0 GiB
    assert pool(mc.TABM_FUNCTION) == mc.TAIL_GPU_PARALLEL <= 10  # the tail's L4s; the champion's are free by then


def test_gate_waits_for_every_gpu_family_but_the_exempt_timexer():
    """A new GPU family is waited for unless it is named here; the exemption is TimeXer alone."""
    assert mc.GATE_EXEMPT_GPU_FAMILIES == ("TimeXer",)
    source = MODAL_APP.read_text()
    assert ('gpu=[f for kind, f in tasks if kind in dict(family_tasks) and kind not in market_state["exempt"]]'
            in source)
