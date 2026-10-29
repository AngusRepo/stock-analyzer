"""R33-NEW-15 switch packet and step order. Synthetic fixtures only; nothing is written."""
from copy import deepcopy
from datetime import datetime, timezone

import pytest

from services import r33_switch
from services.paired_nav_journal import digest
from services.paper_strategy_mode import MLP_MODE, R33_MODE
from test_r33_l4_equal7 import _calibration, _ensemble

NOW = datetime(2026, 11, 9, 8, tzinfo=timezone.utc)
OLD = {'schema_version': 'paired-nav-formal-ml-baseline-v1', 'artifact_id': 'active8-ensemble:old:0123',
       'cohort_id': 'old', 'payload_checksum': '1' * 64, 'base_artifact_set_checksum': '2' * 64}
RUNTIME_KEY = 'ml:active8:paper_runtime_approval:v1:r31-20261031'


def _merged():
    from services.l4_allocation_contract import inherited_sparse_controls
    config = {'position': {'maxPositions': 3}, 'fees': {'commission': .001, 'tax': .003}, 'ranking': {'enabled': True},
              'exit': {'hardStopPct': -.1}}
    constraints = {'exposure_cap': .9, 'name_cap': .3, 'min_weight': .03, 'max_positions': 3, 'buy_cost': .001,
                   'sell_cost': .004, **inherited_sparse_controls(config)}
    config['l4Distribution'] = {'scope': 'paper', 'operating_mode': MLP_MODE, 'strategy_role': 'B',
                                'artifact': {'model_checksum': 'o' * 64, 'l3_identity': OLD},
                                'constraints': constraints, 'sealedExecution': {'kept': True},
                                'opb': {'enabled': True, 'arms': [{'id': 'base', 'constraints': {}}],
                                        'approved_policy_identity': 'f0' * 32}}
    return config


def _bundle():
    from services.r33_isotonic_calibration import MODELS
    from services.r33_monthly_lifecycle import BUNDLE_SCHEMA, PROMOTION_DECISION
    return {'schema_version': BUNDLE_SCHEMA, 'status': 'sealed', 'cohort_id': 'c1', 'manifest_checksum': 'f' * 64,
            'knowledge_cutoff_date': '2026-11-02', 'full_fit_signal_date_max': '2026-10-26',
            'training_run_id': 'run-r33', 'promotion_decision': PROMOTION_DECISION,
            'artifacts': {m: {'artifact_id': f'{m}:c1', 'version': m + '-v1', 'checksum': 'sha256:' + 'a' * 64,
                              'artifact_path': f'gs://x/{m}', 'metadata_path': f'gs://x/{m}.json', 'state': 'offline_passed'}
                          for m in MODELS},
            'calibration': {'payload_checksum': '5' * 64},
            'oof_checks': {'path': 'r33/monthly_candidates/c1/oof_checks.json', 'checksum': 'c' * 64, 'status': 'pass',
                           'sealed_status': 'pass', 'pit_certified': True, 'pit_certification_sha256': '9' * 64}}


def _inputs():
    from services.active8_paper_admission import RUNTIME_SCHEMA
    merged = _merged()
    raw = {'exit': {'hardStopPct': -.1}, 'l4Distribution': deepcopy(merged['l4Distribution'])}
    configuration = {'trading_config': merged, 'risk_config': {'position': {'maxSingleNamePct': .1}},
                     'allocator_source_identity': {'l4_portfolio.py': 'a' * 64},
                     'l3_inference_source_identity': {'active8_paper_admission.py': 'b' * 64,
                                                      'active8_nav_adoption.py': 'c' * 64},
                     'native_execution_policy': {'schema_version': 'paired-nav-execution-policy-v1',
                                                 'execution_owner_version': 'native-paper-v1:' + 'd' * 64,
                                                 'variables': {'LIVE_EXECUTION_CLIENT_ENABLED': '0'}}}
    old_admission = {'approved_at': '2026-10-12T01:59:00Z', 'configuration': deepcopy(configuration),
                     'strategy_bundle': {'candidate_l3_identity': OLD}}
    prior = {'schema_version': RUNTIME_SCHEMA, 'admission': old_admission, 'configuration': deepcopy(configuration),
             'scope': 'paper', 'approved': True, 'maturity_transfer': False, 'efficacy_status': 'unproven',
             'source_reference': 'SYNTHETIC', 'approved_at': '2026-10-31T00:00:00Z'}
    prior['approval_checksum'] = digest(prior)
    return dict(raw_config=raw, merged_config=merged, prior=prior, old_admission=old_admission,
                pointer={**{k: OLD[k] for k in r33_switch.IDENTITY_KEYS}, 'promoted_at': 'x'}, current_plan_id='p' * 64,
                bundle=_bundle(), bundle_path='r33/monthly_candidates/c1/bundle.json', bundle_sha256='d' * 64,
                serving_table=_calibration(), training_label_known_max='2026-10-30',
                source_evidence={'evidence_files': {'tests.xml': 'e' * 64}},
                exit_rules={'swingHardStopPct': -.08, 'swingMaxHoldSessions': 20},
                business_date='2026-11-09', effective_signal_date='2026-11-10',
                wei_approval={'approved': True, 'scope': 'paper', 'approved_at': '2026-11-08T12:00:00Z',
                              'source_reference': 'SYNTHETIC TEST ONLY'},
                source_reference='SYNTHETIC TEST ONLY', approved_at='2026-11-08T14:00:00Z', runtime_key=RUNTIME_KEY,
                runtime_before=deepcopy(prior), archive_uri='gs://stockvision-models/r33/monthly_candidates/c1/bundle.json',
                meta_layer={'alpha_vote_models': ['LightGBM'], 'formal_layer3_slots': ['LightGBM']}, now=NOW)


def test_prepare_builds_a_cutover_that_serving_accepts():
    from services.r33_cutover import verify_serving
    inputs = _inputs()
    before = deepcopy(inputs)
    packet = r33_switch.prepare(**inputs)
    assert inputs == before
    assert packet['ensemble'] == _ensemble()
    approval, admission = packet['approval'], packet['admission']
    verify_serving(approval, admission, packet['ensemble'])
    evidence = approval['approved_r33_cutover']
    assert evidence['economics_change_scope'] == [
        'trading:config.l4Distribution.artifact', 'trading:config.l4Distribution.operating_mode',
        'trading:config.l4Distribution.opb.approved_policy_identity', 'trading:config.exit.swingHardStopPct',
        'trading:config.exit.swingMaxHoldSessions']
    assert evidence['first_night'] == {'supersedes_plan_policy_identity': 'f0' * 32, 'effective_signal_date': '2026-11-10'}
    policy = approval['configuration']['trading_config']['l4Distribution']
    assert policy['operating_mode'] == R33_MODE and policy['sealedExecution'] == {'kept': True}
    assert approval['configuration']['trading_config']['exit'] == {'hardStopPct': -.1, 'swingHardStopPct': -.08,
                                                                    'swingMaxHoldSessions': 20}
    raw = packet['writes']['kv-config']['after']
    assert raw['l4Distribution'] == policy and raw['exit']['swingMaxHoldSessions'] == 20
    assert set(raw) == set(inputs['raw_config'])
    row = packet['ensemble_row']
    assert row['knowledge_cutoff_date'] == '2026-10-26' and row['schema_version'] == 'active8-oof-ensemble-serving-artifact-v1'
    assert packet['roster']['matches'] is False
    assert packet['writes']['grant'] == {'key': RUNTIME_KEY, 'before': inputs['prior'], 'after': approval}


@pytest.mark.parametrize('fault', ['prior_not_live_config', 'prior_admission', 'pointer_moved', 'exit_rules_missing',
                                   'bundle_not_pass', 'pit', 'bundle_path', 'serving_table_source', 'label_after_signal',
                                   'raw_without_policy', 'constraints', 'raw_policy_differs'])
def test_prepare_fails_closed(fault):
    inputs = _inputs()
    edits = {
        'prior_not_live_config': lambda: inputs['merged_config']['fees'].update(tax=0),
        'prior_admission': lambda: inputs.update(old_admission={**inputs['old_admission'], 'approved_at': 'x'}),
        'pointer_moved': lambda: inputs['pointer'].update(payload_checksum='3' * 64),
        'exit_rules_missing': lambda: inputs['exit_rules'].pop('swingMaxHoldSessions'),
        'bundle_not_pass': lambda: inputs['bundle']['oof_checks'].update(status='fail'),
        'pit': lambda: inputs['bundle']['oof_checks'].update(pit_certified=False),
        'bundle_path': lambda: inputs.update(bundle_path='r33/monthly_candidates/c2/bundle.json'),
        'serving_table_source': lambda: inputs['bundle']['calibration'].update(payload_checksum='6' * 64),
        'label_after_signal': lambda: inputs.update(training_label_known_max='2026-11-09'),
        'raw_without_policy': lambda: inputs['raw_config'].pop('l4Distribution'),
        'constraints': lambda: inputs['merged_config']['l4Distribution']['constraints'].update(max_positions=4),
        'raw_policy_differs': lambda: inputs['raw_config']['l4Distribution'].update(scope='live'),
    }
    edits[fault]()
    with pytest.raises((RuntimeError, ValueError)):
        r33_switch.prepare(**inputs)


def _observed(packet, *, done=()):
    writes = packet['writes']
    observed = {w['key']: deepcopy(w['after'] if name in done else w['before']) for name, w in writes.items()}
    observed['r33_row'] = dict(packet['ensemble_row']) if 'r33-row' in done else None
    observed['pointer'] = ({k: packet['ensemble_row'][k] for k in r33_switch.IDENTITY_KEYS} if 'promotion' in done
                           else dict(packet['baseline_pointer']))
    return observed


def test_steps_run_strictly_in_order_and_roll_back_in_reverse():
    packet = r33_switch.prepare(**_inputs())
    for count in range(len(r33_switch.STEPS) + 1):
        done = r33_switch.STEPS[:count]
        step, states = r33_switch.next_step(packet, _observed(packet, done=done))
        assert step == (r33_switch.STEPS[count] if count < len(r33_switch.STEPS) else None)
        assert r33_switch.rollback_step(packet, _observed(packet, done=done))[0] == (done[-1] if done else None)
    # A later step done before an earlier one, or any foreign value, is drift.
    for observed in (_observed(packet, done=('admission',)), _observed(packet, done=('kv-config', 'r33-row'))):
        with pytest.raises(RuntimeError, match='live_state_drift'):
            r33_switch.next_step(packet, observed)
    foreign = _observed(packet)
    foreign['trading:config'] = {'other': True}
    with pytest.raises(RuntimeError, match='live_state_drift:kv-config=drift'):
        r33_switch.next_step(packet, foreign)
    changed_row = _observed(packet, done=r33_switch.STEPS[:4])
    changed_row['r33_row']['archive_uri'] = 'gs://elsewhere'
    with pytest.raises(RuntimeError, match='r33-row=drift'):
        r33_switch.next_step(packet, changed_row)


def test_roster_status_needs_the_r33_order_in_both_meta_fields():
    from services.alpha_model_roster import R33_MODELS
    order = list(R33_MODELS)
    assert r33_switch.roster_status({'alpha_vote_models': order, 'formal_layer3_slots': order})['matches'] is True
    assert r33_switch.roster_status({'alpha_vote_models': order, 'formal_layer3_slots': order[::-1]})['matches'] is False
    assert r33_switch.roster_status(None)['matches'] is False


def test_check_prior_requires_the_live_grant():
    inputs = _inputs()
    args = dict(merged_config=inputs['merged_config'], admission=inputs['old_admission'], pointer=inputs['pointer'])
    r33_switch.check_prior(inputs['prior'], live_prior=deepcopy(inputs['prior']), **args)
    with pytest.raises(RuntimeError, match='prior_not_active_grant'):
        r33_switch.check_prior(inputs['prior'], live_prior={**inputs['prior'], 'approved_at': 'later'}, **args)
