"""Original L3 execution/ledger publication races, private SQLite; NOT ROI."""
from datetime import datetime
import sqlite3

import pytest

from services import active8_nav_adoption as authority, model_artifact_registry as registry
from services.paired_nav_journal import mature_staged_pairs, materialize_staged_receipts
from test_nav_l3_adoption import ready, publish, prepared, environment
from test_nav_l3_mature_evidence import stamp
import test_nav_l3_mature_evidence as original


def stage_next_session(ready, prepared, monkeypatch, *, with_all_owners=False):
    client = ready[0]
    monkeypatch.setattr(original, 'SESSIONS', [*original.SESSIONS, '2026-09-22'])
    # Real next-day recommendation/allocation and receipt, not a fabricated
    # journal row or decision. Deliberately delay only original materialization.
    original.build_mature_l3(prepared, monkeypatch, days=11, start_day=10,
                            with_environment=True, with_all_owners=with_all_owners, stage_only=True)
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return stamp('2026-09-22')
    monkeypatch.setattr(authority, 'datetime', Clock)
    monkeypatch.setattr(registry, '_now_iso', lambda: stamp('2026-09-22').isoformat())
    client.conn.create_function('current_timestamp', 0, lambda: '2026-09-22 14:00:00')


@pytest.mark.parametrize('timing', ['during_commit', 'before_prepare'])
def test_l3_old_date_publication_cannot_ignore_later_original_journal_commit(ready, prepared, monkeypatch, timing):
    client, candidate, nav, *_ = ready
    db = prepared[0]
    stage_next_session(ready, prepared, monkeypatch)
    preview = publish(ready, confirm=False)
    assert preview['can_promote'] and preview['nav_validation']['decision'] == 'PASS'
    before = {table: client.query('SELECT * FROM ' + table + ' ORDER BY 1') for table in
        ('model_champion_pointers', 'model_champion_history', 'active8_ensemble_pointer_v1',
         'model_artifact_registry', 'active8_ensemble_artifacts_v1', 'paired_nav_review_records_v1')}
    old_count = client.query('SELECT COUNT(*) AS n FROM paired_nav_daily_journal_v1')[0]['n']
    reached = []
    def materialize_after_check(conn):
        mature_staged_pairs(business_date='2026-09-22', query=db.query, writer=db.writer,
                            now=stamp('2026-09-22'))
        reached.append(True)
        assert client.query('SELECT COUNT(*) AS n FROM paired_nav_daily_journal_v1')[0]['n'] == old_count + 1
    if timing == 'during_commit':
        client.before_batch = materialize_after_check
    else:
        materialize_after_check(client.conn)
    with pytest.raises(sqlite3.DatabaseError):
        publish(ready)
    assert reached == [True], 'must run the original materializer'
    assert client.batches == (1 if timing == 'during_commit' else 0)
    assert {table: client.query('SELECT * FROM ' + table + ' ORDER BY 1') for table in before} == before
    # The legitimate current-date retry must work, using the same immutable
    # review/reservation. Freshness is not a new efficacy look or permanent HOLD.
    client.before_batch = None
    result = publish(ready, business_date='2026-09-22')
    assert result['readback_verified']
    current = result['nav_validation']
    assert current['review_record_checksum'] == nav['review_record_checksum']
    assert current['reservation_checksum'] == nav['reservation_checksum']
    assert current['evaluable_date_count'] == 11
    assert current['review_family_journal_frontier'][0]['last_session_date'] == '2026-09-22'
    assert client.query('SELECT * FROM paired_nav_review_records_v1 ORDER BY 1') == before['paired_nav_review_records_v1']


@pytest.mark.parametrize('ready', [True], indirect=True)
def test_l3_unrelated_family_materialization_does_not_block_publication(ready, prepared, monkeypatch):
    client, _, nav, *_ = ready
    db = prepared[0]
    stage_next_session(ready, prepared, monkeypatch, with_all_owners=True)
    assert materialize_staged_receipts(business_date='2026-09-22', query=db.query,
        writer=db.writer, now=stamp('2026-09-22'), pair_id=nav['effect_pair_id']) == 1
    preview = publish(ready, confirm=False, business_date='2026-09-22')
    assert preview['can_promote']
    global_count = client.query("SELECT COUNT(*) AS n FROM paired_nav_daily_journal_v1 WHERE session_date<=?",
                                ['2026-09-22'])[0]['n']
    pair_id = client.query("SELECT DISTINCT pair_id FROM paired_nav_daily_journal_v1 "
                          "WHERE json_extract(payload_json,'$.comparison.owner')='l4_alpha_ev'")[0]['pair_id']
    assert pair_id not in {row['pair_id'] for row in nav['review_family_journal_frontier']}
    reached = []
    def other_family(conn):
        count = materialize_staged_receipts(business_date='2026-09-22', query=db.query,
            writer=db.writer, now=stamp('2026-09-22'), pair_id=pair_id)
        assert count == 1
        reached.append(True)
    client.before_batch = other_family
    result = publish(ready, business_date='2026-09-22')
    assert result['readback_verified'] and reached == [True]
    assert result['nav_validation']['review_family_journal_frontier'] == preview['nav_validation']['review_family_journal_frontier']
    assert client.query("SELECT COUNT(*) AS n FROM paired_nav_daily_journal_v1 WHERE session_date<=?",
                        ['2026-09-22'])[0]['n'] == global_count + 1
