"""tools/r33_display_win_rate.py: segment fit, honest checks, and the committed display table. No network."""
import json
import math
from pathlib import Path
import sys

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT / 'tools') not in sys.path:
    sys.path.insert(0, str(ROOT / 'tools'))

import r33_display_win_rate as tool  # noqa: E402
from services.r33_crossfit_serving import HINGE_ESTIMATOR, _build_hinge_payload, fit_hinge  # noqa: E402

COMMITTED = ROOT / 'worker' / 'src' / 'lib' / 'r33DisplayWinRate.json'
BLOCKS = [dict(score_lo=-2.0, score_hi=-0.5, mean_excess=-0.01), dict(score_lo=-0.49, score_hi=0.5, mean_excess=0.0),
          dict(score_lo=0.51, score_hi=2.0, mean_excess=0.01)]
STEP = dict(schema_version='r33-roster-isotonic-excess-v2', blocks=BLOCKS)


def _table(days=40, names=30, signal=1.0, seed=3, knot=None):
    rng = np.random.default_rng(seed)
    dates = [f'2026-{6 + i // 28:02d}-{1 + i % 28:02d}' for i in range(days)]
    score, excess, weight, day_rows = [], [], [], {}
    for i, day in enumerate(dates):
        s = rng.uniform(-2, 2, names)
        lift = s if knot is None else np.maximum(s - knot, 0)
        e = signal * 0.01 * lift + rng.normal(0, 0.02, names)
        day_rows[day] = np.arange(i * names, (i + 1) * names)
        score += list(s); excess += list(e - e.mean()); weight += [1.0 / names] * names
    return dict(score=np.array(score), excess=np.array(excess), weight=np.array(weight), day_rows=day_rows,
                horizon=5, calendar_index={d: i for i, d in enumerate(dates)})


def _hinge_serving(table):
    curve, _ = fit_hinge(table)
    return _build_hinge_payload(curve=curve, variant='mean_z', horizon_sessions=5,
                                model_order=['LightGBM', 'ExtraTrees', 'TabM', 'GNN'], diagnostics={},
                                score_quantiles=list(np.quantile(table['score'], np.linspace(0, 1, 21))),
                                inputs={'estimator': HINGE_ESTIMATOR, 'source_calibration_checksum': '5' * 64})


def test_segments_follow_the_serving_edges_and_rank_wins():
    fit = tool.validate_fit(_table(), STEP)
    assert [(s['score_lo'], s['score_hi']) for s in fit['segments']] == [(b['score_lo'], b['score_hi']) for b in BLOCKS]
    rates = [s['win_rate'] for s in fit['segments']]
    assert rates == sorted(rates) and rates[0] < 0.5 < rates[-1]
    assert sum(s['n'] for s in fit['segments']) == 40 * 30
    assert fit['oof']['days'] == 40 and fit['holdout']['test']['days'] == 12 - 5 + 1
    for check in ('holdout', 'purged_leave_one_day_out', 'purged_kfold'):
        assert fit[check]['brier_skill'] > 0
    assert fit['purged_kfold']['folds'] == tool.KFOLDS


def test_hinge_serving_gets_two_segments_at_the_knot():
    table = _table(days=60, names=60, knot=0.8, signal=3.0)
    serving = _hinge_serving(table)
    fit = tool.validate_fit(table, serving)
    knot = serving['curve']['knot']
    low, high = fit['segments']
    assert high['score_lo'] == knot and low['score_hi'] < knot <= high['score_hi']
    assert low['win_rate'] < high['win_rate']
    assert sum(s['n'] for s in fit['segments']) == 60 * 60
    for check in ('holdout', 'purged_leave_one_day_out', 'purged_kfold'):
        assert fit[check]['brier_skill'] > 0
    # Display lookup is the Worker's: the last segment whose score_lo the score passed.
    assert list(tool.predict(fit['segments'], [knot - 1e-9, knot])) == [low['win_rate'], high['win_rate']]


def test_honest_checks_refit_the_knot_on_training_days(monkeypatch):
    table = _table(days=40, names=30, knot=0.8, signal=3.0)
    serving = _hinge_serving(table)
    seen = []
    real = tool.segment_edges
    monkeypatch.setattr(tool, 'segment_edges', lambda s, t, days: seen.append(days) or real(s, t, days))
    tool.validate_fit(table, serving)
    trainings = [d for d in seen if d is not None]
    assert len(trainings) == 1 + 40 + tool.KFOLDS          # holdout, every LODO day, every fold
    assert all(len(d) < 40 for d in trainings)            # never the full OOF


def test_no_signal_has_no_skill():
    fit = tool.validate_fit(_table(signal=0.0, seed=9), STEP)
    assert fit['purged_leave_one_day_out']['brier_skill'] < 0.01


def test_build_table_refuses_a_serving_table_that_was_not_reproduced():
    payload = dict(serving_calibration=dict(payload_checksum='a' * 64, blocks=BLOCKS))
    with pytest.raises(ValueError, match='serving_not_reproduced'):
        tool.build_table(artifact_payload=payload, serving=dict(payload_checksum='b' * 64), table=_table(),
                         built_from_source_sha='0' * 40)


def test_plain_numbers_match_js_canonical_json():
    assert tool._plain(dict(a=2.0, b=0.00001, c=1.123456789012345, d=[True, 3])) == dict(a=2, b=0, c=1.123456789012, d=[True, 3])


def test_segment_bounds_near_zero_stay_apart_and_touching_segments_are_refused():
    # A knot inside (-1e-4, 1e-4): flushing bounds to 0 would make the Worker refuse the table.
    segments = [dict(score_lo=-1.9, score_hi=-0.00003, win_rate=0.4, n=5, days_weight=1.0),
                dict(score_lo=0.00002, score_hi=1.8, win_rate=0.6, n=5, days_weight=1.0)]
    plain = tool._plain(dict(segments=segments))['segments']
    assert [(s['score_lo'], s['score_hi']) for s in plain] == [(-1.9, -0.00003), (0.00002, 1.8)]
    tool.check_segments(plain)
    with pytest.raises(ValueError, match='segments_overlap'):
        tool.check_segments([segments[0], dict(segments[1], score_lo=-0.00003)])
    with pytest.raises(ValueError, match='segment_invalid'):
        tool.check_segments([dict(segments[0], win_rate=1.2)])


def test_committed_display_table_is_self_consistent():
    if not COMMITTED.exists():
        pytest.skip('no committed display table on this branch')
    body = json.loads(COMMITTED.read_text(encoding='utf-8'))
    assert body['table_sha256'] == tool.table_sha256(body)
    assert body['schema_version'] == tool.SCHEMA and body['purpose'] == 'display_only' and body['decision_effect'] == 'none'
    assert body['method'] in (tool.METHOD_STEP, tool.METHOD_HINGE)
    ident = body['identity']
    assert all(len(ident[k]) == 64 for k in ('ensemble_payload_checksum', 'serving_calibration_checksum',
                                              'source_calibration_checksum', 'oof_manifest_checksum'))
    lows = [s['score_lo'] for s in body['segments']]
    assert lows == sorted(lows) and all(0 < s['win_rate'] < 1 and s['n'] > 0 for s in body['segments'])
    assert all(math.isfinite(s['score_hi']) for s in body['segments'])
