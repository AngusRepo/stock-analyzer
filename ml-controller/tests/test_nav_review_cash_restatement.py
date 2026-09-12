"""Original frozen journals/reviews after late cash; synthetic, never ROI."""
from datetime import date, timedelta

import pytest

from services import paired_nav_daily_review as daily
from services import paired_nav_review_store as store
from services.paired_nav_evidence import read_verified_nav_evidence
from test_nav_candidate_decision import environment, read
from test_paired_nav_lifecycle import stamp
from test_paired_nav_review_store import migrate, two_sessions
from test_paired_nav_daily_review import append_session


def test_late_cash_cannot_reuse_old_checkpoint_support_or_spend_another_look(environment, monkeypatch):
    db, *_ = environment
    migrate(db)
    two_sessions(environment, monkeypatch)
    days = ['2026-09-10', '2026-09-11', '2026-09-14', '2026-09-15',
            '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-21']
    previous = '2026-09-09'
    for index, day in enumerate(days):
        append_session(environment, monkeypatch, previous, day, 150 + index * 50)
        previous = day
    first = daily.run_daily_nav_reviews(business_date=previous, query=db.query,
        writer=db.writer, now=stamp(previous))
    assert first['status'] == 'daily_nav_reviews_current'
    assert read(environment, day=previous)['decision'] == 'PASS'
    saved = {t: db.query(f'SELECT * FROM {t} ORDER BY 1', [])
             for t in (store.RECORDS, store.PARTS)}
    journals = db.query('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY pair_id,session_date', [])

    # This arm owned 100 shares on the original ex-date. Only its source has
    # received this delayed announcement. No mutable or fabricated review PASS.
    from test_paired_nav_daily_review import receipt as original_receipt
    def corrected_receipt(packet, seal, **kwargs):
        value = original_receipt(packet, seal, **kwargs)
        if packet['owner'] == 'l4_alpha_ev':
            value.update(cash_accounting_version=1, corporate_actions=[{
                'action_id': 'late-original-cash', 'symbol': '2330', 'kind': 'cash',
                'ex_date': '2026-09-10', 'payable_date': '2026-09-22',
                'cash_per_share': 2., 'stock_per_share': 0.}])
        return value
    monkeypatch.setattr('test_paired_nav_daily_review.receipt', corrected_receipt)
    day = '2026-09-22'
    append_session(environment, monkeypatch, previous, day, 500)
    latest = read_verified_nav_evidence(business_date=day, query=db.query, now=stamp(day))
    affected = [p for p in latest.pairs if dict(p.comparison)['owner'] == 'l4_alpha_ev']
    assert any(o.accounting_adjustment_checksum for p in affected for o in p.observations)
    result = read(environment, day=day)
    assert result['decision'] == 'HOLD'
    assert result['reason'] == 'nav_checkpoint_accounting_restated'
    assert result['evaluable_date_count'] == 11
    assert result['next_review_sessions'] == 30
    assert read(environment, owner='allocator_ev_fusion', day=day)['decision'] == 'PASS'
    for _ in range(2):
        retried = daily.run_daily_nav_reviews(business_date=day, query=db.query,
            writer=db.writer, now=stamp(day))
        assert retried['status'] == 'daily_nav_reviews_current'
        assert read(environment, day=day) == result
    for table, rows in saved.items():
        assert db.query(f'SELECT * FROM {table} ORDER BY 1', []) == rows
    assert db.query('SELECT * FROM paired_nav_daily_journal_v1 WHERE session_date<=? ORDER BY pair_id,session_date',
                    [previous]) == journals

    # Continue the SAME pair through its original30-session checkpoint. These
    # are synthetic weekday fixtures, not a Taiwan exchange-calendar claim.
    for _ in range(19):
        following = date.fromisoformat(day) + timedelta(days=1)
        while following.weekday() >= 5:
            following += timedelta(days=1)
        append_session(environment, monkeypatch, day, following.isoformat(), 500)
        day = following.isoformat()
    final = daily.run_daily_nav_reviews(business_date=day, query=db.query,
        writer=db.writer, now=stamp(day))
    assert final['status'] == 'daily_nav_reviews_current'
    resolved = read(environment, day=day)
    assert resolved['review_id'] == 'sessions_30'
    assert resolved['evaluable_date_count'] == 30
    assert resolved['reason'] != 'nav_checkpoint_accounting_restated'
    assert resolved['decision'] in ('PASS', 'HOLD')  # Never require a profit.
    assert resolved['maximum_window_exhausted'] is True
    assert set(final['runs'][-1]['result']['reserved_alpha_by_family'].values()) == {.05}
    assert all(value <= .05 for run in final['runs'] for value in run['result']['reserved_alpha_by_family'].values())
    for table, rows in saved.items():
        current = {r['record_id']: r for r in db.query(f'SELECT * FROM {table}', [])}
        assert all(current[r['record_id']] == r for r in rows)
    final_records = db.query(f'SELECT * FROM {store.RECORDS} ORDER BY record_id', [])
    assert len([r for r in final_records if r['record_kind'] == 'reservation']) == 4
    # End-of-window corrections cannot mint a31st look or silently keep PASS.
    def another_correction(packet, seal, **kwargs):
        value = corrected_receipt(packet, seal, **kwargs)
        if packet['owner'] == 'l4_alpha_ev':
            value['corporate_actions'].append({
                'action_id': 'second-late-cash', 'symbol': '2330', 'kind': 'cash',
                'ex_date': '2026-09-23', 'payable_date': packet['session_date'],
                'cash_per_share': 1., 'stock_per_share': 0.})
        return value
    monkeypatch.setattr('test_paired_nav_daily_review.receipt', another_correction)
    following = date.fromisoformat(day) + timedelta(days=1)
    while following.weekday() >= 5:
        following += timedelta(days=1)
    append_session(environment, monkeypatch, day, following.isoformat(), 500)
    expired = read(environment, day=following.isoformat())
    assert expired['decision'] == 'HOLD' and expired['reason'] == 'nav_checkpoint_accounting_restated'
    assert expired['next_review_sessions'] is None and expired['maximum_window_exhausted'] is True
    repeated = daily.run_daily_nav_reviews(business_date=following.isoformat(),
        query=db.query, writer=db.writer, now=stamp(following.isoformat()))
    assert repeated['status'] == 'daily_nav_reviews_current'
    assert db.query(f'SELECT * FROM {store.RECORDS} ORDER BY record_id', []) == final_records


@pytest.mark.parametrize('alter', ['duplicate', 'missing_execution', 'foreign_id'])
def test_pinned_population_requires_verified_complete_original_registration(environment, monkeypatch, alter):
    db, *_ = environment
    two_sessions(environment, monkeypatch)
    original = read_verified_nav_evidence(business_date='2026-09-09', query=db.query, now=stamp('2026-09-09'))
    ids = list(original.population_snapshot_ids)
    if alter == 'duplicate':
        ids.append(ids[-1])
        message = 'census_invalid'
    elif alter == 'foreign_id':
        ids = sorted([*ids, 'nonexistent-snapshot'])
        message = 'manifest_missing'
    else:
        ids.remove(original.pairs[0].observations[0].snapshot_id)
        message = 'journal_registration_mismatch'
    with pytest.raises((ValueError, RuntimeError), match=message):
        read_verified_nav_evidence(business_date='2026-09-09', query=db.query,
            now=stamp('2026-09-09'), _population_snapshot_ids=ids)
