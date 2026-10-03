import json
from copy import deepcopy
import polars as pl
import pytest
from services.research_corporate_history import (make_history_record, records_frame,
    load_history_tape, load_research_corporate_components, validate_history_record)
from services.backtest_corporate_accounting import load_corporate_tape
from services.paired_nav_journal import digest


def sample():
    snapshot={'session_date':'2026-06-16','covered_symbols':['1582'],'actions':[
        {'action_id':'cash-event','symbol':'1582','kind':'cash','ex_date':'2026-06-16',
         'payable_date':'2026-07-15','cash_per_share':3.,'stock_per_share':0}],
        'blockers':{},'source_checksum':'a'*64,'tax_basis':'gross_before_personal_tax'}
    return make_history_record(snapshot,captured_at='2026-10-03T01:00:00+00:00',
        history_start='2026-06-16',history_end='2026-07-15',source_refs=[
            {'dataset':'finlab.dividend_announcement','uri':'local://sealed.parquet',
             'sha256':'b'*64,'fetched_at':'2026-10-03T00:00:00+00:00'}])


def test_old_event_retains_actual_current_capture_time_and_no_live_credit():
    record=sample(); tape=load_history_tape(records_frame([record]))
    assert tape['2026-06-16']['observed_at']=='2026-10-03T01:00:00+00:00'
    assert record['original_paper_receipt'] is False
    assert record['decision_input_eligible'] is False
    assert record['execution_parity_credit'] is False
    with pytest.raises((ValueError,KeyError)):
        load_corporate_tape(records_frame([record]))


def test_history_requires_explicit_opt_in_and_never_falls_back_on_corruption():
    frame=records_frame([sample()]); calls=[]
    reader=lambda uri: calls.append(uri) or frame
    assert load_research_corporate_components({'corporate_history_records':'history'},reader)=={}
    assert not calls
    assert load_research_corporate_components({'corporate_history_records':'history'},reader,allow_history=True)
    record=sample();record['snapshot']['actions'][0]['cash_per_share']=999
    corrupt=pl.DataFrame({'session_date':['2026-06-16'],'record_json':[json.dumps(record)]})
    with pytest.raises(ValueError,match='corrupt'):
        load_research_corporate_components({'corporate_history_records':'history','corporate_source_records':'paper'},lambda uri:corrupt,allow_history=True)


@pytest.mark.parametrize('key,value', [('original_paper_receipt',True),('decision_input_eligible',True),('execution_parity_credit',True)])
def test_reconstruction_cannot_claim_feature_pit_or_execution_parity(key,value):
    r=sample();r[key]=value;r['record_checksum']=digest({k:v for k,v in r.items() if k!='record_checksum'})
    with pytest.raises(ValueError,match='semantic_invalid'):validate_history_record(r)


def test_future_source_missing_terms_and_duplicate_sessions_rejected():
    r=sample();r['source_refs'][0]['fetched_at']='2026-10-04T00:00:00+00:00'
    r['record_checksum']=digest({k:v for k,v in r.items() if k!='record_checksum'})
    with pytest.raises(ValueError,match='source_ref_invalid'):validate_history_record(r)
    with pytest.raises(ValueError,match='session_identity'):records_frame([sample(),sample()])
    r=sample();s=r['snapshot'];s['blockers']={'1582':['unresolved_revision']}
    s['covered_symbols']=['1582','2330']
    record=make_history_record(s,captured_at=r['captured_at'],source_refs=r['source_refs'],history_start=r['history_start'],history_end=r['history_end'])
    from services.research_corporate_history import account_history_snapshot
    assert account_history_snapshot(record['snapshot'], {'2330'})['blockers']=={}
    with pytest.raises(ValueError,match='required_terms_missing:.*1582'):
        account_history_snapshot(record['snapshot'], {'1582'})


def test_historical_cash_uses_existing_receivable_then_payment_accounting():
    from services.backtest_corporate_accounting import apply_corporate_session
    from test_backtest_corporate_accounting import account
    book=account();book.positions['1582']=book.positions.pop('2330')
    r=sample();s=r['snapshot'];apply_corporate_session(book,s,'2026-06-16',{'1582':100.})
    assert book.cash==99000 and book.corporate_receivables['cash-event']['cash_due']==300
    paid=deepcopy(s);paid['session_date']='2026-07-15'
    apply_corporate_session(book,paid,'2026-07-15',{'1582':97.})
    assert book.cash==99300 and not book.corporate_receivables


def test_compiler_retains_receivable_and_does_not_use_later_revision():
    from test_finlab_corporate_actions import row, CASH, STOCK
    from services.research_corporate_history import reconstruct_company_sessions
    original=row(**{STOCK[0]:0.,'除權交易日':None,'現金股利發放日':'2026-09-09'})
    later=row(**{STOCK[0]:0.,'除權交易日':None,'現金股利發放日':'2026-09-09',
        'key_date':'2026-10-01 12:00:00',CASH[0]:99.})
    refs=sample()['source_refs']+[{'dataset':'official.exchange_census','uri':'local://census.json',
        'sha256':'c'*64,'fetched_at':'2026-10-03T00:00:00+00:00'}]
    days=['2026-09-07','2026-09-08','2026-09-09']
    tape=load_history_tape(reconstruct_company_sessions(pl.DataFrame([original,later]),days=days,
        symbols=['2330'],captured_at='2026-10-03T01:00:00+00:00',source_refs=refs,
        issuer_evidence={},other_events={d:[] for d in days}))
    assert all(tape[d]['actions'][0]['cash_per_share']==3. for d in days)
    assert all(tape[d]['observed_at'].startswith('2026-10-03') for d in days)
    assert all(tape[d]['vendor_asof_cutoff'].startswith(d) for d in days)


def test_compiler_requires_explicit_complete_census():
    from test_finlab_corporate_actions import row
    from services.research_corporate_history import reconstruct_company_sessions
    with pytest.raises(ValueError,match='exchange_census_missing'):
        reconstruct_company_sessions(pl.DataFrame([row()]),days=['2026-09-07'],symbols=['2330'],
            captured_at='2026-10-03T01:00:00+00:00',source_refs=sample()['source_refs'],
            issuer_evidence={},other_events={})


def test_raw_sources_and_materialized_artifact_are_checked_before_use(tmp_path):
    import hashlib
    from services.research_corporate_history import verify_local_sources, load_history_artifact, validate_history_coverage
    raw=tmp_path/'source.json';raw.write_text('{}')
    ref={'dataset':'test','uri':raw.as_uri(),'sha256':hashlib.sha256(raw.read_bytes()).hexdigest()}
    verify_local_sources([ref])
    raw.write_text('{"changed":true}')
    with pytest.raises(ValueError,match='raw_source_corrupt'):verify_local_sources([ref])
    file=tmp_path/'history.parquet';records_frame([sample()]).write_parquet(file)
    sha=hashlib.sha256(file.read_bytes()).hexdigest()
    frame=load_history_artifact(file,sha)
    validate_history_coverage(frame,days=['2026-06-16'],symbols=['1582'])
    with pytest.raises(ValueError,match='sessions_missing'):validate_history_coverage(frame,days=['2026-06-17'],symbols=['1582'])
    with pytest.raises(ValueError,match='symbols_missing'):validate_history_coverage(frame,days=['2026-06-16'],symbols=['1582','0050'])
    with pytest.raises(ValueError,match='checksum_mismatch'):load_history_artifact(file,'0'*64)


def test_revised_outstanding_event_blocks_affected_holder_without_forging_old_terms():
    from test_finlab_corporate_actions import row, STOCK
    from services.research_corporate_history import reconstruct_company_sessions, account_history_snapshot
    old=row(**{STOCK[0]:0.,'除權交易日':None,'現金股利發放日':'2026-09-09'})
    changed=row(**{STOCK[0]:0.,'除權交易日':None,'除息交易日':'2026-09-10',
        '現金股利發放日':'2026-09-30','key_date':'2026-09-07 18:00:00'})
    refs=sample()['source_refs']+[{'dataset':'official.exchange_census','uri':'local://census.json',
        'sha256':'c'*64,'fetched_at':'2026-10-03T00:00:00+00:00'}]
    days=['2026-09-07','2026-09-08']
    tape=load_history_tape(reconstruct_company_sessions(pl.DataFrame([old,changed]),days=days,
        symbols=['2330'],captured_at='2026-10-03T01:00:00+00:00',source_refs=refs,
        issuer_evidence={},other_events={d:[] for d in days}))
    assert tape[days[0]]['actions']
    assert 'outstanding_event_revision_unresolved' in tape[days[1]]['blockers']['2330']
    with pytest.raises(ValueError,match='required_terms_missing'):
        account_history_snapshot(tape[days[1]],{'2330'})


def test_stock_delivery_without_issuer_history_is_not_certified_no_payment():
    from test_finlab_corporate_actions import row
    from services.research_corporate_history import reconstruct_company_sessions
    refs=sample()['source_refs']+[{'dataset':'official.exchange_census','uri':'local://census.json',
        'sha256':'c'*64,'fetched_at':'2026-10-03T00:00:00+00:00'}]
    tape=load_history_tape(reconstruct_company_sessions(pl.DataFrame([row()]),days=['2026-09-07'],
        symbols=['2330'],captured_at='2026-10-03T01:00:00+00:00',source_refs=refs,
        issuer_evidence={},other_events={'2026-09-07':[]}))
    assert 'stock_delivery_issuer_history_unverified' in tape['2026-09-07']['blockers']['2330']


def test_export_rejects_invalid_history_before_any_database_read(monkeypatch,tmp_path):
    from services import dataset_snapshot_exporter as exporter
    monkeypatch.setattr(exporter,'_query_active_stocks',lambda *args:pytest.fail('early database read'))
    req=exporter.DatasetSnapshotExportRequest(business_date='2026-10-01',start_date='2025-01-01',
        end_date='2026-10-01',corporate_history_path=str(tmp_path/'missing.parquet'))
    with pytest.raises(ValueError,match='request_incomplete'):exporter.export_backtest_dataset_snapshot(req)


def test_later_buyer_does_not_inherit_an_old_unpaid_stock_entitlement():
    from services.research_corporate_history import account_history_snapshot
    s=sample()['snapshot'];s['session_date']='2026-07-15'
    s['actions']=[{'action_id':'old-stock','symbol':'1582','kind':'stock','ex_date':'2026-06-16',
        'payable_date':None,'cash_per_share':0.,'stock_per_share':.1}]
    s['blockers']={'1582':['stock_delivery_issuer_history_unverified']}
    assert not account_history_snapshot(s,{'1582'},outstanding_action_ids=[])['blockers']
    with pytest.raises(ValueError,match='required_terms_missing'):
        account_history_snapshot(s,{'1582'},outstanding_action_ids=['old-stock'])
    s['session_date']='2026-06-16'
    with pytest.raises(ValueError,match='required_terms_missing'):
        account_history_snapshot(s,{'1582'},outstanding_action_ids=[])


def test_issuer_rounding_is_bound_to_one_event_and_sealed_source():
    from services.research_corporate_history import apply_issuer_cash_rounding
    record=sample();s=record['snapshot'];s['actions'][0]['fiscal_period']='114年'
    rule={'symbol':'1582','fiscal_period':'114年','ex_date':'2026-06-16','document_date':'2026-05-29',
        'cash_rounding':'floor_twd','source_sha256':'b'*64,'review_semantic':'issuer_event_terms_reviewed',
        'excerpt':'現金股利計算至元，元以下捨去。'}
    assert apply_issuer_cash_rounding(s,[rule],record['source_refs'])['actions'][0]['cash_rounding']=='floor_twd'
    assert 'cash_rounding' not in apply_issuer_cash_rounding(s,[{**rule,'fiscal_period':'113年'}],record['source_refs'])['actions'][0]
    with pytest.raises(ValueError,match='rule_invalid'):
        apply_issuer_cash_rounding(s,[{**rule,'source_sha256':'0'*64}],record['source_refs'])


def test_real_account_path_accepts_unheld_gap_but_blocks_new_held_symbol():
    from types import SimpleNamespace
    from services.backtest_engine import _apply_daily_corporate, AccountState
    from services.research_corporate_history import CorporateHistoryGap
    from test_backtest_settlement_nav import _position
    s=sample()['snapshot'];dataset=SimpleNamespace(corporate_sources={'2026-06-16':s})
    empty=AccountState(cash=100000.,initial_capital=100000.)
    _apply_daily_corporate(empty,dataset,'2026-06-16')
    held=AccountState(cash=100000.,initial_capital=100000.,positions={'2330':_position()})
    with pytest.raises(CorporateHistoryGap) as caught:
        _apply_daily_corporate(held,dataset,'2026-06-16')
    assert caught.value.requirements['blockers']=={'2330':['event_index_coverage_missing']}
    assert held.cash==100000. and not held.corporate_sessions


def test_history_export_keeps_full_price_universe_while_allowing_declared_source_scope(monkeypatch,tmp_path):
    from services import dataset_snapshot_exporter as exporter
    import hashlib
    path=tmp_path/'history.parquet';records_frame([sample()]).write_parquet(path)
    stocks=pl.DataFrame({'id':[1,2],'symbol':['1582','2330'],'market':['TWSE','TWSE']})
    prices=pl.DataFrame({'stock_id':[1,2],'date':['2026-06-16','2026-06-16']})
    monkeypatch.setattr(exporter,'_query_active_stocks',lambda *args:stocks)
    monkeypatch.setattr(exporter,'_query_prices',lambda *args:(prices,1))
    class PastCoverageCheck(Exception):pass
    def stop(*args,**kwargs):raise PastCoverageCheck()
    monkeypatch.setattr(exporter,'_query_date_range',stop)
    req=exporter.DatasetSnapshotExportRequest(business_date='2026-10-03',start_date='2026-06-16',
        end_date='2026-06-16',corporate_history_path=str(path),
        corporate_history_checksum=hashlib.sha256(path.read_bytes()).hexdigest())
    with pytest.raises(PastCoverageCheck):exporter.export_backtest_dataset_snapshot(req)
    assert stocks.height==2 and prices.height==2


def test_entitlement_scope_follows_each_simulated_day_not_todays_account():
    from types import SimpleNamespace
    from services.backtest_engine import _apply_daily_corporate, AccountState
    from services.research_corporate_history import CorporateHistoryGap
    from test_backtest_settlement_nav import _position
    s1=sample()['snapshot'];s1['actions']=[]
    s2=deepcopy(s1);s2.update(session_date='2026-06-17',covered_symbols=['2330'])
    dataset=SimpleNamespace(corporate_sources={'2026-06-16':s1,'2026-06-17':s2})
    strategy_a=AccountState(cash=100000.,initial_capital=100000.,positions={'1582':_position()})
    _apply_daily_corporate(strategy_a,dataset,'2026-06-16')
    strategy_a.positions={'2330':_position()}
    _apply_daily_corporate(strategy_a,dataset,'2026-06-17')
    assert len(strategy_a.corporate_sessions)==2
    strategy_b=AccountState(cash=100000.,initial_capital=100000.,positions={'2330':_position()})
    with pytest.raises(CorporateHistoryGap) as caught:
        _apply_daily_corporate(strategy_b,dataset,'2026-06-16')
    assert caught.value.requirements['session_date']=='2026-06-16'


def catalog_fixture():
    from services.research_corporate_history import COMPANY_EVENT_CATALOGS
    catalogs = {key: pl.DataFrame({'date':['2026-05-05'],'8109':['1150505']})
                for key in COMPANY_EVENT_CATALOGS}
    refs = [{'dataset':'finlab.'+key} for key in COMPANY_EVENT_CATALOGS]
    return catalogs, refs


def test_finlab_event_index_requires_all_four_sources_and_preserves_event_blockers():
    from services.research_corporate_history import finlab_company_event_census
    catalogs, refs = catalog_fixture()
    result = finlab_company_event_census(catalogs,days=['2026-05-04','2026-05-05'],source_refs=refs)
    assert result['2026-05-04'] == []
    assert len(result['2026-05-05']) == 4
    assert all(e['symbol']=='8109' for e in result['2026-05-05'])
    catalogs.pop(next(iter(catalogs)))
    with pytest.raises(ValueError,match='catalogs_incomplete'):
        finlab_company_event_census(catalogs,days=['2026-05-05'],source_refs=refs)


def test_finlab_event_index_rejects_failed_or_ambiguous_downloads():
    from services.research_corporate_history import finlab_company_event_census
    catalogs, refs = catalog_fixture()
    with pytest.raises(ValueError,match='provenance_missing'):
        finlab_company_event_census(catalogs,days=['2026-05-05'],source_refs=refs[:-1])
    key = next(iter(catalogs))
    for frame,reason in (
        (pl.DataFrame({'date':[],'8109':[]}), 'schema_invalid'),
        (pl.DataFrame({'date':['2026-05-05'],'8109':[None]}), 'no_observed_events'),
        (pl.DataFrame({'date':['2026-05-05'],'8109':['1150506']}), 'date_conflict'),
    ):
        catalogs[key] = frame
        with pytest.raises(ValueError,match=reason):
            finlab_company_event_census(catalogs,days=['2026-05-05'],source_refs=refs)


def etf_fixture():
    rows=pl.DataFrame({'symbol':['0056'],'date':['2026-06-16'],
        '收益分配基準日':['2026-06-18'],'收益分配發放日':['2026-06-20'],
        '收益分配金額(每1受益權單位)':[1.35],'收益分配標準':['元以下全捨']})
    split=pl.DataFrame({'date':['2026-06-17'],'0050':['2026-06-24']})
    refs=[{'dataset':name,'uri':'local://fixture','sha256':'f'*64,'fetched_at':'2026-10-03T00:00:00+00:00'}
        for name in ('finlab.tw_etf_dividend_events','finlab.etf_split:恢復買賣日期','official.etf_registry')]
    return rows,split,refs


def test_etf_history_keeps_cash_entitlement_until_first_session_after_payment():
    from services.research_corporate_history import reconstruct_etf_sessions
    rows,split,refs=etf_fixture();days=['2026-06-16','2026-06-19','2026-06-22','2026-06-23','2026-06-24']
    tape=load_history_tape(reconstruct_etf_sessions(rows,split_catalog=split,days=days,
        symbols=['0050','0056'],captured_at='2026-10-03T01:00:00+00:00',source_refs=refs))
    assert tape['2026-06-22']['actions'][0]['payable_date']=='2026-06-20'
    assert tape['2026-06-23']['actions']==[]
    assert tape['2026-06-24']['blockers']=={'0050':['etf_split_economic_terms_required']}
    assert not tape['2026-06-19']['blockers']


def test_etf_unknown_amount_blocks_and_future_distribution_never_books():
    from services.research_corporate_history import reconstruct_etf_sessions
    rows,split,refs=etf_fixture();rows=rows.with_columns(pl.lit(None).alias('收益分配金額(每1受益權單位)'))
    tape=load_history_tape(reconstruct_etf_sessions(rows,split_catalog=split,
        days=['2026-06-15','2026-06-16'],symbols=['0056'],captured_at='2026-10-03T01:00:00+00:00',source_refs=refs))
    assert tape['2026-06-15']['actions']==[] and not tape['2026-06-15']['blockers']
    assert tape['2026-06-16']['blockers']['0056']==['etf_distribution_terms_missing']


def test_history_merge_rejects_overlap_and_mismatched_calendar():
    from services.research_corporate_history import merge_history_frames
    f=records_frame([sample()])
    with pytest.raises(ValueError,match='scope_overlap'):merge_history_frames(f,f)
    other=sample();other['snapshot']['session_date']='2026-06-17'
    other=make_history_record(other['snapshot'],captured_at=other['captured_at'],source_refs=other['source_refs'],history_start=other['history_start'],history_end=other['history_end'])
    with pytest.raises(ValueError,match='calendar_mismatch'):merge_history_frames(f,records_frame([other]))



def test_old_unverified_stock_event_does_not_poison_current_verified_event():
    from services.research_corporate_history import account_history_snapshot, CorporateHistoryGap
    snap = sample()['snapshot']
    snap.update(covered_symbols=['4114'], blockers={'4114':['stock_delivery_issuer_history_unverified']},
        unverified_stock_action_ids={'4114':['old']}, actions=[
            {'symbol':'4114','kind':'stock','action_id':'old','ex_date':'2025-07-17'},
            {'symbol':'4114','kind':'stock','action_id':'new','ex_date':snap['session_date']}])
    assert not account_history_snapshot(snap, ['4114'], outstanding_action_ids=['new'])['blockers']
    with pytest.raises(CorporateHistoryGap):
        account_history_snapshot(snap, ['4114'], outstanding_action_ids=['old'])



def test_reviewed_stock_join_requires_exact_event_sources_and_publication_clock():
    from services.research_corporate_history import apply_reviewed_stock_rules
    snap={'session_date':'2026-06-25','actions':[{'kind':'stock','symbol':'7777',
        'ex_date':'2026-06-25','record_date':'2026-07-01','stock_per_share':.0225}]}
    rule={'symbol':'7777','ex_date':'2026-06-25','record_date':'2026-07-01','stock_per_share':.0225,
        'source_sha256s':['a'*64],'published_date':'2026-07-27','payable_date':'2026-07-30',
        'fractional_treatment':'book_entry_fee'}
    refs=[{'sha256':'a'*64}]
    assert 'payable_date' not in apply_reviewed_stock_rules(snap,[rule],refs)['actions'][0]
    snap['session_date']='2026-07-28'
    assert apply_reviewed_stock_rules(snap,[rule],refs)['actions'][0]['payable_date']=='2026-07-30'
    with pytest.raises(ValueError,match='provenance_missing'):
        apply_reviewed_stock_rules(snap,[rule],[])
    rule['record_date']='2025-07-01'
    assert 'payable_date' not in apply_reviewed_stock_rules(snap,[rule],refs)['actions'][0]
