"""Exercise real batch preparation with uploads captured locally."""
import io
from datetime import date, timedelta
import numpy as np
import polars as pl
import pytest
from app import features, universal_training


class MemoryBucket:
    def __init__(self):
        self.files = {}

    def blob(self, name):
        bucket = self
        class Blob:
            def upload_from_file(self, stream, **kwargs):
                bucket.files[name] = stream.read()
            def upload_from_string(self, value, **kwargs):
                bucket.files[name] = value
        return Blob()


def test_rank_prep_keeps_no_touch_rows_and_rejects_unmatured_returns(monkeypatch):
    dates = [(date(2026, 1, 1) + timedelta(days=i)).isoformat() for i in range(65)]
    bucket = MemoryBucket()
    monkeypatch.setattr(universal_training, '_get_bucket', lambda: bucket)
    monkeypatch.setattr(features, 'FEATURE_COLS', ['return_1d'])
    monkeypatch.setattr(features, 'TIMESFM_L175_FEATURE_COLS', [])
    payload = {'symbol': 'TEST', 'prices': [
        {'date': day, 'open': 100.0, 'close': 100.0} for day in dates
    ]}
    outputs = []
    for direction in (None, 0.0, 1.0):
        frame = pl.DataFrame({
            'date': dates,
            'return_1d': [0.0] * 65,
            'target_5d': [0.01] * 60 + [None] * 5,
            'target_dir': pl.Series([direction] * 65, dtype=pl.Float64),
        })
        monkeypatch.setattr(features, 'build_feature_matrix', lambda *a, **k: frame)
        result = universal_training.prep_universal_batch(
            universal_training.UniversalPrepRequest(payloads=[payload], gcs_prefix='local-test')
        )
        assert result['rows'] == 60
        with np.load(io.BytesIO(bucket.files['local-test/prep/batch_0.npz']), allow_pickle=True) as saved:
            assert 'target_dir' not in saved.files
            assert saved['dates'].tolist() == dates[:60]
            assert saved['label_known_dates'].tolist() == dates[5:]
            assert len(saved['X']) == len(saved['y']) == len(saved['target_returns']) == 60
            outputs.append({key: saved[key].copy() for key in ('X', 'y', 'target_returns', 'dates')})
    for output in outputs[1:]:
        for key in outputs[0]:
            np.testing.assert_array_equal(output[key], outputs[0][key])


def test_future_barrier_path_must_not_decide_five_day_sample_eligibility():
    close = np.full(25, 100.0)
    high = close.copy()
    low = close.copy()
    atr = np.full(25, 2.0)
    no_touch = features.compute_triple_barrier_labels(close, high, low, atr)[0]
    high[10] = 108.0  # Identical first five days; only a later path changes.
    later_touch = features.compute_triple_barrier_labels(close, high, low, atr)[0]
    assert np.isnan(no_touch)
    assert later_touch == 1.0
    frame = pl.DataFrame({'f': [0.0, 0.0], 'target_rank': [0.5, 0.5],
                          'target_5d': [0.0, 0.0], 'target_dir': [no_touch, later_touch]})
    old, _ = features.sanitize_feature_frame(frame, feature_cols=['f'],
        required_target_cols=['target_rank', 'target_5d', 'target_dir'])
    repaired, _ = features.sanitize_feature_frame(frame, feature_cols=['f'],
        required_target_cols=['target_rank', 'target_5d'])
    assert old.height == 1
    assert repaired.height == 2


def test_direction_task_still_requires_its_own_target(monkeypatch):
    monkeypatch.setattr(features, 'FEATURE_COLS', ['return_1d'])
    frame = pl.DataFrame({'return_1d': [0.0, 0.0], 'target_5d': [0.01, 0.01],
                          'target_dir': [None, 1.0]})
    X, y, names = features.get_features(frame, target_col='target_dir')
    assert len(X) == 1
    assert y.tolist() == [1.0]
    assert names == ['return_1d']


def test_r33_prep_marks_rows_before_market_since_unknown_and_forwards_the_contract(monkeypatch):
    """C28-02 C3/C2: a venue is proven only from its listing date; lags reach the feature layer."""
    import json
    dates = [(date(2026, 1, 1) + timedelta(days=i)).isoformat() for i in range(65)]
    monkeypatch.setattr(features, 'FEATURE_COLS', ['return_1d'])
    monkeypatch.setattr(features, 'TIMESFM_L175_FEATURE_COLS', [])
    frame = pl.DataFrame({'date': dates, 'return_1d': [0.0] * 65, 'target_5d': [0.01] * 60 + [None] * 5,
                          'target_dir': pl.Series([None] * 65, dtype=pl.Float64)})
    seen = []
    monkeypatch.setattr(features, 'build_feature_matrix', lambda *a, **k: seen.append(k) or frame)
    payload = {'symbol': 'TEST', 'market': 'TWSE', 'prices': [{'date': day, 'open': 100.0, 'close': 100.0} for day in dates]}
    markets = {}
    from app.pit_contract import content_sha256, load
    sha = content_sha256(load('pit-availability-contract-v1'))
    for name, item, version in (('legacy', payload, None),
                                ('r33', {**payload, 'market_since': dates[30]}, 'pit-availability-contract-v1')):
        bucket = MemoryBucket()
        monkeypatch.setattr(universal_training, '_get_bucket', lambda: bucket)
        universal_training.prep_universal_batch(universal_training.UniversalPrepRequest(
            payloads=[item], gcs_prefix='local-test', pit_contract_version=version,
            pit_contract_sha256=sha if version else None))
        with np.load(io.BytesIO(bucket.files['local-test/prep/batch_0.npz']), allow_pickle=True) as saved:
            markets[name] = saved['markets'].tolist()
        report = json.loads(bucket.files['local-test/prep/cleaning_report_batch_0.json'])
        assert report.get('pit_contract_version') == version and seen[-1]['pit_contract_version'] == version
        # The report names the contract content this image applied; the controller checks it per batch.
        assert report.get('pit_contract_sha256') == (sha if version else None)
    assert markets['legacy'] == ['TWSE'] * 60
    assert markets['r33'] == ['UNKNOWN'] * 30 + ['TWSE'] * 30
    # A listing date that is not an ISO date would compare as a string; the batch fails closed.
    bucket = MemoryBucket()
    monkeypatch.setattr(universal_training, '_get_bucket', lambda: bucket)
    with pytest.raises(ValueError, match='feature_data_quality_build_failed:TEST:ValueError'):
        universal_training.prep_universal_batch(universal_training.UniversalPrepRequest(
            payloads=[{**payload, 'market_since': '2026/01/31'}], gcs_prefix='local-test',
            pit_contract_version='pit-availability-contract-v1', pit_contract_sha256=sha))
    assert 'local-test/prep/batch_0.npz' not in bucket.files
