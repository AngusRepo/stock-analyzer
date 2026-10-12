import json
import sys
from types import SimpleNamespace

import pandas as pd
import polars as pl
import pytest

from test_finlab_remote_backfill_tool_contract import _load_tool_module


def test_partial_writer_keeps_requested_fields_and_full_writer_still_requires_all(tmp_path):
    tool=_load_tool_module()
    frame=pd.DataFrame({'2330':[10.,11.]},index=pd.to_datetime(['2026-10-08','2026-10-12']))
    frames={'pe':frame,'pb':frame}
    with pytest.raises(ValueError,match='training_auxiliary_source_missing'):
        tool.write_training_auxiliary_vintage(frames,lane='fundamental_factor_diversity',
            run_dir=tmp_path,years=3,end_date='2026-10-12',start_date='2026-10-12')
    tool.write_training_auxiliary_vintage(frames,lane='fundamental_factor_diversity',
        run_dir=tmp_path,years=3,end_date='2026-10-12',start_date='2026-10-12',requested_fields={'pe','pb'})
    m=json.loads((tmp_path/'raw/training_auxiliary_full_vintage/manifest.json').read_bytes())
    assert set(m['fields'])=={'pe','pb'}
    assert m['fields']['pe']['rows']==1
    assert m['fields']['pe']['start_date']=='2026-10-12'
    assert not (tmp_path/'raw/training_auxiliary_full_vintage/eps.parquet').exists()


def test_actual_daily_materializer_seals_pe_pb_and_broker_without_expanding_fetch(monkeypatch,tmp_path):
    tool=_load_tool_module()
    wide=pd.DataFrame({str(s):[10.,11.] for s in range(3000,3100)},
                      index=pd.to_datetime(['2026-10-08','2026-10-12']))
    broker=pd.DataFrame({'date':pd.to_datetime(['2026-10-08','2026-10-12']),
                        'symbol':['3000','3000'],'broker':['A','A'],'buy':[100.,120.],'sell':[20.,30.]})
    calls=[]
    class Source:
        binding={'test_only':'synthetic; no vendor or cloud calls'}
        def __init__(self,*a,**kw):pass
        def get(self,key):
            calls.append(key)
            if key=='broker_transactions':return broker.copy()
            if key in ('price_earning_ratio:本益比','price_earning_ratio:股價淨值比'):return wide.copy()
            raise AssertionError('unexpected vendor fetch:'+key)
    monkeypatch.setitem(sys.modules,'finlab',SimpleNamespace(data=Source(),login=lambda *a,**kw:None))
    monkeypatch.setattr(tool,'login_finlab_sdk',lambda login:None)
    monkeypatch.setattr(tool,'d1_counts',lambda start:{})
    monkeypatch.setattr(tool.time,'sleep',lambda seconds:None)
    scope={'fundamental_factor_diversity':{'pe','pb'},'broker_flow_diversity':set()}
    tool.materialize_specs(years=3,run_dir=tmp_path/'daily',
        lanes=list(scope),key_scope=scope,source_start_date='2026-10-12',source_end_date='2026-10-12',
        daily_refresh=True)
    root=tmp_path/'daily/raw'
    m=json.loads((root/'training_auxiliary_full_vintage/manifest.json').read_bytes())
    assert set(m['fields'])=={'pe','pb'}
    assert all(x['rows']==1 for x in m['fields'].values())
    b=json.loads((root/'training_long_full_vintage/broker.json').read_bytes())
    assert b['start']==b['end']=='2026-10-12' and b['rows']==1
    values=pl.read_parquet(root/'training_long_full_vintage/broker.parquet')
    assert values['broker_net_lots'].to_list()==[90.]
    assert sorted(calls)==sorted(['price_earning_ratio:本益比','price_earning_ratio:股價淨值比','broker_transactions'])
