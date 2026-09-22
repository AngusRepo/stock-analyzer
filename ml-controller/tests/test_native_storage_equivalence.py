"""Storage changes cannot revoke Paper admission or hide an unknown engine."""
import asyncio
import json
import threading
from copy import deepcopy
from pathlib import Path

from services.native_execution_equivalence import policy_execution_owner
from services.native_paper_sandbox import native_execution_identity
from services.paired_nav_execution_environment import execution_policy
from services.paired_nav_journal import digest
from test_native_paper_sandbox import native_runner
from test_paired_nav_execution_environment import environment_packet


def test_exact_running_native_build_is_certified(native_runner):
    certificate=json.loads(Path(__file__).parents[1].joinpath('services/native_execution_equivalence.json').read_text())
    actual=native_execution_identity(native_runner)
    assert actual in {'native-paper-v1:'+digest(p) for p in certificate['runtime_components']}
    assert policy_execution_owner(actual)=='native-paper-v1:'+digest(certificate['policy_components'])
    assert policy_execution_owner('native-paper-v1:'+'f'*64)=='native-paper-v1:'+'f'*64


def test_source_mutation_retains_new_identity(native_runner,monkeypatch):
    original=Path.read_bytes
    monkeypatch.setattr(Path,'read_bytes',lambda p:original(p)+(b'#changed' if p.name=='paired_native_session.py' else b''))
    actual=native_execution_identity(native_runner)
    assert policy_execution_owner(actual)==actual


def test_only_certified_owner_changes_are_equivalent():
    c=json.loads(Path(__file__).parents[1].joinpath('services/native_execution_equivalence.json').read_text())
    prior=environment_packet('native-paper-v1:'+digest(c['policy_components']))
    new=deepcopy(prior);new['execution_owner_version']='native-paper-v1:'+digest(c['runtime_components'][-1])
    assert execution_policy(prior)==execution_policy(new)
    new['source_context']['variables']['SOME_EXECUTION_SETTING']='changed'
    assert execution_policy(prior)!=execution_policy(new)
    assert new['execution_owner_version']!=prior['execution_owner_version']  # raw evidence stays exact


def test_model_pool_read_does_not_block_event_loop(monkeypatch):
    from routers import model_pool
    entered=threading.Event();release=threading.Event()
    def read():
        entered.set()
        if not release.wait(3):raise RuntimeError('read blocked the event loop')
        return {'models':{},'l2_feature_sidecars':{}}
    monkeypatch.setattr(model_pool,'load_d1_champion_pool',read)
    monkeypatch.setattr(model_pool,'build_research_benchmark_manifest',lambda *a:{})
    async def scenario():
        pending=asyncio.create_task(model_pool.lineage())
        try:
            for _ in range(100):
                if entered.is_set():break
                await asyncio.sleep(.01)
            assert entered.is_set()
        finally:release.set()
        assert (await pending)['status']=='ok'
    asyncio.run(scenario())
