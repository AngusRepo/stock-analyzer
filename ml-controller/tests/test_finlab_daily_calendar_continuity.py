import importlib.util,sys,types
from pathlib import Path
import pandas as pd
import polars as pl
from services.finlab_canonical_materializer import materialize_finlab_canonical_outputs,build_source_sessions

ROOT=Path(__file__).resolve().parents[2]

def load_tool(monkeypatch):
    spec=importlib.util.spec_from_file_location('finlab_calendar_continuity_tool',ROOT/'tools/finlab_v4_remote_backfill.py')
    tool=importlib.util.module_from_spec(spec);monkeypatch.setitem(sys.modules,spec.name,tool);spec.loader.exec_module(tool)
    return tool

def test_real_daily_collector_keeps_full_calendar_before_single_date_slice(monkeypatch,tmp_path):
    tool=load_tool(monkeypatch)
    source=pd.DataFrame({str(i):[10.,11.,12.] for i in range(100)},index=pd.to_datetime(['2026-08-19','2026-08-20','2026-08-21']))
    monkeypatch.setitem(sys.modules,'finlab',types.SimpleNamespace(data=types.SimpleNamespace(get=lambda key:source),login=lambda *args:None))
    monkeypatch.setattr(tool,'login_finlab_sdk',lambda *args:None)
    monkeypatch.setattr(tool,'d1_counts',lambda start:{})
    monkeypatch.setattr(tool,'CORE_SPECS',[tool.CORE_SPECS[0]])
    tool.materialize_specs(years=3,run_dir=tmp_path,lanes=['daily_price'],source_start_date='2026-08-21',source_end_date='2026-08-21',generated_at='2026-08-21T14:00:00Z')
    raw=pl.read_parquet(tmp_path/'raw/daily_price/close.parquet')
    assert raw.height==1,'native daily prices remain bounded, not a full price backfill'
    sessions=build_source_sessions(tmp_path,run_id='native21',observed_at='2026-08-21T14:00:00Z',end_date='2026-08-21')
    assert [r['session_date'] for r in sessions]==['2026-08-19','2026-08-20','2026-08-21']
    assert all(r['positive_close_count']==100 for r in sessions)
    assert len(build_source_sessions(tmp_path,run_id='native21',observed_at='now',end_date='2026-08-20'))==2

def test_source_calendar_is_written_before_prices_and_ops_ack(monkeypatch,tmp_path):
    tool=load_tool(monkeypatch)
    lane=tmp_path/'raw/daily_price';lane.mkdir(parents=True)
    pl.DataFrame({'date':['2026-08-20'],**{str(i):[10.] for i in range(100)}}).write_parquet(lane/'close.parquet')
    calls=[]
    def write(statements,**kwargs):
        calls.append((kwargs.get('domain','legacy'),[s[0] for s in statements]))
        return {'total':len(statements),'success_count':len(statements),'error_count':0,'changes_total':len(statements)}
    monkeypatch.setattr(tool,'market_domain_active',lambda:True)
    monkeypatch.setattr(tool,'d1_batch_execute',write)
    monkeypatch.setattr(tool,'controller_d1_batch_execute',write)
    monkeypatch.setattr(tool,'ops_d1_batch_execute',lambda stmts,**kwargs:write(stmts,domain='ops'))
    tool.materialize_canonical_to_d1({'run_id':'native','artifact_root':str(tmp_path),'generated_at':'2026-08-20T14:00:00Z'},start_date='2026-08-20',end_date='2026-08-20',datasets=['canonical_market_daily'])
    market=next(sqls for domain,sqls in calls if domain=='market')
    assert 'INTO finlab_source_sessions_v1' in market[0]
    assert any('INTO canonical_market_daily' in sql for sql in market[1:])
    assert calls[-1][0]=='ops'
