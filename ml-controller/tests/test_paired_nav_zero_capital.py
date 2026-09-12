"""Economic loss is not missing data. Synthetic odd-lot fee accounting only."""
from datetime import datetime, timezone
from copy import deepcopy

import pytest

from services.paired_nav_journal import replay_session, stage_execution_receipt, mature_staged_pairs
from services.paired_nav_evidence import read_verified_nav_evidence
from test_paired_nav_journal import DB, FEES, packet, receipt, seal


INITIAL = {'cash': 0., 'positions': {'2330': 1}, 'marks': {'2330': 20.}, 'nav': 20.}
NOW = datetime(2026, 9, 12, 8, tzinfo=timezone.utc)


def sell(day='2026-09-08'):
    return {'fill_id': 'sell-one-odd-lot', 'symbol': '2330', 'side': 'sell', 'shares': 1,
        'price': 20., 'commission': 20, 'tax': 0, 'executed_at': day + 'T01:10:00Z'}


def test_one_share_sale_exhausted_by_minimum_commission_is_exact_loss():
    result = replay_session(previous=deepcopy(INITIAL), fills=[sell()], marks={'2330': 20},
        corporate_actions=[], session_date='2026-09-08', fees=FEES)
    assert result['nav'] == result['cash'] == 0
    assert result['positions'] == {}
    assert result['costs'] == 20
    assert result['daily_return'] == result['drawdown'] == -1
    subsequent = replay_session(previous=result, fills=[], marks={}, corporate_actions=[],
        session_date='2026-09-09', fees=FEES)
    assert subsequent['nav'] == 0 and subsequent['daily_return'] is None
    assert subsequent['return_status'] == 'undefined_zero_opening_nav'
    assert subsequent['drawdown'] == -1


def test_zero_nav_does_not_break_nightly_or_become_fake_zero_return():
    db, previous = DB(legacy_assessments=False), None
    for signal, day in [('2026-09-07', '2026-09-08'), ('2026-09-08', '2026-09-09')]:
        p = packet(day, previous)
        p['initial_account'] = deepcopy(INITIAL)
        frozen = seal(db, p, signal)
        rec = receipt(p, frozen, fills=[sell(day)] if previous is None else [], marks={'2330': 20.})
        stage_execution_receipt(execution=rec, query=db.query, writer=db.writer, now=NOW)
        previous = day
    result = mature_staged_pairs(business_date=previous, query=db.query, writer=db.writer, now=NOW)
    evidence = read_verified_nav_evidence(now=NOW, business_date=previous, query=db.query)
    rows = evidence.pairs[0].observations
    assert [r.net_return_delta for r in rows] == [-1., None]
    summary = evidence.pairs[0].summary()
    assert summary['accounted_sessions'] == 2 and summary['exact_nav_sessions'] == 1
    assert summary['undefined_return_sessions'] == 1
    assert summary['sample_status'] == 'undefined_return'
    assert summary['mean_daily_nav_delta'] is None
    assert summary['mean_daily_nav_delta_enclosure']['lower'] is None
    assert result['paired_nav_evidence']['promotion_allowed'] is False
    from services.paired_nav_effect_inference import NavEffectPolicy, evaluate_nav_effects
    effect = evaluate_nav_effects(now=NOW, business_date=previous, query=db.query,
        policy=NavEffectPolicy('test-zero-capital-only', 2, .05, 1, 999))['pairs'][0]
    assert effect['undefined_return_sessions'] == 1
    assert effect['reason'] == 'nav_valuation_or_return_incomplete'
    assert effect['mean_daily_nav_delta'] is None and effect['resamples_completed'] == 0
    before = db.query('SELECT * FROM paired_nav_daily_journal_v1', [])
    assert mature_staged_pairs(business_date=previous, query=db.query, writer=db.writer, now=NOW)['paired_nav_evidence'] == result['paired_nav_evidence']
    assert db.query('SELECT * FROM paired_nav_daily_journal_v1', []) == before


def test_zero_nav_does_not_allow_unfunded_buy_or_zero_stock_mark():
    with pytest.raises(ValueError, match='negative_cash'):
        replay_session(previous={'cash': 0, 'positions': {}, 'nav': 0, 'peak_nav': 20},
            fills=[{**sell(), 'side': 'buy'}], marks={'2330': 20}, corporate_actions=[],
            session_date='2026-09-08', fees=FEES)
    with pytest.raises(ValueError, match='zero_mark'):
        replay_session(previous=deepcopy(INITIAL), fills=[], marks={'2330': 0}, corporate_actions=[],
            session_date='2026-09-08', fees=FEES)


@pytest.mark.parametrize('allow_unpriced_rights', [False, True])
def test_inconsistent_zero_open_cannot_recover_by_bypassing_valuation_branch(allow_unpriced_rights):
    with pytest.raises(ValueError, match='unfunded_zero_nav_recovery'):
        replay_session(previous={'cash': 100, 'positions': {}, 'nav': 0, 'performance_complete': False},
            fills=[], marks={}, corporate_actions=[], session_date='2026-09-08', fees=FEES,
            allow_unpriced_rights=allow_unpriced_rights)


def test_zero_lower_valuation_bound_is_not_known_zero_nav():
    from services.paired_nav_chain import paired_return_interval
    from services.paired_nav_evidence import NavObservation, PairedNavSeries
    previous = {'candidate': {'nav': None, 'valuation_complete': False,
        'nav_lower_bound': 0, 'nav_upper_bound': 20}, 'baseline': {'nav': 20}}
    current = {'candidate': {'nav': 10}, 'baseline': {'nav': 20}}
    interval = paired_return_interval(previous, current)
    assert interval['kind'] == 'unbounded_return_zero_opening_nav_lower_bound'
    assert interval['lower'] is interval['upper'] is None
    obs = NavObservation('2026-09-08', 'snap', 'checksum', None, None, 0, None,
        interval['lower'], interval['upper'], interval['kind'])
    summary = PairedNavSeries('pair', (), (obs,)).summary()
    assert summary['sample_status'] == 'valuation_incomplete'
    assert summary['undefined_return_sessions'] == 0 and summary['unbounded_return_sessions'] == 1
    # A zero closing lower bound is valid if opening capital was known positive.
    bound = paired_return_interval(current, previous)
    assert bound['lower'] == -1 and bound['upper'] == 1
    # Both arms must validate, even when the first arm already has zero capital.
    with pytest.raises((RuntimeError, ValueError)):
        paired_return_interval({'baseline': {'nav': 0}, 'candidate': {'nav': -1}}, current)
    mixed = paired_return_interval({'baseline': {'nav': 0}, 'candidate': previous['candidate']},
        {'baseline': {'nav': 0}, 'candidate': current['candidate']})
    assert mixed['kind'] == 'unbounded_return_zero_opening_nav_lower_bound'


def test_existing_positive_nav_series_keeps_its_original_checksum():
    from services.paired_nav_evidence import NavObservation, PairedNavSeries
    from services.paired_nav_journal import digest
    obs = NavObservation('2026-09-08', 'snap', 'checksum', None, -.01, -.02, .01, .01, .01)
    # Literal legacy wire shape, not asdict(new_model), which would accidentally
    # include every future optional field in the expected OLD checksum.
    original = {'session_date': '2026-09-08', 'snapshot_id': 'snap', 'journal_checksum': 'checksum',
        'previous_journal_checksum': None, 'candidate_daily_return': -.01, 'baseline_daily_return': -.02,
        'net_return_delta': .01, 'lower': .01, 'upper': .01}
    pair = PairedNavSeries('pair', (('pair_id', 'pair'),), (obs,))
    assert pair.checksum == digest(['paired-nav-verified-series-v1', pair.identity, [original]])
    assert pair.checksum == 'f3452be7008851bbae1c3f2ee9981965f7af72b4fe4f349103b1f4428f068a4c'
