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


def _publish_r33_dry_run(monkeypatch, *, registry_edit=None, ranking=None, paper=True):
    """The original atomic publisher (dry run) on a prepared R33 cutover. D1, structure and paper
    adoption are stubbed; the base-artifact contract and the ranking gate run for real."""
    import json
    from services import active8_bundle_transaction, active8_paper_admission
    from services import model_artifact_registry as registry, model_serving_resolver
    packet = r33_switch.prepare(**_inputs())
    row = {**packet['ensemble_row'], 'state': 'candidate', 'production_effect': 0}
    evidence = {'registration': {'oof_promotion_evidence': {
        'schema_version': 'model-cpcv-evidence-v1', 'method': 'outer_purged_walk_forward_rank_ic', 'folds': 7,
        'decision': 'PASS'}}}
    rows = [{**item, 'model_name': name, 'candidate_type': 'oof_full_fit_release', 'training_run_id': row['training_run_id'],
             'artifact_path': f'universal/{name}.joblib', 'metadata_path': f'universal/{name}.json',
             'state': 'offline_strong_pass', 'offline_evidence_json': json.dumps(evidence)}
            for name, item in packet['ensemble']['base_artifacts'].items()]
    if registry_edit:
        registry_edit(rows)
    calls = []
    monkeypatch.setattr(registry, 'assess_ensemble_qualifications',
                        lambda payload: calls.append(payload) or {'ranking': ranking or {'decision': 'FAIL', 'blockers': ['x']}})
    monkeypatch.setattr(model_serving_resolver, '_artifact_structure_block_reason', lambda *a, **k: None)
    monkeypatch.setattr(active8_bundle_transaction, 'prepare_bundle_transaction',
                        lambda **k: {'guards': [], 'recovered_existing_commit': False, 'current_pointers': []})
    monkeypatch.setattr(active8_paper_admission, 'prepare_paper_adoption',
                        lambda **k: {'admission': k['admission'], 'configuration': {}})
    result = registry.run_active8_ensemble_bundle_promotion_controller(
        training_run_id=row['training_run_id'], registry_rows=rows, d1_pointers=[], ensemble_rows=[row],
        ensemble_artifact_id=row['artifact_id'], ensemble_payload_checksum=row['payload_checksum'],
        evaluation_business_date=packet['admission']['business_date'], paper_admission=packet['admission'] if paper else None,
        confirm=False, reason='r33_cutover')
    return result, calls


def test_publisher_admits_the_r33_full_fit_bundle_without_the_active8_ranking_gate(monkeypatch):
    # R33 base artifacts bind artifact_id/version/checksum; their rows are oof_full_fit_release.
    # The active8 ranking gate (d952019c, "for non-R33 Paper") does not apply: R33's gate is its OOF checks.
    result, calls = _publish_r33_dry_run(monkeypatch)
    assert result['status'] == 'dry_run' and result['can_promote'] is True, result
    assert result['release_models'] == sorted(_bundle()['artifacts']) and calls == []
    assert 'paper_ranking_override' not in result


@pytest.mark.parametrize('edit,decision', [
    (lambda rows: rows[0].update(checksum='sha256:' + '0' * 64), 'active8_bundle_contract_invalid'),
    (lambda rows: rows[0].update(version='other'), 'active8_bundle_contract_invalid'),
    (lambda rows: rows[0].update(candidate_type='manual_hotfix'), 'active8_bundle_incomplete'),
    (lambda rows: rows[0].update(state='rejected'), 'active8_bundle_contract_invalid'),
    (lambda rows: rows[0].update(artifact_id='other:v1:oof_full_fit_release'), 'active8_bundle_incomplete'),
])
def test_publisher_still_binds_each_r33_base_artifact(monkeypatch, edit, decision):
    result, _ = _publish_r33_dry_run(monkeypatch, registry_edit=edit)
    assert result['status'] == 'blocked' and result['decision'] == decision


def test_publisher_never_adopts_an_r33_object_without_its_paper_admission(monkeypatch):
    # No R33 NAV adoption exists (active8_nav_inference refuses it); the publisher blocks first.
    result, calls = _publish_r33_dry_run(monkeypatch, paper=False)
    assert result['status'] == 'blocked' and result['decision'] == 'r33_requires_paper_admission' and calls == []


# ---- same-cohort recalibration (L3-EV-STEP): only the serving estimator changes ----

def _hinge_calibration():
    from services import r33_crossfit_serving as serving
    curve = dict(kind='hinge', intercept=-0.001, slope=0.028, knot=0.5, knot_quantile=0.85, score_cap=1.0)
    quantiles = [-1.0 + 0.1 * i for i in range(21)]
    return serving._build_hinge_payload(
        curve=curve, variant='mean_z', horizon_sessions=5, model_order=list(_ensemble()['model_order']),
        diagnostics={}, score_quantiles=quantiles,
        inputs={'estimator': serving.HINGE_ESTIMATOR, 'source_calibration_checksum': '5' * 64})


def _recalibration_inputs():
    """The live state is the first R33 cutover's (cohort c1, legacy step table, its grant in KV);
    the new object swaps in the hinge table."""
    first = r33_switch.prepare(**_inputs())
    live, grant = first['ensemble'], first['approval']
    inputs = _inputs()
    inputs.update(raw_config=deepcopy(first['writes']['kv-config']['after']),
                  merged_config=deepcopy(grant['configuration']['trading_config']), prior=deepcopy(grant),
                  old_admission=deepcopy(first['admission']), runtime_before=deepcopy(grant),
                  pointer={**{k: live[k] for k in r33_switch.IDENTITY_KEYS}, 'promoted_at': 'x'},
                  serving_table=_hinge_calibration(), live_ensemble=deepcopy(live),
                  serving_sanity=_sanity(_hinge_calibration(), grant['configuration']['trading_config']['fees']))
    new = _hinge_calibration()
    approval = {'schema_version': r33_switch.RECALIBRATION_SCHEMA, 'approved': True, 'scope': 'paper_r33_recalibration',
                'cohort_id': 'c1', 'from_serving_table_checksum': live['serving_calibration']['payload_checksum'],
                'to_estimator': new['inputs']['estimator'], 'to_serving_table_checksum': new['payload_checksum'],
                'approved_at': '2026-11-08T13:00:00Z', 'source_reference': 'SYNTHETIC TEST ONLY'}
    return inputs, approval


def test_a_same_cohort_estimator_swap_needs_wei_approval_and_then_serves():
    from services.r33_crossfit_serving import HINGE_ESTIMATOR, table_name
    from services.r33_cutover import verify_serving
    inputs, approval = _recalibration_inputs()
    with pytest.raises(RuntimeError, match='same_cohort_recalibration_requires_wei_approval'):
        r33_switch.prepare(**inputs)
    packet = r33_switch.prepare(**inputs, recalibration_approval=approval)
    verify_serving(packet['approval'], packet['admission'], packet['ensemble'])
    r33_switch.validate_packet(packet, now=NOW)
    live = inputs['live_ensemble']
    assert packet['ensemble']['cohort_id'] == live['cohort_id'] and packet['ensemble']['payload_checksum'] != live['payload_checksum']
    assert {k for k in live if packet['ensemble'][k] != live[k]} == {'serving_calibration', 'artifact_id', 'payload_checksum'}
    calibration = packet['approval']['approved_r33_cutover']['calibration']
    assert calibration['serving_table_checksum'] == approval['to_serving_table_checksum']
    assert calibration['serving_table_path'] == f'r33/monthly_candidates/c1/{table_name(HINGE_ESTIMATOR)}'
    assert packet['recalibration']['from']['serving_table_checksum'] == approval['from_serving_table_checksum']
    assert packet['recalibration']['to']['estimator'] == HINGE_ESTIMATOR
    # A dropped record is caught at activation (the seal is recomputed to show it is the validators).
    stripped = r33_switch.seal(dict(packet, recalibration=None))
    with pytest.raises(RuntimeError, match='same_cohort_recalibration_requires_wei_approval'):
        r33_switch.validate_packet(stripped, now=NOW)


@pytest.mark.parametrize('fault', ['other_cohort', 'other_from', 'other_to', 'other_estimator', 'not_approved',
                                   'extra_field', 'no_reference', 'no_time', 'bad_time', 'future_time',
                                   'live_not_pointer', 'other_bundle', 'new_bundle', 'same_estimator', 'live_tampered',
                                   'prior_not_cutover', 'exit_rules_changed'])
def test_a_recalibration_fails_closed(fault):
    inputs, approval = _recalibration_inputs()
    live = inputs['live_ensemble']
    edits = {
        'other_cohort': lambda: approval.update(cohort_id='c2'),
        'other_from': lambda: approval.update(from_serving_table_checksum='0' * 64),
        'other_to': lambda: approval.update(to_serving_table_checksum='0' * 64),
        'other_estimator': lambda: approval.update(to_estimator='r33-purged-crossfit-recalibrated-v1'),
        'not_approved': lambda: approval.update(approved='yes'),
        'extra_field': lambda: approval.update(note='x'),
        'no_reference': lambda: approval.update(source_reference=' '),
        'live_not_pointer': lambda: inputs.update(live_ensemble=_ensemble(_calibration(ys=(-0.03, 0.0, 0.01, 0.03)))),
        'other_bundle': lambda: inputs.update(live_ensemble={**live, 'source_bundle': {**live['source_bundle'], 'sha256': 'e' * 64}}),
        # A self-consistent new object from another sealed bundle of the same cohort.
        'new_bundle': lambda: inputs.update(bundle_sha256='e' * 64),
        'same_estimator': lambda: inputs.update(
            serving_table=_calibration(ys=(-0.03, 0.0, 0.01, 0.03)),
            serving_sanity=_sanity(_calibration(ys=(-0.03, 0.0, 0.01, 0.03)), inputs['merged_config']['fees'])),
        'no_time': lambda: approval.pop('approved_at'),
        'bad_time': lambda: approval.update(approved_at='tonight'),
        'future_time': lambda: approval.update(approved_at='2099-01-01T00:00:00Z'),
        # The DB column and the payload agree, but the object no longer recomputes to its checksum.
        'live_tampered': lambda: live['serving_calibration']['blocks'][0].update(mean_excess=0.5),
        # A grant that is not (and does not pin) the R33 cutover grant does not own the live table.
        'prior_not_cutover': lambda: _replace_prior(inputs, _inputs()['prior']),
        'exit_rules_changed': lambda: inputs['exit_rules'].update(swingMaxHoldSessions=10),
    }
    edits[fault]()
    reason = {'live_not_pointer': 'recalibration_live_object_not_the_pointer',
              'other_bundle': 'recalibration_live_object_invalid',
              'new_bundle': 'recalibration_changes_more_than_the_estimator',
              'same_estimator': 'recalibration_changes_more_than_the_estimator',
              'future_time': 'recalibration_approval_in_the_future',
              'live_tampered': 'recalibration_live_object_invalid',
              'prior_not_cutover': 'recalibration_prior_not_an_r33_cutover_grant',
              'exit_rules_changed': 'recalibration_changes_the_exit_rules'}.get(fault, 'recalibration_approval_invalid')
    with pytest.raises(RuntimeError, match=reason):
        r33_switch.prepare(**inputs, recalibration_approval=approval)


def test_a_recalibration_approval_on_an_ordinary_cutover_is_refused():
    _, approval = _recalibration_inputs()
    with pytest.raises(RuntimeError, match='recalibration_approval_without_a_recalibration'):
        r33_switch.prepare(**_inputs(), recalibration_approval=approval)
    assert r33_switch.prepare(**_inputs())['recalibration'] is None


def _replace_prior(inputs, prior):
    """The same live config and admission under a grant that carries no R33 cutover evidence."""
    prior = deepcopy(prior)
    prior.update(admission=deepcopy(inputs['old_admission']),
                 configuration=deepcopy(inputs['prior']['configuration']))
    prior.pop('approval_checksum')
    prior['approval_checksum'] = digest(prior)
    inputs.update(prior=prior, runtime_before=deepcopy(prior))


@pytest.mark.parametrize('fault', ['dropped_reference', 'dropped_time', 'extra_field', 'future_time',
                                   'from_rewritten', 'from_estimator_is_to'])
def test_a_tampered_recalibration_record_is_refused_at_activation(fault):
    """validate_packet re-runs prepare's checks: a re-sealed packet cannot carry a weaker record."""
    inputs, approval = _recalibration_inputs()
    packet = r33_switch.prepare(**inputs, recalibration_approval=approval)
    r33_switch.validate_packet(packet, now=NOW)
    record = packet['recalibration']
    edits = {
        'dropped_reference': lambda: record['approval'].pop('source_reference'),
        'dropped_time': lambda: record['approval'].pop('approved_at'),
        'extra_field': lambda: record['approval'].update(note='x'),
        'future_time': lambda: record['approval'].update(approved_at='2099-01-01T00:00:00Z'),
        # Rewritten in both places, so the record agrees with itself but not with the live grant.
        'from_rewritten': lambda: (record['approval'].update(from_serving_table_checksum='0' * 64),
                                   record['from'].update(serving_table_checksum='0' * 64)),
        'from_estimator_is_to': lambda: record['from'].update(estimator=record['to']['estimator']),
    }
    edits[fault]()
    reason = {'future_time': 'recalibration_approval_in_the_future', 'from_rewritten': 'packet_recalibration_invalid',
              'from_estimator_is_to': 'packet_recalibration_invalid'}.get(fault, 'recalibration_approval_invalid')
    with pytest.raises(RuntimeError, match=reason):
        r33_switch.validate_packet(r33_switch.seal(packet), now=NOW)


def test_activation_refuses_a_recalibration_from_another_bundle_even_with_a_consistent_record(monkeypatch):
    """prepare refuses it (new_bundle above); a packet produced past that check fails validate_packet."""
    from services.r33_crossfit_serving import estimator_of
    inputs, approval = _recalibration_inputs()
    inputs['bundle_sha256'] = 'e' * 64

    def record_only(**kw):
        live, new = kw['live_ensemble'], kw['ensemble']
        side = lambda o: {'artifact_id': o['artifact_id'], 'payload_checksum': o['payload_checksum'],  # noqa: E731
                          'serving_table_checksum': o['serving_calibration']['payload_checksum'],
                          'estimator': estimator_of(o['serving_calibration'])}
        return {'approval': deepcopy(kw['approval']), 'from': side(live), 'to': side(new)}
    monkeypatch.setattr(r33_switch, 'recalibration', record_only)
    forged = r33_switch.prepare(**inputs, recalibration_approval=approval)
    monkeypatch.undo()
    with pytest.raises(RuntimeError, match='packet_recalibration_invalid'):
        r33_switch.validate_packet(forged, now=NOW)

