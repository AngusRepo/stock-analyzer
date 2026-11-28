"""F-B cutover warm start: fold-OOF scores only from the fold that tests the day, a past-only
purged hinge, the frozen day's own L2 run and holdings, and an artifact that keeps the
training-after-signal guard true."""
from copy import deepcopy

import numpy as np
import pytest

from services import l4_opb_cutover_warm_start as warm
from services.r33_crossfit_serving import fit_hinge, hinge_value
from services.r33_ensemble import EVIDENCE_KEY
from services.r33_isotonic_calibration import MODELS, pool_scores
from services.r33_rank_pool import validate_rank_pool
from test_r33_rank_pool import IDENTITY, _book, _ensemble

DAY = '2026-11-09'


def _table(days=40, n=12, horizon=5, seed=3):
    rng = np.random.default_rng(seed)
    calendar = [f'2026-{9 + i // 28:02d}-{1 + i % 28:02d}' for i in range(days + horizon)]
    score, excess, weight, day_rows = [], [], [], {}
    for i, day in enumerate(calendar[:days]):
        s = rng.normal(size=n)
        e = 0.004 * np.maximum(s, 0) + rng.normal(scale=.01, size=n)
        day_rows[day] = np.arange(len(score), len(score) + n)
        score += list(s); excess += list(e - e.mean()); weight += [1. / n] * n
    return {'score': np.asarray(score), 'excess': np.asarray(excess), 'weight': np.asarray(weight),
            'day_rows': day_rows, 'horizon': horizon, 'calendar_index': {d: i for i, d in enumerate(calendar)}}


def test_fold_scores_come_only_from_the_fold_that_tests_the_day():
    windows = {'w1': {'train_end': '2026-09-20', 'test_start': '2026-10-01', 'test_end': '2026-10-31'},
               'w2': {'train_end': '2026-10-24', 'test_start': '2026-11-01', 'test_end': '2026-11-30'},
               'bad': {'train_end': '2026-11-20', 'test_start': '2026-11-01', 'test_end': '2026-11-30'}}
    rows = [{'prediction_date': DAY, 'symbol': '3000', 'model_name': m, 'raw_score': .1 * i, 'fold_id': 'w2'}
            for i, m in enumerate(MODELS)]
    rows.append({'prediction_date': '2026-10-15', 'symbol': '3000', 'model_name': MODELS[0], 'raw_score': 9., 'fold_id': 'w1'})
    scores = warm.fold_scores(rows, DAY, windows, MODELS)
    assert scores == {'3000': {m: pytest.approx(.1 * i) for i, m in enumerate(MODELS)}}
    with pytest.raises(ValueError, match='fold_not_out_of_sample'):
        warm.fold_scores(rows + [dict(rows[0], fold_id='w1')], DAY, windows, MODELS)
    with pytest.raises(ValueError, match='fold_not_out_of_sample'):
        warm.fold_scores([dict(rows[0], fold_id='bad')], DAY, windows, MODELS)


def test_fold_labels_must_be_known_before_the_day():
    table = _table()
    calendar = sorted(table['calendar_index'], key=table['calendar_index'].get)
    day = calendar[30]
    ok = {'f': {'train_end': calendar[30 - table['horizon'] - 1], 'test_start': day, 'test_end': day}}
    warm.fold_trained_before(ok, ['f'], day, table)
    holiday = {'f': {'train_end': calendar[30 - table['horizon'] - 1] + 'x', 'test_start': day, 'test_end': day}}
    warm.fold_trained_before(holiday, ['f'], day, table)     # a non-session train end maps to the prior session
    late = {'f': {'train_end': calendar[30 - table['horizon']], 'test_start': day, 'test_end': day}}
    with pytest.raises(ValueError, match='fold_labels_not_before_day'):
        warm.fold_trained_before(late, ['f'], day, table)


def test_past_only_hinge_never_sees_labels_known_on_or_after_the_day():
    table = _table()
    days = sorted(table['day_rows'])
    day = days[30]
    curve, receipt = warm.past_only_curve(table, day)
    index = table['calendar_index']
    assert index[receipt['train_last']] + table['horizon'] < index[day]
    assert receipt['label_known_date'] < day
    # Perturbing every label that is not yet known on `day` leaves the curve unchanged.
    late = deepcopy(table)
    for d in days:
        if index[d] + table['horizon'] >= index[day]:
            late['excess'][late['day_rows'][d]] += 1.
    assert warm.past_only_curve(late, day)[0] == curve
    with pytest.raises(ValueError, match='outside_oof_calendar'):
        warm.past_only_curve(table, '2027-01-01')


def _pool(symbols, run='run-1', sha='p' * 64):
    from services.r33_calibration_job import POOL_SOURCE
    return symbols, {'source': POOL_SOURCE, 'signal_date': DAY, 'screener_run_id': run, 'membership_sha256': sha}


def _curve():
    return fit_hinge(_table(), sorted(_table()['day_rows'])[:20])[0]


def test_warm_rank_pool_scores_like_serving_with_the_past_only_hinge():
    symbols, raws = _book()
    curve = _curve()
    snapshot, evidence = warm.warm_rank_pool(day=DAY, scores=raws, pool=_pool(symbols), holdings=[symbols[0]],
                                             ensemble=_ensemble(), l3_identity=IDENTITY, curve=curve,
                                             ehat_receipt={'estimator': warm.EHAT_SOURCE})
    raw = np.array([[raws[s][m] for m in MODELS] for s in symbols])
    score, z, _ = pool_scores(raw, np.isfinite(raw), variant='mean_z')
    for i, s in enumerate(symbols):
        assert evidence[s]['score'] == pytest.approx(score[i])
        assert evidence[s]['expected_excess'] == pytest.approx(float(hinge_value(curve, score[i:i + 1])[0]))
    assert evidence[symbols[0]]['held'] is True
    assert snapshot['warm_start']['score_source'] == 'fold_oof'
    assert validate_rank_pool(snapshot) is snapshot


def _override(symbols, raws, **pool):
    return warm.frozen_override(day=DAY, scores=raws, pool=_pool(symbols, **pool), ensemble=_ensemble(),
                                l3_identity={**IDENTITY, 'cohort_id': 'c1'}, curve=_curve(),
                                ehat_receipt={'estimator': warm.EHAT_SOURCE})


def test_override_keeps_the_frozen_l2_run_and_rebinds_evidence():
    symbols, raws = _book()
    runtime = {'signal_date': DAY, 'l3_identity': {'cohort_id': 'old'},
               'r33_rank_pool': {'screener_run_id': 'run-1', 'pool_membership_sha256': 'p' * 64},
               'account': {'holdings': [{'symbol': '9999'}]},
               'predictions': {symbols[1]: {'kept': 1, EVIDENCE_KEY: {'old': True}}, '9999': {EVIDENCE_KEY: {'old': 1}}}}
    out, recommendations = _override(symbols, raws)(deepcopy(runtime), [{'symbol': symbols[1]}])
    assert recommendations == [{'symbol': symbols[1]}]
    assert out['l3_identity']['cohort_id'] == 'c1'
    assert out['predictions'][symbols[1]]['kept'] == 1
    assert out['predictions'][symbols[1]][EVIDENCE_KEY]['schema_version'] == 'r33-rank-evidence-v1'
    assert out['predictions']['9999'][EVIDENCE_KEY]['unscored_reason'] == 'fold_oof_missing'
    validate_rank_pool(out['r33_rank_pool'], out['predictions'])
    with pytest.raises(ValueError, match='l2_pool_mismatch'):
        _override(symbols, raws, run='run-2')(deepcopy(runtime), [])
    with pytest.raises(ValueError, match='l2_pool_mismatch'):
        _override(symbols, raws)({**deepcopy(runtime), 'signal_date': '2026-11-10'}, [])


def test_warm_artifact_keeps_the_model_checksum_and_the_label_guard():
    bundle = {'model_checksum': 'm' * 64, 'training_label_known_max': '2026-11-20', 'model': {}}
    out = warm.warm_artifact(bundle, day=DAY, label_known_max='2026-11-06')
    assert out['model_checksum'] == bundle['model_checksum'] and out['training_label_known_max'] == '2026-11-06'
    with pytest.raises(ValueError, match='labels_not_before_day'):
        warm.warm_artifact(bundle, day=DAY, label_known_max=DAY)


def test_replay_admits_an_artifact_override_only_with_a_warm_start_override(monkeypatch):
    from test_l4_opb_v3_replay import LIVE, Learning, Market, Paper, Runs, WEIGHTS
    from services import l4_opb_arm_replay as replay
    from services.paired_nav_collection import allocator_source_identity
    runtime = {'signal_date': '2026-10-01', 'l3_identity': {'source': 'fixed'},
               'account': {'fees': {'buy_cost': .001, 'sell_cost': .004},
                           'risk_limits': {'exposure_cap': .45, 'name_cap': .125, 'buys_halted': False}}}
    content = {'allocator_source_identity': allocator_source_identity(),
               'inputs': {'alpha_policy': {'l4Distribution': {**deepcopy(LIVE), 'runtime': runtime}},
                          'return_history': {'lookback': 252}, 'recommendations': [{'symbol': 'A'}]}}
    monkeypatch.setattr('services.paired_nav_journal.read_snapshot', lambda query, snapshot_id:
        {'manifest': {'frozen_at': '2026-10-02T00:30:00Z'}, 'payload': {'content': deepcopy(content)}})
    stored = {'execution_scope': 'paper', 'l3_identity': {'source': 'fixed'}, 'opb': {'arm_id': 'base'},
              'weights': dict(WEIGHTS['base'])}
    kwargs = dict(live=deepcopy(LIVE), signal_date='2026-10-01', business_date='2026-10-09', paper=Paper(stored),
                  learning=Learning(), market=Market(), run=Runs())
    with pytest.raises(ValueError, match='artifact_override_invalid'):
        replay.replay_day_v3(**kwargs, artifact=deepcopy(LIVE['artifact']))
    with pytest.raises(ValueError, match='artifact_override_invalid'):
        replay.replay_day_v3(**kwargs, frozen_override=lambda r, c: (r, c),
                             artifact={**LIVE['artifact'], 'model_checksum': 'b' * 64})


def _tool():
    import importlib.util
    from pathlib import Path
    path = Path(__file__).resolve().parents[2] / 'tools' / 'opb_cutover_warm_start.py'
    spec = importlib.util.spec_from_file_location('opb_cutover_warm_start_tool', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_warm_start_write_waits_for_every_pending_allocator_source_change():
    """Warm rows live in the context of the deployed allocator sources; a later source deploy orphans them."""
    import json
    tool = _tool()
    paths = tool.allocator_source_paths()
    assert 'ml-controller/services/recommendation_service.py' in paths and len(paths) > 40
    assert 'ml-controller/services/allocator_source_equivalence.json' in paths

    def runner(diff='', prs=()):
        def run(cmd):
            if cmd[:1] == ['gh']:
                return json.dumps(list(prs))
            return diff if 'diff' in cmd else ''
        return run

    with pytest.raises(SystemExit, match='deploy them, then warm start'):
        tool.source_batch_guard(ack_prs='', run=runner(diff='ml-controller/services/recommendation_service.py\n'))
    touching = [{'number': 330, 'files': [{'path': 'ml-controller/services/recommendation_service.py'}]},
                {'number': 331, 'files': [{'path': 'frontend/src/App.tsx'}]}]
    with pytest.raises(SystemExit, match=r'\[330\]'):
        tool.source_batch_guard(ack_prs='', run=runner(prs=touching))
    assert tool.source_batch_guard(ack_prs='330', run=runner(prs=touching))['open_source_prs'] == [330]
    assert tool.source_batch_guard(ack_prs='', run=runner())['open_source_prs'] == []
    # A re-issued equivalence certificate moves the context like a source change does.
    with pytest.raises(SystemExit, match='allocator_source_equivalence.json'):
        tool.source_batch_guard(ack_prs='', run=runner(diff='ml-controller/services/allocator_source_equivalence.json\n'))
    certificate_pr = [{'number': 332, 'files': [{'path': 'ml-controller/services/allocator_source_equivalence.json'}]}]
    with pytest.raises(SystemExit, match=r'\[332\]'):
        tool.source_batch_guard(ack_prs='', run=runner(prs=certificate_pr))


def test_guard_covers_every_file_the_context_identity_reads(monkeypatch):
    """Any file allocator_source_identity() opens (sources or certificates) is watched by the guard."""
    from pathlib import Path
    from services.paired_nav_collection import allocator_source_identity
    tool = _tool()
    services = Path(__file__).resolve().parents[1] / 'services'
    opened = set()
    for name in ('read_text', 'read_bytes'):
        original = getattr(Path, name)

        def spy(self, *args, _original=original, **kwargs):
            resolved = Path(self).resolve()
            if resolved.parent == services:
                opened.add('ml-controller/services/' + resolved.name)
            return _original(self, *args, **kwargs)
        monkeypatch.setattr(Path, name, spy)
    allocator_source_identity()
    assert 'ml-controller/services/allocator_source_equivalence.json' in opened
    assert opened <= set(tool.allocator_source_paths()), sorted(opened - set(tool.allocator_source_paths()))


def test_warm_start_write_needs_the_dry_run_context(monkeypatch, tmp_path):
    tool = _tool()
    monkeypatch.setattr('subprocess.run', lambda cmd, **kw: type('R', (), {'stdout': 'abc' if 'rev-parse' in cmd else ''})())
    with pytest.raises(SystemExit, match='--expect-context'):
        tool.main(['--switch-packet', 'p', '--bundle', 'b', '--cutover-signal-date', '2026-12-05',
                   '--write', '--deployed-sha', 'abc'])
