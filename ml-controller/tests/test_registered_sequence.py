import copy
import hashlib
import json

import pytest

from test_active8_prep_lifecycle import _Bucket, _seal_sequence
from services.active8_prep_lifecycle import _registered_sequence, _manifest_checksum


def fixture():
    bucket = _Bucket()
    prefix, manifest = _seal_sequence(bucket)
    manifest['lane_reports'] = [{'lane': 'daily_price', 'source_uri': {
        'capture_id': 'capture', 'close': 'gs://test-bucket/capture/adj_close.parquet'}}]
    manifest['manifest_checksum'] = _manifest_checksum(manifest)
    raw = json.dumps(manifest).encode()
    bucket.store[prefix + '/prep/sequence_manifest.json'] = raw
    source = {'prefix': prefix, 'capture_id': 'capture', 'manifest_sha256': hashlib.sha256(raw).hexdigest()}
    return bucket, source, manifest


def test_registered_manifest_and_actual_batches():
    bucket, source, manifest = fixture()
    assert _registered_sequence(bucket, '2026-07-24', source) == (source['prefix'], manifest)
    bucket.store[source['prefix'] + '/prep/batch_0.npz'] = b'changed'
    with pytest.raises(ValueError, match='batch_checksum'):
        _registered_sequence(bucket, '2026-07-24', source)


@pytest.mark.parametrize('field,value,error', [
    ('manifest_sha256', '0' * 64, 'manifest_checksum'),
    ('capture_id', 'other', 'single_capture'),
])
def test_registration_tamper(field, value, error):
    bucket, source, _ = fixture()
    source[field] = value
    with pytest.raises(ValueError, match=error):
        _registered_sequence(bucket, '2026-07-24', source)


def test_registered_date_cannot_be_relabelled():
    bucket, source, _ = fixture()
    with pytest.raises(ValueError, match='identity_or_date'):
        _registered_sequence(bucket, '2026-07-25', source)


def test_registered_internal_seal_required():
    bucket, source, manifest = fixture()
    manifest = copy.deepcopy(manifest)
    manifest['status'] = 'failed'
    raw = json.dumps(manifest).encode()
    bucket.store[source['prefix'] + '/prep/sequence_manifest.json'] = raw
    source['manifest_sha256'] = hashlib.sha256(raw).hexdigest()
    with pytest.raises(ValueError, match='identity_or_date'):
        _registered_sequence(bucket, '2026-07-24', source)
