import sys
import types

import google.cloud
from google.api_core.exceptions import NotFound


class Blob:
    def __init__(self, bucket, path):
        self.bucket, self.path = bucket, path

    def exists(self):
        raise AssertionError('read_cached must not spend a round-trip on exists()')

    def download_as_bytes(self):
        if self.path not in self.bucket.objects:
            raise NotFound(self.path)
        return self.bucket.objects[self.path]

    def upload_from_string(self, raw, content_type):
        self.bucket.objects[self.path] = raw


class Bucket:
    def __init__(self):
        self.objects = {}

    def blob(self, path):
        return Blob(self, path)


def fake_storage(monkeypatch):
    clients = []

    class Client:
        def __init__(self):
            clients.append(self)
            self.buckets = {}

        def bucket(self, name):
            return self.buckets.setdefault(name, Bucket())

    module = types.ModuleType('google.cloud.storage')
    module.Client = Client
    monkeypatch.setitem(sys.modules, 'google.cloud.storage', module)
    monkeypatch.setattr(google.cloud, 'storage', module, raising=False)
    return clients


def test_read_cached_reuses_one_client_and_maps_missing_to_none(monkeypatch):
    from services import official_history_cache as cache
    cache._bucket.cache_clear()
    clients = fake_storage(monkeypatch)
    monkeypatch.setenv('FINLAB_OFFICIAL_HISTORY_CACHE_PREFIX', '/official/')
    monkeypatch.setenv('GCS_BUCKET_NAME', 'bucket-a')

    assert cache.read_cached('breadth/TWSE-2026-10-08.json') is None
    cache.write_cached('breadth/TWSE-2026-10-08.json', b'{"ok":1}')
    assert cache.read_cached('breadth/TWSE-2026-10-08.json') == b'{"ok":1}'
    assert len(clients) == 1
    cache._bucket.cache_clear()
