from pathlib import Path
import shutil
import polars as pl
import pytest
from google.cloud import storage
from services import snapshot_parquet as reader
from services.backtest_engine import _snapshot_lazy_filter, _date_filter, _filter_snapshot_symbols


@pytest.mark.parametrize("failure", [None, "download", "parse", "cancel"])
def test_download_owned_temp_cleanup_on_every_exit(tmp_path, monkeypatch, failure):
    source=tmp_path/'source.parquet';pl.DataFrame({'date':['2026-01-01'], 'symbol':['2330']}).write_parquet(source)
    targets=[]
    class FakeBlob:
        def download_to_filename(self,path):
            targets.append(Path(path));shutil.copyfile(source,path)
            if failure=='download':raise RuntimeError('failed download')
            if failure=='cancel':raise KeyboardInterrupt()
    class FakeBucket:
        def blob(self,_):return FakeBlob()
    class FakeClient:
        def bucket(self,_):return FakeBucket()
    monkeypatch.setattr(storage,'Client',FakeClient)
    def transform(frame):
        if failure=='parse':raise ValueError('bad transform')
        return frame
    if failure:
        with pytest.raises(BaseException):reader.read_snapshot_parquet('gs://bucket/object',transform=transform)
    else:assert reader.read_snapshot_parquet('gs://bucket/object',transform=transform).height==1
    assert len(targets)==1 and not targets[0].parent.exists()
    assert source.exists()


@pytest.mark.parametrize('empty',[False,True])
@pytest.mark.parametrize('selected',[None,['2330']])
def test_lazy_predicates_equal_original_eager_rows_types_and_nulls(tmp_path,empty,selected):
    frame=pl.DataFrame({'date':['2025-12-31','2026-01-01','2026-01-02',None],
        'symbol':['2330','2330','1101','2330'],'close':[10.,11.,12.,None]}).with_columns(pl.col('date').str.to_date())
    if empty:frame=frame.head(0)
    path=tmp_path/'source.parquet';frame.write_parquet(path)
    expected=_filter_snapshot_symbols(_date_filter(frame,'2026-01-01','2026-01-02'),selected)
    actual=reader.read_snapshot_parquet('file://'+str(path),transform=lambda lf:
        _snapshot_lazy_filter(lf,start_date='2026-01-01',end_date='2026-01-02',symbols=selected))
    assert actual.equals(expected) and actual.schema==expected.schema
    assert path.exists()


@pytest.mark.parametrize('stock_ids', [[1],[2],[1,2]])
@pytest.mark.parametrize('date_window',[('2026-01-01','2026-01-02'),('2027-01-01','2027-01-02')])
def test_join_before_filter_keeps_empty_schema_and_rows(tmp_path,stock_ids,date_window):
    from services.backtest_engine import _with_symbol_from_stocks
    frame=pl.DataFrame({'date':['2026-01-01'],'stock_id':[1],'close':[10.]}).with_columns(pl.col('date').str.to_date())
    stocks=pl.DataFrame({'id':stock_ids,'symbol':[str(s) for s in stock_ids]})
    path=tmp_path/'input.parquet';frame.write_parquet(path)
    start,end=date_window
    expected=_date_filter(_with_symbol_from_stocks(frame,stocks),start,end)
    actual=reader.read_snapshot_parquet(str(path),transform=lambda lf:
        _snapshot_lazy_filter(lf,start_date=start,end_date=end,stocks=stocks))
    assert actual.equals(expected) and actual.schema==expected.schema
