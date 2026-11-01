"""W4(a) challenger runtime: cancelled at the budget, L4 challengers only after the champion's GPU calls."""
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


async def settle():
    for _ in range(20):
        await asyncio.sleep(0)


def test_l4_challengers_start_only_after_every_champion_gpu_call_in_arm_order():
    async def scenario():
        loop = asyncio.get_running_loop()
        trainer, gate = FakeTrainer(), mc.GpuGate(2)
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
        gpu[2].set_result(None)
        await settle()
        assert trainer.spawned() == ["mkt9:w1", "mkt9:w2", "mkt0:w1", "mkt0:w2"]  # whole arms first
        for call in trainer.calls.values():
            call.finish.set()
        results = await asyncio.gather(*tasks)
        assert [r["model"] for r in results] == ["mkt0:w1", "mkt9:w1", "mkt0:w2", "mkt9:w2"]
        assert not any(kind == "cancel" for kind, *_ in trainer.log)
        for w in (1, 2):
            tree[w].set_result(None)
    asyncio.run(scenario())


def test_l4_challengers_never_outlive_the_champion():
    async def scenario():
        loop = asyncio.get_running_loop()
        trainer, gate = FakeTrainer(), mc.GpuGate(1)
        blocks = asyncio.ensure_future(ready_blocks())
        gpu, tree = loop.create_future(), loop.create_future()
        gate.track(1, gpu=[gpu], champion=[gpu, tree])
        running = asyncio.ensure_future(mc.run_challenger(
            trainer, payload("mkt9", 1), blocks, budget_s=None, gate=gate, ticket=gate.ticket((0, 1))))
        queued = asyncio.ensure_future(mc.run_challenger(
            trainer, payload("mkt0", 1), blocks, budget_s=None, gate=gate, ticket=gate.ticket((1, 1))))
        gpu.set_result(None)
        await settle()
        assert trainer.spawned() == ["mkt9:w1", "mkt0:w1"]  # both inputs sit in Modal's queue (max_containers=1)
        tree.set_result(None)  # the champion's last CPU call finishes; both challengers are still unfinished
        first, second = await asyncio.wait_for(asyncio.gather(running, queued), timeout=1)
        assert first == second == {"unsupported": "market_challenger_budget_exceeded:running:champion_done"}
        assert sorted(entry for entry in trainer.log if entry[0] == "cancel") == [
            ("cancel", "mkt0:w1", True), ("cancel", "mkt9:w1", True)]
    asyncio.run(scenario())


def test_l4_challenger_is_not_spawned_when_the_champion_finishes_first():
    async def scenario():
        trainer, gate = FakeTrainer(), mc.GpuGate(2)
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
