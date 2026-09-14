"""Exercise real batch preparation with uploads captured locally."""
import io
from datetime import date, timedelta
import numpy as np
import polars as pl
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
