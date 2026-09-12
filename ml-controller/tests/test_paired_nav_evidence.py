"""Real SQLite journal/receipt tests, synthetic prices, no performance claims."""
from dataclasses import FrozenInstanceError
from datetime import datetime, timezone

import pytest

from services.paired_nav_evidence import read_verified_nav_evidence
from services.paired_nav_journal import mature_staged_pairs, stage_execution_receipt, read_snapshot, materialize_pair
from test_paired_nav_chain import populated, corrupt_payload
from test_paired_nav_journal import DB, packet, receipt, seal, buy
from test_paired_nav_sequential_state import nominate, sessions, nightly, records
from test_subscription_rights import action

NOW = datetime(2026, 10, 31, 8, tzinfo=timezone.utc)


def test_raw_series_is_complete_chronological_page_independent_and_read_only():
    db = populated(2)
    before = db.query('SELECT * FROM paired_nav_daily_journal_v1', [])
    small = read_verified_nav_evidence(now=NOW, business_date='2026-09-10', query=db.query, page_size=1)
    large = read_verified_nav_evidence(now=NOW, business_date='2026-09-10', query=db.query, page_size=100)
    assert small == large
    assert len(small.pairs) == 2
    for pair in small.pairs:
        assert tuple(o.session_date for o in pair.observations) == ('2026-09-08', '2026-09-09', '2026-09-10')
        assert tuple(o.net_return_delta for o in pair.observations) == (0, 0, 0)
        assert pair.summary()['mean_daily_nav_delta'] == 0
        assert pair.observations[0].previous_journal_checksum is None
        assert pair.observations[1].previous_journal_checksum == pair.observations[0].journal_checksum
        with pytest.raises(FrozenInstanceError):
            pair.observations[0].net_return_delta = .1
    assert db.query('SELECT * FROM paired_nav_daily_journal_v1', []) == before


def test_prefix_is_not_a_sliding_window_or_reset_on_catchup():
    db = DB()
    nominate(db)
    days = sessions(db, 12)
    nightly(db, days[9])
    first = read_verified_nav_evidence(now=NOW, business_date=days[9], query=db.query)
    old_budget = records(db)
    result = nightly(db, days[-1])
    second = read_verified_nav_evidence(now=NOW, business_date=days[-1], query=db.query)
    assert first.pairs[0].observations == second.pairs[0].observations[:10]
    assert len(second.pairs[0].observations) == 12
    assert records(db)[:1] == old_budget
    before = records(db)
    assert nightly(db, days[-1])['paired_nav_evidence'] == result['paired_nav_evidence']
    assert records(db) == before
    # Later retrieval without new rows must not change the evidence identity.
    later = read_verified_nav_evidence(now=NOW, business_date='2026-10-30', query=db.query)
    assert later.pairs[0].checksum == second.pairs[0].checksum


def test_actual_fee_and_nav_losses_survive_into_nightly_and_inference_input():
    db = DB()
    previous = None
    for signal, day, price in [('2026-09-07', '2026-09-08', 110), ('2026-09-08', '2026-09-09', 90)]:
        p = packet(day, previous)
        frozen = seal(db, p, signal)
        rec = receipt(p, frozen, fills=[buy()] if previous is None else [], marks={'2330': price})
        stage_execution_receipt(execution=rec, query=db.query, writer=db.writer, now=NOW)
        previous = day
    result = mature_staged_pairs(business_date=previous, query=db.query, writer=db.writer, now=NOW)
    data = read_verified_nav_evidence(now=NOW, business_date=previous, query=db.query)
    rows = data.pairs[0].observations
    assert rows[0].net_return_delta == pytest.approx(100980 / 100000 - 1)
    assert rows[1].net_return_delta == pytest.approx(98980 / 100980 - 1)
    mean = sum(o.net_return_delta for o in rows) / 2
    assert result['paired_nav_evidence']['pairs'][0]['mean_daily_nav_delta'] == pytest.approx(mean)
    assert result['paired_nav_evidence']['pairs'][0]['mean_daily_nav_delta_enclosure']['lower'] == pytest.approx(mean)
    assert mean < 0 and result['paired_nav_evidence']['promotion_allowed'] is False


def test_unknown_rights_preserve_all_dates_and_do_not_select_complete_cases():
    db, previous = DB(), None
    for signal, day in [('2026-09-04', '2026-09-07'), ('2026-09-07', '2026-09-08'),
                        ('2026-09-08', '2026-09-09'), ('2026-09-09', '2026-09-10'),
                        ('2026-09-10', '2026-09-11')]:
        p = packet(day, previous)
        p['initial_account'] = {'cash': 99000., 'positions': {'2330': 100}, 'marks': {'2330': 100.}, 'nav': 109000.}
        frozen = seal(db, p, signal)
        rec = receipt(p, frozen, marks={'2330': 99.})
        rec['corporate_actions'] = [action()]
        stage_execution_receipt(execution=rec, query=db.query, writer=db.writer, now=NOW)
        previous = day
    result = mature_staged_pairs(business_date=previous, query=db.query, writer=db.writer, now=NOW)
    data = read_verified_nav_evidence(now=NOW, business_date=previous, query=db.query)
    assert tuple(o.net_return_delta for o in data.pairs[0].observations) == (None, None, None, None, 0)
    summary = result['paired_nav_evidence']['pairs'][0]
    assert summary['accounted_sessions'] == 5 and summary['exact_nav_sessions'] == 1
    assert summary['mean_daily_nav_delta'] is None
    assert summary['sample_status'] == 'valuation_incomplete'
    bounds = summary['mean_daily_nav_delta_enclosure']
    assert bounds['lower'] < 0 < bounds['upper']
    assert 'not_confidence_interval' in bounds['kind']
    from services.paired_nav_effect_inference import NavEffectPolicy, evaluate_nav_effects
    effect = evaluate_nav_effects(now=NOW, business_date=previous, query=db.query,
        policy=NavEffectPolicy('test-unknown-rights-only', 3, .05, 2, 1999))['pairs'][0]
    assert effect['accounted_sessions'] == 5 and effect['exact_nav_sessions'] == 1
    assert effect['reason'] == 'nav_valuation_or_return_incomplete'
    assert effect['mean_delta_lower_one_sided'] is None
    assert effect['resamples_completed'] == 0 and effect['promotion_allowed'] is False


def test_even_coherently_rehashed_nav_cannot_override_the_frozen_execution():
    db = populated()
    def invent_gain(p):
        p['arms']['candidate'].update(nav=101000., cash=101000., daily_return=.01)
        p['net_return_delta'] = .01
    corrupt_payload(db, '2026-09-10', invent_gain)
    with pytest.raises(RuntimeError, match='execution_accounting_mismatch'):
        read_verified_nav_evidence(now=NOW, business_date='2026-09-10', query=db.query)


def test_missing_raw_receipt_cannot_be_replaced_by_an_internally_consistent_journal():
    db = populated()
    db.conn.execute('DROP TRIGGER paired_nav_manifest_no_delete_v1')
    db.conn.execute("DELETE FROM paired_nav_frozen_manifests_v1 WHERE snapshot_kind='execution_receipt' AND signal_date='2026-09-10'")
    with pytest.raises(RuntimeError, match='execution_receipt_missing'):
        read_verified_nav_evidence(now=NOW, business_date='2026-09-10', query=db.query)


def test_corrupt_late_page_does_not_publish_new_budget_or_partial_evidence():
    db = DB()
    nominate(db)
    days = sessions(db, 12)
    nightly(db, days[9])
    # Materialize the two later ledgers without running assessment persistence.
    # The nightly reader will stage day11, then encounter corrupt day12.
    for row in db.query("SELECT snapshot_id FROM paired_nav_frozen_manifests_v1 WHERE snapshot_kind='execution_receipt' AND signal_date>? ORDER BY signal_date", [days[9]]):
        execution = read_snapshot(db.query, row['snapshot_id'])['payload']['content']
        materialize_pair(snapshot_id=execution['snapshot_id'], session_date=execution['session_date'],
            execution=execution, query=db.query, writer=db.writer, now=NOW)
    before = records(db)
    corrupt_payload(db, days[-1], lambda p: p.update(net_return_delta=.01), recompute_hash=False)
    with pytest.raises(RuntimeError, match='checksum_mismatch'):
        nightly(db, days[-1])
    assert records(db) == before


def test_observer_mutations_cannot_change_raw_series_or_journal_identity():
    db = populated()
    def observe(prefix):
        prefix['net_return_delta'] = 42
        prefix['pair_identity']['candidate_checksum'] = 'bad'
        prefix['return_enclosure']['lower'] = 42
    result = read_verified_nav_evidence(now=NOW, business_date='2026-09-10', query=db.query, observe_prefix=observe)
    assert all(o.net_return_delta == 0 and o.lower == 0 for o in result.pairs[0].observations)
    assert dict(result.pairs[0].identity)['candidate_checksum'] == 'c' * 64


def test_empty_is_no_evidence_not_zero_effect_or_mature():
    data = read_verified_nav_evidence(now=NOW, business_date='2026-09-10', query=DB().query)
    assert data.pairs == () and data.summary()['pairs'] == []
    assert data.summary()['inference_status'] == 'not_evaluated'
