from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Event, Lock
from time import sleep
import pytest
from services.read_singleflight import ReadSingleFlight
from services.verified_read_observation import verified_read_observation, observed_read


def test_simultaneous_same_identity_once_and_no_mutable_or_ttl_cache():
    group=ReadSingleFlight();started=Event();release=Event();calls=[]
    def fetch():calls.append(1);started.set();assert release.wait(3);return {'rows':[1]}
    with ThreadPoolExecutor(8) as pool:
        first=pool.submit(group.read,('source','checksum','scope'),fetch);assert started.wait(1)
        rest=[pool.submit(group.read,('source','checksum','scope'),fetch) for _ in range(7)]
        sleep(.05);release.set();results=[first.result(),*[f.result() for f in rest]]
    assert len(calls)==1
    results[0]['rows'].append(2);assert results[1]=={'rows':[1]}
    group.read(('source','checksum','scope'),fetch);assert len(calls)==2
    assert not group._pending


def test_failure_retries_and_distinct_scope_never_shares():
    group=ReadSingleFlight()
    with pytest.raises(ValueError):group.read(('x','scope1'),lambda:(_ for _ in ()).throw(ValueError('bad')))
    assert group.read(('x','scope1'),lambda:1)==1
    assert group.read(('x','scope2'),lambda:2)==2
    assert not group._pending


def test_observation_still_detects_a_change_during_request():
    state=[1]
    with pytest.raises(RuntimeError,match='observation_changed'):
        with verified_read_observation():
            assert observed_read(('db','exact-query'),'SELECT value',lambda:list(state))==[1]
            state[0]=2


def test_saturation_cancellation_and_recursive_failure_do_not_poison_registry():
    group=ReadSingleFlight(max_inflight=1);started=Event();release=Event()
    def blocked():
        started.set();assert release.wait(3);return 1
    with ThreadPoolExecutor(2) as pool:
        first=pool.submit(group.read,'busy',blocked);assert started.wait(1)
        assert group.read('different',lambda:2)==2
        assert len(group._pending)==1
        release.set();assert first.result()==1
    with pytest.raises(KeyboardInterrupt):
        group.read('cancel',lambda:(_ for _ in ()).throw(KeyboardInterrupt()))
    with pytest.raises(RuntimeError,match='recursive_key'):
        group.read('recursive',lambda:group.read('recursive',lambda:1))
    assert not group._pending and group.read('cancel',lambda:3)==3


def test_eight_ui_requests_share_only_initial_io_and_each_verifies_fresh_source():
    from services.verified_read_observation import observation_active
    lock=Lock();counts={'initial':0,'verification':0};start=Barrier(8);initial=Event();release=Event()
    # Every participant must finish its body before any exits and rechecks.
    bodies=Barrier(8)
    def fetch():
        phase='initial' if observation_active() else 'verification'
        with lock:counts[phase]+=1
        if phase=='initial':
            initial.set();assert release.wait(3)
        return [{'value':1}]
    def request():
        start.wait()
        with verified_read_observation():
            result=observed_read(('same-db','SELECT value'),'SELECT value',fetch)
            bodies.wait()
        return result
    with ThreadPoolExecutor(8) as pool:
        requests=[pool.submit(request) for _ in range(8)]
        assert initial.wait(1);sleep(.1);release.set()
        assert all(job.result()==[{'value':1}] for job in requests)
    assert counts=={'initial':1,'verification':8}
