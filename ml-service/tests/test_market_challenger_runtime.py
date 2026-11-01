"""W4(a) challenger runtime: cancelled at the budget, L4 challengers one at a time after the champion's
non-TimeXer GPU calls and only while no TimeXer input waits for an L4."""
import asyncio
import re
from pathlib import Path
from types import SimpleNamespace

import pytest

from app import market_conditioner as mc
from tests.test_market_conditioner import history_block

MODAL_APP = Path(__file__).resolve().parents[1] / "modal_app.py"


class FakeTrainer:
    """Records spawns and cancels; each call finishes only when the test says so."""

    def __init__(self):
        self.log, self.calls = [], {}
        self.spawn = SimpleNamespace(aio=self._spawn)

    async def _spawn(self, payload):
        name = f"{payload['market_conditioner_arm']}:w{payload['window_id']}"
        finish, log = asyncio.Event(), self.log

        async def get():
            await finish.wait()
            return {"model": name}

        async def cancel(terminate_containers=False):
            log.append(("cancel", name, terminate_containers))
        self.calls[name] = SimpleNamespace(finish=finish, get=SimpleNamespace(aio=get), cancel=SimpleNamespace(aio=cancel))
        log.append(("spawn", name))
        return self.calls[name]

    def spawned(self):
        return [name for kind, name, *_ in self.log if kind == "spawn"]


def payload(arm, wid):
    return {"market_conditioner_arm": arm, "window_id": wid}


async def ready_blocks():
    return {"history": history_block()}


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
        tree = {w: loop.create_future() for w in (1, 2)}
        for w in (1, 2):
            gate.track(w, gpu=[gpu[w]], champion=[gpu[w], tree[w]])
        tasks = [asyncio.ensure_future(mc.run_challenger(
            trainer, payload(arm, w), blocks, budget_s=None, gate=gate, ticket=gate.ticket((mc.ARMS.index(arm), w))))
            for w in (1, 2) for arm in ("mkt0", "mkt9")]
        await settle()
        assert trainer.spawned() == []
        gpu[1].set_result(None)  # window 1's GPU calls are done, window 2's are not: cohort-wide gate holds
        await settle()
        assert trainer.spawned() == [] and not gate.gpu_free.is_set()
        gpu[2].set_exception(RuntimeError("gnn failed"))  # a failed champion call has released its GPU too
        await settle()
        order = ["mkt9:w1", "mkt9:w2", "mkt0:w1", "mkt0:w2"]  # whole arms first
        for step, name in enumerate(order):
            assert trainer.spawned() == order[:step + 1]  # the next input waits until this one settles
            trainer.calls[name].finish.set()
            await settle()
        results = await asyncio.gather(*tasks)
        assert [r["model"] for r in results] == ["mkt0:w1", "mkt9:w1", "mkt0:w2", "mkt9:w2"]
        assert not any(kind == "cancel" for kind, *_ in trainer.log)
        for w in (1, 2):
            tree[w].set_result(None)
    asyncio.run(scenario())


def test_l4_challengers_never_outlive_the_champion():
    async def scenario():
        loop = asyncio.get_running_loop()
        trainer, gate = FakeTrainer(), mc.GpuGate(1, backlog=no_backlog)
        blocks = asyncio.ensure_future(ready_blocks())
        gpu, tree = loop.create_future(), loop.create_future()
        gate.track(1, gpu=[gpu], champion=[gpu, tree])
        running = asyncio.ensure_future(mc.run_challenger(
            trainer, payload("mkt9", 1), blocks, budget_s=None, gate=gate, ticket=gate.ticket((0, 1))))
        queued = asyncio.ensure_future(mc.run_challenger(
            trainer, payload("mkt0", 1), blocks, budget_s=None, gate=gate, ticket=gate.ticket((1, 1))))
        gpu.set_result(None)
        await settle()
        assert trainer.spawned() == ["mkt9:w1"]  # one input in flight; the second waits for its turn
        tree.set_result(None)  # the champion's last call finishes while the first challenger still runs
        first, second = await asyncio.wait_for(asyncio.gather(running, queued), timeout=1)
        assert first == {"unsupported": "market_challenger_budget_exceeded:running:champion_done"}
        assert second == {"unsupported": "market_challenger_budget_exceeded:waiting_for_champion_gpu:champion_done"}
        assert [entry for entry in trainer.log if entry[0] == "cancel"] == [("cancel", "mkt9:w1", True)]
        assert trainer.spawned() == ["mkt9:w1"]
    asyncio.run(scenario())


def test_l4_challenger_is_not_spawned_when_the_champion_finishes_first():
    async def scenario():
        trainer, gate = FakeTrainer(), mc.GpuGate(2, backlog=no_backlog)
        gate.track(1, gpu=[], champion=[])  # window 2's GPU calls never finish; the windows return regardless
        task = asyncio.ensure_future(mc.run_challenger(
            trainer, payload("mkt9", 1), asyncio.ensure_future(ready_blocks()), budget_s=None, gate=gate,
            ticket=gate.ticket((0, 1))))
        await settle()
        gate.champion_done.set()
        result = await asyncio.wait_for(task, timeout=1)
        assert result == {"unsupported": "market_challenger_budget_exceeded:waiting_for_champion_gpu:champion_done"}
        assert trainer.spawned() == []
    asyncio.run(scenario())


def test_no_spawn_while_a_timexer_input_waits_for_an_l4(monkeypatch):
    """Minor-T2: another workspace GPU job can leave a TimeXer input queued when the gate opens."""
    monkeypatch.setattr(mc, "BACKLOG_POLL_S", 0.01)

    async def scenario():
        queued = {"n": 2}

        async def backlog():
            return queued["n"]
        trainer, gate = FakeTrainer(), mc.GpuGate(1, backlog=backlog)
        gate.track(1, gpu=[], champion=[asyncio.get_running_loop().create_future()])
        task = asyncio.ensure_future(mc.run_challenger(
            trainer, payload("mkt9", 1), asyncio.ensure_future(ready_blocks()), budget_s=None, gate=gate,
            ticket=gate.ticket((0, 1))))
        await asyncio.sleep(0.1)
        assert gate.gpu_free.is_set() and trainer.spawned() == []
        queued["n"] = 0  # the TimeXer input got its L4
        await asyncio.sleep(0.1)
        assert trainer.spawned() == ["mkt9:w1"]
        trainer.calls["mkt9:w1"].finish.set()
        assert (await asyncio.wait_for(task, timeout=1)) == {"model": "mkt9:w1"}
    asyncio.run(scenario())


def test_an_unknown_backlog_never_spawns(monkeypatch):
    monkeypatch.setattr(mc, "BACKLOG_POLL_S", 0.01)

    async def scenario():
        async def backlog():
            raise RuntimeError("stats unavailable")
        trainer, gate = FakeTrainer(), mc.GpuGate(1, backlog=backlog)
        gate.track(1, gpu=[], champion=[asyncio.get_running_loop().create_future()])
        task = asyncio.ensure_future(mc.run_challenger(
            trainer, payload("mkt9", 1), asyncio.ensure_future(ready_blocks()), budget_s=None, gate=gate,
            ticket=gate.ticket((0, 1))))
        await asyncio.sleep(0.1)
        assert trainer.spawned() == []
        gate.champion_done.set()
        result = await asyncio.wait_for(task, timeout=1)
        assert result == {"unsupported": "market_challenger_budget_exceeded:waiting_for_champion_backlog:champion_done"}
        assert trainer.spawned() == []
    asyncio.run(scenario())


def test_budget_cancels_the_remote_input():
    async def scenario():
        trainer = FakeTrainer()
        result = await mc.run_challenger(trainer, payload("mkt9", 3), asyncio.ensure_future(ready_blocks()),
                                         budget_s=0.05)
        assert result == {"unsupported": "market_challenger_budget_exceeded:running:budget"}
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
    assert "memory=8192" in specs[mc.TREE_FUNCTION]


def test_gate_waits_for_every_gpu_family_but_the_exempt_timexer():
    """A new GPU family is waited for unless it is named here; the exemption is TimeXer alone."""
    assert mc.GATE_EXEMPT_GPU_FAMILIES == ("TimeXer",)
    source = MODAL_APP.read_text()
    assert ('gpu=[f for kind, f in tasks if kind in dict(family_tasks) and kind not in market_state["exempt"]]'
            in source)
