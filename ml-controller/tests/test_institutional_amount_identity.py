from pathlib import Path
import polars as pl
import pytest
from services.finlab_canonical_materializer import build_institutional_amount_rows

def write_fields(root, categories):
    lane=root/'raw/institutional_amount_summary';lane.mkdir(parents=True)
    for field,amount in [('buy_amount',100.),('sell_amount',80.),('net_amount',20.)]:
        pl.DataFrame({'date':['2026-08-20'],**{cat:[amount+i] for i,cat in enumerate(categories)}}).write_parquet(lane/f'{field}.parquet')

def build(root):
    return build_institutional_amount_rows(root,run_id='original',generated_at='2026-09-06T00:00:00Z',start_date='2026-08-20',end_date='2026-08-20')

def test_foreign_subtotal_never_overwrites_ex_dealer_foreign(tmp_path):
    write_fields(tmp_path,['上櫃外資及陸資(不含自營商)','上櫃外資及陸資合計','上櫃外資自營商'])
    rows=build(tmp_path)
    assert len(rows)==3
    by_investor={r['investor']:r for r in rows}
    assert set(by_investor)=={'foreign','foreign_total','foreign_dealer'}
    assert by_investor['foreign']['net_amount']==20.
    assert by_investor['foreign_total']['net_amount']==21.

def test_unknown_duplicate_foreign_categories_fail_before_writer(tmp_path):
    write_fields(tmp_path,['上櫃外資(不含自營商)','上櫃外資及陸資(不含自營商)'])
    with pytest.raises(RuntimeError,match='duplicate_identity'):
        build(tmp_path)
