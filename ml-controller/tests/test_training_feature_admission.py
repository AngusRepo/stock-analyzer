import asyncio
import hashlib
import io
import json
from unittest.mock import AsyncMock

import numpy as np
import pytest

from services.training_feature_admission import require_feature_source_observations
from test_training_source_preflight import Bucket, manifests, seal


def set_batch(bucket, manifest, rates, *, matrix=None, count=2):
    out = io.BytesIO()
    np.savez(out, X=np.zeros((count,137)) if matrix is None else matrix,
             missingness_rates=rates)
    path = 'prep/prep/batch_0.npz'
    bucket.objects[path] = out.getvalue()
    manifest['output_checksums'][path] = hashlib.sha256(out.getvalue()).hexdigest()
    bucket.objects['prep/prep/manifest.json'] = seal(manifest)


@pytest.mark.parametrize('fault', ['missingness_absent','all_missing','nan','negative','above_one',
    'wrong_width','matrix_nan','matrix_shape','names_tamper','batch_tamper','inventory','row_count'])
def test_invalid_feature_sources_rejected(fault):
    manifest, seq = manifests()
    bucket = Bucket(manifest, seq)
    rates = np.zeros(137)
    matrix = np.zeros((2,137))
    if fault == 'all_missing': rates[41] = 1
    if fault == 'nan': rates[41] = np.nan
    if fault == 'negative': rates[41] = -0.01
    if fault == 'above_one': rates[41] = 1.01
    if fault == 'wrong_width': rates = np.zeros(136)
    if fault == 'matrix_nan': matrix[0,0] = np.nan
    if fault == 'matrix_shape': matrix = np.zeros((1,137))
    set_batch(bucket, manifest, rates, matrix=matrix)
    if fault == 'names_tamper': bucket.objects['prep/prep/feature_names.json'] = b'[]'
    if fault == 'batch_tamper': bucket.objects['prep/prep/batch_0.npz'] = b'bad'
    if fault == 'inventory': manifest['output_checksums']['prep/prep/batch_1.npz'] = 'a'*64
    if fault == 'row_count': manifest['output_rows'] = 3
    if fault == 'missingness_absent':
        out = io.BytesIO(); np.savez(out, X=matrix)
        bucket.objects['prep/prep/batch_0.npz'] = out.getvalue()
        manifest['output_checksums']['prep/prep/batch_0.npz'] = hashlib.sha256(out.getvalue()).hexdigest()
    with pytest.raises(ValueError, match='training_feature_source_'):
        require_feature_source_observations(bucket, manifest)


def test_batch_local_legal_missingness_and_zero_values_remain_valid():
    manifest, seq = manifests(); bucket = Bucket(manifest, seq)
    rates = np.zeros(137); rates[41] = 1
    set_batch(bucket, manifest, rates)
    path = 'prep/prep/batch_1.npz'; out = io.BytesIO()
    np.savez(out, X=np.zeros((1,137)), missingness_rates=np.full(137, .5))
    bucket.objects[path] = out.getvalue()
    manifest.update(batch_rows=[2,1], output_rows=3)
    manifest['output_checksums'][path] = hashlib.sha256(out.getvalue()).hexdigest()
    result = require_feature_source_observations(bucket, manifest)
    assert result['rows'] == 3 and result['coordinates'] == 137
    assert not result['historical_publication_vintage_certified']


def test_entirely_missing_source_stops_actual_paid_oof_entry(monkeypatch):
    from routers import walk_forward as wf
    from services import walk_forward_retrain as retrain, modal_client
    manifest, seq = manifests(); bucket = Bucket(manifest, seq)
    rates = np.zeros(137); rates[41] = 1
    set_batch(bucket, manifest, rates)
    monkeypatch.setattr(retrain, '_get_bucket', lambda: bucket)
    spawn = AsyncMock(); monkeypatch.setattr(modal_client, 'spawn_walk_forward_orchestrator', spawn)
    req = wf.WalkForwardRequest(start_date='2026-01-01', end_date='2026-04-01', confirm=True,
                              prep_gcs_prefix='prep', sequence_gcs_prefix='seq')
    with pytest.raises(wf.HTTPException, match='training_feature_source_entirely_missing:f41'):
        asyncio.run(wf.walk_forward_run(req))
    spawn.assert_not_called()
