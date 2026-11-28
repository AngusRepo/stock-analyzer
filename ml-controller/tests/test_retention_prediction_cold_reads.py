"""L-2 cold reads: ml-controller readers of Learning `predictions` give the same result after the
retention drain archived and deleted rows older than the hot window (120 + 7 buffer days), or stop with an
explicit reason when no archived equivalent exists."""
from __future__ import annotations

import json
import math
import sqlite3
from pathlib import Path

import pytest

from services import retention_history, retention_prediction_reads as reads

SCHEMA = Path(__file__).resolve().parents[2] / 'worker' / 'domain-schemas' / 'learning.sql'
CUTOFF = '2026-07-28'
OLD_DATES = ['2026-03-02', '2026-04-15', '2026-05-20', '2026-07-27']
HOT_DATES = [CUTOFF, '2026-09-01', '2026-11-20']
MODELS = ['ensemble', 'LightGBM', 'TabM']
STOCKS = [2330, 2317, 2454, 1101]
RISK = ['green', 'yellow', 'red', 'black', None]
OUTCOMES = ['hit_target1', 'hit_target2', 'hit_stop', 'expired', None]


class SqliteD1:
    def __init__(self, db: sqlite3.Connection):
        self.db = db

    def query(self, sql, params=None, **_):
        return [dict(row) for row in self.db.execute(sql, params or [])]

    def execute(self, sql, params=None, **_):
        self.db.execute(sql, params or [])
        return {'meta': {'changes': self.db.total_changes}}


def learning_db() -> sqlite3.Connection:
    db = sqlite3.connect(':memory:')
    db.row_factory = sqlite3.Row
    db.executescript(SCHEMA.read_text())
    return db


def seed(db: sqlite3.Connection) -> None:
    i = 0
    for date in [*OLD_DATES, *HOT_DATES]:
        for stock in STOCKS:
            for model in MODELS:
                # 1101 only has archived rows: its 'all' rows must survive the drain.
                if stock == 1101 and date >= CUTOFF:
                    continue
                for version in (0, 1):
                    i += 1
                    verified = i % 7 != 0
                    db.execute(
                        '''INSERT INTO predictions(id, stock_id, model_name, generated_at, prediction_date, forecast_data,
                           direction_correct, price_error_pct, market_risk_level, actual_return_pct, trade_pnl_pct,
                           trade_pnl_r, trade_outcome, max_favorable_pct, max_adverse_pct, verified_at,
                           verification_label_known_date)
                           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
                        [i, stock, model, f'{date}T05:3{version}:00Z', date, json.dumps({'v': version, 'i': i}),
                         (i % 2) if verified else None, (i % 9) / 10 if i % 4 else None, RISK[i % 5],
                         ((i % 13) - 6) / 100 if verified and i % 3 else None,
                         ((i % 11) - 5) / 100 if verified and i % 5 else None,
                         ((i % 7) - 3) / 10 if verified and i % 6 else None, OUTCOMES[i % 5],
                         (i % 8) / 100 if i % 3 else None, -(i % 6) / 100 if i % 2 else None,
                         f'{date} 20:00:00' if verified else None, date if verified else None])


def drain(db: sqlite3.Connection, chunk: int = 7) -> list[dict]:
    """What retention-hot-window-drain leaves: old rows gone, their totals in prediction_cold_stats_v1.

    Chunks are added with the same expressions and merge rules as retentionPredictionColdStats.ts.
    """
    deleted = [dict(row) for row in db.execute('SELECT * FROM predictions WHERE prediction_date < ? ORDER BY id', [CUTOFF])]
    names = [name for name, _, _ in reads.PREDICTION_COLD_STATS_EXPRESSIONS]

    def merge(name, kind):
        if kind == 'count':
            return f'{name}={name}+excluded.{name}'
        both = f'{name}+excluded.{name}' if kind == 'sum' else f'{kind}({name},excluded.{name})'
        return (f'{name}=CASE WHEN {name} IS NULL THEN excluded.{name} WHEN excluded.{name} IS NULL '
                f'THEN {name} ELSE {both} END')
    sql = (f"INSERT INTO prediction_cold_stats_v1 (stock_id, model_name, {', '.join(names)}, archived_rows) "
           f"SELECT p.stock_id, p.model_name, {', '.join(e for _, _, e in reads.PREDICTION_COLD_STATS_EXPRESSIONS)}, COUNT(*) "
           'FROM predictions p WHERE p.rowid IN (SELECT value FROM json_each(?)) GROUP BY p.stock_id, p.model_name '
           'ON CONFLICT(stock_id, model_name) DO UPDATE SET '
           + ', '.join(merge(n, k) for n, k, _ in reads.PREDICTION_COLD_STATS_EXPRESSIONS)
           + ', archived_rows=archived_rows+excluded.archived_rows')
    for start in range(0, len(deleted), chunk):
        ids = [row['id'] for row in deleted[start:start + chunk]]
        db.execute(sql, [json.dumps(ids)])
        db.execute('DELETE FROM predictions WHERE id IN (SELECT value FROM json_each(?))', [json.dumps(ids)])
    return deleted


def archive_reader(deleted: list[dict]):
    """retention_history.archived_predictions over the deleted rows (filters as in the real reader)."""
    def read(start, end, *, date_column='prediction_date', model_name=None, stock_ids=None, **_):
        wanted = None if stock_ids is None else set(stock_ids)
        return iter([dict(row) for row in deleted
                     if start <= str(row.get(date_column) or '') <= end
                     and (model_name is None or row['model_name'] == model_name)
                     and (wanted is None or row['stock_id'] in wanted)])
    return read


def table(db, name):
    rows = [dict(row) for row in db.execute(f'SELECT * FROM {name} ORDER BY stock_id, model_name, period')]
    for row in rows:
        row.pop('id'); row.pop('last_updated')
    return rows


def assert_rows_equal(actual, expected):
    assert [(r['stock_id'], r['model_name'], r['period']) for r in actual] == \
        [(r['stock_id'], r['model_name'], r['period']) for r in expected]
    for a, e in zip(actual, expected):
        for key, value in e.items():
            if isinstance(value, float) or isinstance(a[key], float):
                assert a[key] is not None and value is not None and math.isclose(a[key], value, rel_tol=1e-12, abs_tol=1e-12), (key, a, e)
            else:
                assert a[key] == value, (key, a, e)


def run_verify(monkeypatch, db):
    from services import verify_service
    monkeypatch.setattr(verify_service, 'LEARNING_D1_CLIENT', SqliteD1(db))
    verify_service.update_model_accuracy()
    verify_service.update_trade_performance()


def test_verify_all_period_matches_before_and_after_the_drain(monkeypatch):
    before, after = learning_db(), learning_db()
    seed(before); seed(after)
    drain(after)
    assert after.execute('SELECT COUNT(*) FROM predictions WHERE prediction_date < ?', [CUTOFF]).fetchone()[0] == 0
    run_verify(monkeypatch, before)
    run_verify(monkeypatch, after)
    expected_accuracy, expected_trades = table(before, 'model_accuracy'), table(before, 'trade_performance')
    assert {r['stock_id'] for r in expected_accuracy if r['period'] == 'all'} == set(STOCKS)
    assert_rows_equal(table(after, 'model_accuracy'), expected_accuracy)
    assert_rows_equal(table(after, 'trade_performance'), expected_trades)


def test_verify_without_the_stats_table_keeps_the_original_queries(monkeypatch):
    before, plain = learning_db(), learning_db()
    seed(before); seed(plain)
    plain.execute('DROP TABLE prediction_cold_stats_v1')
    run_verify(monkeypatch, before)
    run_verify(monkeypatch, plain)
    assert_rows_equal(table(plain, 'model_accuracy'), table(before, 'model_accuracy'))
    assert reads.load_prediction_cold_stats(SqliteD1(plain).query) == {}
    broken = SqliteD1(plain)
    broken.query = lambda *a, **k: (_ for _ in ()).throw(RuntimeError('D1 timeout'))
    with pytest.raises(RuntimeError, match='timeout'):
        reads.load_prediction_cold_stats(broken.query)


def test_cold_stats_pages_by_primary_key():
    db = learning_db()
    for stock in range(4500):
        db.execute('INSERT INTO prediction_cold_stats_v1(stock_id, model_name, d_total) VALUES(?, ?, 1)', [stock, 'm'])
    stats = reads.load_prediction_cold_stats(SqliteD1(db).query)
    assert len(stats) == 4500 and stats[(4499, 'm')]['d_total'] == 1
    plan = ' '.join(r[3] for r in db.execute('EXPLAIN QUERY PLAN SELECT * FROM prediction_cold_stats_v1 '
                                             'WHERE (stock_id, model_name) > (?, ?) ORDER BY stock_id, model_name LIMIT 2000', [0, '']))
    assert plan.startswith('SEARCH') and 'SCAN' not in plan


def test_migration_safety_rows_match_before_and_after_the_drain(monkeypatch):
    from routers import admin
    before, after = learning_db(), learning_db()
    seed(before); seed(after)
    deleted = drain(after)
    monkeypatch.setattr(admin, 'LEARNING_D1_CLIENT', SqliteD1(before))
    monkeypatch.setattr(retention_history, 'archived_predictions', archive_reader([]))
    expected = admin._migration_safety_prediction_rows('2026-01-01', '2026-11-30')
    monkeypatch.setattr(admin, 'LEARNING_D1_CLIENT', SqliteD1(after))
    monkeypatch.setattr(retention_history, 'archived_predictions', archive_reader(deleted))
    actual = admin._migration_safety_prediction_rows('2026-01-01', '2026-11-30')
    # ORDER BY generated_at DESC has no tie-break in the original SQL either: same rows, same order of times.
    assert [r['generated_at'] for r in actual] == [r['generated_at'] for r in expected]
    key = lambda r: (r['generated_at'], r['stock_id'], r['forecast_data'])  # noqa: E731
    assert sorted(actual, key=key) == sorted(expected, key=key)
    assert any(row['prediction_date'] < CUTOFF for row in expected)


def test_legacy_opb_ledger_stops_instead_of_reading_a_cut_window(monkeypatch):
    """Rollback path (no l4Distribution): recommendation_service is source-pinned, so the 180-day
    ledger is not merged with the archive; once a chunk is archived the pipeline stops explicitly."""
    source = (Path(__file__).resolve().parents[1] / 'graphs' / 'daily_pipeline_v2.py').read_text()
    guard = source.index("require_hot_prediction_lookback(datetime.now(timezone.utc).date().isoformat(), 180, 'legacy_opb_reward_ledger')")
    assert guard < source.index('load_online_portfolio_bandit_reward_ledger()')
    from services.recommendation_service import load_online_portfolio_bandit_reward_ledger
    import inspect
    assert inspect.signature(load_online_portfolio_bandit_reward_ledger).parameters['lookback_days'].default == 180
    monkeypatch.setattr(retention_history.OPS, 'query', lambda *a, **k: [{'hit': 1}])
    with pytest.raises(reads.ColdPredictionsRequired, match='legacy_opb_reward_ledger'):
        reads.require_hot_prediction_lookback('2026-11-30', 180, 'legacy_opb_reward_ledger')


def test_fail_closed_guards_name_the_reader_and_window(monkeypatch):
    from datetime import date
    from services import allocator_ev_fusion_artifact_builder as fusion, l4_alpha_ev_artifact_builder as l4
    manifest = [{'hit': 1}]
    monkeypatch.setattr(retention_history.OPS, 'query', lambda *a, **k: manifest)
    with pytest.raises(reads.ColdPredictionsRequired, match='allocator_ev_fusion_training_rows:2026-03-01..2026-05-30'):
        fusion.load_allocator_ev_fusion_training_rows(lambda *a: [], end_date='2026-05-30', lookback_days=90)
    with pytest.raises(reads.ColdPredictionsRequired, match='l4_alpha_ev_training_rows'):
        l4.load_l4_alpha_ev_training_rows(lambda *a: [], end_date='2026-05-30', lookback_days=90)
    # No archived chunk covers the window: the guard reads one manifest row and lets the reader run.
    manifest.clear()
    reads.require_hot_predictions('2026-03-01', '2026-05-30', 'x')
    # Dates inside the hot floor never ask the ops ledger.
    monkeypatch.setattr(retention_history.OPS, 'query', lambda *a, **k: pytest.fail('ops read for a hot window'))
    # 120-day reader floor + 7 buffer days: the drain never archives on or after today - 127 days.
    assert reads.never_archived('2026-07-24', today=date(2026, 11, 28))
    assert not reads.never_archived('2026-07-23', today=date(2026, 11, 28))
    assert not reads.never_archived('2026-11-01', date_column='generated_at', today=date(2026, 11, 28))
    reads.require_hot_predictions(date.today().isoformat(), date.today().isoformat(), 'x')


def test_more_reads_stop_with_a_reason_when_their_window_reaches_the_archive(monkeypatch):
    from datetime import date, timedelta
    from routers import retrain_trigger
    from services import s12_trade_ev_bootstrap as s12
    monkeypatch.setattr(retention_history.OPS, 'query', lambda *a, **k: [{'hit': 1}])
    # TimesFM L1.75 (retired) 420-day history: never trained on a window cut at the hot window.
    monkeypatch.setattr(retrain_trigger, 'LEARNING_D1_CLIENT', SqliteD1(learning_db()))
    with pytest.raises(reads.ColdPredictionsRequired, match='timesfm_l175_history'):
        retrain_trigger._load_timesfm_l175_history(stock_ids=[2330], run_date='2026-11-25')
    # S12 trade-EV bootstrap: a short page whose window reaches the archive stops ...
    with pytest.raises(reads.ColdPredictionsRequired, match='s12_trade_ev_bootstrap'):
        # run_date 30 days back: its 120-day window starts before today - 127 days.
        s12.load_s12_replay_trade_rows(run_date=(date.today() - timedelta(days=30)).isoformat(),
                                       query_fn=lambda *a, **k: [], core_query_fn=lambda *a, **k: [])
    # A run_date within the 7 buffer days stays exact and never asks the ops ledger.
    s12.load_s12_replay_trade_rows(run_date=(date.today() - timedelta(days=7)).isoformat(),
                                   query_fn=lambda *a, **k: [], core_query_fn=lambda *a, **k: [])
    # ... while a full page only checks from its oldest (hot) date.
    seen = []
    monkeypatch.setattr(retention_history.OPS, 'query', lambda *a, **k: seen.append(a) or [])
    reads.require_hot_latest([{'prediction_date': '2026-11-01'}, {'prediction_date': '2026-11-20'}], 2,
                             '2026-07-01', '2026-11-25', 'x')
    assert seen == [], 'a full page inside the hot window reads no ops ledger'


def test_no_lookahead_audit_counts_archived_label_violations(monkeypatch):
    from services.no_lookahead_audit import CANONICAL_LABEL_VERSION, run_audit
    def prepared():
        db = learning_db()
        seed(db)
        db.execute('UPDATE predictions SET verification_label_schema_version=?, verification_label_end_date=prediction_date,'
                   ' verification_label_known_date=date(prediction_date, \'+8 days\')', [CANONICAL_LABEL_VERSION])
        # Violations both in rows the drain will archive and in hot rows.
        db.execute('UPDATE predictions SET verification_label_known_date=prediction_date WHERE id % 9 = 0')
        return db
    def checks(db):
        q = SqliteD1(db)
        result = run_audit(lambda sql, params, timeout: q.query(sql, params))
        by = {c['name']: c for c in result['checks']}
        return by
    before, after = prepared(), prepared()
    drain(after)
    b, a = checks(before), checks(after)
    assert b['canonical_prediction_label']['violations'] > 0
    assert a['canonical_prediction_label']['violations'] < b['canonical_prediction_label']['violations']
    assert (a['canonical_prediction_label']['violations'] + a['canonical_prediction_label_archived']['violations']
            == b['canonical_prediction_label']['violations'] + b['canonical_prediction_label_archived']['violations'])
    assert a['canonical_prediction_label_archived']['status'] == 'FAIL'
    assert b['canonical_prediction_label_archived'] == {'name': 'canonical_prediction_label_archived', 'violations': 0, 'status': 'PASS'}
