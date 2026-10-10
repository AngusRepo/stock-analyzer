import copy,hashlib,json
import pytest
from services.training_price_venue_scope import verify_scope,compare_prior_scope,scope_from_manifest,digest,write_scope_manifest
from test_training_price_capture import fixture,load

def scope_fixture():
    b=fixture();p='capture/raw/daily_price_full_vintage/manifest.json';m=json.loads(b.data[p])
    body={'stat':'ok','data':{'subject':'公告自115年9月28日起終止與測試公司（股票代號：3004）簽訂之興櫃股票契約',
          'content':'測試公司因於臺灣證券交易所上市而申請終止興櫃股票買賣，自115年9月28日起終止。'}}
    raw=json.dumps(body,ensure_ascii=False)
    e={'symbol':'3004','market':'TWSE','listed_from':'2026-09-28','evidence':{'raw_utf8':raw,'sha256':hashlib.sha256(raw.encode()).hexdigest(),'url':'https://www.tpex.org.tw/www/bulletin/annDetail?docId=fixture'}}
    s={'schema':'price-prior-venue-scope-v1','capture_id':m['capture_id'],'end_date':m['end_date'],'price_checksums':m['checksums'],'entries':[e]}
    m.update(prior_venue_scope=s,prior_venue_scope_sha256=digest(s));b.data[p]=json.dumps(m).encode()
    return b,m,s,e

def test_exact_official_scope_changes_comparison_only():
    from datetime import date,timedelta
    from services.training_price_capture import load_training_price_capture
    b,m,s,e=scope_fixture()
    prior=[{'date':str(date(2026,1,1)+timedelta(days=i)),'close':9.} for i in range(60)]+[{'date':'2026-09-28','close':101.}]
    prices,_,proof=load_training_price_capture(b,sequence_gcs_prefix='seq',stock_rows=[{'id':1,'symbol':'3004','market':'TWSE'}],prices_lookback=100,run_date='2026-09-29',prior_prices={1:prior},prior_indicators={})
    assert len(prices[1])==2 and len(prior)==61
    assert proof['prior_venue_comparisons'][0]['comparable_prior_rows']==1
    assert proof['prior_venue_scope_sha256']==digest(s)

@pytest.mark.parametrize('fault',['capture','checksum','date','symbol','market','host','raw','duplicate','absent_transition'])
def test_wrong_or_unbound_scope_rejected(fault):
    b,m,s,e=scope_fixture()
    if fault=='capture':s['capture_id']='other'
    elif fault=='checksum':s['price_checksums']={}
    elif fault=='date':e['listed_from']='2026-09-27'
    elif fault=='symbol':e['symbol']='9999'
    elif fault=='market':e['market']='OTC'
    elif fault=='host':e['evidence']['url']='https://example.com/www/bulletin/annDetail'
    elif fault=='raw':e['evidence']['raw_utf8']+=' '
    elif fault=='duplicate':s['entries'].append(copy.deepcopy(e))
    else:
        e['evidence']['raw_utf8']=e['evidence']['raw_utf8'].replace('上市而申請','下市而申請')
        e['evidence']['sha256']=hashlib.sha256(e['evidence']['raw_utf8'].encode()).hexdigest()
    with pytest.raises(ValueError):verify_scope(s,m)

@pytest.mark.parametrize('fault',['missing_day','before_listing','duplicate','wrong_owner','wrong_market'])
def test_rows_do_not_allow_coverage_loss(fault):
    b,m,s,e=scope_fixture();old=[{'date':'2026-09-28'},{'date':'2026-09-29'}];rows=copy.deepcopy(old);kw=dict(symbol='3004',market='TWSE')
    if fault=='missing_day':rows.pop()
    elif fault=='before_listing':rows.insert(0,{'date':'2026-09-27'})
    elif fault=='duplicate':old.append(old[0])
    elif fault=='wrong_owner':kw['symbol']='9999'
    else:kw['market']='OTC'
    with pytest.raises(ValueError):compare_prior_scope(e,previous=old,rows=rows,**kw)

def test_producer_seals_and_rejects_second_write(tmp_path):
    b,m,s,e=scope_fixture();m.pop('prior_venue_scope');m.pop('prior_venue_scope_sha256')
    p=tmp_path/'raw/daily_price_full_vintage/manifest.json';p.parent.mkdir(parents=True);p.write_text(json.dumps(m))
    contract=tmp_path/'scope.json';raw=json.dumps(s).encode();contract.write_bytes(raw)
    expected=hashlib.sha256(raw).hexdigest()
    assert write_scope_manifest(tmp_path,contract,expected)==digest(s)
    assert scope_from_manifest(json.loads(p.read_bytes()))[1]==digest(s)
    with pytest.raises(ValueError,match='already_sealed'):write_scope_manifest(tmp_path,contract,expected)
    with pytest.raises(ValueError,match='checksum'):write_scope_manifest(tmp_path,contract,'0'*64)


def test_actual_sealed_materializer_emits_explicit_scope(monkeypatch, tmp_path):
    import pandas as pd
    import services.finlab_sealed_raw as sealed
    from test_finlab_remote_backfill_tool_contract import _load_tool_module
    tool = _load_tool_module()
    days = pd.to_datetime(['2026-09-28','2026-09-29'])
    source = pd.DataFrame({str(s):[100.,101.] for s in range(3000,3100)},index=days)
    class Source:
        binding = {'test_only':'synthetic sealed numeric source'}
        def __init__(self,*a,**kw):pass
        def get(self,key):return source.copy()
    monkeypatch.setattr(sealed,'SealedDailySource',Source)
    monkeypatch.setattr(tool,'d1_counts',lambda start:{})
    monkeypatch.setattr(tool,'start_date_for_years',lambda years:'2026-09-01')
    monkeypatch.setattr(tool,'write_official_training_calendar',lambda **kw:None)
    monkeypatch.setattr(tool,'write_training_breadth_capture',lambda **kw:None)
    monkeypatch.setattr(tool.time,'sleep',lambda seconds:None)
    fields=('adj_close','adj_open','open','high','low','close','volume','value','market_value')
    frames={k:tool.normalize_wide_index(source.copy()) for k in fields}
    template=tmp_path/'template'; actual=tmp_path/'actual'
    tool.write_adjusted_price_vintage(frames,run_dir=template,years=4,end_date='2026-09-29')
    m=json.loads((template/'raw/daily_price_full_vintage/manifest.json').read_bytes())
    _,_,s,_=scope_fixture();s.update(capture_id=actual.name,price_checksums=m['checksums'])
    contract=tmp_path/'scope.json';raw=json.dumps(s).encode();contract.write_bytes(raw)
    tool.materialize_specs(years=4,run_dir=actual,lanes=['daily_price'],source_start_date='2026-09-29',source_end_date='2026-09-29',
        sealed_raw_root='synthetic',sealed_raw_receipt_sha256='a'*64,
        price_venue_scope_manifest=contract,price_venue_scope_sha256=hashlib.sha256(raw).hexdigest())
    produced=json.loads((actual/'raw/daily_price_full_vintage/manifest.json').read_bytes())
    assert scope_from_manifest(produced)[1]==digest(s)
    assert produced['checksums']==m['checksums']
