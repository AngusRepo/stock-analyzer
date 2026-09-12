"""Model isolation tests use synthetic predictions, never investment results."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
import sqlite3

import pytest

from services.paired_native_models import prediction_arms, model_context_fields, validate_model_frame
from services.paired_native_runtime import build_capture_source
from services.paired_nav_journal import digest
from services.native_paper_source_capture import ImmutableNativeObjects
from test_native_paper_source_capture import Bucket
from test_native_paper_sandbox import native_runner, base_state, checksum, read_state

NOW = datetime(2026, 9, 7, 2, tzinfo=timezone.utc)
FRAME = {'input_id': '2026-09-07:rescore', 'stage': 'rescore', 'observed_at': NOW.isoformat()}


def packet(owner='ensemble'):
    models = {arm: {'model_identity': {'artifact_id': arm + '-ensemble', 'artifact_checksum': key * 64,
                'cohort_id': arm + '-cohort'},
                'predictions': {'2330': {'signal_raw': 'BUY', 'direction_accuracy': confidence}}}
              for arm, key, confidence in [('baseline', 'b', .9), ('candidate', 'c', .3)]}
    common = models['baseline']['predictions']
    variables = {'ML_CONTROLLER_URL': 'https://controller.fixture', 'SHIOAJI_PROXY_URL': 'https://broker.fixture'}
    result = {'owner': owner, 'candidate_checksum': 'c' * 64, 'baseline_checksum': 'b' * 64,
        'model_predictions': common, 'model_predictions_checksum': digest(common),
        'model_prediction_arms': models, 'model_prediction_arms_checksum': digest(models),
        'variables': variables, 'source_context': {'variables': variables,
            'frozen_kv': {'ml:config.debate_max_rounds': '2'}},
        'configuration': {'trading_config': {'intraday': {}}}, 'session_date': '2026-09-07'}
    if owner == 'atomic_strategy':
        shared = models['baseline']['model_identity']
        result['configuration']['formal_baseline_identity'] = {'artifact_id': shared['artifact_id'],
            'payload_checksum': shared['artifact_checksum'], 'cohort_id': shared['cohort_id']}
        for arm, value in models.items():
            value['model_identity'] = deepcopy(shared)
            value['input_identity'] = {'schema_version': 'atomic-native-input-v1', 'arm': arm,
                'definition_checksum': result['candidate_checksum'], 'slate_checksum': digest(['slate', arm]),
                'serving_manifest_digest': 'e' * 64, 'prepared_input_checksum': 'f' * 64,
                'predictions_checksum': digest(value['predictions'])}
        result['model_prediction_arms_checksum'] = digest(models)
    return result


def request():
    return {'url': 'https://controller.fixture/intraday/rescore', 'method': 'POST',
        'body': json.dumps({'today': '2026-09-07', 'positions': [{'symbol': '2330', 'shares': 100,
            'entry_date': '2026-09-01', 'entry_price': 100, 'current_price': 100}]})}


def capture(p, objects, clock=lambda: NOW, transport=None, domain_queries=None):
    def forbidden(*args, **kwargs):
        raise AssertionError('Frozen inference must not use external network')
    return build_capture_source(snapshot_id='s' * 64, packet=p, objects=objects,
        domain_queries=domain_queries or {}, kv_read=lambda key: None,
        clock=clock, transport=transport or forbidden)


def outcome(record):
    return json.loads(record['response']['body'])['results'][0]


@pytest.mark.parametrize('owner', ['ensemble', 'atomic_strategy'])
def test_actual_rescore_uses_each_frozen_model_and_durable_retry_after_deadline(owner):
    original = packet(owner)
    before = deepcopy(original)
    objects = ImmutableNativeObjects(Bucket())
    first = capture(original, objects)
    a = first.for_arm('baseline').read('frozen_fetch', request(), FRAME)
    b = first.for_arm('candidate').read('frozen_fetch', request(), FRAME)
    assert outcome(a)['original_confidence'] == .9 and outcome(a)['action'] == 'HOLD'
    assert outcome(b)['original_confidence'] == .3 and outcome(b)['action'] == 'EXIT'
    assert a['identity'] != b['identity']
    assert a['identity']['source_context']['model_identity']['artifact_checksum'] == 'b' * 64
    assert b['identity']['source_context']['model_identity'] == original['model_prediction_arms']['candidate']['model_identity']
    second = capture(original, objects, clock=lambda: NOW + timedelta(days=2))
    assert second.for_arm('baseline').read('frozen_fetch', request(), FRAME) == a
    assert second.for_arm('candidate').read('frozen_fetch', request(), FRAME) == b
    assert original == before
    with pytest.raises(ValueError, match='rescore_arm_required'):
        first.read('frozen_fetch', request(), FRAME)
    with pytest.raises(ValueError, match='unknown_model_arm'):
        first.for_arm('production')


@pytest.mark.parametrize('owner', ['ensemble', 'atomic_strategy'])
def test_identical_market_request_is_shared_even_though_ml_models_differ(owner):
    calls = []
    class Response:
        status_code, text, headers = 200, '{"close":100}', {}
    def transport(*args, **kwargs):
        calls.append(args)
        return Response()
    source = capture(packet(owner), ImmutableNativeObjects(Bucket()), transport=transport)
    quote = {'url': 'https://broker.fixture/quote/2330', 'method': 'GET', 'body': ''}
    a = source.for_arm('baseline').read('frozen_fetch', quote, FRAME)
    b = source.for_arm('candidate').read('frozen_fetch', quote, FRAME)
    assert a == b and len(calls) == 1


def test_equal_predictions_still_bind_distinct_artifacts():
    p = packet()
    p['model_prediction_arms']['candidate']['predictions'] = deepcopy(p['model_predictions'])
    p['model_prediction_arms_checksum'] = digest(p['model_prediction_arms'])
    source = capture(p, ImmutableNativeObjects(Bucket()))
    a = source.for_arm('baseline').read('frozen_fetch', request(), FRAME)
    b = source.for_arm('candidate').read('frozen_fetch', request(), FRAME)
    assert a['response'] == b['response']
    assert a['identity'] != b['identity']


@pytest.mark.parametrize('mutation,reason', [
    (lambda p: p.pop('model_prediction_arms'), 'arm_predictions_required'),
    (lambda p: p['model_prediction_arms'].pop('candidate'), 'model_arms_invalid'),
    (lambda p: p.update(model_prediction_arms_checksum='wrong'), 'model_arms_invalid'),
    (lambda p: p.update(owner='l4_alpha_ev'), 'model_arms_invalid'),
    (lambda p: p.update(candidate_checksum='d' * 64), 'arm_identity_mismatch'),
])
def test_missing_or_mislabeled_arm_cannot_fall_back_to_incumbent(mutation, reason):
    p = packet()
    mutation(p)
    with pytest.raises(ValueError, match=reason):
        prediction_arms(p)


@pytest.mark.parametrize('confidence', [None, True, -.1, 1.1, '0.3'])
def test_model_comparison_does_not_fabricate_half_confidence_for_bad_evidence(confidence):
    p = packet()
    p['model_prediction_arms']['candidate']['predictions']['2330']['direction_accuracy'] = confidence
    p['model_prediction_arms_checksum'] = digest(p['model_prediction_arms'])
    source = capture(p, ImmutableNativeObjects(Bucket()))
    with pytest.raises(ValueError, match='arm_prediction_invalid'):
        source.for_arm('candidate').read('frozen_fetch', request(), FRAME)


def test_zero_is_a_real_confidence_not_a_missing_half_confidence():
    p = packet()
    p['model_prediction_arms']['candidate']['predictions']['2330']['direction_accuracy'] = 0.
    p['model_prediction_arms_checksum'] = digest(p['model_prediction_arms'])
    result = capture(p, ImmutableNativeObjects(Bucket())).for_arm('candidate').read('frozen_fetch', request(), FRAME)
    assert outcome(result)['original_confidence'] == 0
    assert outcome(result)['action'] == 'EXIT'


def test_parent_must_bind_the_complete_model_pair_before_execution():
    p = packet()
    result = model_context_fields(p, p)
    assert result['model_prediction_arms'] == p['model_prediction_arms']
    with pytest.raises(ValueError, match='model_arms_parent_mismatch'):
        model_context_fields(p, {**p, 'model_prediction_arms_checksum': 'wrong'})
    p.pop('model_prediction_arms')
    with pytest.raises(ValueError, match='model_arms_parent_missing'):
        model_context_fields(p, p)


def test_ev_only_legacy_pair_keeps_shared_ml_and_cannot_gain_a_second_model():
    p = packet()
    p['owner'] = 'l4_alpha_ev'
    p.pop('model_prediction_arms')
    p.pop('model_prediction_arms_checksum')
    arms = prediction_arms(p)
    assert arms['baseline'] == arms['candidate']
    source = capture(p, ImmutableNativeObjects(Bucket()))
    assert outcome(source.read('frozen_fetch', request(), FRAME))['original_confidence'] == .9


@pytest.mark.parametrize('owner', ['ensemble', 'atomic_strategy'])
def test_actual_worker_native_rescore_writes_only_the_correct_arms_private_warning_and_replays(native_runner, owner):
    from services.native_paper_sandbox import run_native_paper_frames
    from services.paired_native_runtime import KV_READ_POLICY
    p = packet(owner)
    p['configuration']['trading_config']['intraday']['rescoreEnabled'] = True
    raw = base_state()
    with sqlite3.connect(':memory:') as db:
        db.executescript(raw)
        db.execute("INSERT INTO paper_positions(account_id,symbol,name,shares,avg_cost,entry_price,entry_date) VALUES(2,'2330','fixture',100,100,100,'2026-09-01')")
        db.execute("INSERT INTO _native_private_kv VALUES('trading:config',?,NULL,NULL)",
            [json.dumps(p['configuration']['trading_config'])])
        raw = '\n'.join(db.iterdump())
    market_calls = []
    class Response:
        status_code, headers = 200, {}
        text = json.dumps({'data': {'2330': {'last': 100, 'close': 100, 'source_time': NOW.isoformat(),
            'quote_age_ms': 0, 'source_age_ms': 0, 'total_volume': 100000}}})
    def transport(method, url, **kwargs):
        assert url.startswith('https://broker.fixture/')
        market_calls.append(url)
        return Response()
    objects = ImmutableNativeObjects(Bucket())
    source = capture(p, objects, transport=transport)
    frame = {**FRAME, 'cron': '0 2 * * 1-5'}
    input_frame = {**frame, 'capture_kv_reads': True, 'kv_read_policy': KV_READ_POLICY}
    outputs = {}
    for arm in ('baseline', 'candidate'):
        outputs[arm] = run_native_paper_frames(state_sql=raw, state_checksum=checksum(raw),
            account_id=2, variables=p['variables'], frames=[frame], frame_inputs={frame['input_id']: input_frame},
            runner=native_runner, capture_source=source.for_arm(arm))
        validate_model_frame(p, arm, outputs[arm]['captured_inputs'][frame['input_id']])
        # Restart using only the exact captured inputs, with no model/network reader.
        replay = run_native_paper_frames(state_sql=raw, state_checksum=checksum(raw),
            account_id=2, variables=p['variables'], frames=[frame],
            frame_inputs=outputs[arm]['captured_inputs'], runner=native_runner)
        assert replay['state_checksum'] == outputs[arm]['state_checksum']
    with read_state(outputs['baseline']) as db:
        assert db.execute("SELECT value FROM _native_private_kv WHERE key='intraday:warn:2330:2026-09-07'").fetchone() is None
    with read_state(outputs['candidate']) as db:
        row = db.execute("SELECT value FROM _native_private_kv WHERE key='intraday:warn:2330:2026-09-07'").fetchone()
        warning = json.loads(row[0])
        assert warning['last_action'] == 'EXIT'
        assert warning['last_conf'] == .3 and warning['execution_policy'] == 'observe_only'
    assert outputs['baseline']['state_checksum'] != outputs['candidate']['state_checksum']
    assert set(market_calls) == {'https://broker.fixture/orderbooks', 'https://broker.fixture/snapshots'}
    assert len(market_calls) == len(set(market_calls))  # Each distinct market read is shared once.
    # This real consumer is observe-only. Do not mislabel a warning as a fill or NAV gain.
    assert all(out['frames'][0]['result']['orders'] == [] for out in outputs.values())


@pytest.mark.parametrize('owner', ['ensemble', 'atomic_strategy'])
def test_swapped_or_relabelled_other_model_result_cannot_pass_replay_reconciliation(owner):
    p = packet(owner)
    source = capture(p, ImmutableNativeObjects(Bucket()))
    a = source.for_arm('baseline').read('frozen_fetch', request(), FRAME)
    b = source.for_arm('candidate').read('frozen_fetch', request(), FRAME)
    validate_model_frame(p, 'baseline', {**FRAME, 'responses': [a]})
    validate_model_frame(p, 'candidate', {**FRAME, 'responses': [b]})
    with pytest.raises(ValueError, match='transcript_identity_mismatch'):
        validate_model_frame(p, 'candidate', {**FRAME, 'responses': [a]})
    # Even coherent relabelling cannot convert the incumbent's .9/HOLD into
    # the candidate's .3/EXIT: replay recomputes from sealed candidate inputs.
    forged = {**deepcopy(a), 'identity': deepcopy(b['identity'])}
    with pytest.raises(ValueError, match='transcript_result_mismatch'):
        validate_model_frame(p, 'candidate', {**FRAME, 'responses': [forged]})


@pytest.mark.parametrize('owner', ['ensemble', 'atomic_strategy'])
def test_real_native_registration_freezes_both_model_identities(native_runner, owner):
    from services.paired_native_registration import register_allocation_pair
    from services.paired_nav_journal import freeze_snapshot, read_snapshot
    from services.native_paper_sandbox import native_runtime_manifest
    from test_paired_native_registration import calendar, NOW as REGISTER_AT
    from test_native_paper_bootstrap import fixture as source_fixture
    from test_native_paper_state import fixture as state_fixture
    from test_paired_nav_journal import DB
    source_db, query_source = source_fixture()
    try:
        db, p = DB(legacy_assessments=False), packet(owner)
        parent = freeze_snapshot(signal_date='2026-09-07', source_run_id='l3-models',
            snapshot_kind='allocation_context', content={key: p[key] for key in ('model_predictions', 'model_prediction_arms')},
            query=db.query, writer=db.writer, now=REGISTER_AT)
        config = {'trading_config': {'fees': {'commission': .001425, 'minCommission': 20,
            'tax': .003, 'dayTradeTax': .0015}}, 'risk_config': {'system': {'killSwitch': True}}}
        if owner == 'atomic_strategy':
            config['formal_baseline_identity'] = p['configuration']['formal_baseline_identity']
        allocation = {key: p[key] for key in ('owner', 'candidate_checksum', 'baseline_checksum',
            'model_predictions_checksum', 'model_prediction_arms_checksum')}
        allocation.update(pair_id='l3-registration', configuration=config, configuration_checksum=digest(config),
            allocation_context_snapshot_id=parent['snapshot_id'],
            **{arm: {'recommendations': state_fixture()['recommendations']} for arm in ('baseline', 'candidate')})
        seal = freeze_snapshot(signal_date='2026-09-07', source_run_id=allocation['pair_id'],
            snapshot_kind='allocation_pair', content=allocation, query=db.query, writer=db.writer, now=REGISTER_AT)
        objects = ImmutableNativeObjects(Bucket())
        domains = set(native_runtime_manifest(native_runner)['tables'].values())
        args = dict(snapshot_id=seal['snapshot_id'], query=db.query, writer=db.writer, objects=objects,
            domain_queries={d: query_source for d in domains}, kv_read=calendar, account_id=1,
            variables={}, kv_read_policy={'source': ['holiday:'], 'private': ['paper:']},
            runner=native_runner, now=REGISTER_AT)
        if owner == 'atomic_strategy':
            # A legacy hand-built model packet is no longer a complete Atomic
            # allocation source. The real canonical-parent path has its own test.
            with pytest.raises(ValueError, match='atomic_comparison_root_missing'):
                register_allocation_pair(**args)
            return
        result = register_allocation_pair(**args)
        registered = read_snapshot(db.query, result['snapshot_id'])['payload']['content']
        assert registered['model_prediction_arms'] == p['model_prediction_arms']
        assert registered['model_prediction_arms_checksum'] == p['model_prediction_arms_checksum']
        assert registered['session_date'] == '2026-09-08'
        assert register_allocation_pair(**{**args, 'domain_queries': {}}) == result
    finally:
        source_db.close()


@pytest.mark.parametrize('fault', ['missing_arms', 'wrong_model', 'wrong_definition', 'wrong_arm',
    'wrong_prediction', 'mixed_manifest', 'mixed_prepared', 'missing_slate'])
def test_atomic_model_and_input_identities_cannot_be_interchanged(fault):
    p = packet('atomic_strategy')
    candidate = p['model_prediction_arms']['candidate']
    if fault == 'missing_arms': p.pop('model_prediction_arms')
    if fault == 'wrong_model': candidate['model_identity']['artifact_checksum'] = 'c' * 64
    if fault == 'wrong_definition': candidate['input_identity']['definition_checksum'] = 'd' * 64
    if fault == 'wrong_arm': candidate['input_identity']['arm'] = 'baseline'
    if fault == 'wrong_prediction': candidate['predictions']['2330']['direction_accuracy'] = .9
    if fault == 'mixed_manifest': candidate['input_identity']['serving_manifest_digest'] = 'd' * 64
    if fault == 'mixed_prepared': candidate['input_identity']['prepared_input_checksum'] = 'd' * 64
    if fault == 'missing_slate': candidate['input_identity'].pop('slate_checksum')
    if 'model_prediction_arms' in p:
        p['model_prediction_arms_checksum'] = digest(p['model_prediction_arms'])
    with pytest.raises(ValueError): prediction_arms(p)


def test_atomic_same_model_same_output_still_records_distinct_slate_and_empty_is_not_formal():
    p = packet('atomic_strategy')
    candidate = p['model_prediction_arms']['candidate']
    candidate['predictions'] = deepcopy(p['model_predictions'])
    candidate['input_identity']['predictions_checksum'] = digest(candidate['predictions'])
    p['model_prediction_arms_checksum'] = digest(p['model_prediction_arms'])
    source = capture(p, ImmutableNativeObjects(Bucket()))
    a = source.for_arm('baseline').read('frozen_fetch', request(), FRAME)
    b = source.for_arm('candidate').read('frozen_fetch', request(), FRAME)
    assert a['response'] == b['response'] and a['identity'] != b['identity']
    assert a['identity']['source_context']['model_identity'] == b['identity']['source_context']['model_identity']
    candidate['predictions'] = {}
    candidate['input_identity']['predictions_checksum'] = digest({})
    p['model_prediction_arms_checksum'] = digest(p['model_prediction_arms'])
    assert prediction_arms(p)['candidate']['predictions'] == {}
    with pytest.raises(ValueError, match='arm_prediction_missing'):
        capture(p, ImmutableNativeObjects(Bucket())).for_arm('candidate').read('frozen_fetch', request(), FRAME)


def test_atomic_daily_predictions_advance_without_replacing_model_or_strategy():
    from services.paired_native_models import validate_prediction_carry
    previous = packet('atomic_strategy')
    current = deepcopy(previous)
    current['model_prediction_arms']['candidate']['predictions'] = {'1101': {'signal_raw': 'BUY', 'direction_accuracy': .8}}
    for arm, value in current['model_prediction_arms'].items():
        value['input_identity'].update(slate_checksum=digest(['next', arm]), prepared_input_checksum='a' * 64,
            predictions_checksum=digest(value['predictions']))
    current['model_prediction_arms_checksum'] = digest(current['model_prediction_arms'])
    validate_prediction_carry(previous, current)
    changed = deepcopy(current)
    changed['configuration']['formal_baseline_identity']['payload_checksum'] = 'd' * 64
    for value in changed['model_prediction_arms'].values(): value['model_identity']['artifact_checksum'] = 'd' * 64
    changed['model_prediction_arms_checksum'] = digest(changed['model_prediction_arms'])
    with pytest.raises(ValueError, match='carry_model_identity_changed'): validate_prediction_carry(previous, changed)
    changed = deepcopy(current)
    changed['candidate_checksum'] = 'd' * 64
    for value in changed['model_prediction_arms'].values(): value['input_identity']['definition_checksum'] = 'd' * 64
    changed['model_prediction_arms_checksum'] = digest(changed['model_prediction_arms'])
    with pytest.raises(ValueError, match='carry_atomic_definition_changed'): validate_prediction_carry(previous, changed)
    with pytest.raises(ValueError, match='carry_model_owner_changed'): validate_prediction_carry(previous, packet())
