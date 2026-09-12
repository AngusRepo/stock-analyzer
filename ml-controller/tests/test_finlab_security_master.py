from dataclasses import fields
from datetime import datetime
from pathlib import Path
import sqlite3
import sys

import polars as pl
import pytest

from services.finlab_security_master import normalize_security_master, normalize_etf_master, merge_security_masters
from services.finlab_canonical_materializer import FinLabCanonicalOutputs, build_d1_upsert_statements


def company(**overrides):
    return {'symbol': '2330', '公司簡稱': 'TSMC', '市場別': 'sii', '上市日期': '1994-09-05',
            '上櫃日期': None, '興櫃日期': None, **overrides}


def etf(**overrides):
    return {'symbol': '0050', '證券簡稱': '元大台灣50', '上市日期': datetime(2003, 6, 30),
        'ETF詳情頁': 'https://www.twse.com.tw/zh/ETFortune-institute/etfInfo/0050', **overrides}


def outputs(rows):
    values = {f.name: [] for f in fields(FinLabCanonicalOutputs)}
    values.update(run_id='test', generated_at='2026-09-08T00:00:00Z', artifact_root='', manifest={}, security_master=rows)
    return FinLabCanonicalOutputs(**values)


def statements(rows):
    return [(sql, params) for sql, params in build_d1_upsert_statements(outputs(rows))
            if sql.startswith('INSERT INTO stocks ')]


def test_verified_company_and_etf_keep_distinct_owners():
    rows = merge_security_masters(normalize_security_master(pl.DataFrame([company()]), '2026-09-08T08:00:00+08:00'),
        normalize_etf_master(pl.DataFrame([etf()]), '2026-09-08T00:00:00Z'))
    assert [(r['symbol'], r['listed_date']) for r in rows] == [('0050', '2003-06-30'), ('2330', '1994-09-05')]
    assert {r['listing_observed_at'] for r in rows} == {'2026-09-08T00:00:00.000000+00:00'}
    with pytest.raises(ValueError, match='duplicate_owner'):
        merge_security_masters(rows, rows)


def test_emerging_source_keeps_exact_venue_without_breaking_core_exchange_family_check():
    row = normalize_security_master(pl.DataFrame([company(**{'市場別': 'rotc', '上市日期': None,
        '興櫃日期': '2024-08-12'})]), '2026-09-08T00:00:00Z')[0]
    assert row['market'] == 'OTC'
    assert row['listing_market'] == 'ROTC'
    assert row['listed_date'] == '2024-08-12'
    assert row['listed_date_source'].endswith(':興櫃日期')


@pytest.mark.parametrize('changes,reason', [({'市場別': 'unknown'}, 'market_unknown'),
    ({'上市日期': None}, 'listing_missing'), ({'symbol': '??'}, 'symbol_invalid'),
    ({'公司簡稱': None}, 'name_missing')])
def test_company_fails_missing_or_unverifiable_facts(changes, reason):
    with pytest.raises(ValueError, match=reason):
        normalize_security_master(pl.DataFrame([company(**changes)]), '2026-09-08T00:00:00Z')


@pytest.mark.parametrize('url', ['https://www.twse.com.tw.evil.test/zh/ETFortune-institute/etfInfo/0050',
    'https://www.twse.com.tw/zh/ETFortune-institute/etfInfo/0051', 'https://www.tpex.org.tw/0050'])
def test_etf_does_not_infer_unverified_market(url):
    with pytest.raises(ValueError, match='market_unverified'):
        normalize_etf_master(pl.DataFrame([etf(**{'ETF詳情頁': url})]), '2026-09-08T00:00:00Z')


def test_listing_migration_preserves_legacy_and_upsert_never_rolls_back_or_resets_account_metadata():
    db = sqlite3.connect(':memory:')
    db.executescript('''CREATE TABLE stocks(id INTEGER PRIMARY KEY, symbol TEXT UNIQUE, name TEXT,
        market TEXT CHECK(market IN ('TWSE','OTC','US')), listed_date TEXT, delisted_date TEXT, pinned INTEGER, sector TEXT,
        in_current_watchlist INTEGER, source TEXT);
        INSERT INTO stocks VALUES(42,'2330','old','TWSE','2020-01-01',NULL,1,'semiconductor',1,'manual');
        INSERT INTO stocks VALUES(43,'0050','ETF','TWSE','2003-06-30',NULL,0,'ETF',0,'manual');''')
    root = Path(__file__).resolve().parents[2]
    db.executescript((root / 'worker/domain-migrations/core/0007_stock_listing_source.sql').read_text())
    assert db.execute('SELECT listed_date,listing_legacy_date FROM stocks WHERE id=42').fetchone() == (None, '2020-01-01')
    assert db.execute('SELECT listed_date FROM stocks WHERE id=43').fetchone() == ('2003-06-30',)
    rows = normalize_security_master(pl.DataFrame([company()]), '2026-09-08T00:00:00Z')
    for sql, params in statements(rows):
        db.execute(sql, params)
    assert db.execute('SELECT id,pinned,sector,in_current_watchlist,source,listed_date FROM stocks WHERE id=42').fetchone() == (
        42, 1, 'semiconductor', 1, 'manual', '1994-09-05')
    for clock in ['2026-09-07T23:59:59Z']:
        bad = normalize_security_master(pl.DataFrame([company(**{'上市日期': '2020-01-01'})]), clock)
        for sql, params in statements(bad):
            db.execute(sql, params)
        assert db.execute('SELECT listed_date FROM stocks WHERE id=42').fetchone() == ('1994-09-05',)
    for sql, params in statements(rows):
        db.execute(sql, params)  # exact retry remains valid
    conflicting = normalize_security_master(pl.DataFrame([company(**{'上市日期': '2020-01-01'})]), '2026-09-08T00:00:00Z')
    with pytest.raises(sqlite3.IntegrityError, match='capture_conflict'):
        for sql, params in statements(conflicting):
            db.execute(sql, params)
    emerging = normalize_security_master(pl.DataFrame([company(**{'symbol': '7777', '市場別': 'rotc',
        '上市日期': None, '興櫃日期': '2024-08-12'})]), '2026-09-08T00:00:00Z')
    for sql, params in statements(emerging):
        db.execute(sql, params)
    assert db.execute("SELECT market,listing_market FROM stocks WHERE symbol='7777'").fetchone() == ('OTC', 'ROTC')


@pytest.mark.parametrize('mode', ['ready', 'missing_schema', 'missing_trigger', 'partial_write', 'dry_run'])
def test_core_owner_preflight_and_ack_before_receipts(monkeypatch, mode):
    root = Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(root))
    from tools import finlab_v4_remote_backfill as tool
    from services import finlab_canonical_materializer as materializer
    rows = normalize_security_master(pl.DataFrame([company()]), '2026-09-08T00:00:00Z')
    calls = []
    trigger = (root / 'worker/domain-migrations/core/0007_stock_listing_source.sql').read_text()

    def query(sql, params=None, *, domain=None):
        assert domain == 'core'
        calls.append('preflight')
        if mode == 'missing_schema':
            raise RuntimeError('missing_listing_schema')
        return [] if 'LIMIT 0' in sql or mode == 'missing_trigger' else [{'sql': trigger}]

    def batch(sqls, **kwargs):
        assert kwargs['domain'] == 'core'
        assert all(sql.startswith('INSERT INTO stocks ') for sql, _ in sqls)
        calls.append('core')
        return {'total': 1, 'success_count': 0 if mode == 'partial_write' else 1,
                'error_count': 1 if mode == 'partial_write' else 0, 'changes_total': 1}

    def ops(sqls, **kwargs):
        calls.append('ops')
        return {'total': 1, 'success_count': 1, 'error_count': 0, 'changes_total': 1}

    monkeypatch.setattr(tool, 'd1_query', query)
    monkeypatch.setattr(tool, 'd1_batch_execute', batch)
    monkeypatch.setattr(tool, 'ops_d1_batch_execute', ops)
    monkeypatch.setattr(tool, 'controller_d1_batch_execute', lambda *a, **kw: pytest.fail('Core leaked to legacy owner'))
    saved_sql = [(sql, params) for sql, params in build_d1_upsert_statements(outputs(rows)) if sql.startswith('INSERT INTO stocks ')]
    monkeypatch.setattr(materializer, 'build_d1_upsert_statements', lambda _: saved_sql + [
        ('INSERT INTO data_source_inventory (source) VALUES (?)', ['finlab'])])
    arguments = dict(manifest={'artifact_root': '', 'run_id': 'test', 'generated_at': '2026-09-08T00:00:00Z'},
        start_date=None, end_date=None, datasets=['stocks'], canonical_outputs=outputs(rows), dry_run=mode == 'dry_run')
    if mode in {'missing_schema', 'missing_trigger', 'partial_write'}:
        with pytest.raises(RuntimeError, match={'missing_schema': 'missing_listing_schema',
                'missing_trigger': 'migration_missing', 'partial_write': 'write_incomplete'}[mode]):
            tool.materialize_canonical_to_d1(**arguments)
        assert 'ops' not in calls
        if mode != 'partial_write':
            assert 'core' not in calls
    else:
        result = tool.materialize_canonical_to_d1(**arguments)
        assert calls == ([] if mode == 'dry_run' else ['preflight', 'preflight', 'core', 'ops'])
        assert result['writes_by_domain']['core'] == 1


@pytest.mark.parametrize('failed_source', [None, 'company_basic_info', 'tw_etf_basic_info'])
def test_source_capture_one_lane_three_distinct_artifacts_and_failure_is_not_green(monkeypatch, tmp_path, failed_source):
    from types import SimpleNamespace
    import pandas as pd
    root = Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(root))
    from tools import finlab_v4_remote_backfill as tool
    calls = []

    def fetch(key):
        calls.append(key)
        if key == failed_source:
            raise RuntimeError('source_unavailable')
        return pd.DataFrame([{'symbol': '2330', 'source_identity': key}])

    monkeypatch.setitem(sys.modules, 'finlab', SimpleNamespace(data=SimpleNamespace(get=fetch), login=None))
    monkeypatch.setattr(tool, 'login_finlab_sdk', lambda _: None)
    monkeypatch.setattr(tool, 'd1_counts', lambda _: {})
    monkeypatch.setattr(tool, 'utc_now', lambda: '2026-09-08T00:00:00+00:00')
    summaries, diffs, reports, blockers = tool.materialize_specs(years=1, run_dir=tmp_path,
        lanes=['security_master'], generated_at='2026-01-01T00:00:00+00:00')
    assert calls == ['security_categories', 'company_basic_info', 'tw_etf_basic_info']
    assert len(summaries) == len(diffs) == 1
    assert len(reports) == len(summaries[0]['artifacts']) == 3
    assert {r['field'] for r in reports} == {'table', 'company_basic_info', 'tw_etf_basic_info'}
    assert len({r['path'] for r in summaries[0]['artifacts']}) == 3
    assert pl.read_parquet(tmp_path / 'raw/security_master/table.parquet')['source_identity'][0] == 'security_categories'
    for key in {'company_basic_info', 'tw_etf_basic_info'} - {failed_source}:
        frame = pl.read_parquet(tmp_path / f'raw/security_master/{key}.parquet')
        assert frame['source_identity'][0] == key
        assert frame['__observed_at'][0] == '2026-09-08T00:00:00+00:00'
    assert len(blockers) == (1 if failed_source else 0)
    if failed_source:
        assert blockers[0]['required_fields'] == [failed_source]
        assert next(r for r in reports if r['field'] == failed_source)['status'] == 'failed'
