import json
import threading
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
import pytest
from services import strategy_nav_read_model as nav
from services import walk_forward_retrain


@pytest.fixture
def transport(monkeypatch):
    made = []
    monkeypatch.setattr(nav, '_READ_TRANSPORT', threading.local())
    monkeypatch.setenv('GCS_BUCKET_NAME', 'first-bucket')

    def create():
        bucket = SimpleNamespace(reads=0, downloads=0, generation=1, closed=False)

        def close():
            bucket.closed = True

        def blob(key):
            value = SimpleNamespace()

            def reload():
                bucket.reads += 1
                value.size = 30
                value.generation = bucket.generation

            def download_as_bytes(*, if_generation_match):
                assert if_generation_match == bucket.generation
                bucket.downloads += 1
                return json.dumps({'generation': bucket.generation}).encode()

            value.reload, value.download_as_bytes = reload, download_as_bytes
            return value

        bucket.client, bucket.blob = SimpleNamespace(close=close), blob
        made.append(bucket)
        return bucket

    monkeypatch.setattr(walk_forward_retrain, '_get_bucket', create)
    return made


def test_thirteen_requests_share_transport_but_revalidate_current_object_generation(transport):
    for index in range(13):
        store = nav.production_read_store()
        store.bucket.generation = index + 1
        assert store.read('original') == {'generation': index + 1}
    assert len(transport) == 1
    assert transport[0].reads == transport[0].downloads == 13


def test_parallel_worker_threads_do_not_share_auth_sessions(transport):
    parent = nav.production_read_store()
    barrier = threading.Barrier(2)

    def work():
        first = nav.production_read_store()
        barrier.wait(timeout=5)
        assert nav.production_read_store() is first
        return first

    with ThreadPoolExecutor(max_workers=2) as executor:
        one, two = list(executor.map(lambda _: work(), range(2)))
    assert one is not two and one is not parent and two is not parent
    assert len(transport) == 3


def test_bucket_change_replaces_and_closes_only_old_thread_transport(transport, monkeypatch):
    prior = nav.production_read_store()
    monkeypatch.setenv('GCS_BUCKET_NAME', 'second-bucket')
    current = nav.production_read_store()
    assert current is not prior and prior.bucket.closed
    assert not current.bucket.closed


def test_fork_reinitializes_without_touching_parent_transport(transport, monkeypatch):
    parent = nav.production_read_store()
    old_pid = nav.os.getpid()
    monkeypatch.setattr(nav.os, 'getpid', lambda: old_pid + 1)
    assert nav.production_read_store() is not parent
    assert not parent.bucket.closed


def test_failed_initialization_is_not_cached_or_returned_as_a_working_store(monkeypatch):
    monkeypatch.setattr(nav, '_READ_TRANSPORT', threading.local())
    attempts = []
    monkeypatch.setattr(walk_forward_retrain, '_get_bucket', lambda: attempts.append(1))
    for _ in range(2):
        with pytest.raises(ValueError, match='store_unavailable'):
            nav.production_read_store()
    assert len(attempts) == 2
