"""R33 Paper cutover grant (R33-NEW-07). Synthetic fixtures only."""
from copy import deepcopy
from datetime import datetime, timezone

import pytest

from services import r33_cutover
from services.paired_nav_journal import digest
from services.paper_strategy_mode import MLP_MODE, R33_MODE
from test_r33_l4_equal7 import IDENTITY, _ensemble
from test_r33_paper_mode import _policy

NOW = datetime(2026, 11, 9, 8, tzinfo=timezone.utc)


# --- R33-NEW-07: cutover grant -----------------------------------------------------------------

def _config(policy, *, risk=None):
    return {'trading_config': {'fees': {'commission': .001425, 'tax': .003}, 'l4Distribution': policy},
            'risk_config': risk or {'position': {'maxSingleNamePct': .1}},
            'allocator_source_identity': {'l4_portfolio.py': 'a' * 64},
            'l3_inference_source_identity': {'active8_paper_admission.py': 'b' * 64,
                                             'active8_nav_adoption.py': 'c' * 64},
            'native_execution_policy': {'execution_owner_version': 'native-paper-v1:' + 'd' * 64,
                                        'variables': {'LIVE_EXECUTION_CLIENT_ENABLED': '0'}}}


OLD_IDENTITY = {'schema_version': 'paired-nav-formal-ml-baseline-v1', 'artifact_id': 'active8-ensemble:old:0123',
                'cohort_id': 'old', 'payload_checksum': '1' * 64, 'base_artifact_set_checksum': '2' * 64}


def _old_policy():
    return {'scope': 'paper', 'artifact': {'model_checksum': 'o' * 64, 'feature_schema': 'full-l3-30-timexer-signals-v4'},
            'operating_mode': MLP_MODE, 'strategy_role': 'B', 'constraints': {'exposure_cap': .9},
            'opb': {'enabled': True, 'approved_policy_identity': 'p' * 64}}


def _evidence(policy, ensemble):
    source = ensemble['source_bundle']
    return {'schema_version': r33_cutover.SCHEMA, 'mode': R33_MODE,
            'candidate_bundle': {'path': source['path'], 'sha256': source['sha256'], 'cohort_id': ensemble['cohort_id'],
                                 'manifest_checksum': source['manifest_checksum'],
                                 'oof_checks_checksum': source['oof_checks_checksum'],
                                 'oof_checks_status': 'pass', 'pit_certified': True},
            'artifacts': deepcopy(ensemble['base_artifacts']),
            'base_artifact_set_checksum': ensemble['base_artifact_set_checksum'],
            'ensemble': {'artifact_id': ensemble['artifact_id'], 'payload_checksum': ensemble['payload_checksum']},
            'calibration': {'source_payload_checksum': source['source_calibration_checksum'],
                            'serving_table_path': 'r33/monthly_candidates/c1/crossfit_serving_table.json',
                            'serving_table_checksum': ensemble['serving_calibration']['payload_checksum']},
            'rank_pool_schema': r33_cutover.RANK_POOL_SCHEMA,
            'feature_schema': policy['artifact']['feature_schema'],
            'l4_model_checksum': policy['artifact']['model_checksum'],
            'economics_change_scope': ['trading:config.l4Distribution.artifact',
                                       'trading:config.l4Distribution.operating_mode',
                                       'trading:config.l4Distribution.opb.approved_policy_identity'],
            'first_night': {'supersedes_plan_policy_identity': 'p' * 64, 'effective_signal_date': '2026-11-10'},
            'wei_approval': {'approved': True, 'scope': 'paper', 'approved_at': '2026-11-08T12:00:00Z',
                             'source_reference': 'SYNTHETIC TEST ONLY'}}


def _grant(monkeypatch):
    from services import active8_paper_admission
    ensemble, policy = _ensemble(), _policy()
    old_config, new_config = _config(_old_policy()), _config(policy)
    old_admission = {'approved_at': '2026-10-12T01:59:00Z', 'configuration': deepcopy(old_config),
                     'strategy_bundle': {'candidate_l3_identity': OLD_IDENTITY}}
    prior = {'admission': old_admission, 'configuration': deepcopy(old_config), 'approved_at': '2026-10-31T00:00:00Z'}
    admission = {'approved_at': '2026-11-08T13:00:00Z', 'business_date': '2026-11-09',
                 'configuration': deepcopy(new_config),
                 'strategy_bundle': {'baseline_l3_identity': OLD_IDENTITY, 'candidate_l3_identity': IDENTITY,
                                     'baseline_trading_config': deepcopy(old_config['trading_config']),
                                     'candidate_trading_config': deepcopy(new_config['trading_config'])}}
    approval = {'admission': admission, 'configuration': deepcopy(new_config), 'approved_at': '2026-11-08T14:00:00Z',
                'prior_runtime_approval': prior, 'approved_r33_cutover': _evidence(policy, ensemble)}
    seen = []
    monkeypatch.setattr(active8_paper_admission, 'validate_runtime_approval',
                        lambda value, adm, **kw: seen.append((value, adm)) or value)
    return approval, admission, ensemble, seen


def test_valid_r33_cutover_checks_the_prior_chain(monkeypatch):
    approval, admission, ensemble, seen = _grant(monkeypatch)
    before = deepcopy(approval)
    assert r33_cutover.validate_cutover(approval, admission, now=NOW) == approval['approved_r33_cutover']
    assert approval == before
    assert seen == [(approval['prior_runtime_approval'], approval['prior_runtime_approval']['admission'])]
    r33_cutover.validate_against_ensemble(approval['approved_r33_cutover'], ensemble)


@pytest.mark.parametrize('fault', ['risk', 'fees', 'constraints', 'opb_policy', 'source', 'execution', 'live_flag',
                                   'scope_missing', 'scope_extra', 'scope_unknown', 'no_prior', 'prior_same_admission',
                                   'baseline_identity', 'baseline_config', 'mode', 'role', 'l3_identity',
                                   'l4_checksum', 'feature_schema', 'rank_pool', 'calibration', 'oof_status', 'pit',
                                   'cohort', 'wei_scope', 'wei_order', 'first_night_identity', 'first_night_date',
                                   'first_night_format', 'extra_field'])
def test_r33_cutover_rejects_every_other_change(monkeypatch, fault):
    approval, admission, _, _ = _grant(monkeypatch)
    e, c = approval['approved_r33_cutover'], approval['configuration']
    new_policy = c['trading_config']['l4Distribution']
    edits = {
        'risk': lambda: c['risk_config']['position'].update(maxSingleNamePct=.2),
        'fees': lambda: c['trading_config']['fees'].update(commission=0),
        'constraints': lambda: new_policy['constraints'].update(exposure_cap=.95),
        'opb_policy': lambda: new_policy['opb'].update(enabled=False),
        'source': lambda: c['allocator_source_identity'].update({'l4_portfolio.py': 'f' * 64}),
        'execution': lambda: c['native_execution_policy'].update(execution_owner_version='native-paper-v1:' + 'e' * 64),
        'live_flag': lambda: c['native_execution_policy']['variables'].update(LIVE_EXECUTION_CLIENT_ENABLED='1'),
        'scope_missing': lambda: e['economics_change_scope'].pop(),
        'scope_extra': lambda: e['economics_change_scope'].append('trading:config.l4Distribution.strategy_role'),
        'scope_unknown': lambda: e['economics_change_scope'].append('trading:config.fees'),
        'no_prior': lambda: approval.pop('prior_runtime_approval'),
        'prior_same_admission': lambda: approval['prior_runtime_approval'].update(admission=admission),
        'baseline_identity': lambda: admission['strategy_bundle'].update(
            baseline_l3_identity={**OLD_IDENTITY, 'payload_checksum': '3' * 64}),
        'baseline_config': lambda: admission['strategy_bundle']['baseline_trading_config']['fees'].update(tax=0),
        'mode': lambda: e.update(mode=MLP_MODE),
        'role': lambda: admission['strategy_bundle']['candidate_trading_config']['l4Distribution'].update(strategy_role='A'),
        'l3_identity': lambda: e['ensemble'].update(payload_checksum='0' * 64),
        'l4_checksum': lambda: e.update(l4_model_checksum='0' * 64),
        'feature_schema': lambda: e.update(feature_schema='full-l3-30-timexer-signals-v4'),
        'rank_pool': lambda: e.update(rank_pool_schema='r33-rank-pool-v0'),
        'calibration': lambda: e['calibration'].update(serving_table_checksum='0' * 64),
        'oof_status': lambda: e['candidate_bundle'].update(oof_checks_status='fail'),
        'pit': lambda: e['candidate_bundle'].update(pit_certified=False),
        'cohort': lambda: e['candidate_bundle'].update(cohort_id='c2'),
        'wei_scope': lambda: e['wei_approval'].update(scope='live'),
        'wei_order': lambda: e['wei_approval'].update(approved_at='2026-11-08T15:00:00Z'),
        'first_night_identity': lambda: e['first_night'].update(supersedes_plan_policy_identity='n' * 64),
        'first_night_date': lambda: e['first_night'].update(effective_signal_date='2026-11-06'),
        'first_night_format': lambda: e['first_night'].update(effective_signal_date='2026/11/10'),
        'extra_field': lambda: e.update(maturity_transfer=True),
    }
    edits[fault]()
    with pytest.raises((RuntimeError, ValueError)):
        r33_cutover.validate_cutover(approval, admission, now=NOW)


@pytest.mark.parametrize('fault', ['artifacts', 'bundle_sha', 'source_calibration', 'serving_table', 'ensemble_id'])
def test_serving_evidence_must_describe_the_published_object(monkeypatch, fault):
    approval, _, ensemble, _ = _grant(monkeypatch)
    e = approval['approved_r33_cutover']
    {'artifacts': lambda: e['artifacts']['GNN'].update(version='GNN-v0'),
     'bundle_sha': lambda: e['candidate_bundle'].update(sha256='0' * 64),
     'source_calibration': lambda: e['calibration'].update(source_payload_checksum='0' * 64),
     'serving_table': lambda: e['calibration'].update(serving_table_checksum='0' * 64),
     'ensemble_id': lambda: e['ensemble'].update(artifact_id='r33-equal7:c1:0')}[fault]()
    with pytest.raises(RuntimeError, match='r33_cutover_invalid:ensemble_mismatch'):
        r33_cutover.validate_against_ensemble(e, ensemble)


def test_serving_finds_the_cutover_through_later_source_releases(monkeypatch):
    approval, admission, ensemble, _ = _grant(monkeypatch)
    later = {'admission': admission, 'approved_strategy_nav_source_change': {'release_manifest_checksum': 'm' * 64},
             'prior_runtime_approval': approval}
    assert r33_cutover.cutover_evidence(later, admission) is approval['approved_r33_cutover']
    r33_cutover.verify_serving(later, admission, ensemble)
    plain = {'admission': admission, 'prior_runtime_approval': {'admission': admission}}
    with pytest.raises(RuntimeError, match='serving_requires_cutover_evidence'):
        r33_cutover.verify_serving(plain, admission, ensemble)
    # Another admission's cutover never authorises this one.
    foreign = {'admission': admission, 'prior_runtime_approval': {**approval, 'admission': {'other': True}}}
    assert r33_cutover.cutover_evidence(foreign, admission) is None
    # A non-R33 object must not claim R33 cutover evidence.
    with pytest.raises(RuntimeError, match='serving_requires_cutover_evidence'):
        r33_cutover.verify_serving(approval, admission, {'kind': 'active8'})
    r33_cutover.verify_serving(admission, admission, {'kind': 'active8'})


def test_runtime_approval_routes_the_r33_cutover_exclusively(monkeypatch):
    from services import active8_paper_admission as paper
    calls = []
    monkeypatch.setattr(r33_cutover, 'validate_cutover', lambda a, adm, now: calls.append(a))
    admission = {'approved_at': '2026-11-08T13:00:00Z', 'configuration': {}}
    approval = {'schema_version': paper.RUNTIME_SCHEMA, 'admission': admission, 'scope': 'paper', 'approved': True,
                'maturity_transfer': False, 'efficacy_status': 'unproven', 'source_reference': 'SYNTHETIC',
                'approved_at': '2026-11-08T14:00:00Z', 'approved_r33_cutover': {'schema_version': 'x'},
                'approved_source_change': {'release': 'x'}}
    approval['approval_checksum'] = digest({k: v for k, v in approval.items() if k != 'approval_checksum'})
    with pytest.raises(RuntimeError, match='active8_paper_r33_cutover_must_be_exclusive'):
        paper.validate_runtime_approval(approval, admission, now=NOW)
    assert calls == []


def _signed(approval):
    approval['approval_checksum'] = digest({k: v for k, v in approval.items() if k != 'approval_checksum'})
    return approval


def test_full_runtime_approval_accepts_the_cutover_and_still_pins_the_configuration():
    """No monkeypatch: the prior grant and the cutover grant both pass the real validator."""
    from services import active8_paper_admission as paper
    ensemble, policy = _ensemble(), _policy()
    old_config, new_config = _config(_old_policy()), _config(policy)
    common = {'schema_version': paper.RUNTIME_SCHEMA, 'scope': 'paper', 'approved': True, 'maturity_transfer': False,
              'efficacy_status': 'unproven', 'source_reference': 'SYNTHETIC TEST ONLY'}
    old_admission = {'approved_at': '2026-10-12T01:59:00Z', 'configuration': deepcopy(old_config),
                     'strategy_bundle': {'candidate_l3_identity': OLD_IDENTITY}}
    prior = _signed({**common, 'admission': old_admission, 'configuration': deepcopy(old_config),
                     'approved_at': '2026-10-31T00:00:00Z'})
    admission = {'approved_at': '2026-11-08T13:00:00Z', 'business_date': '2026-11-09',
                 'configuration': deepcopy(new_config),
                 'strategy_bundle': {'baseline_l3_identity': OLD_IDENTITY, 'candidate_l3_identity': IDENTITY,
                                     'baseline_trading_config': deepcopy(old_config['trading_config']),
                                     'candidate_trading_config': deepcopy(new_config['trading_config'])}}
    approval = _signed({**common, 'admission': admission, 'configuration': deepcopy(new_config),
                        'approved_at': '2026-11-08T14:00:00Z', 'prior_runtime_approval': prior,
                        'approved_r33_cutover': _evidence(policy, ensemble)})
    assert paper.validate_runtime_approval(approval, admission, now=NOW) == approval
    # The cutover evidence never excuses a configuration that differs from the new admission.
    drifted = deepcopy(approval)
    drifted['configuration']['risk_config']['position']['maxSingleNamePct'] = .2
    drifted['prior_runtime_approval']['configuration']['risk_config']['position']['maxSingleNamePct'] = .2
    drifted['prior_runtime_approval']['admission']['configuration'] = deepcopy(drifted['prior_runtime_approval']['configuration'])
    _signed(drifted['prior_runtime_approval'])
    _signed(drifted)
    with pytest.raises(RuntimeError, match='active8_paper_runtime_approval_policy_changed'):
        paper.validate_runtime_approval(drifted, admission, now=NOW)
    tampered = deepcopy(approval)
    tampered['prior_runtime_approval']['approved_at'] = '2026-10-30T00:00:00Z'      # checksum no longer matches
    _signed(tampered)
    with pytest.raises(RuntimeError, match='active8_paper_runtime_approval_invalid'):
        paper.validate_runtime_approval(tampered, admission, now=NOW)


@pytest.mark.parametrize('fault', ['artifacts_junk', 'opb_identity_free', 'bundle_path', 'table_path',
                                   'calibration_keys', 'wei_keys', 'wei_time'])
def test_r33_cutover_binds_every_evidence_field_at_grant_time(monkeypatch, fault):
    approval, admission, _, _ = _grant(monkeypatch)
    e = approval['approved_r33_cutover']
    candidate_policy = admission['strategy_bundle']['candidate_trading_config']['l4Distribution']
    {'artifacts_junk': lambda: e.update(artifacts={'junk': 1}),
     'opb_identity_free': lambda: candidate_policy['opb'].update(approved_policy_identity='z' * 64),
     'bundle_path': lambda: e['candidate_bundle'].update(path='r33/monthly_candidates/c2/bundle.json'),
     'table_path': lambda: e['calibration'].update(serving_table_path='r33/other/crossfit_serving_table.json'),
     'calibration_keys': lambda: e['calibration'].update(extra='x'),
     'wei_keys': lambda: e['wei_approval'].pop('source_reference'),
     'wei_time': lambda: e['wei_approval'].update(approved_at='not-a-time')}[fault]()
    with pytest.raises((RuntimeError, ValueError)):
        r33_cutover.validate_cutover(approval, admission, now=NOW)


def test_r33_can_cut_over_from_a_previous_r33_cutover(monkeypatch):
    approval, admission, _, _ = _grant(monkeypatch)
    approval['prior_runtime_approval']['approved_r33_cutover'] = {'schema_version': 'older'}
    assert r33_cutover.validate_cutover(approval, admission, now=NOW) is approval['approved_r33_cutover']


def test_serving_never_follows_an_unpinned_nested_prior(monkeypatch):
    """A plain grant may not smuggle cutover evidence inside an unvalidated prior."""
    approval, admission, ensemble, _ = _grant(monkeypatch)
    plain = {'admission': admission, 'prior_runtime_approval': approval}
    assert r33_cutover.cutover_evidence(plain, admission) is None
    with pytest.raises(RuntimeError, match='serving_requires_cutover_evidence'):
        r33_cutover.verify_serving(plain, admission, ensemble)
    provenance = {'admission': admission, 'approved_capture_provenance_source_change': {'release': 'x'},
                  'prior_runtime_approval': approval}
    assert r33_cutover.cutover_evidence(provenance, admission) is approval['approved_r33_cutover']


def test_publication_of_an_r33_object_needs_the_cutover_grant(monkeypatch):
    from services import active8_paper_admission as paper, active8_nav_adoption
    approval, admission, ensemble, _ = _grant(monkeypatch)
    monkeypatch.setattr(paper, 'validate_admission', lambda adm, **kw: adm)
    monkeypatch.setattr(active8_nav_adoption, 'verify_current_configuration', lambda config: config)
    row = {'payload_json': __import__('json').dumps(ensemble)}
    admission['business_date'] = '2026-11-10'
    pointer = [{k: OLD_IDENTITY[k] for k in ('artifact_id', 'cohort_id', 'payload_checksum', 'base_artifact_set_checksum')}]
    for active, ok in ((approval, True), ({**approval, 'approved_r33_cutover': None}, False)):
        monkeypatch.setattr(paper, 'verify_active_approval', lambda adm, now=None, a=active: a)
        call = lambda: paper.prepare_paper_adoption(ensemble_row=row, admission=admission,
                                                    business_date='2026-11-10', query=lambda sql, args: pointer)
        if ok:
            assert call()['admission']['business_date'] == '2026-11-10'
        else:
            with pytest.raises(RuntimeError, match='serving_requires_cutover_evidence'):
                call()
