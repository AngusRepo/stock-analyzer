"""Exact source reapproval cannot grant configuration drift or maturity transfer."""
from copy import deepcopy
from datetime import datetime, timezone
import json
from pathlib import Path

import pytest

from services.active8_paper_admission import RUNTIME_SCHEMA, validate_runtime_approval
from services.paired_nav_collection import allocator_source_identity
from services.paired_nav_recommendation_path import recommendation_source_identity
from services.native_paper_sandbox import native_execution_identity
from services.paired_nav_journal import digest
from test_native_paper_sandbox import native_runner


def seal(value):
    value['approval_checksum'] = digest({k: v for k, v in value.items() if k != 'approval_checksum'})
    return value


@pytest.fixture
def source_grant(native_runner, monkeypatch):
    monkeypatch.setenv('NATIVE_PAPER_RUNNER', str(native_runner))
    sources = {'allocator_source_identity': allocator_source_identity(),
               'l3_inference_source_identity': recommendation_source_identity()}
    before = {'trading_config': {'opb': {'enabled': True}, 'fees': {'commission': .001425}},
              'risk_config': {'cap': .3}, **deepcopy(sources),
              'native_execution_policy': {'execution_owner_version': 'native-paper-v1:' + '0' * 64,
                  'variables': {'LIVE_EXECUTION_CLIENT_ENABLED': '0'}, 'frozen_kv': {'policy': 'unchanged'}}}
    before['allocator_source_identity']['paired_nav_collection.py'] = '0' * 64
    admission = {'approved_at': '2026-10-12T12:00:00Z', 'configuration': deepcopy(before)}
    prior = seal({'schema_version': RUNTIME_SCHEMA, 'admission': admission, 'configuration': before,
        'scope': 'paper', 'approved': True, 'maturity_transfer': False, 'efficacy_status': 'unproven',
        'source_reference': 'private synthetic prior operator record', 'approved_at': admission['approved_at']})
    owner = native_execution_identity()
    manifest = {'schema_version': 'strategy-nav-source-release-v1', 'scope': 'paper',
        'production_baseline_verified': True, 'source_equivalence': False, 'maturity_transfer': False,
        'prior_approval_checksum': prior['approval_checksum'], 'prior_configuration_checksum': digest(before),
        'approved_sources': sources, 'execution_owner_version': owner}
    original_read = Path.read_text
    monkeypatch.setattr(Path, 'read_text', lambda path, *a, **kw: json.dumps(manifest)
        if path.name == 'strategy_nav_source_release.json' else original_read(path, *a, **kw))
    after = deepcopy(before)
    after.update(deepcopy(sources))
    after['native_execution_policy']['execution_owner_version'] = owner
    approval = seal({**deepcopy(prior), 'configuration': after, 'prior_runtime_approval': deepcopy(prior),
        'approved_at': '2026-10-14T12:00:00Z', 'source_reference': 'private synthetic NAV source grant',
        'approved_strategy_nav_source_change': {'release_manifest_checksum': digest(manifest)}})
    return admission, approval, manifest


def test_exact_source_release_preserves_economics_and_new_native_identity(source_grant):
    admission, approval, _ = source_grant
    assert validate_runtime_approval(approval, admission, now=datetime(2026, 10, 14, 13, tzinfo=timezone.utc)) == approval


@pytest.mark.parametrize('fault', ['risk', 'fees', 'opb', 'live', 'source', 'owner', 'prior', 'maturity', 'manifest', 'future'])
def test_new_source_grant_rejects_other_drift(source_grant, fault):
    admission, approval, manifest = source_grant
    config = approval['configuration']
    if fault == 'risk': config['risk_config']['cap'] = .4
    elif fault == 'fees': config['trading_config']['fees']['commission'] = 0
    elif fault == 'opb': config['trading_config']['opb']['enabled'] = False
    elif fault == 'live': config['native_execution_policy']['variables']['LIVE_EXECUTION_CLIENT_ENABLED'] = '1'
    elif fault == 'source': config['l3_inference_source_identity']['paired_nav_atomic_candidate.py'] = 'f' * 64
    elif fault == 'owner': config['native_execution_policy']['execution_owner_version'] = 'native-paper-v1:' + 'f' * 64
    elif fault == 'prior':
        # A different internally valid record is still unapproved.
        approval['prior_runtime_approval']['source_reference'] = 'different prior record'
        seal(approval['prior_runtime_approval'])
    elif fault == 'maturity': approval['maturity_transfer'] = True
    elif fault == 'manifest':
        manifest['source_equivalence'] = True
        approval['approved_strategy_nav_source_change']['release_manifest_checksum'] = digest(manifest)
    elif fault == 'future': approval['approved_at'] = '2026-10-15T12:00:00Z'
    seal(approval)
    with pytest.raises(RuntimeError):
        validate_runtime_approval(approval, admission, now=datetime(2026, 10, 14, 13, tzinfo=timezone.utc))


def policy_grant(source_grant):
    from services.l4_distribution_runtime import distribution_policy_identity
    admission, approval, manifest = source_grant
    prior = approval['prior_runtime_approval']
    old = {'scope': 'paper', 'artifact': {'model_checksum': 'a' * 64, 'l3_identity': {'source': 'fixed'}},
           'constraints': {'covariance_horizon_sessions': 1, 'name_cap': .125},
           'opb': {'enabled': True, 'approved_policy_identity': 'b' * 64}}
    prior['configuration']['trading_config']['l4Distribution'] = deepcopy(old)
    prior['configuration']['native_execution_policy']['variables']['LIVE_EXECUTION_SUBMIT_GUARD_ENABLED'] = '0'
    seal(prior)
    manifest['prior_approval_checksum'] = prior['approval_checksum']
    manifest['prior_configuration_checksum'] = digest(prior['configuration'])
    new = deepcopy(old)
    new['constraints']['covariance_horizon_sessions'] = 5
    new['sealedExecution'] = {'schema_version': 'l4-sealed-execution-v1',
        'rotation_mode': 'selected_ready_or_filled', 'expiry': 'retain_until_next_seal',
        'require_matched_risk_horizon': True, 'minimum_covariance_windows': 20}
    new['opb']['approved_policy_identity'] = distribution_policy_identity(new, new['artifact']['l3_identity'])
    approval['configuration']['trading_config']['l4Distribution'] = new
    approval['configuration']['native_execution_policy']['variables']['LIVE_EXECUTION_SUBMIT_GUARD_ENABLED'] = '0'
    activation = {'schema_version': 'l4-execution-policy-activation-v1', 'scope': 'paper',
        'maturity_transfer': False, 'account_reset': False, 'minimum_covariance_windows': 20,
        'previous_policy_checksum': digest(old), 'next_policy_checksum': digest(new),
        'engineering_receipt_checksum': 'c' * 64, 'source_reference': 'test-only fixture'}
    manifest['policy_activation'] = activation
    approval['approved_strategy_nav_source_change']['release_manifest_checksum'] = digest(manifest)
    approval['approved_l4_execution_policy_change'] = {'activation_checksum': digest(activation)}
    seal(approval)
    return admission, approval


def test_explicit_policy_grant_activates_only_measured_horizon_and_fixed_rotation(source_grant):
    admission, approval = policy_grant(source_grant)
    assert validate_runtime_approval(approval, admission, now=datetime(2026, 10, 14, 13, tzinfo=timezone.utc)) == approval


@pytest.mark.parametrize('fault', ['cap', 'model', 'opb', 'minimum', 'expiry', 'calibration', 'live', 'grant'])
def test_policy_activation_rejects_unreviewed_changes(source_grant, fault):
    admission, approval = policy_grant(source_grant)
    config = approval['configuration']
    policy = config['trading_config']['l4Distribution']
    if fault == 'cap': policy['constraints']['name_cap'] = .5
    elif fault == 'model': policy['artifact']['model_checksum'] = 'f' * 64
    elif fault == 'opb': policy['opb']['enabled'] = False
    elif fault == 'minimum': policy['sealedExecution']['minimum_covariance_windows'] = 2
    elif fault == 'expiry': policy['sealedExecution']['expiry'] = 'sell_anyway'
    elif fault == 'calibration': policy['sealedExecution']['uncertainty_calibration_checksum'] = 'f' * 64
    elif fault == 'live': config['native_execution_policy']['variables']['LIVE_EXECUTION_CLIENT_ENABLED'] = '1'
    elif fault == 'grant': approval.pop('approved_l4_execution_policy_change')
    seal(approval)
    with pytest.raises(RuntimeError):
        validate_runtime_approval(approval, admission, now=datetime(2026, 10, 14, 13, tzinfo=timezone.utc))


@pytest.mark.parametrize('active_policy', ['old', 'new', 'revoked'])
def test_staged_policy_grant_does_not_activate_until_config_changes(source_grant, monkeypatch, active_policy):
    from services import active8_paper_admission as paper, kv_client
    admission, candidate = policy_grant(source_grant)
    source = deepcopy(candidate)
    source.pop('approved_l4_execution_policy_change')
    source['configuration']['trading_config']['l4Distribution'] = deepcopy(
        candidate['prior_runtime_approval']['configuration']['trading_config']['l4Distribution'])
    seal(source)
    read = Path.read_text
    monkeypatch.setattr(Path, 'read_text', lambda path, *a, **kw: json.dumps({
        'runtime_admission':'source-test','policy_runtime_admission':'policy-test'})
        if path.name=='native_execution_behavior_release.json' else read(path,*a,**kw))
    values={paper.KEY:None if active_policy=='revoked' else admission,
        'source-test':source,'policy-test':candidate,
        'trading:config':(candidate if active_policy=='new' else source)['configuration']['trading_config']}
    monkeypatch.setattr(kv_client,'get_json',lambda key,**kwargs:deepcopy(values.get(key)))
    if active_policy=='revoked':
        with pytest.raises(RuntimeError,match='revoked'):
            paper.verify_active_approval(admission)
    else:
        assert paper.verify_active_approval(admission)==(candidate if active_policy=='new' else source)


V1_POLICY = {'scope': 'paper', 'artifact': {'model_checksum': 'a' * 64, 'l3_identity': {'source': 'fixed'}},
    'constraints': {'alpha_strength': 1., 'buy_cost': .001425, 'cluster_edge_threshold': None,
        'cluster_threshold_quantile': .9, 'covariance_horizon_sessions': 5, 'exposure_cap': 1.,
        'l2_penalty': 0., 'max_cluster_weight': .55, 'max_positions': 5, 'min_weight': 0., 'name_cap': .25,
        'risk_aversion': 2., 'sector_concentration_cap': .5, 'sell_cost': .004425, 'turnover_penalty': 0.},
    'opb': {'enabled': True, 'exploration': .05, 'approved_policy_identity': 'b' * 64, 'arms': [
        {'id': 'base', 'constraints': {}},
        {'id': 'diversified_alpha', 'constraints': {'exposure_cap': .92, 'min_weight': .03, 'name_cap': .25}},
        {'id': 'conservative', 'constraints': {'exposure_cap': .8, 'min_weight': .04, 'name_cap': .2}},
        {'id': 'base_twin', 'constraints': {'min_weight': .02}}]}}
RISK_DEFAULTS = {'system': {'killSwitch': False}, 'portfolio': {'dailyPnlLossLimitPct': -.03,
    'orangeTargetExposure': .45, 'marketShockRedPct': -.05}, 'position': {'maxSingleNamePct': .25},
    'order': {'maxDailyBuyOrders': 5}}
# A v3 OPB block with every knob written out (the branch's v3 fixture values; market proxy explicit).
V3_OPB = {'schema_version': 'l4-opb-selection-arms-v3', 'enabled': True, 'reward_window_observations': 60,
    'reward_half_life_observations': 20., 'reward': 'exposure_normalized_market_neutral_daily_v1',
    'family_error_rate': .1, 'critical_value_simulations': 4000, 'hac_lag_sessions': 2, 'min_exposure_ratio': .5,
    'market_proxy': '0050',
    'inert_counterfactual': {'enabled': False, 'reference_exposure_cap': None, 'reference_name_cap': None},
    'cutover_warm_start': {'enabled': False, 'max_observations': 0},
    'arms': [{'id': 'base'}, {'id': 'alpha_tilt', 'risk_aversion': .5}, {'id': 'ridge', 'l2_penalty': .02}]}


def policy_chain(source_grant, *changes, cost_objective='single_side_v1'):
    """S plus P1..Pn: P1 = the v1 -> v2 owner move, P(k+1) = constraints change k."""
    from services.l4_policy_activation import activation_document, change_document, policy_grants
    admission, approval, manifest = source_grant
    prior = approval['prior_runtime_approval']
    config = prior['configuration']
    config['trading_config'].update(l4Distribution=deepcopy(V1_POLICY),
        position={'maxPctOfPortfolio': .25, 'maxPositions': 5},
        circuit={'maxPositionPct': .08, 'highVolReducedPosPct': .04})
    config['risk_config'] = {'system': {'killSwitch': False}, 'portfolio': {'dailyPnlLossLimitPct': -.03},
                             'position': {'maxSingleNamePct': .25}, 'order': {}}
    config['native_execution_policy']['variables']['LIVE_EXECUTION_SUBMIT_GUARD_ENABLED'] = '0'
    seal(prior)
    manifest['prior_approval_checksum'] = prior['approval_checksum']
    manifest['prior_configuration_checksum'] = digest(config)
    for name in ('trading_config', 'risk_config'):
        approval['configuration'][name] = deepcopy(config[name])
    approval['configuration']['native_execution_policy']['variables']['LIVE_EXECUTION_SUBMIT_GUARD_ENABLED'] = '0'
    activation, next_config, next_risk = activation_document(config['trading_config'], config['risk_config'],
        lookback=252, cost_objective=cost_objective, risk_defaults=RISK_DEFAULTS,
        engineering_receipt_checksum='c' * 64, source_reference='test-only fixture')
    packets = [{'activation': activation, 'next_merged_config': next_config, 'next_risk_config': next_risk}]
    for change in changes:
        activation, next_config = change_document(packets[-1]['next_merged_config'], changes=change,
            engineering_receipt_checksum='d' * 64, source_reference='test-only change fixture')
        packets.append({'activation': activation, 'next_merged_config': next_config, 'next_risk_config': next_risk})
    manifest['policy_activations'] = [p['activation'] for p in packets]
    approval['approved_strategy_nav_source_change']['release_manifest_checksum'] = digest(manifest)
    source = seal(approval)
    return admission, source, policy_grants(source, packets), manifest


def policy_v2_grant(source_grant, **kwargs):
    admission, source, grants, _ = policy_chain(source_grant, **kwargs)
    return admission, source, grants[0]


ROUND_TRIP = {'cost_objective': 'entry_round_trip_v1'}
CLOCK = datetime(2026, 10, 14, 13, tzinfo=timezone.utc)


@pytest.mark.parametrize('cost_objective', ['single_side_v1', 'entry_round_trip_v1'])
def test_policy_v2_grant_accepts_only_the_recomputed_owner_move(source_grant, cost_objective):
    admission, source, candidate = policy_v2_grant(source_grant, cost_objective=cost_objective)
    assert validate_runtime_approval(source, admission, now=CLOCK) == source
    assert validate_runtime_approval(candidate, admission, now=CLOCK) == candidate
    config = candidate['configuration']
    policy = config['trading_config']['l4Distribution']
    assert policy['constraints']['cost_objective'] == cost_objective
    assert 'maxPctOfPortfolio' not in config['trading_config']['position']
    assert config['trading_config']['circuit']['positionScales'] == {'highVol': .5, 'severeHighVol': .5,
        'momentumZone': {'RED': .3, 'YELLOW': .7}, 'lossStreak': .5}
    assert config['risk_config']['portfolio'] == {'dailyPnlLossLimitPct': -.03, 'orangeTargetExposure': .45,
                                                  'marketShockRedPct': -.05}
    assert [arm['id'] for arm in policy['opb']['arms']] == ['base', 'diversified_alpha', 'conservative']
    assert policy['opb']['migration']['arms_equivalent_to_kept_arm_dropped'] == ['base_twin']


def test_cost_objective_is_part_of_the_policy_identity(source_grant):
    from services.l4_policy_activation import next_constraints_policy
    _, _, grant = policy_v2_grant(source_grant)
    single = grant['configuration']['trading_config']['l4Distribution']
    round_trip = next_constraints_policy(single, ROUND_TRIP)
    assert round_trip['opb']['approved_policy_identity'] != single['opb']['approved_policy_identity']
    assert {k: v for k, v in round_trip['constraints'].items() if k != 'cost_objective'} == {
        k: v for k, v in single['constraints'].items() if k != 'cost_objective'}


@pytest.mark.parametrize('fault', ['arm', 'risk_present', 'risk_extra', 'scale', 'position', 'fees', 'live', 'identity'])
def test_policy_v2_grant_rejects_any_other_diff(source_grant, fault):
    admission, _, candidate = policy_v2_grant(source_grant)
    config = candidate['configuration']
    trading, policy = config['trading_config'], config['trading_config']['l4Distribution']
    if fault == 'arm': policy['opb']['arms'][1]['name_fraction'] = .9
    elif fault == 'risk_present': config['risk_config']['portfolio']['dailyPnlLossLimitPct'] = -.05
    elif fault == 'risk_extra': config['risk_config']['order']['maxDailySellOrders'] = 99
    elif fault == 'scale': trading['circuit']['positionScales']['lossStreak'] = .4
    elif fault == 'position': trading['position']['maxPctOfPortfolio'] = .25
    elif fault == 'fees': trading['fees']['commission'] = 0
    elif fault == 'live': config['native_execution_policy']['variables']['LIVE_EXECUTION_CLIENT_ENABLED'] = '1'
    elif fault == 'identity': policy['opb']['approved_policy_identity'] = 'f' * 64
    seal(candidate)
    with pytest.raises(RuntimeError, match='l4_execution_policy_activation_invalid'):
        validate_runtime_approval(candidate, admission, now=CLOCK)


def test_policy_chain_accepts_each_recomputed_prefix(source_grant):
    admission, source, (first, second), _ = policy_chain(source_grant, ROUND_TRIP)
    assert validate_runtime_approval(first, admission, now=CLOCK) == first
    assert validate_runtime_approval(second, admission, now=CLOCK) == second
    one, two = (g['configuration'] for g in (first, second))
    assert two['risk_config'] == one['risk_config']
    assert {k: v for k, v in two['trading_config'].items() if k != 'l4Distribution'} == {
        k: v for k, v in one['trading_config'].items() if k != 'l4Distribution'}
    assert two['trading_config']['l4Distribution']['constraints']['cost_objective'] == 'entry_round_trip_v1'
    assert len(second['approved_l4_execution_policy_change']['activation_checksums']) == 2


@pytest.mark.parametrize('fault', ['fixed_key', 'noop', 'other_constraint', 'risk', 'identity', 'order', 'skip', 'extra'])
def test_policy_chain_rejects_unreviewed_steps(source_grant, fault):
    admission, _, (_, second), manifest = policy_chain(source_grant, ROUND_TRIP)
    config, chain = second['configuration'], manifest['policy_activations']
    policy = config['trading_config']['l4Distribution']
    named = second['approved_l4_execution_policy_change']['activation_checksums']
    if fault in ('fixed_key', 'noop'):
        # Re-review the forged step so only its content is wrong.
        chain[1]['changes'] = ({'return_history_lookback_sessions': 120} if fault == 'fixed_key'
                               else {'cost_objective': 'single_side_v1'})
        policy['constraints'].update(chain[1]['changes'])
        chain[1]['next_policy_checksum'] = digest(policy)
        named[1] = digest(chain[1])
        second['approved_strategy_nav_source_change']['release_manifest_checksum'] = digest(manifest)
    elif fault == 'other_constraint': policy['constraints']['risk_aversion'] = 3.
    elif fault == 'risk': config['risk_config']['portfolio']['orangeTargetExposure'] = .5
    elif fault == 'identity': policy['opb']['approved_policy_identity'] = 'f' * 64
    elif fault == 'order': named.reverse()
    elif fault == 'skip': named.pop(0)
    elif fault == 'extra': named.append('e' * 64)
    seal(second)
    # A non-prefix grant is not this release's; a reviewed prefix with the wrong content is refused by the chain.
    reason = ('strategy_nav_runtime_source_release_invalid' if fault in ('order', 'skip', 'extra')
              else 'l4_execution_policy_activation_invalid')
    with pytest.raises(RuntimeError, match=reason):
        validate_runtime_approval(second, admission, now=CLOCK)


@pytest.mark.parametrize('changes', [{'return_history_lookback_sessions': 120}, {'cost_objective': 'single_side_v1'},
                                     {'name_cap': .3}, {'cost_objective': 'one_way'}, {}])
def test_constraints_change_document_refuses_unreviewable_changes(source_grant, changes):
    from services.l4_policy_activation import change_document
    _, _, grant = policy_v2_grant(source_grant)
    with pytest.raises(ValueError):
        change_document(grant['configuration']['trading_config'], changes=changes,
                        engineering_receipt_checksum='d' * 64, source_reference='test-only change fixture')


@pytest.mark.parametrize('written', ['none', 'risk_only', 'both'])
def test_staged_policy_v2_grant_switches_only_after_both_kv_writes(source_grant, monkeypatch, written):
    from services import active8_paper_admission as paper, kv_client
    admission, source, candidate = policy_v2_grant(source_grant)
    read = Path.read_text
    monkeypatch.setattr(Path, 'read_text', lambda path, *a, **kw: json.dumps({
        'runtime_admission': 'source-test', 'policy_runtime_admissions': ['policy-test']})
        if path.name == 'native_execution_behavior_release.json' else read(path, *a, **kw))
    trading = (candidate if written == 'both' else source)['configuration']['trading_config']
    risk = (source if written == 'none' else candidate)['configuration']['risk_config']
    values = {paper.KEY: admission, 'source-test': source, 'policy-test': candidate,
              'trading:config': trading, 'trading:risk_config': risk}
    monkeypatch.setattr(kv_client, 'get_json', lambda key, **kwargs: deepcopy(values.get(key)))
    assert paper.verify_active_approval(admission) == (candidate if written == 'both' else source)


@pytest.mark.parametrize('state', ['source', 'P1', 'P2', 'P2_trading_S_risk'])
def test_staged_policy_chain_selects_the_grant_matching_kv(source_grant, monkeypatch, state):
    from services import active8_paper_admission as paper, kv_client
    admission, source, grants, _ = policy_chain(source_grant, ROUND_TRIP)
    read = Path.read_text
    monkeypatch.setattr(Path, 'read_text', lambda path, *a, **kw: json.dumps({
        'runtime_admission': 'source-test', 'policy_runtime_admissions': ['policy-1', 'policy-2']})
        if path.name == 'native_execution_behavior_release.json' else read(path, *a, **kw))
    expected = {'source': source, 'P1': grants[0], 'P2': grants[1], 'P2_trading_S_risk': source}[state]
    trading = (grants[1] if state.startswith('P2') else expected)['configuration']['trading_config']
    risk = expected['configuration']['risk_config']
    values = {paper.KEY: admission, 'source-test': source, 'policy-1': grants[0], 'policy-2': grants[1],
              'trading:config': trading, 'trading:risk_config': risk}
    monkeypatch.setattr(kv_client, 'get_json', lambda key, **kwargs: deepcopy(values.get(key)))
    assert paper.verify_active_approval(admission) == expected


def test_source_release_after_activated_step_pins_that_policy_grant_as_prior(source_grant):
    """TOOL-PK: with P2 live, the next source-only release S' (built by release_admission.new_grant)
    takes the P2 grant as prior, and its own chain continues from P2."""
    from services.active8_paper_admission import runtime_configuration_identity
    from services.l4_policy_activation import change_document, policy_grants
    admission, source, (_, p2), manifest = policy_chain(source_grant, ROUND_TRIP)
    assert validate_runtime_approval(p2, admission, now=CLOCK) == p2
    configuration = p2['configuration']
    manifest.clear()
    manifest.update({'schema_version': 'strategy-nav-source-release-v1', 'scope': 'paper',
        'source_equivalence': False, 'maturity_transfer': False, 'production_baseline_verified': True,
        'prior_approval_checksum': p2['approval_checksum'],
        'prior_configuration_checksum': digest(runtime_configuration_identity(configuration)),
        'approved_sources': {k: configuration[k] for k in ('allocator_source_identity', 'l3_inference_source_identity')},
        'execution_owner_version': native_execution_identity()})
    s_prime = seal({'schema_version': p2['schema_version'], 'admission': p2['admission'], 'scope': 'paper',
        'approved': True, 'maturity_transfer': False, 'efficacy_status': 'unproven',
        'source_reference': 'test-only W-REL', 'approved_at': '2026-10-14T12:30:00Z',
        'configuration': deepcopy(configuration), 'prior_runtime_approval': deepcopy(p2),
        'approved_strategy_nav_source_change': {'release_manifest_checksum': digest(manifest)}})
    assert validate_runtime_approval(s_prime, admission, now=CLOCK) == s_prime
    # Going back to the pre-P1 S is an economic change against prior P2, not a source-only release.
    reverted = deepcopy(s_prime)
    reverted['configuration']['trading_config'] = deepcopy(source['configuration']['trading_config'])
    with pytest.raises(RuntimeError, match='strategy_nav_runtime_economic_configuration_changed'):
        validate_runtime_approval(seal(reverted), admission, now=CLOCK)
    # The S' chain starts from P2 (activate_l4_policy prepare-change --continue-from CHAIN --step 2).
    activation, next_config = change_document(configuration['trading_config'], changes={'risk_aversion': 3.},
        engineering_receipt_checksum='e' * 64, source_reference='test-only continued change')
    manifest['policy_activations'] = [activation]
    s_prime['approved_strategy_nav_source_change']['release_manifest_checksum'] = digest(manifest)
    seal(s_prime)
    (p_next,) = policy_grants(s_prime, [{'activation': activation, 'next_merged_config': next_config,
                                         'next_risk_config': configuration['risk_config']}])
    assert validate_runtime_approval(s_prime, admission, now=CLOCK) == s_prime
    assert validate_runtime_approval(p_next, admission, now=CLOCK) == p_next


# K20 G0b (Wei 2026-11-12 Q9): a risk-only P1 adds risk_config fields; the policy stays S's.
RISK_FIELDS = {'position.minCorrelationOverlap': 20}
# The four position fields live trading:risk_config carries (runbook §2.1a read-back, 11/5).
LIVE_POSITION = {'maxSingleNamePct': .25, 'maxPerSector': 2, 'correlationThreshold': .65, 'correlationWindow': 60}


def risk_chain(source_grant, risk_fields=RISK_FIELDS):
    """S plus a risk-only P1 over the V1 policy of policy_chain's S."""
    from services.l4_policy_activation import policy_grants, risk_change_document
    admission, approval, manifest = source_grant
    prior = approval['prior_runtime_approval']
    config = prior['configuration']
    config['trading_config'].update(l4Distribution=deepcopy(V1_POLICY))
    config['risk_config'] = {'system': {'killSwitch': False}, 'position': deepcopy(LIVE_POSITION)}
    config['native_execution_policy']['variables']['LIVE_EXECUTION_SUBMIT_GUARD_ENABLED'] = '0'
    seal(prior)
    manifest['prior_approval_checksum'] = prior['approval_checksum']
    manifest['prior_configuration_checksum'] = digest(config)
    for name in ('trading_config', 'risk_config'):
        approval['configuration'][name] = deepcopy(config[name])
    approval['configuration']['native_execution_policy']['variables']['LIVE_EXECUTION_SUBMIT_GUARD_ENABLED'] = '0'
    activation, next_risk = risk_change_document(config['trading_config'], config['risk_config'],
        risk_fields=risk_fields, engineering_receipt_checksum='e' * 64, source_reference='test-only risk fixture')
    packets = [{'activation': activation, 'next_merged_config': deepcopy(config['trading_config']),
                'next_risk_config': next_risk}]
    manifest['policy_activations'] = [activation]
    approval['approved_strategy_nav_source_change']['release_manifest_checksum'] = digest(manifest)
    source = seal(approval)
    return admission, source, policy_grants(source, packets)[0]


def test_risk_only_grant_accepts_exactly_the_declared_added_fields(source_grant):
    admission, source, candidate = risk_chain(source_grant)
    assert validate_runtime_approval(source, admission, now=CLOCK) == source
    assert validate_runtime_approval(candidate, admission, now=CLOCK) == candidate
    assert candidate['configuration']['risk_config']['position'] == {**LIVE_POSITION, 'minCorrelationOverlap': 20}
    assert (candidate['configuration']['trading_config']['l4Distribution']
            == source['configuration']['trading_config']['l4Distribution'])
    wrong = deepcopy(candidate)
    wrong['configuration']['risk_config']['position']['minCorrelationOverlap'] = 21
    with pytest.raises(RuntimeError):
        validate_runtime_approval(seal(wrong), admission, now=CLOCK)
    moved = deepcopy(candidate)
    moved['configuration']['trading_config']['l4Distribution']['constraints']['name_cap'] = .2
    with pytest.raises(RuntimeError):
        validate_runtime_approval(seal(moved), admission, now=CLOCK)


def test_risk_only_document_never_moves_a_present_field_or_the_policy():
    from services.l4_policy_activation import expected_configuration, risk_change_document
    trading, risk = {'l4Distribution': deepcopy(V1_POLICY)}, {'position': deepcopy(LIVE_POSITION)}
    with pytest.raises(ValueError, match='risk_field_present'):
        risk_change_document(trading, risk, risk_fields={'position.maxSingleNamePct': .3},
                             engineering_receipt_checksum='e' * 64, source_reference='x')
    with pytest.raises(ValueError):
        risk_change_document(trading, risk, risk_fields={}, engineering_receipt_checksum='e' * 64, source_reference='x')
    activation, next_risk = risk_change_document(trading, risk, risk_fields=RISK_FIELDS,
                                                 engineering_receipt_checksum='e' * 64, source_reference='x')
    assert expected_configuration({'trading_config': trading, 'risk_config': risk}, activation) == (trading, next_risk)
    forged = {**activation, 'next_policy_checksum': '0' * 64}
    with pytest.raises(ValueError):
        expected_configuration({'trading_config': trading, 'risk_config': risk}, forged)


@pytest.mark.parametrize('kv_state', ['before_risk_write', 'after_risk_write'])
def test_risk_only_grant_is_not_active_until_the_risk_write_lands(source_grant, monkeypatch, kv_state):
    """The policy is unchanged, so only trading:risk_config tells P1 from S."""
    from services import active8_paper_admission as paper, kv_client
    admission, source, candidate = risk_chain(source_grant)
    read = Path.read_text
    monkeypatch.setattr(Path, 'read_text', lambda path, *a, **kw: json.dumps({
        'runtime_admission': 'source-test', 'policy_runtime_admission': 'policy-test'})
        if path.name == 'native_execution_behavior_release.json' else read(path, *a, **kw))
    granted = candidate if kv_state == 'after_risk_write' else source
    values = {paper.KEY: admission, 'source-test': source, 'policy-test': candidate,
              'trading:config': source['configuration']['trading_config'],
              'trading:risk_config': granted['configuration']['risk_config']}
    monkeypatch.setattr(kv_client, 'get_json', lambda key, **kwargs: deepcopy(values.get(key)))
    assert paper.verify_active_approval(admission) == granted


# --- OPB v2 -> v3 schema change (l4-policy-opb-schema-change-v1): S = v2, P1 = v3 -------------------

def opb_chain(source_grant, opb=V3_OPB):
    """S at a v2 policy (the v1 -> v2 owner move of V1_POLICY, already live) plus P1 = its v3 OPB block."""
    from services.l4_policy_activation import activation_document, opb_change_document, policy_grants
    admission, approval, manifest = source_grant
    prior = approval['prior_runtime_approval']
    config = prior['configuration']
    trading = {**config['trading_config'], 'l4Distribution': deepcopy(V1_POLICY),
               'position': {'maxPctOfPortfolio': .25, 'maxPositions': 5},
               'circuit': {'maxPositionPct': .08, 'highVolReducedPosPct': .04}}
    risk = {'system': {'killSwitch': False}, 'portfolio': {'dailyPnlLossLimitPct': -.03},
            'position': {'maxSingleNamePct': .25}, 'order': {}}
    _, v2_trading, v2_risk = activation_document(trading, risk, lookback=252, cost_objective='entry_round_trip_v1',
        risk_defaults=RISK_DEFAULTS, engineering_receipt_checksum='c' * 64, source_reference='test-only v2 S')
    config['trading_config'], config['risk_config'] = v2_trading, v2_risk
    config['native_execution_policy']['variables']['LIVE_EXECUTION_SUBMIT_GUARD_ENABLED'] = '0'
    seal(prior)
    manifest['prior_approval_checksum'] = prior['approval_checksum']
    manifest['prior_configuration_checksum'] = digest(config)
    for name in ('trading_config', 'risk_config'):
        approval['configuration'][name] = deepcopy(config[name])
    approval['configuration']['native_execution_policy']['variables']['LIVE_EXECUTION_SUBMIT_GUARD_ENABLED'] = '0'
    activation, next_config = opb_change_document(v2_trading, opb=deepcopy(opb),
        engineering_receipt_checksum='d' * 64, source_reference='test-only v3 OPB fixture')
    manifest['policy_activations'] = [activation]
    approval['approved_strategy_nav_source_change']['release_manifest_checksum'] = digest(manifest)
    source = seal(approval)
    (p1,) = policy_grants(source, [{'activation': activation, 'next_merged_config': next_config,
                                    'next_risk_config': deepcopy(v2_risk)}])
    return admission, source, p1, manifest


def test_opb_v3_grant_accepts_exactly_the_recomputed_opb_block(source_grant):
    from services.l4_distribution_runtime import distribution_policy_identity
    from services.l4_opb_selection import is_v2, is_v3
    admission, source, p1, _ = opb_chain(source_grant)
    assert validate_runtime_approval(source, admission, now=CLOCK) == source
    assert validate_runtime_approval(p1, admission, now=CLOCK) == p1
    s_config, p_config = source['configuration'], p1['configuration']
    s_policy, p_policy = (c['trading_config']['l4Distribution'] for c in (s_config, p_config))
    assert is_v2(s_policy) and not is_v3(s_policy) and is_v3(p_policy)
    assert {k: v for k, v in p_policy.items() if k != 'opb'} == {k: v for k, v in s_policy.items() if k != 'opb'}
    assert {k: v for k, v in p_policy['opb'].items() if k not in ('approved_policy_identity', 'migration')} == V3_OPB
    assert p_policy['opb']['migration'] == {
        'source_policy_identity': s_policy['opb']['approved_policy_identity'],
        'arm_semantic': 'allocator_selection_override', 'replaced_v2_arms': s_policy['opb']['arms'],
        'v2_migration': s_policy['opb']['migration']}
    assert p_policy['opb']['approved_policy_identity'] == distribution_policy_identity(
        p_policy, p_policy['artifact']['l3_identity']) != s_policy['opb']['approved_policy_identity']
    assert p_config['risk_config'] == s_config['risk_config']
    assert {k: v for k, v in p_config['trading_config'].items() if k != 'l4Distribution'} == {
        k: v for k, v in s_config['trading_config'].items() if k != 'l4Distribution'}


@pytest.mark.parametrize('fault', ['constraints', 'artifact', 'knob', 'arm', 'proxy', 'identity', 'risk', 'fees',
                                   'live', 'policy_field', 'migration_dropped', 'migration_source',
                                   'migration_reidentified'])
def test_tampered_opb_v3_grant_fails_closed(source_grant, fault):
    admission, _, p1, _ = opb_chain(source_grant)
    config = p1['configuration']
    policy = config['trading_config']['l4Distribution']
    if fault == 'constraints': policy['constraints']['risk_aversion'] = 3.
    elif fault == 'artifact': policy['artifact']['model_checksum'] = 'f' * 64
    elif fault == 'knob': policy['opb']['family_error_rate'] = .2
    elif fault == 'arm': policy['opb']['arms'][1]['risk_aversion'] = .6
    elif fault == 'proxy': del policy['opb']['market_proxy']      # same identity, not the reviewed block
    elif fault == 'identity': policy['opb']['approved_policy_identity'] = 'f' * 64
    elif fault == 'risk': config['risk_config']['portfolio']['dailyPnlLossLimitPct'] = -.05
    elif fault == 'fees': config['trading_config']['fees']['commission'] = 0
    elif fault == 'live': config['native_execution_policy']['variables']['LIVE_EXECUTION_CLIENT_ENABLED'] = '1'
    elif fault == 'policy_field': policy['strategy_role'] = 'A'
    elif fault == 'migration_dropped': del policy['opb']['migration']
    elif fault == 'migration_source': policy['opb']['migration']['source_policy_identity'] = 'f' * 64
    elif fault == 'migration_reidentified':
        # A self-consistent policy (identity recomputed) whose record names another source.
        from services.l4_distribution_runtime import distribution_policy_identity
        policy['opb']['migration']['v2_migration'] = None
        policy['opb']['approved_policy_identity'] = distribution_policy_identity(policy, policy['artifact']['l3_identity'])
    seal(p1)
    with pytest.raises(RuntimeError, match='l4_execution_policy_activation_invalid'):
        validate_runtime_approval(p1, admission, now=CLOCK)


@pytest.mark.parametrize('forgery', ['opb_without_rechecksum', 'rereviewed_other_opb', 'v2_target', 'missing_knob',
                                     'supplied_migration'])
def test_runtime_approval_recomputes_the_opb_step_instead_of_trusting_the_document(source_grant, forgery):
    """strategy_nav_runtime_approval accepts the new schema only through expected_configuration's recomputation."""
    from services.l4_policy_activation import next_opb_policy
    admission, source, p1, manifest = opb_chain(source_grant)
    activation = manifest['policy_activations'][0]
    if forgery == 'opb_without_rechecksum':
        activation['opb'] = {**activation['opb'], 'min_exposure_ratio': .4}
    elif forgery == 'rereviewed_other_opb':
        # The document is consistent with itself (checksums recomputed for another block),
        # but the grant still carries the reviewed configuration: no longer the recomputed step.
        other = {**V3_OPB, 'hac_lag_sessions': 3}
        v2 = source['configuration']['trading_config']['l4Distribution']
        forged = next_opb_policy(v2, other)
        activation.update(opb=other, next_policy_checksum=digest(forged),
                          next_policy_identity=forged['opb']['approved_policy_identity'])
    elif forgery == 'v2_target':
        activation['opb'] = {**activation['opb'], 'schema_version': 'l4-opb-relative-arms-v2'}
    elif forgery == 'missing_knob':
        activation['opb'] = {k: v for k, v in activation['opb'].items() if k != 'cutover_warm_start'}
    elif forgery == 'supplied_migration':
        # The reviewed block carries the derived record itself: still refused, the record has one owner.
        derived = p1['configuration']['trading_config']['l4Distribution']['opb']['migration']
        activation['opb'] = {**activation['opb'], 'migration': deepcopy(derived)}
    p1['approved_l4_execution_policy_change'] = {'activation_checksums': [digest(activation)]}
    source['approved_strategy_nav_source_change']['release_manifest_checksum'] = digest(manifest)
    p1['approved_strategy_nav_source_change'] = deepcopy(source['approved_strategy_nav_source_change'])
    seal(p1)
    with pytest.raises(RuntimeError, match='l4_execution_policy_activation_invalid'):
        validate_runtime_approval(p1, admission, now=CLOCK)


@pytest.mark.parametrize('kv_state', ['source', 'p1'])
def test_staged_opb_v3_grant_is_active_only_after_the_trading_config_write(source_grant, monkeypatch, kv_state):
    from services import active8_paper_admission as paper, kv_client
    admission, source, p1, _ = opb_chain(source_grant)
    read = Path.read_text
    monkeypatch.setattr(Path, 'read_text', lambda path, *a, **kw: json.dumps({
        'runtime_admission': 'source-test', 'policy_runtime_admissions': ['policy-test']})
        if path.name == 'native_execution_behavior_release.json' else read(path, *a, **kw))
    granted = p1 if kv_state == 'p1' else source
    values = {paper.KEY: admission, 'source-test': source, 'policy-test': p1,
              'trading:config': granted['configuration']['trading_config'],
              'trading:risk_config': source['configuration']['risk_config']}
    monkeypatch.setattr(kv_client, 'get_json', lambda key, **kwargs: deepcopy(values.get(key)))
    assert paper.verify_active_approval(admission) == granted


# OPB schema-change chains: attacks beyond the single-link tests above.
OPB_CHAIN_INVALID = 'l4_execution_policy_activation_invalid'


def _opb_restage(source, manifest, packets):
    """Release with this chain: manifest + S re-sealed, P1..Pn derived exactly as policy_grants does."""
    from services.l4_policy_activation import policy_grants
    manifest['policy_activations'] = [p['activation'] for p in packets]
    source['approved_strategy_nav_source_change']['release_manifest_checksum'] = digest(manifest)
    seal(source)
    return policy_grants(source, packets)


def _opb_attack_world(source_grant):
    admission, source, p1, manifest = opb_chain(source_grant)
    s = source['configuration']
    act = manifest['policy_activations'][0]
    pk = {'activation': act, 'next_merged_config': p1['configuration']['trading_config'],
          'next_risk_config': p1['configuration']['risk_config']}
    return admission, source, manifest, s, pk


def test_second_opb_link_after_v3_is_refused(source_grant):
    admission, source, manifest, s, pk = _opb_attack_world(source_grant)
    v3 = pk['next_merged_config']['l4Distribution']
    forged_l4 = {**deepcopy(v3), 'opb': {**deepcopy(v3['opb']), 'hac_lag_sessions': 3}}
    act2 = {**deepcopy(pk['activation']), 'opb': {**V3_OPB, 'hac_lag_sessions': 3},
            'previous_policy_checksum': digest(v3), 'next_policy_checksum': digest(forged_l4),
            'next_policy_identity': forged_l4['opb']['approved_policy_identity']}
    pk2 = {'activation': act2, 'next_merged_config': {**deepcopy(pk['next_merged_config']), 'l4Distribution': forged_l4},
           'next_risk_config': deepcopy(pk['next_risk_config'])}
    p1, p2 = _opb_restage(source, manifest, [pk, pk2])
    assert validate_runtime_approval(p1, admission, now=CLOCK) == p1
    with pytest.raises(RuntimeError, match=OPB_CHAIN_INVALID):
        validate_runtime_approval(p2, admission, now=CLOCK)


def test_same_opb_link_twice_is_refused(source_grant):
    admission, source, manifest, s, pk = _opb_attack_world(source_grant)
    p1, p2 = _opb_restage(source, manifest, [pk, deepcopy(pk)])
    with pytest.raises(RuntimeError, match=OPB_CHAIN_INVALID):
        validate_runtime_approval(p2, admission, now=CLOCK)


def _risk_link(trading, risk):
    from services.l4_policy_activation import risk_change_document
    act, nxt = risk_change_document(trading, risk, risk_fields={'order.opbChainOnlyField': 1},
        engineering_receipt_checksum='e' * 64, source_reference='risk link')
    return {'activation': act, 'next_merged_config': deepcopy(trading), 'next_risk_config': nxt}


def test_opb_after_a_risk_link_is_the_recomputed_composition(source_grant):
    from services.l4_policy_activation import opb_change_document
    admission, source, manifest, s, pk = _opb_attack_world(source_grant)
    risk = _risk_link(s['trading_config'], s['risk_config'])
    act, nxt = opb_change_document(s['trading_config'], opb=deepcopy(V3_OPB), engineering_receipt_checksum='d' * 64,
                                   source_reference='opb after risk')
    opb = {'activation': act, 'next_merged_config': nxt, 'next_risk_config': risk['next_risk_config']}
    p1, p2 = _opb_restage(source, manifest, [risk, opb])
    assert validate_runtime_approval(p1, admission, now=CLOCK) == p1
    assert validate_runtime_approval(p2, admission, now=CLOCK) == p2
    # The opb link must not drop the risk link's field (risk is recomputed, not trusted).
    p2['configuration']['risk_config'] = deepcopy(s['risk_config']); seal(p2)
    with pytest.raises(RuntimeError, match=OPB_CHAIN_INVALID):
        validate_runtime_approval(p2, admission, now=CLOCK)


def test_risk_after_the_opb_link_is_the_recomputed_composition(source_grant):
    admission, source, manifest, s, pk = _opb_attack_world(source_grant)
    risk = _risk_link(pk['next_merged_config'], pk['next_risk_config'])
    p1, p2 = _opb_restage(source, manifest, [pk, risk])
    assert validate_runtime_approval(p2, admission, now=CLOCK) == p2


@pytest.mark.parametrize('named', ['second_only', 'beyond_chain', 'reversed'])
def test_grant_naming_anything_but_a_prefix_is_refused(source_grant, named):
    admission, source, manifest, s, pk = _opb_attack_world(source_grant)
    risk = _risk_link(pk['next_merged_config'], pk['next_risk_config'])
    p1, p2 = _opb_restage(source, manifest, [pk, risk])
    a1, a2 = digest(pk['activation']), digest(risk['activation'])
    if named == 'second_only':
        p2['approved_l4_execution_policy_change'] = {'activation_checksums': [a2]}
    elif named == 'beyond_chain':
        p2['approved_l4_execution_policy_change'] = {'activation_checksums': [a1, a2, a2]}
    else:
        p2['approved_l4_execution_policy_change'] = {'activation_checksums': [a2, a1]}
    seal(p2)
    with pytest.raises(RuntimeError, match='strategy_nav_runtime_source_release_invalid|' + OPB_CHAIN_INVALID):
        validate_runtime_approval(p2, admission, now=CLOCK)


def test_an_opb_link_from_another_release_chain_is_refused(source_grant):
    """continue-from pointing at another chain: its v2 source is not this release's S."""
    from services.l4_policy_activation import next_constraints_policy, opb_change_document
    admission, source, manifest, s, pk = _opb_attack_world(source_grant)
    other_l4 = next_constraints_policy(s['trading_config']['l4Distribution'], {'risk_aversion': 3.})
    other = {**deepcopy(s['trading_config']), 'l4Distribution': other_l4}
    act, nxt = opb_change_document(other, opb=deepcopy(V3_OPB), engineering_receipt_checksum='d' * 64,
                                   source_reference='foreign chain')
    (p1,) = _opb_restage(source, manifest, [{'activation': act, 'next_merged_config': nxt,
                                        'next_risk_config': deepcopy(s['risk_config'])}])
    with pytest.raises(RuntimeError, match=OPB_CHAIN_INVALID):
        validate_runtime_approval(p1, admission, now=CLOCK)


def test_smuggled_risk_fields_on_the_opb_document_do_not_move_risk(source_grant):
    admission, source, manifest, s, pk = _opb_attack_world(source_grant)
    act = {**deepcopy(pk['activation']), 'risk_config_added_fields': {'order.opbChainOnlyField': 1}}
    moved = deepcopy(pk['next_risk_config']); moved.setdefault('order', {})['opbChainOnlyField'] = 1
    (p1,) = _opb_restage(source, manifest, [{**pk, 'activation': act, 'next_risk_config': moved}])
    with pytest.raises(RuntimeError, match=OPB_CHAIN_INVALID):
        validate_runtime_approval(p1, admission, now=CLOCK)


def test_mixing_the_v1_execution_activation_into_an_opb_chain_is_refused(source_grant):
    admission, source, manifest, s, pk = _opb_attack_world(source_grant)
    v1 = {'schema_version': 'l4-execution-policy-activation-v1', 'scope': 'paper', 'maturity_transfer': False,
          'account_reset': False}
    p1, p2 = _opb_restage(source, manifest, [pk, {'activation': v1, 'next_merged_config': pk['next_merged_config'],
                                             'next_risk_config': pk['next_risk_config']}])
    with pytest.raises(RuntimeError, match=OPB_CHAIN_INVALID):
        validate_runtime_approval(p2, admission, now=CLOCK)


def test_derived_identity_supplied_in_the_opb_block_is_refused(source_grant):
    admission, source, manifest, s, pk = _opb_attack_world(source_grant)
    ident = pk['next_merged_config']['l4Distribution']['opb']['approved_policy_identity']
    act = {**deepcopy(pk['activation']), 'opb': {**V3_OPB, 'approved_policy_identity': ident}}
    (p1,) = _opb_restage(source, manifest, [{**pk, 'activation': act}])
    with pytest.raises(RuntimeError, match=OPB_CHAIN_INVALID):
        validate_runtime_approval(p1, admission, now=CLOCK)


def test_unchecksummed_grant_config_with_a_valid_but_different_v3_block_is_refused(source_grant):
    """Grant carries another valid v3 block whose identity it recomputed; the manifest still names the reviewed one."""
    from services.l4_policy_activation import next_opb_policy
    admission, source, manifest, s, pk = _opb_attack_world(source_grant)
    (p1,) = _opb_restage(source, manifest, [pk])
    p1['configuration']['trading_config']['l4Distribution'] = next_opb_policy(
        s['trading_config']['l4Distribution'], {**V3_OPB, 'critical_value_simulations': 5000})
    seal(p1)
    with pytest.raises(RuntimeError, match=OPB_CHAIN_INVALID):
        validate_runtime_approval(p1, admission, now=CLOCK)


def test_opb_block_missing_market_proxy_but_same_identity_is_refused_at_document_level(source_grant):
    """canonical_opb makes the identity equal; the document still needs the explicit field."""
    from services.l4_opb_selection import canonical_opb
    from services.l4_policy_activation import next_opb_policy
    admission, source, manifest, s, pk = _opb_attack_world(source_grant)
    v2 = s['trading_config']['l4Distribution']
    full = next_opb_policy(v2, deepcopy(V3_OPB))
    assert canonical_opb(full['opb'])['approved_policy_identity'] == full['opb']['approved_policy_identity']
    with pytest.raises(ValueError, match='field_missing:market_proxy'):
        next_opb_policy(v2, {k: v for k, v in V3_OPB.items() if k != 'market_proxy'})
    other = next_opb_policy(v2, {**V3_OPB, 'market_proxy': '0056'})
    assert other['opb']['approved_policy_identity'] != full['opb']['approved_policy_identity']
