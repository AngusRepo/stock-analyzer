from pathlib import Path
from types import SimpleNamespace
import threading
import time
import sys
import pytest
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tools.finlab_gcs_upload import upload_capture


class Bucket:
    name = 'test'

    def __init__(self):
        self.files = {}
        self.events = []
        self.fail = None
        self.active = self.peak = 0
        self.lock = threading.Lock()

    def list_blobs(self, prefix):
        return [SimpleNamespace(name=n, generation=g, size=len(data))
                for n, (g, data) in self.files.items() if n.startswith(prefix)]

    def blob(self, name):
        bucket = self
        class Blob:
            generation = None
            def upload_from_filename(self, path, *, if_generation_match, checksum):
                assert checksum in {'md5', 'crc32c'}
                with bucket.lock:
                    bucket.active += 1
                    bucket.peak = max(bucket.peak, bucket.active)
                try:
                    time.sleep(.005)
                    if name == bucket.fail:
                        raise RuntimeError('upload_failed')
                    old = bucket.files.get(name, (0, b''))[0]
                    if old != if_generation_match:
                        raise RuntimeError('generation_conflict')
                    self.generation = old + 1
                    bucket.files[name] = (self.generation, Path(path).read_bytes())
                    bucket.events.append(name)
                finally:
                    with bucket.lock:
                        bucket.active -= 1
        return Blob()


def capture(tmp_path):
    for name in ['raw/a', 'raw/b', 'raw/c', 'raw/d', 'manifest.json', 'inference/reference.json']:
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(name.encode())


def test_two_pass_upload_only_changed_and_new_with_identical_contents(tmp_path):
    capture(tmp_path)
    bucket, state = Bucket(), {}
    first = upload_capture(tmp_path, bucket=bucket, prefix='run', uploaded_files=state)
    assert first['objects'] == 6 and 1 < bucket.peak <= 4
    assert bucket.events[-2:] == ['run/manifest.json', 'run/inference/reference.json']
    (tmp_path / 'manifest.json').write_bytes(b'updated_d1_result')
    (tmp_path / 'raw/new').write_bytes(b'new')
    bucket.events.clear()
    second = upload_capture(tmp_path, bucket=bucket, prefix='run', uploaded_files=state)
    assert second['objects'] == 2 and second['skipped_objects'] == 5
    assert bucket.events == ['run/raw/new', 'run/manifest.json']
    for path in tmp_path.rglob('*'):
        if path.is_file():
            assert bucket.files['run/' + path.relative_to(tmp_path).as_posix()][1] == path.read_bytes()


def test_deleted_remote_file_is_repaired(tmp_path):
    capture(tmp_path)
    bucket, state = Bucket(), {}
    upload_capture(tmp_path, bucket=bucket, prefix='run', uploaded_files=state)
    del bucket.files['run/raw/a']
    result = upload_capture(tmp_path, bucket=bucket, prefix='run', uploaded_files=state)
    assert result['objects'] == 1 and bucket.files['run/raw/a'][1] == b'raw/a'


def test_remote_replacement_is_rejected_before_publication(tmp_path):
    capture(tmp_path)
    bucket, state = Bucket(), {}
    upload_capture(tmp_path, bucket=bucket, prefix='run', uploaded_files=state)
    bucket.files['run/raw/a'] = (99, b'corrupt')
    bucket.events.clear()
    with pytest.raises(RuntimeError, match='remote_generation_changed'):
        upload_capture(tmp_path, bucket=bucket, prefix='run', uploaded_files=state)
    assert bucket.events == []


def test_failed_input_does_not_publish_metadata_or_reusable_state(tmp_path):
    capture(tmp_path)
    bucket, state = Bucket(), {}
    bucket.fail = 'run/raw/a'
    with pytest.raises(RuntimeError, match='upload_failed'):
        upload_capture(tmp_path, bucket=bucket, prefix='run', uploaded_files=state)
    assert 'run/manifest.json' not in bucket.files
    assert 'run/inference/reference.json' not in bucket.files
    assert state == {}


def test_real_storage_sdk_builds_checksummed_upload_without_network(tmp_path):
    """Exercise the installed SDK request path; only the HTTP transport is fake."""
    import base64
    import json
    from unittest.mock import Mock
    import google_crc32c
    from google.auth.credentials import AnonymousCredentials
    from google.cloud import storage
    import requests

    content = b'captured finlab data'
    (tmp_path / 'raw.parquet').write_bytes(content)
    crc = base64.b64encode(google_crc32c.Checksum(content).digest()).decode()
    requests_seen = []

    def request(method, url, **kwargs):
        requests_seen.append((method, url, kwargs))
        assert method == 'POST' and 'ifGenerationMatch=0' in url
        assert b'"crc32c": "' + crc.encode() + b'"' in kwargs['data']
        response = requests.Response()
        response.status_code = 200
        response._content = json.dumps({'name': 'run/raw.parquet', 'generation': '1',
                                        'size': str(len(content)), 'crc32c': crc}).encode()
        response.headers['content-type'] = 'application/json'
        return response

    transport = Mock()
    transport.request.side_effect = request
    client = storage.Client(project='offline-test', credentials=AnonymousCredentials(), _http=transport)
    real_bucket = client.bucket('offline-test')
    bucket = SimpleNamespace(name=real_bucket.name, list_blobs=lambda **kw: [], blob=real_bucket.blob)
    result = upload_capture(tmp_path, bucket=bucket, prefix='run', uploaded_files={})
    assert result['objects'] == 1, result
    assert requests_seen, {'result': result, 'requests': len(requests_seen)}
