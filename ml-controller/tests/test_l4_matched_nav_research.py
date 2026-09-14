import importlib.util
from pathlib import Path
import pytest
p=Path(__file__).resolve().parents[1]/'scripts/l4_matched_nav_research.py'
spec=importlib.util.spec_from_file_location('nav_research',p);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def bar(price=100,volume=100000):return {'open':price,'close':price,'high':price+1,'low':price-1,'volume':volume}
def test_costs_once_and_no_future_return_credit():
    state,fills,_,_=m.execute({'cash':100000.,'units':{},'nav':100000.},{'A':100.},{'A':bar()},{'A':bar()},{'A':100.},{'A':100.},0)
    assert state['nav']==99980 and state['cash']==89980
    assert len(fills)==1 and fills[0]['commission']==20 and fills[0]['tax']==0
    state,_,_,_=m.execute(state,None,{'A':bar(110)},{'A':bar()},{'A':110.},{'A':100.},0)
    assert state['nav']==100980
    state,fills,_,_=m.execute(state,{}, {'A':bar(110)},{'A':bar(110)},{'A':110.},{'A':110.},0)
    assert state['nav']==100927 and fills[0]['tax']==33

def test_total_return_factor_change_is_not_a_loss_or_cash_deposit():
    state={'cash':1000.,'units':{'A':100.},'nav':11000.}
    out,fills,_,events=m.execute(state,None,{'A':bar(50)},{'A':bar(100)},{'A':100.},{'A':100.},0)
    assert out['nav']==state['nav'] and out['cash']==1000 and not fills
    assert events[0]['ratio']==2

def test_missing_open_is_unfilled_not_dropped_pool():
    q=bar();q['open']=None
    state,fills,skips,_=m.execute({'cash':1000.,'units':{},'nav':1000.},{'A':5.},{'A':q},{'A':bar()},{'A':100.},{'A':100.},0)
    assert state['nav']==1000 and not fills and skips[0]['reason']=='missing_open_or_adjustment'

def test_volume_and_cash_limits_hold():
    state,fills,_,_=m.execute({'cash':1000.,'units':{},'nav':1000.},{'A':100.},{'A':bar()},{'A':bar(volume=500)},{'A':100.},{'A':100.},0)
    assert fills[0]['shares']==5 and state['cash']==480
    state,fills,_,_=m.execute({'cash':250.,'units':{},'nav':250.},{'A':100.},{'A':bar()},{'A':bar()},{'A':100.},{'A':100.},0)
    assert fills[0]['shares']==2 and state['cash']==30

def test_missing_held_mark_fails_instead_of_forward_fill():
    with pytest.raises(ValueError,match='held_close_missing'):
        m.execute({'cash':0.,'units':{'A':1.},'nav':100.},None,{}, {},{}, {'A':100.},0)

def test_signal_quantity_does_not_use_next_open_to_pick_more_shares():
    out,fills,_,_=m.execute({'cash':100000.,'units':{},'nav':100000.},{'A':100.},{'A':bar(80)},{'A':bar(100)},{'A':80.},{'A':100.},0)
    assert fills[0]['shares']==100

def test_native_opb_rejects_same_day_reward_and_uses_prior_receipt():
    base={'exposure_cap':1.,'name_cap':.08,'min_weight':0.,'max_positions':5}
    opb=m.native_opb_policy(base);opb['approved_policy_identity']='test'
    policy={'constraints':base,'opb':opb}
    receipt={'policy_identity':'test','complete':True,'known_date':'2026-08-21','arm_id':'base','reward_kind':'complete_policy_account_net_return','reward':.001}
    with pytest.raises(ValueError,match='reward_contract_invalid'):m.choose_opb(policy,[receipt],'test','2026-08-21')
    _,e=m.choose_opb(policy,[receipt],'test','2026-08-24')
    assert e['samples']==1 and e['status']=='learned_policy'


def test_stale_account_is_explicit_and_does_not_enable_missing_quote_fill():
    state,fills,_,_=m.execute({'cash':1000.,'units':{'A':10.},'nav':2000.},{}, {}, {},{}, {'A':100.},0,mark_prices={'A':100.})
    assert state['nav']==2000 and state['stale_symbols']==['A'] and not fills

def test_failed_sale_cannot_create_sixth_position():
    state={'cash':10000.,'units':{'A':10.},'nav':11000.}
    out,fills,skips,_=m.execute(state,{'B':10.},{'B':bar()},{'B':bar()},{'A':100.,'B':100.},{'A':100.,'B':100.},0,max_positions=1)
    assert not fills and out['units']=={'A':10.}
    assert any(r['reason']=='actual_position_cap_after_failed_sells' for r in skips)


def test_default_nav_refuses_mature_label_conditioned_universe():
    with pytest.raises(ValueError,match='requires_asof_decision_universe'):
        m.load_inputs()


def test_asof_nav_rejects_omitted_formal_candidate(tmp_path,monkeypatch):
    import json,hashlib
    import polars as pl
    c=tmp_path/'corrected';c.mkdir();dest=c/'asof';dest.mkdir()
    ref=tmp_path/'selection_reference.json'
    ref.write_text(json.dumps({'responses':[{'results':[{'signal_date':'2026-08-21','symbol':s,'hard_gate_passed':1,'feature_available':1,'strategy_selected':1} for s in ['A','B']]}]}))
    source=dest/'held-predictions.parquet'
    pl.DataFrame([{'date':'2026-08-21','symbol':'A','l3_available':True,**{n:0. for n in m.MODELS}}]).write_parquet(source)
    (dest/'asof-forecast-receipt.json').write_text(json.dumps({'future_labels_required':False,'formal_route_sha256':hashlib.sha256(ref.read_bytes()).hexdigest(),'source_sha256':hashlib.sha256(source.read_bytes()).hexdigest()}))
    monkeypatch.setattr(m,'C',c)
    with pytest.raises(ValueError,match='formal_route_coverage_mismatch'):m.load_inputs(asof_dir=dest)
