"""Accounting closure is not a profit test or a daily inference reservation."""
from datetime import datetime, timezone

import pytest

from services.paired_nav_journal import mature_staged_pairs, stage_execution_receipt
from services.paired_nav_schema import validate_paired_nav_schema
from test_paired_nav_journal import DB, packet, receipt, seal, buy
from test_paired_nav_sequential_state import nominate, sessions, nightly as legacy_research, records

NOW = datetime(2026, 10, 31, tzinfo=timezone.utc)


def close(db, day):
    def accounting_query(sql, params):
        assert 'paired_nav_nominations' not in sql
        assert 'paired_nav_assessment' not in sql
        return db.query(sql, params)
    return mature_staged_pairs(business_date=day, query=accounting_query, writer=db.writer, now=NOW)


@pytest.mark.parametrize('legacy_assessments', [False, True])
def test_loss_is_recorded_and_retries_close_without_statistical_tables(legacy_assessments):
    db = DB(legacy_assessments=legacy_assessments)
    assert validate_paired_nav_schema(db.query)['status'] == 'ready'
    previous = None
    for signal, day, price in [('2026-09-07', '2026-09-08', 110), ('2026-09-08', '2026-09-09', 90)]:
        p = packet(day, previous)
        frozen = seal(db, p, signal)
        stage_execution_receipt(execution=receipt(p, frozen, fills=[buy()] if previous is None else [],
            marks={'2330': price}), query=db.query, writer=db.writer, now=NOW)
        previous = day
    result = close(db, previous)
    assert result['status'] == 'materialized'
    assert result['recorded_pair_sessions'] == 2
    assert result['journal_chain_verified'] is True
    assert result['paired_nav_evidence']['pairs'][0]['mean_daily_nav_delta'] < 0
    assert result['assessment_role'] == 'accounting_evidence_only'
    assert 'sequential_assessment_state' not in result
    assert result['promotion_allowed'] is False  # Correct accounting is not a promotion decision.
    assert close(db, previous)['status'] == 'up_to_date'
    if legacy_assessments:
        assert records(db) == []


def test_existing_budget_history_is_preserved_but_not_required_or_extended():
    db = DB()
    nominate(db)
    days = sessions(db, 12)
    legacy_research(db, days[9])
    previous = records(db)
    assert len(previous) == 1
    result = close(db, days[-1])
    assert result['recorded_pair_sessions'] == 12
    assert records(db) == previous
    assert close(db, days[-1])['processed_pair_sessions'] == 0
    assert records(db) == previous


def test_missing_execution_still_blocks_without_assessment_tables():
    db = DB(legacy_assessments=False)
    frozen = seal(db, packet())
    with pytest.raises(RuntimeError, match='due_execution_receipt_missing:' + frozen['snapshot_id']):
        close(db, '2026-09-08')


def test_missing_accounting_guard_still_blocks_empty_nightly_queue():
    db = DB(legacy_assessments=False)
    db.conn.execute('DROP TRIGGER paired_nav_journal_no_delete_v1')
    with pytest.raises(RuntimeError, match='schema_immutability_missing'):
        close(db, '2026-09-08')
