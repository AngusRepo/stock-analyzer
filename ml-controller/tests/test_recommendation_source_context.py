"""Original loader outputs and frozen SQLite reads; not investment returns."""
from copy import deepcopy
import inspect
import json
import re
import sqlite3

import pytest

from services.recommendation_service import load_fundamental_quality_by_symbol
from services.pit_sector_alpha import load_pit_sector_alpha_experts
from services.recommendation_source_context import capture_recommendation_sources, replay_recommendation_sources
from services.paired_nav_journal import digest
from test_pit_sector_alpha import _query as sector_query, DECISION_CUTOFF


@pytest.fixture
def source_db():
    db = sqlite3.connect(':memory:', check_same_thread=False)
    db.row_factory = sqlite3.Row
    # Use every column requested by the ORIGINAL loader, not a second query.
    tables = re.findall(r'SELECT(.*?)FROM (canonical_\w+)', inspect.getsource(load_fundamental_quality_by_symbol), re.S)
    assert len(tables) == 2
    for fields, table in tables:
        columns = [c.strip() for c in fields.split(',')]
        db.execute(f'CREATE TABLE {table} ({",".join(columns)})')
    for symbol, roe in [('2330', 8), ('2317', 25), ('9999', 12)]:
        db.execute('INSERT INTO canonical_fundamental_features(stock_id,period,available_date,as_of_date,source,roe,eps,pe,pb) '
            'VALUES(?,?,?,?,?,?,?,?,?)', [symbol,'2026Q1','2026-05-15','2026-05-15','finlab.fundamental_factor_diversity',roe,3,12,1.2])
        db.execute('INSERT INTO canonical_revenue_monthly(stock_id,revenue_month,revenue,yoy,source,as_of_date) '
            'VALUES(?,?,?,?,?,?)', [symbol,'2026-06',1000,20,'finlab.monthly_revenue','2026-07-10'])
    reads = []
    def query(sql, params, **kwargs):
        reads.append((sql,deepcopy(params)))
        if 'FROM canonical_' in sql:
            return [dict(r) for r in db.execute(sql, params)]
        return sector_query(sql, params)
    yield db, reads, query
    db.close()


def capture(query, **kwargs):
    return capture_recommendation_sources(run_date='2026-07-24', knowledge_cutoff=DECISION_CUTOFF,
        formal_recs=[{'symbol':'2330','industry':'SEMICONDUCTOR'}, {'symbol':'9999','industry':'STEEL'}],
        candidate_recs={'candidate':[{'symbol':'2330','industry':'SEMICONDUCTOR'},
            {'symbol':'2317','industry':'SEMICONDUCTOR'}, {'symbol':'9999','industry':'SEMICONDUCTOR'}], 'empty':[]},
        query=query, **kwargs)


def test_original_scoring_shared_observations_and_candidate_own_fallback(source_db):
    db, reads, query = source_db
    context = capture(query)
    formal = context['formal']
    candidate = context['definitions']['candidate']
    assert formal['status'] == candidate['status'] == 'captured'
    assert context['definitions']['empty']['fundamental_quality_by_symbol'] == {}
    assert candidate['fundamental_quality_by_symbol']['2330'] == formal['fundamental_quality_by_symbol']['2330']
    assert candidate['pit_sector_alpha_by_symbol']['9999']['features']['sector_formal_rs_rank'] == 1
    assert formal['pit_sector_alpha_by_symbol']['9999']['features']['sector_formal_rs_rank'] == -1
    # Whole frozen taxonomy/sector queries run once, not separately per candidate.
    assert all(sum(1 for s,p in reads if s == sql and p == params) == 1 for sql,params in reads)
    assert [p for sql,p in reads if 'FROM canonical_revenue_monthly' in sql] == [['2330','9999'],['2317']]
    assert formal['fundamental_quality_by_symbol'] == load_fundamental_quality_by_symbol(
        context['inputs']['formal_recs'], '2026-07-24', query_fn=query)
    assert formal['pit_sector_alpha_by_symbol'] == load_pit_sector_alpha_experts(query,
        signal_date='2026-07-24', symbols=['2330','9999'], knowledge_cutoff=DECISION_CUTOFF,
        fallback_industry_by_symbol={'2330':'SEMICONDUCTOR','9999':'STEEL'})
    before = deepcopy(context)
    count = len(reads)
    db.execute('UPDATE canonical_fundamental_features SET roe=-500')
    assert replay_recommendation_sources(context) == before
    again = capture(lambda *a,**k: pytest.fail('successful reads must not refresh'), saved=context)
    assert again['observations'] == context['observations'] and again['definitions'] == context['definitions']
    assert len(reads) == count and context == before
    assert context['knowledge_scope'] == 'observed_at_capture_not_historical_asof' and context['nav_maturity_credit'] == 0


@pytest.mark.parametrize('response', ['raise', 'none', 'bad_rows'])
def test_candidate_source_failure_is_not_valid_zero_and_retry_only_failed(source_db, response):
    _, reads, query = source_db
    def failing(sql, params, **kwargs):
        if 'FROM canonical_fundamental_features' in sql and params[0] == '2317':
            if response == 'raise': raise RuntimeError('provider failed')
            return None if response == 'none' else [42]
        return query(sql,params,**kwargs)
    context = capture(failing)
    assert context['formal']['status'] == 'captured'
    assert context['definitions']['candidate']['status'] == 'incomplete'
    assert '2317' in context['definitions']['candidate']['fundamental_errors']
    assert replay_recommendation_sources(context) == context
    count = len(reads)
    recovered = capture(query,saved=context)
    assert len(reads) == count+1
    assert recovered['formal'] == context['formal']
    assert recovered['definitions']['candidate']['status'] == 'captured'
    assert sum(len(v['failed_attempts']) for v in recovered['observations'].values()) == 1


def test_future_rows_keep_original_pit_filter_and_absence_is_explicit(source_db):
    db, _, query = source_db
    db.execute("UPDATE canonical_fundamental_features SET available_date='2026-08-01' WHERE stock_id='2317'")
    db.execute("UPDATE canonical_revenue_monthly SET as_of_date='2026-08-01' WHERE stock_id='2317'")
    context = capture(query)
    candidate = context['definitions']['candidate']
    assert candidate['status'] == 'captured'  # successful absence, not a provider failure
    value = candidate['fundamental_quality_by_symbol']['2317']
    assert value['score'] == 0 and value['noLookahead']['droppedFutureRevenueRows'] == 1
    assert value['dataIssues']
    assert context['nav_maturity_credit'] == 0


def test_sector_session_lag_uses_core_not_market_and_reuses_same_observation(source_db):
    core = sqlite3.connect(':memory:')
    core.row_factory = sqlite3.Row
    core.executescript("CREATE TABLE market_risk(date TEXT,twii_close REAL); INSERT INTO market_risk VALUES('2026-07-24',20000);")
    calls = []
    def market(sql,params,**kwargs):
        assert 'FROM market_risk' not in sql
        return source_db[2](sql,params,**kwargs)
    def core_query(sql,params,**kwargs):
        calls.append(sql)
        assert 'FROM market_risk' in sql
        return [dict(r) for r in core.execute(sql,params)]
    try:
        context = capture(market,core_query=core_query)
        assert context['formal']['pit_sector_alpha_by_symbol']['2330']['status']=='loaded'
        assert len(calls)==1
        assert sum(v['domain']=='core' for v in context['observations'].values())==1
        assert replay_recommendation_sources(context)==context and len(calls)==1
    finally:
        core.close()


def test_provider_exception_details_are_not_persisted_in_frozen_evidence():
    def failed(*args, **kwargs):
        raise RuntimeError('https://fixture.invalid?token=PRIVATE_TEST_SENTINEL')
    context = capture(failed)
    assert 'PRIVATE_TEST_SENTINEL' not in json.dumps(context)
    assert context['formal']['status']=='incomplete'
    assert replay_recommendation_sources(context)==context


@pytest.mark.parametrize('kind', ['revenue', 'financial'])
@pytest.mark.parametrize('observed', ['2026-08-01', 'invalid'])
def test_pure_scorer_cannot_use_later_or_invalid_observation(kind, observed):
    from services.fundamental_quality import score_fundamental_quality
    row = dict(revenue_month='2026-06', available_date='2026-07-10', as_of_date=observed,
               yoy=20, roe=25, pe=12, eps=3)
    result = score_fundamental_quality(decision_date='2026-07-24', **{kind+'_rows':[row]})
    assert result['score'] == 0
    assert result['noLookahead']['droppedFutureRevenueRows' if kind == 'revenue' else 'droppedFutureFinancialRows'] == 1


@pytest.mark.parametrize('fault', ['scope', 'checksum', 'future', 'output'])
def test_tampered_context_rejected(source_db, fault):
    context = capture(source_db[2])
    if fault == 'scope': context['inputs']['candidate_recs']['candidate'].pop()
    if fault == 'checksum': context['source_checksum'] = 'bad'
    if fault == 'future': next(iter(context['observations'].values()))['completed_at'] = '2100-01-01T00:00:00Z'
    if fault == 'output': context['definitions']['candidate']['fundamental_quality_by_symbol']['2330']['score'] += 1
    if fault in {'future','output'}:
        context['source_checksum'] = digest({k:v for k,v in context.items() if k != 'source_checksum'})
    with pytest.raises(ValueError): replay_recommendation_sources(context)
