"""Real original maturity: retired promises cannot starve Atomic; gaps still fail."""
import pytest

from services.paired_nav_journal import freeze_snapshot, mature_staged_pairs, stage_execution_receipt
from services.strategy_nav_accounting_scope import StrategyAccountingScope
from test_paired_nav_journal import DB, packet, receipt, NOW


def seal(db, owner, day='2026-09-08', signal='2026-09-07', token='a'):
    from datetime import datetime, timezone
    p = packet(day, signal)
    p.update(owner=owner, pair_id=token if len(token) == 64 else token * 64)
    saved = freeze_snapshot(signal_date=signal, source_run_id=p['pair_id'], snapshot_kind='execution_pair',
        content=p, query=db.query, writer=db.writer, now=datetime.fromisoformat(signal).replace(hour=12, tzinfo=timezone.utc))
    return p, saved


def test_inactive_missing_receipt_retained_without_writing_or_credit():
    db = DB()
    _, saved = seal(db, 'ensemble')
    with pytest.raises(RuntimeError, match='due_execution_receipt_missing'):
        mature_staged_pairs(business_date='2026-09-09', query=db.query, writer=db.writer, now=NOW)
    before = db.query('SELECT * FROM paired_nav_frozen_manifests_v1', [])
    scope = StrategyAccountingScope(db.query, ('atomic_strategy',))
    result = mature_staged_pairs(business_date='2026-09-09', query=scope.query, writer=db.writer, now=NOW)
    assert result['processed_pair_sessions'] == result['recorded_pair_sessions'] == 0
    assert scope.retained[saved['snapshot_id']]['nav_maturity_credit'] == 0
    assert db.query('SELECT * FROM paired_nav_frozen_manifests_v1', []) == before
    assert db.query('SELECT * FROM paired_nav_daily_journal_v1', []) == []


def test_atomic_missing_receipt_is_never_hidden_by_scope():
    db = DB()
    seal(db, 'ensemble', token='a')
    _, active = seal(db, 'atomic_strategy', token='b')
    scope = StrategyAccountingScope(db.query, ('atomic_strategy',))
    with pytest.raises(RuntimeError, match='due_execution_receipt_missing:' + active['snapshot_id']):
        mature_staged_pairs(business_date='2026-09-09', query=scope.query, writer=db.writer, now=NOW)
    assert db.query('SELECT * FROM paired_nav_daily_journal_v1', []) == []


def test_unknown_owner_is_not_treated_as_retired():
    db = DB()
    seal(db, 'unknown-old-owner')
    scope = StrategyAccountingScope(db.query, ('atomic_strategy',))
    with pytest.raises(RuntimeError, match='accounting_owner_unknown'):
        mature_staged_pairs(business_date='2026-09-09', query=scope.query, writer=db.writer, now=NOW)


def test_pending_receipt_scope_advances_without_erasing_inactive_rows():
    db = DB()
    old, saved = seal(db, 'ensemble', token='a')
    stage_execution_receipt(execution=receipt(old, saved), query=db.query, writer=db.writer, now=NOW)
    scope = StrategyAccountingScope(db.query, ('atomic_strategy',))
    sql = '''SELECT m.snapshot_id,m.signal_date,m.parent_snapshot_id
        FROM paired_nav_frozen_manifests_v1 m
        LEFT JOIN paired_nav_daily_journal_v1 j ON j.snapshot_id=m.parent_snapshot_id
        WHERE m.snapshot_kind='execution_receipt' AND m.signal_date<=? AND j.snapshot_id IS NULL ORDER BY m.signal_date,m.snapshot_id LIMIT 100'''
    assert scope.query(sql, ['2026-09-09']) == []
    assert db.query("SELECT COUNT(*) n FROM paired_nav_frozen_manifests_v1 WHERE snapshot_kind='execution_receipt'", [])[0]['n'] == 1


def test_query_adapter_does_not_filter_shared_inventory_or_review_sources():
    calls = []
    def query(sql, params):
        calls.append((sql, params))
        return [{'owner': 'ensemble'}, {'owner': 'atomic_strategy'}]
    scope = StrategyAccountingScope(query, ('atomic_strategy',))
    sql = "SELECT * FROM paired_nav_frozen_manifests_v1 WHERE snapshot_kind='allocation_pair'"
    assert scope.query(sql, []) == [{'owner': 'ensemble'}, {'owner': 'atomic_strategy'}]
    assert calls == [(sql, [])]


def test_active_receipt_after_a_full_inactive_page_is_not_lost():
    db = DB()
    for index in range(105):
        old, saved = seal(db, 'ensemble', token=f'{index:064x}')
        stage_execution_receipt(execution=receipt(old, saved), query=db.query, writer=db.writer, now=NOW)
    active, saved = seal(db, 'atomic_strategy', day='2026-09-09', signal='2026-09-08', token='b')
    receipt_saved = stage_execution_receipt(execution=receipt(active, saved), query=db.query, writer=db.writer, now=NOW)
    scope = StrategyAccountingScope(db.query, ('atomic_strategy',))
    sql = '''SELECT m.snapshot_id,m.signal_date,m.parent_snapshot_id
        FROM paired_nav_frozen_manifests_v1 m
        LEFT JOIN paired_nav_daily_journal_v1 j ON j.snapshot_id=m.parent_snapshot_id
        WHERE m.snapshot_kind='execution_receipt' AND m.signal_date<=? AND j.snapshot_id IS NULL ORDER BY m.signal_date,m.snapshot_id LIMIT 100'''
    selected = scope.query(sql, ['2026-09-09'])
    assert [row['snapshot_id'] for row in selected] == [receipt_saved['snapshot_id']]
    assert len(scope.retained) == 105
    assert db.query('SELECT COUNT(*) n FROM paired_nav_daily_journal_v1', [])[0]['n'] == 0


def test_display_keeps_original_failure_visible_instead_of_missing_projection(monkeypatch):
    from datetime import datetime, timezone
    import oof_materialize_job_main as job
    from services import strategy_nav_read_model as display, d1_domain_client as domains
    calls = []
    monkeypatch.setattr(job, '_execute_daily_nav_scoped', lambda **kw: {
        'status': 'failed', 'as_of_date': '2026-10-14', 'error_type': 'RuntimeError',
        'reason': 'original_atomic_source_missing'})
    monkeypatch.setattr(display, 'production_read_store', lambda: object())
    monkeypatch.setattr(domains, 'client_for_domain', lambda *args: object())
    def original_projection(**kwargs):
        calls.append(kwargs['business_date'])
        return {'status': 'published', 'entry_count': 1, 'promotion_allowed': False}
    monkeypatch.setattr(display, 'refresh_strategy_nav_read_model', original_projection)
    result = job._execute_daily_nav(end_date='2026-10-14', now=datetime(2026, 10, 14, 14, tzinfo=timezone.utc),
        publish_strategy_display=True)
    assert result['status'] == 'failed' and result['reason'] == 'original_atomic_source_missing'
    assert result['error_type'] == 'RuntimeError' and result['strategy_nav_read_model']['promotion_allowed'] is False
    assert calls == ['2026-10-14']
