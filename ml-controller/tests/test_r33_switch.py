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


def _sanity(table, fees, **changes):
    """A passing B-1 result for exactly this table at the granted round trip (synthetic)."""
    from services.r33_crossfit_serving import SANITY_SCHEMA
    from services.r33_ensemble import round_trip_cost
    return {'schema_version': SANITY_SCHEMA, 'passed': True, 'reasons': [], 'round_trip_cost': round_trip_cost(fees),
            'serving_table_checksum': table['payload_checksum'], 'in_sample': True, **changes}


def _oof_checks_report(schema=None, gates=('crossfit_above_cost', 'net_of_cost')):
    """The parsed sealed v3 OOF checks receipt (check_oof_checks_report verified its bytes)."""
    from services.r33_oof_checks import SCHEMA
    return {'result': {'schema_version': schema or SCHEMA, 'checks': {'inversion': {'gates': dict.fromkeys(gates, True)}}},
            'gate_cost': {'round_trip_cost': 0.00585}}


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
                serving_sanity=_sanity(_calibration(), merged['fees']), oof_checks_report=_oof_checks_report(), now=NOW)


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
    assert packet['roster'] == {'model_order': list(_ensemble()['model_order']), 'source': 'sealed_bundle_serving_table'}
    assert packet['serving_sanity'] == inputs['serving_sanity']
    from services.r33_oof_checks import SCHEMA as OOF_CHECKS_SCHEMA
    assert packet['oof_checks'] == {'schema_version': OOF_CHECKS_SCHEMA, 'checksum': 'c' * 64,
                                    'gates': ['crossfit_above_cost', 'net_of_cost']}
    assert any('l3_identity_changed' in line for line in packet['expected_after_cutover'])
    assert packet['writes']['grant'] == {'key': RUNTIME_KEY, 'before': inputs['prior'], 'after': approval}


@pytest.mark.parametrize('fault', ['prior_not_live_config', 'prior_admission', 'pointer_moved', 'exit_rules_missing',
                                   'bundle_not_pass', 'pit', 'bundle_path', 'serving_table_source', 'label_after_signal',
                                   'raw_without_policy', 'constraints', 'raw_policy_differs', 'sanity_failed',
                                   'sanity_other_table', 'sanity_other_cost', 'sanity_missing', 'oof_checks_v2',
                                   'oof_checks_gate_missing', 'oof_checks_missing'])
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
        'sanity_failed': lambda: inputs['serving_sanity'].update(passed=False, reasons=['top_block_not_above_cost']),
        'sanity_other_table': lambda: inputs['serving_sanity'].update(serving_table_checksum='0' * 64),
        'sanity_other_cost': lambda: inputs['serving_sanity'].update(round_trip_cost=0.0018),
        'sanity_missing': lambda: inputs.update(serving_sanity=None),
        'oof_checks_v2': lambda: inputs.update(oof_checks_report=_oof_checks_report('r33-oof-checks-v2')),
        'oof_checks_gate_missing': lambda: inputs.update(oof_checks_report=_oof_checks_report(gates=('crossfit_above_cost',))),
        'oof_checks_missing': lambda: inputs.update(oof_checks_report={}),
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


def test_the_roster_echo_is_not_read_and_a_failed_sanity_in_the_packet_is_refused():
    """Q7 A: the cutover never reads ml:adaptive_params; B-1 is re-checked at every activation."""
    import inspect
    assert 'meta_layer' not in inspect.signature(r33_switch.prepare).parameters
    assert not hasattr(r33_switch, 'roster_status')
    packet = r33_switch.prepare(**_inputs())
    packet['serving_sanity'] = {**packet['serving_sanity'], 'passed': False, 'reasons': ['net_of_cost_lower_bound_not_positive']}
    packet['packet_checksum'] = digest({k: v for k, v in packet.items() if k != 'packet_checksum'})
    with pytest.raises(RuntimeError, match='serving_curve_sanity_failed:net_of_cost_lower_bound_not_positive'):
        r33_switch.validate_packet(packet, now=NOW)


def test_check_prior_requires_the_live_grant():
    inputs = _inputs()
    args = dict(merged_config=inputs['merged_config'], admission=inputs['old_admission'], pointer=inputs['pointer'])
    r33_switch.check_prior(inputs['prior'], live_prior=deepcopy(inputs['prior']), **args)
    with pytest.raises(RuntimeError, match='prior_not_active_grant'):
        r33_switch.check_prior(inputs['prior'], live_prior={**inputs['prior'], 'approved_at': 'later'}, **args)


def _reapprove(packet, edit):
    approval = packet['approval']
    edit(approval)
    approval.pop('approval_checksum')
    approval['approval_checksum'] = digest(approval)
    packet['writes']['grant']['after'] = approval


RESEALED_EDITS = {
    'admission_before': (lambda p: p['writes']['admission'].update(before={'other': True}),
                         'packet_writes_not_the_validated_values'),
    'kv_key': (lambda p: p['writes']['kv-config'].update(key='trading:config:v2'), 'packet_writes_not_the_validated_values'),
    'admission_key': (lambda p: p['writes']['admission'].update(key='ml:active8:paper_admission:v2'),
                      'packet_writes_not_the_validated_values'),
    'serving_table': (lambda p: p.update(serving_table={**p['serving_table'], 'x': 1}), 'serving_table_not_the_ensemble_table'),
    'ensemble_row': (lambda p: p['ensemble_row'].update(archive_uri=''), 'paired_nav_l3_artifact_registry_mismatch'),
    'scope_subset': (lambda p: p['writes']['kv-config']['after']['exit'].pop('swingMaxHoldSessions'),
                     'raw_config_not_the_granted_change'),
    'runtime_approval': (lambda p: _reapprove(p, lambda a: a.update(efficacy_status='proven')),
                         'active8_paper_runtime_approval_invalid'),
    'evidence': (lambda p: _reapprove(p, lambda a: a['approved_r33_cutover']['candidate_bundle'].update(sha256='0' * 64)),
                 'ensemble_mismatch'),
    'oof_checks_dropped': (lambda p: p.pop('oof_checks'), 'packet_oof_checks_not_the_sealed_v3_receipt'),
    'oof_checks_stale': (lambda p: p['oof_checks'].update(schema_version='r33-oof-checks-v2'),
                         'packet_oof_checks_not_the_sealed_v3_receipt'),
    'oof_checks_other': (lambda p: p['oof_checks'].update(checksum='0' * 64), 'packet_oof_checks_not_the_sealed_v3_receipt'),
    'oof_checks_gate': (lambda p: p['oof_checks'].update(gates=['crossfit_above_cost']),
                        'packet_oof_checks_not_the_sealed_v3_receipt'),
}


@pytest.mark.parametrize('edit', sorted(RESEALED_EDITS))
def test_validate_packet_refuses_each_resealed_edit(edit):
    packet = r33_switch.prepare(**_inputs())
    r33_switch.validate_packet(deepcopy(packet), now=NOW)
    change, message = RESEALED_EDITS[edit]
    change(packet)
    r33_switch.seal(packet)
    with pytest.raises((RuntimeError, ValueError), match=message):
        r33_switch.validate_packet(packet, now=NOW)
