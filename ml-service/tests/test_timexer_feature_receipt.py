import hashlib
import io
import json

import numpy as np
import pytest

from app import timexer_inference
from app.features import FEATURE_COLS


class Bucket:
    def __init__(self, objects):
        self.objects = objects
        self.downloads = []

    def blob(self, path):
        bucket = self

        class Blob:
            def download_as_bytes(self):
                bucket.downloads.append(path)
                return bucket.objects[path]

        return Blob()


def source(*, names_in_inventory=True):
    prefix = 'universal/oof_forward_prep_v2/2026-10-05-test'
    shard_path = f'{prefix}/prep/batch_0.npz'
    names_path = f'{prefix}/prep/feature_names.json'
    shard = io.BytesIO()
    np.savez_compressed(
        shard,
        symbols=np.array(['2330']),
        dates=np.array(['2026-10-05']),
        X=np.ones((1, 137), dtype=np.float32),
    )
    names = json.dumps(list(FEATURE_COLS)).encode()
    receipt = {
        'business_date': '2026-10-05',
        'output_gcs_prefix': prefix,
        'status': 'ready',
        'training_dispatched': False,
        'feature_semantic_version': 'formal137-pit-asof-source-quality-v3',
        'feature_imputation_semantic': 'prior_252_row_median_then_zero_v2',
        'batch_count': 1,
        'feature_names_path': names_path,
        'output_checksums': {
            shard_path: hashlib.sha256(shard.getvalue()).hexdigest(),
        },
    }
    if names_in_inventory:
        receipt['output_checksums'][names_path] = hashlib.sha256(names).hexdigest()
    receipt['receipt_checksum'] = hashlib.sha256(
        json.dumps(receipt, sort_keys=True).encode()
    ).hexdigest()
    objects = {
        f'{prefix}/prep/immutable_receipt.json': json.dumps(receipt).encode(),
        shard_path: shard.getvalue(),
        names_path: names,
        'model.json': json.dumps({
            'version': 'v1', 'artifact_path': 'model.pt', 'checksum': 'a' * 64
        }).encode(),
        'model.pt': b'checkpoint',
    }
    reference = {
        'schema_version': 'timexer-feature-source-v1',
        'signal_date': '2026-10-05',
        'status': 'ready',
        'training_dispatched': False,
        'source_gcs_prefix': prefix,
        'source_receipt_checksum': receipt['receipt_checksum'],
    }
    return Bucket(objects), reference, receipt, shard_path, names_path


@pytest.mark.parametrize('names_in_inventory', [False, True])
def test_feature_receipt_accepts_both_producer_inventories(names_in_inventory):
    bucket, reference, receipt, _, names_path = source(
        names_in_inventory=names_in_inventory
    )
    assert timexer_inference.feature_receipt(bucket, reference, '2026-10-05') == receipt
    assert names_path in bucket.downloads


def test_feature_receipt_rejects_changed_feature_names():
    bucket, reference, _, _, names_path = source()
    bucket.objects[names_path] = b'[]'
    with pytest.raises(ValueError, match='timexer_feature_names_checksum_mismatch'):
        timexer_inference.feature_receipt(bucket, reference, '2026-10-05')


def test_feature_receipt_rejects_unexpected_artifacts():
    bucket, reference, receipt, _, _ = source()
    receipt['output_checksums']['unexpected.json'] = 'a' * 64
    receipt['receipt_checksum'] = hashlib.sha256(
        json.dumps({k: v for k, v in receipt.items() if k != 'receipt_checksum'},
                   sort_keys=True).encode()
    ).hexdigest()
    reference['source_receipt_checksum'] = receipt['receipt_checksum']
    bucket.objects[f"{reference['source_gcs_prefix']}/prep/immutable_receipt.json"] = (
        json.dumps(receipt).encode()
    )
    with pytest.raises(ValueError, match='timexer_feature_inventory_invalid'):
        timexer_inference.feature_receipt(bucket, reference, '2026-10-05')


@pytest.mark.parametrize('names_in_inventory', [False, True])
def test_batch_predict_reads_only_npz_shards(monkeypatch, names_in_inventory):
    import torch

    bucket, reference, _, shard_path, names_path = source(
        names_in_inventory=names_in_inventory
    )
    monkeypatch.setattr(torch.cuda, 'is_available', lambda: True)
    monkeypatch.setattr(torch.cuda, 'empty_cache', lambda: None)
    monkeypatch.setattr(timexer_inference, 'metadata_contract', lambda _: {'variant': 'price', 'feature_history_schema': 'formal137-pit-asof-source-quality-v3'})
    monkeypatch.setattr(timexer_inference, 'load_checkpoint', lambda *a, **kw: (object(), {}))
    monkeypatch.setattr(timexer_inference, 'predict_asof', lambda *a, **kw: [
        {'symbol': '2330', 'raw_score': 0.1, 'available': True}
    ])
    rows = timexer_inference.batch_predict(
        series_list=[{
            'symbol': '2330', 'price_basis': 'finlab_adjusted_close',
            'dates': ['2026-10-05'], 'prices': [100.0],
        }],
        artifact_identity={
            'model': 'TimeXer', 'version': 'v1', 'artifact_id': 'test',
            'artifact_path': 'model.pt', 'metadata_path': 'model.json',
            'checksum': 'a' * 64,
        },
        feature_source=reference, signal_date='2026-10-05',
        version='v1', bucket=bucket,
    )
    assert [row['symbol'] for row in rows] == ['2330']
    assert bucket.downloads.count(shard_path) == 1
    assert bucket.downloads.count(names_path) == 1
