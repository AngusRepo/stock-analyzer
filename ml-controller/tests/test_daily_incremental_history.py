import copy
from datetime import date, datetime, timezone
import io
import json

import pandas as pd
import polars as pl
import pytest

from services.daily_history_capture import (
    encode, digest, packed, unpack, import_legacy_history, load_daily_history,
    update_official_history, seal_daily_history, validate_snapshot,
)
from services.training_session_calendar import verify_training_calendar
from services.training_global_capture import read_market_history
from services.training_us_capture import write_us_quote_capture, quote_series, SYMBOLS
from test_training_session_calendar import calendar_fixture
from test_training_global_capture import attach_global
from test_finlab_breadth_cache import breadth


def month_body(market, month, days):
    rows = [[d.replace('-', '/'), 1, 1, 1, 100+i] for i, d in enumerate(days) if d[:7] == month]
    return {'date': month.replace('-', '')+'01', 'stat':'OK', 'data':rows,
            'tables':[{'fields':['日期'], 'totalCount':len(rows), 'data':rows}]}


def write_prices(root, days):
    folder = root/'raw/daily_price_full_vintage'
    folder.mkdir(parents=True, exist_ok=True)
    stream = io.BytesIO()
    pl.DataFrame({'date':days, **{str(n):[100.]*len(days) for n in range(3000,3100)}}).write_parquet(stream)
    raw = stream.getvalue()
    (folder/'close.parquet').write_bytes(raw)
    (folder/'manifest.json').write_bytes(encode({'capture_id':root.name,'end_date':days[-1],
                                              'checksums':{'close':digest(raw)}}))
    return folder


def baseline_for(days):
    calendar = {}
    for month in sorted({d[:7] for d in days}):
        for market in ('TWSE','TPEX'):
            calendar[market+'-'+month] = {**packed(encode(month_body(market,month,days))),
                                         'sessions':[d for d in days if d[:7]==month]}
    return {'end_date':days[-1], 'calendar':calendar,
            'breadth':{d:packed(encode(breadth(d))) for d in days}}


def test_729_days_then_two_daily_runs_fetch_only_new_dates_and_recent_months(tmp_path):
    days = pd.bdate_range(end='2026-10-15',periods=731).strftime('%Y-%m-%d').tolist()
    snapshot = baseline_for(days[:729])
    for length in (730,731):
        root = tmp_path/str(length)
        folder = write_prices(root,days[:length])
        calls = []
        def fetch(url, *, label):
            calls.append(label)
            if label.startswith('training_calendar_'):
                market, month = label.removeprefix('training_calendar_').split('_')
                return month_body(market,month,days[:length])
            return breadth(label.removeprefix('training_breadth_'))
        previous = copy.deepcopy(snapshot)
        snapshot = update_official_history(run_dir=root,baseline=snapshot,fetch=fetch,pause=lambda _:None)
        assert [c for c in calls if c.startswith('training_breadth_')] == ['training_breadth_'+days[length-1]]
        assert len([c for c in calls if c.startswith('training_calendar_')]) == 4
        assert all(snapshot['breadth'][d] == previous['breadth'][d] for d in days[:length-1])
        assert not (folder/'official_breadth').exists()


def test_skipped_days_are_added_but_missing_old_history_never_bootstraps(tmp_path):
    days = ['2026-09-30','2026-10-01','2026-10-02']
    base = baseline_for(days[:1])
    write_prices(tmp_path/'gap',days)
    calls=[]
    def fetch(url, *, label):
        calls.append(label)
        if label.startswith('training_calendar_'):
            market, month=label.removeprefix('training_calendar_').split('_')
            return month_body(market,month,days)
        return breadth(label.removeprefix('training_breadth_'))
    actual=update_official_history(run_dir=tmp_path/'gap',baseline=base,fetch=fetch,pause=lambda _:None)
    assert set(actual['breadth'])==set(days)
    assert len([c for c in calls if c.startswith('training_breadth_')])==2
    base['breadth'].clear()
    with pytest.raises(ValueError,match='old_session_missing'):
        update_official_history(run_dir=tmp_path/'gap',baseline=base,fetch=fetch,pause=lambda _:None)


def test_legacy_import_and_packed_consumers_produce_identical_features():
    bucket, price=calendar_fixture()
    proof=attach_global(bucket,price)
    before=read_market_history(bucket,price_capture=price,us_component=proof['us_component'])[0]
    ref={'path':price['capture_manifest_path'],'sha256':price['capture_manifest_sha256']}
    value=import_legacy_history(bucket,ref)
    root=ref['path'].rsplit('/',1)[0]
    raw=encode(value)
    bucket.data[root+'/daily_history.json']=raw
    manifest=json.loads(bucket.data[ref['path']]);manifest['daily_history_sha256']=digest(raw)
    bucket.data[ref['path']]=encode(manifest)
    price['capture_manifest_sha256']=digest(encode(manifest))
    for key in list(bucket.data):
        if '/official_calendar/' in key or '/official_breadth/' in key:
            del bucket.data[key]
    assert verify_training_calendar(bucket,price_capture=price)['sessions']==2
    after=read_market_history(bucket,price_capture=price,us_component=proof['us_component'])[0]
    assert before==after
    bucket.data[root+'/daily_history.json']+=b'corrupt'
    with pytest.raises(ValueError,match='snapshot_checksum'):
        read_market_history(bucket,price_capture=price,us_component=proof['us_component'])


def us_body(symbol, values):
    return {'meta':{'symbol':symbol},
            'timestamp':[int(datetime.combine(date.fromisoformat(d),datetime.min.time(),timezone.utc).timestamp()) for d in values],
            'indicators':{'quote':[{'close':list(values.values())}]}}


def test_us_update_keeps_old_history_and_applies_recent_corrections(tmp_path):
    old={'2026-01-02':90.,'2026-09-01':100.,'2026-09-25':102.,'2026-09-28':103.}
    base={'end_date':'2026-09-29','us_quotes':{f:packed(encode(us_body(s,old))) for f,s in SYMBOLS.items()}}
    recent={'2026-09-01':100.,'2026-09-25':105.,'2026-09-28':103.,'2026-09-29':106.}
    receipt=write_us_quote_capture(run_dir=tmp_path,start='2026-01-02',end='2026-09-30',baseline=base,
                                  fetch=lambda symbol:us_body(symbol,recent))
    assert receipt['download_start']=='2026-08-30'
    for field,symbol in SYMBOLS.items():
        rows=quote_series(json.loads((tmp_path/'raw/daily_price_full_vintage/us_quotes'/f'{field}.json').read_bytes()),symbol)
        assert rows=={**old,**recent}
    missing={k:v for k,v in recent.items() if k!='2026-09-25'}
    with pytest.raises(ValueError,match='recent_window_gap'):
        write_us_quote_capture(run_dir=tmp_path/'missing',start='2026-01-02',end='2026-09-30',baseline=base,
                               fetch=lambda symbol:us_body(symbol,missing))


def test_import_seed_then_next_run_loads_its_own_published_snapshot(monkeypatch, tmp_path):
    from services import daily_inference_producer as producer
    bucket, price=calendar_fixture()
    attach_global(bucket,price)
    ref={'path':price['capture_manifest_path'],'sha256':price['capture_manifest_sha256']}
    baseline={'price_capture_id':price['capture_id'],'business_date':'2026-09-29',
              'price_manifest_sha256':ref['sha256'],'input_manifests':[ref]}
    monkeypatch.setattr(producer,'_baseline',lambda *a: ({},baseline))
    with pytest.raises(ValueError,match='baseline_required_run_explicit_import'):
        load_daily_history(bucket,run_date='2026-09-30',capture_prefix='capture')
    seed=encode(import_legacy_history(bucket,ref))
    bucket.data['import/history.json']=seed
    seed_ref={'path':'import/history.json','sha256':digest(seed)}
    snapshot=load_daily_history(bucket,run_date='2026-09-30',capture_prefix='capture',bootstrap_ref=seed_ref)
    run=tmp_path/'next'
    days=['2026-09-28','2026-09-29','2026-09-30']
    folder=write_prices(run,days)
    def fetch(url, *, label):
        if label.startswith('training_calendar_'):
            market, month=label.removeprefix('training_calendar_').split('_')
            return month_body(market,month,days)
        return breadth('2026-09-30')
    updated=update_official_history(run_dir=run,baseline=snapshot,fetch=fetch,pause=lambda _:None)
    us={'2026-09-24':100.,'2026-09-25':102.,'2026-09-28':98.,'2026-09-29':103.,'2026-09-30':104.}
    write_us_quote_capture(run_dir=run,start=days[0],end=days[-1],baseline=snapshot,
                          fetch=lambda symbol:us_body(symbol,us))
    seal_daily_history(run,updated)
    for file in run.rglob('*'):
        if file.is_file():
            bucket.data['next/'+file.relative_to(run).as_posix()]=file.read_bytes()
    next_ref={'path':'next/raw/daily_price_full_vintage/manifest.json',
              'sha256':digest((folder/'manifest.json').read_bytes())}
    baseline.update(price_capture_id='next',business_date='2026-09-30',
                    price_manifest_sha256=next_ref['sha256'],input_manifests=[next_ref])
    actual=load_daily_history(bucket,run_date='2026-10-01',capture_prefix='unused')
    assert actual['end_date']=='2026-09-30' and set(actual['breadth'])==set(days)
    # A bootstrap for another source/capture never overrides current lineage.
    damaged=json.loads(seed);damaged['capture_id']='another'
    with pytest.raises(ValueError,match='snapshot_identity'):
        validate_snapshot(encode(damaged),json.loads(bucket.data[ref['path']]),digest(encode(damaged)))


def test_recent_month_revision_retains_market_date_gap_gate(tmp_path):
    days=['2026-09-29','2026-09-30','2026-10-01']
    base=baseline_for(days[:1]);write_prices(tmp_path,days)
    def fetch(url, *, label):
        market, month=label.removeprefix('training_calendar_').split('_')
        revised=days if market=='TWSE' else [d for d in days if d!='2026-09-30']
        return month_body(market,month,revised)
    with pytest.raises(ValueError,match='training_calendar_session_gap:TPEX'):
        update_official_history(run_dir=tmp_path,baseline=base,fetch=fetch,pause=lambda _:None)


def test_daily_entry_loads_history_before_any_materialization(monkeypatch,tmp_path):
    import sys
    from types import SimpleNamespace
    from google.cloud import storage
    from test_finlab_remote_backfill_tool_contract import _load_tool_module
    from services import daily_history_capture
    tool=_load_tool_module()
    monkeypatch.setenv('FINLAB_API_KEY','offline')
    monkeypatch.setattr(tool,'controller_d1_proxy_configured',lambda:True)
    monkeypatch.setattr(storage,'Client',lambda:SimpleNamespace(bucket=lambda _:None))
    calls=[]
    def load(*args,**kwargs):
        calls.append('load_history')
        raise ValueError('daily_history_baseline_required_run_explicit_import')
    monkeypatch.setattr(daily_history_capture,'load_daily_history',load)
    monkeypatch.setattr(tool,'materialize_specs',lambda **k:pytest.fail('capture started without baseline'))
    monkeypatch.setattr(sys,'argv',['tool','--years','3','--run-id','test','--output-dir',str(tmp_path),
                                  '--daily-refresh','--gcs-bucket','offline','--source-end-date','2026-10-15'])
    with pytest.raises(ValueError,match='baseline_required'):
        tool.main()
    assert calls==['load_history']
