from dataclasses import replace
import pytest
from test_l4_canonical_repair_plan import planner
from services.finlab_canonical_materializer import materialize_finlab_canonical_outputs


def fixture(tmp_path):
    output=materialize_finlab_canonical_outputs(tmp_path,datasets=['canonical_market_daily'])
    rows=[{'stock_id':str(i),'date':'2026-08-20','open':10.,'high':12.,'low':9.,'close':11.,'adj_close':11.,'volume':1000.,'source':'finlab.price'} for i in range(1,101)]
    output=replace(output,canonical_market_daily=rows,source_sessions=[{'session_date':'2026-08-20','positive_close_count':100,'source_run_id':'original','source_checksum':'verified','observed_at':output.generated_at}],canonical_market_index_daily=[{'symbol':'TWII','date':'2026-08-20'}],canonical_market_summary_daily=[{'date':'2026-08-20','market_segment':'LISTED'}])
    inventory={'stock_identities':[{'id':i,'symbol':str(i)} for i in range(1,101)]}
    return output,inventory


def test_unpriced_source_is_preserved_but_never_becomes_return_price(tmp_path):
    output,inventory=fixture(tmp_path)
    absent={**output.canonical_market_daily[0],'stock_id':'no_regular_quote','open':None,'high':None,'low':None,'close':None,'adj_close':None,'volume':451.}
    output=replace(output,canonical_market_daily=output.canonical_market_daily+[absent])
    plan=planner.plan_repair(output,inventory,'2026-08-20')
    assert plan['canonical_rows']==101
    assert plan['complete_ohlcv_rows']==plan['compatibility_rows']==100
    assert plan['source_unpriced_symbols']==['no_regular_quote']
    statements=[sql for sql,params in plan['market_statements'] if 'INTO canonical_market_daily' in sql and params[0]=='no_regular_quote']
    assert len(statements)==1 and 'ON CONFLICT DO NOTHING' in statements[0]
    assert 'DO UPDATE' not in statements[0]


def test_unmapped_instrument_requires_complete_core_inventory(tmp_path):
    output,inventory=fixture(tmp_path)
    output=replace(output,canonical_market_daily=output.canonical_market_daily+[{**output.canonical_market_daily[0],'stock_id':'00999A'}])
    assert not planner.plan_repair(output,inventory,'2026-08-20')['ready_for_complete_date_repair']
    inventory.update(identity_inventory_scope='all_core_stocks',identity_inventory_row_count=100)
    plan=planner.plan_repair(output,inventory,'2026-08-20')
    assert plan['ready_for_complete_date_repair']
    assert plan['unmatched_core_symbols']==['00999A'] and plan['compatibility_rows']==100
    inventory['identity_inventory_row_count']=99
    assert not planner.plan_repair(output,inventory,'2026-08-20')['ready_for_complete_date_repair']


def test_partial_price_is_still_blocked(tmp_path):
    output,inventory=fixture(tmp_path)
    output=replace(output,canonical_market_daily=output.canonical_market_daily+[{**output.canonical_market_daily[0],'stock_id':'broken','adj_close':None}])
    with pytest.raises(ValueError,match='partial_original_ohlcv'):
        planner.plan_repair(output,inventory,'2026-08-20')
