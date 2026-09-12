"""Synthetic accounting/numerical tests, never investment-performance evidence."""
from datetime import date, datetime, timedelta, timezone

import numpy as np
import pytest

from services.paired_nav_effect_inference import NavEffectPolicy, evaluate_nav_effects, _stationary_means
from services.paired_nav_journal import mature_staged_pairs, stage_execution_receipt
from test_paired_nav_chain import corrupt_payload, populated
from test_paired_nav_journal import DB, packet, receipt, seal, buy
from test_paired_nav_lifecycle import environment, registered_old, successor_context, collect

POLICY = NavEffectPolicy('test-fixed-sample-only', 10, .05, 3, 1999)
NOW = datetime(2026, 10, 31, 8, tzinfo=timezone.utc)


def price_path(prices):
    db = DB(legacy_assessments=False)
    previous, day, days = None, date(2026, 9, 7), []
    for price in prices:
        day += timedelta(days=1)
        while day.weekday() >= 5:
            day += timedelta(days=1)
        session = day.isoformat()
        p = packet(session, previous)
        frozen = seal(db, p, previous or '2026-09-07')
        r = receipt(p, frozen, fills=[buy()] if previous is None else [], marks={'2330': price})
        stage_execution_receipt(execution=r, query=db.query, writer=db.writer, now=NOW)
        days.append(session)
        previous = session
    mature_staged_pairs(business_date=days[-1], query=db.query, writer=db.writer, now=NOW)
    return db, days


def test_actual_receipts_cost_once_losses_kept_no_date_reset_and_read_only():
    prices = [110, 90, 101, 96, 115, 92, 88, 97, 91, 85, 100, 102]
    db, days = price_path(prices)
    original = db.query('SELECT * FROM paired_nav_daily_journal_v1', [])
    nine = evaluate_nav_effects(now=NOW, business_date=days[8], query=db.query, policy=POLICY)
    assert nine['pairs'][0]['reason'] == 'nav_sessions_incomplete'
    assert nine['pairs'][0]['accounted_sessions'] == 9
    ten = evaluate_nav_effects(now=NOW, business_date=days[9], query=db.query, policy=POLICY)
    pair = ten['pairs'][0]
    navs = [100000] + [89980 + 100 * p for p in prices[:10]]
    returns = [new / old - 1 for old, new in zip(navs, navs[1:])]
    assert min(returns) < 0 < max(returns)
    assert pair['mean_daily_nav_delta'] == pytest.approx(sum(returns) / 10)
    assert pair['mean_daily_nav_delta'] < 0
    assert pair['inference_status'] == 'evaluated_fixed_sample'
    assert pair['promotion_allowed'] is False
    assert pair['comparison'] is None
    twelve = evaluate_nav_effects(now=NOW, business_date=days[-1], query=db.query, policy=POLICY)
    assert twelve['pairs'][0]['accounted_sessions'] == 12
    assert twelve['pairs'][0]['first_session'] == days[0]
    assert twelve['pairs'][0]['assessment_key'] != pair['assessment_key']
    assert ten == evaluate_nav_effects(now=NOW, business_date=days[9], query=db.query, policy=POLICY, page_size=1)
    later = evaluate_nav_effects(now=NOW, business_date='2026-10-30', query=db.query, policy=POLICY)
    assert later['pairs'] == twelve['pairs']
    assert db.query('SELECT * FROM paired_nav_daily_journal_v1', []) == original
    assert db.query("SELECT name FROM sqlite_master WHERE name='paired_nav_assessment_reservations_v1'", []) == []


@pytest.mark.parametrize('prices,sign', [
    ([101, 104, 103, 108, 107, 112, 111, 116, 115, 120], 1),
    ([99, 96, 97, 92, 93, 88, 89, 84, 85, 80], -1),
])
def test_direction_follows_original_nav_not_score_order(prices, sign):
    db, days = price_path(prices)
    result = evaluate_nav_effects(now=NOW, business_date=days[-1], query=db.query, policy=POLICY)['pairs'][0]
    assert sign * result['mean_daily_nav_delta'] > 0
    assert result['mean_delta_lower_one_sided'] <= result['mean_daily_nav_delta'] <= result['mean_delta_upper_one_sided']
    assert 0 < result['bootstrap_positive_tail_p'] <= 1
    assert result['resamples_completed'] == POLICY.resamples
    assert result['promotion_allowed'] is False


def test_corrupt_last_page_never_publishes_earlier_valid_pairs():
    db, days = price_path([100, 102, 104, 103, 106, 105, 107, 108, 109, 110])
    corrupt_payload(db, days[-1], lambda p: p.update(net_return_delta=.99), recompute_hash=False)
    with pytest.raises(RuntimeError, match='checksum_mismatch'):
        evaluate_nav_effects(now=NOW, business_date=days[-1], query=db.query, policy=POLICY, page_size=1)


def test_no_evidence_not_zero_and_zero_variance_not_certain_positive_effect():
    assert evaluate_nav_effects(now=NOW, business_date='2026-09-10', query=DB().query, policy=POLICY)['pairs'] == []
    short = NavEffectPolicy('test-three-day-only', 3, .05, 2, 1999)
    result = evaluate_nav_effects(now=NOW, business_date='2026-09-10', query=populated(2).query, policy=short)
    assert len(result['pairs']) == 2 and result['evaluated_pairs'] == 0
    assert all(p['reason'] == 'nav_observed_difference_zero' for p in result['pairs'])
    assert all(p['mean_delta_lower_one_sided'] is None for p in result['pairs'])


def test_stationary_sampler_retains_serial_blocks_and_is_deterministic():
    x = np.repeat([-1., 1.], 40)
    blocks = _stationary_means(x, block_length=8, resamples=10000, seed=1234)
    iid = _stationary_means(x, block_length=1, resamples=10000, seed=1234)
    assert np.array_equal(blocks, _stationary_means(x, block_length=8, resamples=10000, seed=1234))
    assert abs(blocks.mean()) < .03
    assert blocks.var() > 4 * iid.var()
    assert np.all((-1 <= blocks) & (blocks <= 1))


def test_original_ev_roles_and_unmature_successors_survive_effect_reader(environment, monkeypatch):
    db, _, context, _ = environment
    collect(environment, context)
    pending = evaluate_nav_effects(now=NOW, business_date='2026-09-08', query=db.query, policy=POLICY)
    assert pending['pairs'] == []
    assert pending['candidate_population']['pair_count'] == 2
    assert all(p['execution_status'] == 'not_registered' for p in pending['candidate_population']['pairs'])
    registered_old(environment)
    before = evaluate_nav_effects(now=NOW, business_date='2026-09-08', query=db.query, policy=POLICY)
    roles = {p['comparison']['owner']: p['comparison']['kind'] for p in before['pairs']}
    assert roles == {'l4_alpha_ev': 'incumbent_replacement', 'allocator_ev_fusion': 'incremental_layer'}
    assert all(p['accounted_sessions'] == 1 for p in before['pairs'])
    collect(environment, successor_context(environment, monkeypatch))
    after = evaluate_nav_effects(now=NOW, business_date='2026-09-08', query=db.query, policy=POLICY)
    assert after['candidate_population']['pair_count'] == 4
    assert after['pairs'] == before['pairs']
    assert sum(p['accounted_sessions'] for p in after['candidate_population']['pairs']) == 2
    assert after['evaluated_pairs'] == 0 and after['promotion_allowed'] is False


def test_constant_nonzero_sample_cannot_claim_known_future_variance():
    from dataclasses import replace
    from services.paired_nav_effect_inference import _evaluate_pair
    from services.paired_nav_evidence import read_verified_nav_evidence
    # Numerical unit fixture only. Public reader never accepts forged dataclasses.
    pair = read_verified_nav_evidence(now=NOW, business_date='2026-09-10', query=populated().query).pairs[0]
    altered = replace(pair, observations=tuple(replace(o, candidate_daily_return=.01,
        net_return_delta=.01, lower=.01, upper=.01) for o in pair.observations))
    result = _evaluate_pair(altered, NavEffectPolicy('test-constant-only', 3, .05, 2, 1999))
    assert result['reason'] == 'nav_variance_unidentified'
    assert result['mean_daily_nav_delta'] == pytest.approx(.01)
    assert result['bootstrap_positive_tail_p'] is None
    assert result['promotion_allowed'] is False


def test_outcome_changes_do_not_reseed_and_location_shift_is_preserved():
    from dataclasses import replace
    from services.paired_nav_effect_inference import _evaluate_pair
    from services.paired_nav_evidence import read_verified_nav_evidence
    db, days = price_path([110, 90, 101, 96, 115, 92, 88, 97, 91, 85])
    pair = read_verified_nav_evidence(now=NOW, business_date=days[-1], query=db.query).pairs[0]
    # Numerical equivariance check, not fabricated input to the public reader.
    shifted = replace(pair, observations=tuple(replace(o,
        candidate_daily_return=o.candidate_daily_return + .001,
        net_return_delta=o.net_return_delta + .001,
        lower=o.lower + .001, upper=o.upper + .001) for o in pair.observations))
    original, changed = _evaluate_pair(pair, POLICY), _evaluate_pair(shifted, POLICY)
    assert original['assessment_key'] != changed['assessment_key']
    assert original['seed'] == changed['seed']
    for key in ('mean_daily_nav_delta', 'mean_delta_lower_one_sided', 'mean_delta_upper_one_sided'):
        assert changed[key] == pytest.approx(original[key] + .001)


@pytest.mark.parametrize('field,value', [
    ('policy_id', ''), ('min_sessions', True), ('min_sessions', 1),
    ('block_length', 10), ('block_length', 0), ('tail_alpha', float('nan')),
    ('tail_alpha', True), ('tail_alpha', .5), ('resamples', 19),
])
def test_policy_never_silently_invents_or_relaxes_a_budget(field, value):
    from dataclasses import asdict
    with pytest.raises(ValueError, match='nav_effect_'):
        NavEffectPolicy(**{**asdict(POLICY), field: value})
