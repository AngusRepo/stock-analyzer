"""Original OPB solver in isolation, never fabricated production approval."""
from copy import deepcopy
from datetime import datetime, timezone

import pytest

from services.opb_counterfactual_prior import build_opb_arm_prior_artifact
from services.paired_nav_intervention import active_intervention, run_isolated_allocation
from services.paired_nav_journal import digest
from services import online_portfolio_bandit, recommendation_service
from test_paired_nav_intervention import inputs, reject_observer_io


def prior():
    return build_opb_arm_prior_artifact(rows=[], price_rows=[],
        expected_return_owner='l4_alpha_ev', trained_until='2026-08-25')['artifact']


def run(prior_artifact=None, **kwargs):
    artifact = prior_artifact if prior_artifact is not None else prior()
    return run_isolated_allocation(inputs=inputs(), inherited_state={},
        owner='opb_arm_prior', candidate_checksum=digest(artifact), opb_prior=artifact,
        decision_at=datetime.now(timezone.utc), **kwargs)


def test_offline_fail_can_produce_real_opb_plan_without_control_approval():
    artifact = prior()
    before = deepcopy(artifact)
    baseline = run_isolated_allocation(inputs=inputs(), inherited_state={})
    result = run(artifact)
    assert artifact == before and artifact['validation']['decision'] == 'FAIL'
    assert 'production_control_approved' not in artifact['validation']
    assert result['capture']['opb_packet']['status'] == 'ok'
    assert result['capture']['allocation_contract']['controller_effective'] == 'OnlinePortfolioBandit'
    assert result['capture']['allocation_contract']['opb_production_control_allowed'] is False
    assert result['capture']['opb_packet']['stage'] == 'isolated_nav_candidate_allocation'
    assert result['capture']['effective_weights'] != baseline['capture']['effective_weights']
    assert result['can_write_order'] is False and result['nav_maturity_credit'] == 0
    assert result['production_effect'] is False and result['promotion_allowed'] is False
    assert active_intervention() is None
    assert run_isolated_allocation(inputs=inputs(), inherited_state={}) == baseline


def test_json_candidate_prior_does_not_enable_formal_control():
    config = inputs('OnlinePortfolioBandit')
    config['alpha_policy']['allocation']['opb_arm_prior'] = prior()
    config['alpha_policy']['allocation']['isolated_nav_candidate'] = True
    result = run_isolated_allocation(inputs=config, inherited_state={})
    assert result['capture']['allocation_contract']['controller_effective'] == 'SparseTangent'
    assert result['capture']['opb_packet']['status'] == 'shadow_only'


def test_original_opb_error_is_not_reported_as_successful_sparse_comparison(monkeypatch):
    def failed(**kwargs):
        raise RuntimeError('original_solver_failure')
    monkeypatch.setattr(online_portfolio_bandit, 'build_online_portfolio_bandit_l2_packet', failed)
    with pytest.raises(RuntimeError, match='original_solver_failure'):
        run()
    assert active_intervention() is None


def test_empty_successful_opb_allocation_is_not_replaced_by_sparse(monkeypatch):
    original = online_portfolio_bandit.build_online_portfolio_bandit_l2_packet
    def empty(**kwargs):
        packet = original(**kwargs)
        packet['controlled_allocation']['weights'] = {}
        return packet
    monkeypatch.setattr(online_portfolio_bandit, 'build_online_portfolio_bandit_l2_packet', empty)
    result = run()
    assert result['capture']['effective_weights'] == {}
    assert result['capture']['allocation_contract']['controller_effective'] == 'OnlinePortfolioBandit'


@pytest.mark.parametrize('field,value', [('generated_at', '2099-01-01T00:00:00+00:00'),
    ('generated_at', '2026-08-25T00:00:00'), ('trained_until', '2099-01-01'),
    ('expected_return_owner', 'allocator_ev_fusion'), ('arm_priors', []),
    ('source_expected_return_semantic', 'gross_return')])
def test_unavailable_or_incompatible_prior_never_silently_uses_default(field, value):
    artifact = prior()
    artifact[field] = value
    with pytest.raises(ValueError, match='paired_nav_'):
        run(artifact)
    assert active_intervention() is None


def test_two_interventions_cannot_change_ev_and_opb_in_one_contrast():
    with pytest.raises(ValueError, match='paired_nav_'):
        run(forecasts={'2330': .1, '2317': .01})
    assert active_intervention() is None


def test_abstained_fusion_preserves_actual_l4_identity_not_rejected_overlay(monkeypatch):
    monkeypatch.setattr(recommendation_service, 'materialize_allocator_ev_fusion', lambda *_a, **_kw: {
        'status': 'blocked', 'primary_expected_return_allowed': False,
        'model_version': 'rejected-fusion', 'trained_until': '2026-09-01',
        'feature_snapshot_version': 'rejected-features', 'blockers': ['fixture_rejected']})
    result = run_isolated_allocation(inputs=inputs(), inherited_state={})
    for row in result['recommendations']:
        resolver = row['_allocator_edge_resolver']
        assert resolver['expected_return_owner'] == 'l4_alpha_ev'
        assert resolver['model_version'] == row['l4_alpha_ev']['model_version'] == 'l4-test'
        assert resolver['trained_until'] == row['l4_alpha_ev']['trained_until'] == '2026-07-01'
        assert row['_expected_return_payload']['overlay_candidate_model_version'] == 'rejected-fusion'
    assert all(row['expected_return_model_version'] == 'l4-test'
               for row in result['capture']['allocation_candidates'])


def test_isolated_retries_do_not_change_when_wall_clock_crosses_midnight(monkeypatch):
    original = inputs()
    before = run_isolated_allocation(inputs=original, inherited_state={})
    class NoWallClock:
        @staticmethod
        def now(*_a):
            raise AssertionError('isolated replay cannot consult current observer date')
    monkeypatch.setattr(recommendation_service, 'datetime', NoWallClock)
    assert run_isolated_allocation(inputs=original, inherited_state={}) == before
