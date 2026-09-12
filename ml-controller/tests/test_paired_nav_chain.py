"""Actual SQLite corruption controls; never writes production or market data."""
from datetime import datetime, timezone
import json

import pytest

from services.paired_nav_chain import paired_return_interval, verify_journal_chain
from services.paired_nav_journal import digest, encode, mature_staged_pairs, stage_execution_receipt
from test_paired_nav_journal import DB, packet, receipt

NOW = datetime(2026, 9, 11, 8, tzinfo=timezone.utc)


def populated(pairs=1):
    db = DB()
    for pair in range(pairs):
        previous = None
        for signal, session in [('2026-09-07', '2026-09-08'), ('2026-09-08', '2026-09-09'),
                                ('2026-09-09', '2026-09-10')]:
            p = packet(session, previous)
            p['pair_id'] += str(pair)
            # The fixture sealer uses one source id per date; give each pair a
            # separate real immutable manifest identity without a test bypass.
            from services.paired_nav_journal import freeze_snapshot
            s = freeze_snapshot(signal_date=signal, source_run_id=p['pair_id'] + ':' + signal,
                snapshot_kind='execution_pair', content=p, query=db.query, writer=db.writer,
                now=datetime.fromisoformat(signal + 'T14:00:00+00:00'))
            stage_execution_receipt(execution=receipt(p, s), query=db.query, writer=db.writer,
                now=datetime.fromisoformat(session + 'T08:00:00+00:00'))
            previous = session
    mature_staged_pairs(business_date='2026-09-10', query=db.query, writer=db.writer, now=NOW)
    return db


def corrupt_payload(db, day, mutate, *, recompute_hash=True):
    # Inject bad historical content, then restore the guard so the nightly
    # preflight succeeds and the test reaches the deeper content verification.
    trigger = db.query("SELECT sql FROM sqlite_master WHERE name='paired_nav_journal_no_update_v1'", [])[0]['sql']
    db.conn.execute('DROP TRIGGER paired_nav_journal_no_update_v1')
    row = db.query('SELECT * FROM paired_nav_daily_journal_v1 WHERE session_date=?', [day])[0]
    body = json.loads(row['payload_json'])
    mutate(body)
    db.conn.execute('UPDATE paired_nav_daily_journal_v1 SET payload_json=?,payload_checksum=? WHERE session_date=?',
        (encode(body), digest(body) if recompute_hash else row['payload_checksum'], day))
    db.conn.execute(trigger)


def test_bounded_pages_verify_every_pair_and_keep_real_zero_observations():
    db = populated(2)
    first = verify_journal_chain(now=NOW, business_date='2026-09-10', query=db.query, page_size=1)
    second = verify_journal_chain(now=NOW, business_date='2026-09-10', query=db.query, page_size=3)
    assert first == second
    assert first['chain_verified'] is True
    assert first['accounted_sessions'] == first['sessions'] == 6
    assert first['pairs'] == 2 and first['latest'] == '2026-09-10'
    earlier = verify_journal_chain(now=NOW, business_date='2026-09-09', query=db.query)
    assert earlier['sessions'] == 4 and earlier['latest'] == '2026-09-09'
    assert earlier['chain_checksum'] != first['chain_checksum']


@pytest.mark.parametrize('day,error', [('2026-09-08', 'missing_origin'), ('2026-09-09', 'predecessor_mismatch')])
def test_deleted_history_is_not_silently_recounted(day, error):
    db = populated()
    db.conn.execute('DROP TRIGGER paired_nav_journal_no_delete_v1')
    db.conn.execute('DELETE FROM paired_nav_daily_journal_v1 WHERE session_date=?', (day,))
    with pytest.raises(RuntimeError, match=error):
        verify_journal_chain(now=NOW, business_date='2026-09-10', query=db.query, page_size=1)


def test_old_tampered_row_fails_nightly_even_when_no_new_receipt_arrives():
    db = populated()
    corrupt_payload(db, '2026-09-08', lambda p: p.update(net_return_delta=.04), recompute_hash=False)
    with pytest.raises(RuntimeError, match='chain_checksum_mismatch'):
        mature_staged_pairs(business_date='2026-09-10', query=db.query, writer=db.writer, now=NOW)


@pytest.mark.parametrize('mutate', [
    lambda p: p.update(net_return_delta=.01),
    lambda p: p['arms']['candidate'].update(daily_return=.01),
    lambda p: p['arms']['candidate'].update(nav=101000),
    lambda p: p['arms']['candidate'].update(daily_return=None),
])
def test_rehashed_but_inconsistent_nav_cannot_manufacture_an_observation(mutate):
    db = populated()
    corrupt_payload(db, '2026-09-10', mutate)
    with pytest.raises(RuntimeError, match='arithmetic_mismatch'):
        verify_journal_chain(now=NOW, business_date='2026-09-10', query=db.query)


def test_rehashed_identity_change_and_stale_column_links_fail():
    for mutate, error in [
        (lambda p: p['pair_identity'].update(candidate_checksum='f' * 64), 'pair_identity_changed'),
        (lambda p: p.update(previous_checksum=None), 'identity_mismatch'),
    ]:
        db = populated()
        corrupt_payload(db, '2026-09-10', mutate)
        with pytest.raises(RuntimeError, match=error):
            verify_journal_chain(now=NOW, business_date='2026-09-10', query=db.query)


def test_missing_execution_manifest_is_not_a_valid_journal():
    db = populated()
    row = db.query('SELECT snapshot_id FROM paired_nav_daily_journal_v1 WHERE session_date=?', ['2026-09-10'])[0]
    db.conn.execute('DROP TRIGGER paired_nav_manifest_no_delete_v1')
    db.conn.execute('DELETE FROM paired_nav_frozen_manifests_v1 WHERE snapshot_id=?', (row['snapshot_id'],))
    with pytest.raises(RuntimeError, match='identity_mismatch'):
        verify_journal_chain(now=NOW, business_date='2026-09-10', query=db.query)


def test_empty_journal_is_explicitly_empty_not_ten_mature_dates():
    result = verify_journal_chain(now=NOW, business_date='2026-09-10', query=DB().query)
    assert result['sessions'] == result['accounted_sessions'] == result['pairs'] == 0
    assert result['latest'] is None


@pytest.mark.parametrize('size', [0, 101, True])
def test_invalid_page_sizes_cannot_skip_the_ledger(size):
    with pytest.raises(ValueError, match='invalid_page_size'):
        verify_journal_chain(now=NOW, business_date='2026-09-10', query=DB().query, page_size=size)


def test_interval_preserves_unknown_values_and_encloses_every_possible_pair():
    previous = {'baseline': {'nav': 100}, 'candidate': {'nav': None, 'valuation_complete': False,
        'nav_lower_bound': 90, 'nav_upper_bound': 110}}
    current = {'baseline': {'nav': None, 'valuation_complete': False,
        'nav_lower_bound': 95, 'nav_upper_bound': 105}, 'candidate': {'nav': 102}}
    bound = paired_return_interval(previous, current)
    assert bound['exact'] is False
    assert bound['lower'] == pytest.approx(102 / 110 - 105 / 100)
    assert bound['upper'] == pytest.approx(102 / 90 - 95 / 100)
    for candidate_open in (90, 94, 100, 106, 110):
        for baseline_close in (95, 98, 100, 105):
            realized = 102 / candidate_open - baseline_close / 100
            assert bound['lower'] - 1e-15 <= realized <= bound['upper'] + 1e-15
    assert previous['candidate']['nav'] is current['baseline']['nav'] is None


def test_known_nav_interval_is_exact_not_another_confidence_interval():
    previous = {arm: {'nav': 100} for arm in ('candidate', 'baseline')}
    current = {'candidate': {'nav': 102}, 'baseline': {'nav': 101}}
    bound = paired_return_interval(previous, current)
    assert bound['exact'] is True and bound['lower'] == bound['upper'] == pytest.approx(.01)
    assert 'not_confidence_interval' in bound['kind']


@pytest.mark.parametrize('low,high', [(None, 110), (-1, 110), (110, 90), (100, 100)])
def test_uncertain_nav_requires_genuine_nonnegative_ordered_bounds(low, high):
    previous = {arm: {'nav': 100} for arm in ('candidate', 'baseline')}
    current = {'candidate': {'nav': None, 'valuation_complete': False,
        'nav_lower_bound': low, 'nav_upper_bound': high}, 'baseline': {'nav': 101}}
    with pytest.raises((ValueError, RuntimeError)):
        paired_return_interval(previous, current)


def test_concurrent_publisher_cannot_make_a_partial_pagination_look_complete():
    db = populated()
    def publishing_query(sql, params):
        if sql.startswith('SELECT COUNT(*) AS n'):
            return [{'n': 4}]
        return db.query(sql, params)
    with pytest.raises(RuntimeError, match='concurrent_publication_retry'):
        verify_journal_chain(now=NOW, business_date='2026-09-10', query=publishing_query, page_size=1)
