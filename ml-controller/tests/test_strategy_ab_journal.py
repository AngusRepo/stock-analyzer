"""Exercise real SQL/hash-chained accounting, with resolved comparison boundary."""
from copy import deepcopy
from datetime import datetime, timezone

from test_paired_nav_journal import DB, packet, seal, receipt, buy
from services.paired_nav_journal import materialize_pair
from services.strategy_ab import SCHEMA, FEE_TERMS, RECIPES


def test_two_day_rebate_survives_real_journal_replay_and_exact_retry(monkeypatch):
    from services import paired_nav_comparison
    monkeypatch.setattr(paired_nav_comparison, 'resolve_comparison', lambda **_: {
        'strategy_ab': {'schema_version': SCHEMA, 'experiment_id': 'a'*64,
                        'role': 'A', 'recipe': RECIPES['A'], 'fee_terms': deepcopy(FEE_TERMS)}})
    db = DB()
    first_packet = packet()
    frozen = seal(db, first_packet)
    fill = {**buy(), 'shares': 200, 'price': 200, 'commission': 57}
    execution = receipt(first_packet, frozen, fills=[fill], marks={'2330': 200})
    kwargs = dict(snapshot_id=frozen['snapshot_id'], session_date='2026-09-08',
                  execution=execution, query=db.query, writer=db.writer,
                  now=datetime(2026,9,9,8,tzinfo=timezone.utc))
    first = materialize_pair(**kwargs)
    account = first['arms']['candidate']
    assert account['cash'] == 59943 and account['nav'] == 99943
    assert account['commission_rebate']['estimated_receivable'] == 37
    assert account['estimated_nav_including_rebate'] == 99980
    assert materialize_pair(**kwargs) == first
    second_packet = packet('2026-09-09','2026-09-08')
    frozen2 = seal(db, second_packet, '2026-09-08')
    second = materialize_pair(snapshot_id=frozen2['snapshot_id'], session_date='2026-09-09',
        execution=receipt(second_packet, frozen2, marks={'2330': 210}),
        query=db.query, writer=db.writer, now=kwargs['now'])
    account2 = second['arms']['candidate']
    assert account2['cash'] == 59943 and account2['nav'] == 101943
    assert account2['commission_rebate'] == account['commission_rebate']
    assert account2['estimated_nav_including_rebate'] == 101980
    assert second['initial_account_nav'] == first['initial_account_nav'] == 100000
    assert second['initial_session_date'] == first['initial_session_date'] == '2026-09-08'
    assert db.query('SELECT COUNT(*) AS n FROM paired_nav_daily_journal_v1',[])[0]['n'] == 2
