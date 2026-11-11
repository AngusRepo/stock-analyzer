import json
import numpy as np
import pytest

from app.timexer_cutoff import input_scope
from app.timexer_contract import ARCHITECTURE, OFFICIAL_COMMIT
from app.timexer_training import load_windows, Windows

def payload():
    return dict(generation_mode='purged_oof', run_date='2026-10-01', signal_date_max='2026-09-22',
        label_known_at_max='2026-10-01', train_start='2023-04-06', train_end='2026-08-31',
        test_start='2026-09-01', test_end='2026-09-22')

def test_full_archive_requires_explicit_dual_cutoff_and_preserves_vintage():
    manifest = dict(source_feature_date_max='2026-10-08')
    value = payload()
    result = input_scope(manifest, value)
    assert result['archive_source_feature_date_max'] == '2026-10-08'
    assert result['point_in_time_vintage_certified'] is False
    assert manifest == dict(source_feature_date_max='2026-10-08')
    del value['signal_date_max']; del value['label_known_at_max']
    with pytest.raises(ValueError, match='manifest_invalid'):
        input_scope(manifest, value)

@pytest.mark.parametrize('change', [dict(label_known_at_max=None), dict(signal_date_max=None),
    dict(label_known_at_max='2026-10-08'), dict(test_end='2026-09-23'),
    dict(train_end='2026-09-01'), dict(generation_mode='native'),
    dict(candidate_type='oof_full_fit_release')])
def test_invalid_or_partial_scope_cannot_relax_manifest_guard(change):
    with pytest.raises((ValueError, TypeError)):
        input_scope(dict(source_feature_date_max='2026-10-08'), dict(payload(), **change))

def test_actual_window_samples_and_tensors_ignore_post_cutoff_poison(tmp_path):
    dates = np.arange(np.datetime64('2025-01-01'), np.datetime64('2025-01-01') + 200).astype(str)
    prices = np.linspace(30, 70, 200, dtype=np.float32)
    matrix = np.arange(200 * 137, dtype=np.float32).reshape(200, 137) / 1000
    def write():
        for folder in ('features-ready/prep', 'sequence/prep', 'canonical/prep'):
            (tmp_path / folder).mkdir(parents=True, exist_ok=True)
        np.savez_compressed(tmp_path / 'features-ready/prep/batch_0.npz',
                            symbols=np.array(['2330'] * len(dates)), dates=dates, X=matrix)
        record = dict(symbol='2330', dates=dates.tolist(), close=prices.tolist(), open=prices.tolist())
        np.savez_compressed(tmp_path / 'sequence/prep/batch_0.npz',
                            sequence_records=np.array([record], dtype=object))
        (tmp_path / 'canonical/prep/symbol_market.json').write_text(json.dumps({'2330': 'TWSE'}))
    job = dict(settings={**ARCHITECTURE, 'official_commit': OFFICIAL_COMMIT}, exogenous=True,
        train_start=dates[167], train_end=dates[172], test_start=dates[178], test_end=dates[194],
        input_scope=dict(signal_date_max=dates[181], label_known_at_max=dates[184]))
    write()
    series, rows, _ = load_windows(tmp_path, job)
    assert rows and max(r['date'] for r in rows) == dates[179]
    assert max(r['label_known_date'] for r in rows) == dates[184]
    before = [Windows(series, rows, True)[i] for i in range(len(rows))]
    prices[185:] *= 100
    matrix[180:] = -99999
    write()
    after_series, after_rows, _ = load_windows(tmp_path, job)
    assert rows == after_rows
    for i, expected in enumerate(before):
        actual = Windows(after_series, after_rows, True)[i]
        np.testing.assert_array_equal(actual[0], expected[0])
        np.testing.assert_array_equal(actual[1], expected[1])
        assert actual[2:] == expected[2:]
