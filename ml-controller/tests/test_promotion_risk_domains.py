"""Policy/configuration parsing controls shared by actual verdict and display."""
from dataclasses import replace
import json

import pytest

from services.promotion_policy import PromotionPolicy, _as_int, evaluate_promotion_candidate
from services.promotion_service import normalize_latest_backtest_row, normalize_latest_monte_carlo_row, normalize_latest_pbo_row
from services.validation_governance import build_validation_packet
from test_promotion_policy import _passing_inputs


@pytest.mark.parametrize('value', [-.01, '-3%', 'not-a-number', float('nan'), None, True])
def test_bad_risk_magnitudes_fail_both_decision_and_display(value):
    backtest, mc, pbo = _passing_inputs()
    backtest['max_drawdown'] = mc['mdd_95th'] = pbo['pbo'] = value
    verdict = evaluate_promotion_candidate(backtest, mc, pbo)
    assert {'backtest_max_drawdown', 'monte_carlo_mdd_95th', 'pbo_probability'} <= set(verdict['failed_gates'])
    packet = build_validation_packet(source='promotion_gate', backtest=backtest, monte_carlo=mc, pbo=pbo)
    gates = {row['name']: row for row in packet['gates']}
    for name in ('backtest_return_quality', 'monte_carlo_tail_risk', 'pbo_overfit_risk'):
        assert gates[name]['status'] == 'FAIL'


def test_real_zero_risk_and_existing_percentage_format_remain_valid():
    backtest, mc, pbo = _passing_inputs()
    for value in (0, '0%', '10%'):
        backtest['max_drawdown'] = mc['mdd_95th'] = pbo['pbo'] = value
        assert evaluate_promotion_candidate(backtest, mc, pbo)['decision'] == 'PASS'


@pytest.mark.parametrize('name,value', [
    ('PROMOTION_MIN_TRADES', 'n/a'), ('PROMOTION_MIN_TRADES', '-1'),
    ('PROMOTION_MIN_TRADES', '0'), ('PROMOTION_MAX_PBO', '150%'),
    ('PROMOTION_MAX_PBO', '1.5'), ('PROMOTION_MAX_MC_MDD_95TH', '-.2'),
])
def test_invalid_configuration_never_silently_installs_a_default(monkeypatch, name, value):
    monkeypatch.setenv(name, value)
    with pytest.raises(ValueError, match='promotion_policy_'):
        PromotionPolicy.from_env()


def test_direct_policy_construction_cannot_bypass_validation():
    for kwargs in ({'min_trades': True}, {'max_pbo': float('nan')}, {'min_regime_trades': 1.5}):
        with pytest.raises(ValueError, match='promotion_policy_'):
            PromotionPolicy(**kwargs)


@pytest.mark.parametrize('regime', [[], None, 'missing', {'bear': None}, {'bear': {'trades': -1}},
                                   {'bear': {'trades': 10.5}}, {'bear': {'return': -.1}}])
def test_invalid_regime_evidence_is_not_silently_dropped(regime):
    backtest, mc, pbo = _passing_inputs()
    backtest['per_regime'] = regime
    verdict = evaluate_promotion_candidate(backtest, mc, pbo)
    assert verdict['decision'] == 'FAIL'
    assert any(g.startswith('regime_') for g in verdict['failed_gates'])


def test_source_normalization_preserves_unknown_not_a_fake_one_hundred_percent_loss():
    backtest = normalize_latest_backtest_row({'raw_results': json.dumps({'per_regime': ['corrupt']})})
    assert backtest['max_drawdown'] is None and backtest['per_regime'] == ['corrupt']
    assert normalize_latest_monte_carlo_row({})['mdd_95th'] is None
    assert normalize_latest_pbo_row({})['pbo'] is None
    b, mc, pbo = _passing_inputs()
    b['max_drawdown'] = None
    assert 'backtest_max_drawdown' in evaluate_promotion_candidate(b, mc, pbo,
        policy=replace(PromotionPolicy(), max_backtest_mdd=1.0))['failed_gates']


def test_counts_never_truncate_fractional_or_boolean_evidence():
    assert _as_int(10.9, -1) == _as_int(True, -1) == -1
    assert _as_int('10.0', -1) == _as_int(10, -1) == 10


def test_regime_ui_preserves_zero_and_distinguishes_missing_from_harm():
    from services.validation_governance import _regime_split_gate
    backtest, _, _ = _passing_inputs()
    backtest['per_regime']['bear_market'] = {'trades': 30, 'return': 0, 'total_return': -.5}
    gate = _regime_split_gate(backtest, policy={}, required=True)
    assert gate['status'] == 'PASS'
    assert gate['evidence']['per_regime']['bear_market']['return'] == 0
    backtest['per_regime']['bear_market']['return'] = None
    backtest['per_regime']['bear_market'].pop('total_return')
    gate = _regime_split_gate(backtest, policy={}, required=True)
    assert gate['status'] == 'FAIL'
    assert gate['evidence']['missing_return_regimes'] == ['bear_market']
    assert gate['evidence']['weak_regimes'] == []


def test_parameter_candidates_cannot_skip_existing_promotion_grade_governance_by_source_name():
    backtest, mc, pbo = _passing_inputs()
    packet = build_validation_packet(source='parameter_candidate_evidence_gate',
        backtest=backtest, monte_carlo=mc, pbo=pbo)
    gates = {g['name']: g for g in packet['gates']}
    assert gates['deflated_sharpe']['status'] == 'FAIL'
    assert gates['walk_forward']['status'] == 'FAIL'
    assert packet['decision'] == 'FAIL'


@pytest.mark.parametrize('identity', [None, '', ' ', True, {'id': 'pretend'}])
def test_evidence_id_does_not_substitute_for_missing_candidate_identity(identity):
    from services.promotion_service import evaluate_alpha_policy_evidence_gate, evaluate_parameter_candidate_evidence_gate
    backtest, mc, pbo = _passing_inputs()
    evidence = {'candidate_id': 'another-candidate', 'backtest': backtest, 'monte_carlo': mc, 'pbo': pbo}
    for evaluate, reason in ((evaluate_alpha_policy_evidence_gate, 'alpha_candidate_identity_missing'),
                             (evaluate_parameter_candidate_evidence_gate, 'parameter_candidate_identity_missing')):
        verdict = evaluate({'id': identity}, evidence)
        assert verdict['decision'] == 'FAIL'
        assert reason in verdict['failed_gates']
