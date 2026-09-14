from copy import deepcopy
from datetime import date,timedelta
import numpy as np
import pytest
from services.l4_dated_risk import build_dated_risk,estimate_risk
from services.l4_risk_history import aligned_dated_history
from services.l4_distribution import digest
from services.similarity_evidence import ledoit_wolf_covariance

def payload(symbol,skip=()):
    return {'symbol':symbol,'prices':[{'date':str(date(2026,7,1)+timedelta(days=i)),
        'adj_close':100*np.exp(.001*i+.02*np.sin(i*.4+ord(symbol[0])))} for i in range(61) if i not in skip]}
DAY='2026-08-30'

def test_staggered_gaps_keep_every_symbol_and_no_multisession_fake_daily_return():
    rows=[payload(chr(65+i),range(i,59,6)) for i in range(6)]
    with pytest.raises(ValueError,match='aligned_history_insufficient'):aligned_dated_history(rows,signal_date=DAY,lookback=60)
    packet=build_dated_risk(rows,signal_date=DAY,lookback=60);result=estimate_risk(packet,sorted(packet['returns']))
    assert len(result['symbols'])==6 and len(packet['intervals'])==60
    assert all(c['observations']>=20 for c in result['coverage'].values())
    assert any(v is None for v in packet['returns']['A'])
    cov=np.array(result['covariance']);assert np.linalg.eigvalsh(cov).min()>-1e-10
    # Off-diagonal estimates must equal independent pairwise observed np.cov.
    a=np.array([np.nan if v is None else v for v in packet['returns']['A']]);b=np.array([np.nan if v is None else v for v in packet['returns']['B']]);valid=np.isfinite(a)&np.isfinite(b)
    pair=estimate_risk(packet,['A','B'])
    assert pair['covariance'][0][1]==pytest.approx(np.cov(a[valid],b[valid])[0,1],abs=1e-12)

def test_complete_history_preserves_exact_native_ledoit_wolf():
    packet=build_dated_risk([payload('A'),payload('B')],signal_date=DAY,lookback=60)
    observed=estimate_risk(packet,['A','B']);expected=ledoit_wolf_covariance(['A','B'],packet['returns'])
    assert observed['covariance']==expected['covariance']
    assert observed['covariance_method']=='ledoit_wolf'

def test_missing_price_is_explicit_and_new_stock_cannot_disable_whole_pool():
    rows=[payload('A'),payload('B')];rows[1]['prices']=rows[1]['prices'][-4:]
    packet=build_dated_risk(rows,signal_date=DAY,lookback=60);risk=estimate_risk(packet,['A','B'])
    assert risk['forbidden_buys']==['B'] and len(risk['covariance'])==2
    assert risk['coverage']['B']['observations']==3
    assert packet['coverage']['B']['before_first_observation_days']==57
    assert packet['coverage']['B']['missing_price_dates']==[]
    assert risk['unsupported_pairs']==1 and risk['unknown_pair_diagonal_loading'][0]==0
    rows[0]['prices'][-1]['adj_close']=None
    packet=build_dated_risk(rows,signal_date=DAY,lookback=60)
    assert 'latest_canonical_price_missing' in packet['coverage']['A']['reasons']

def test_lineage_future_price_duplicates_and_prefix_invariance():
    rows=[payload('A'),payload('B')]
    with pytest.raises(ValueError,match='future_price'):build_dated_risk(rows,signal_date='2026-07-31',lookback=60)
    with pytest.raises(ValueError,match='duplicate_or_missing'):build_dated_risk([rows[0],rows[0]],signal_date=DAY,lookback=60)
    packet=build_dated_risk(rows,signal_date=DAY,lookback=60);broken=deepcopy(packet);broken['returns']['A'][0]=99
    with pytest.raises(ValueError,match='checksum'):estimate_risk(broken,['A','B'])
    modified=deepcopy(rows);modified[0]['prices'][-1]['adj_close']*=2
    after=build_dated_risk(modified,signal_date=DAY,lookback=60)
    assert packet['returns']['A'][:-1]==after['returns']['A'][:-1]

def test_actual_runtime_respects_new_stock_data_gate_without_pool_truncation():
    from test_l4_distribution_runtime import fixture
    from services.l4_distribution_runtime import run
    recs,policy,_=fixture();policy['runtime']['signal_date']=DAY;policy['runtime']['account']['signal_date']=DAY
    rows=[payload(s) for s in ['A','B','C']];rows[-1]['prices']=rows[-1]['prices'][-4:]
    packet=build_dated_risk(rows,signal_date=DAY,lookback=60)
    plan=run(recs,policy,return_history=packet)[0]['_l4_portfolio_plan']
    assert set(plan['weights'])=={'A','B','C'} and plan['weights']['C']==0
    assert 'C' in plan['forbidden_buys']
    assert plan['risk_evidence']['dated_history']['coverage']['C']['observations']==3


def test_canonical_owner_read_repairs_mirror_and_next_read_picks_up_backfill():
    from services.l4_risk_history import load_canonical_risk_payloads
    from services.paired_nav_collection import capture_allocator_return_history,replay_allocator_return_history
    original=[payload('A')];before=deepcopy(original);ready=False
    def query(sql,params,timeout):
        assert 'canonical_market_daily' in sql and 'UPDATE' not in sql and params[-1]==DAY
        return [{'stock_id':'A','date':r['date'],'adj_close':r['adj_close'],'source':'finlab.price'}
            for i,r in enumerate(before[0]['prices']) if ready or i!=20]
    original[0]['prices'][10]['adj_close']=9999
    risk=load_canonical_risk_payloads(payloads=original,held_payloads=[],signal_date=DAY,lookback=60,query=query)
    assert risk[0]['prices'][10]['adj_close']==before[0]['prices'][10]['adj_close']
    assert risk[0]['prices'][20]['adj_close'] is None
    frozen=capture_allocator_return_history(payloads=original,held_payloads=[],canonical_risk_payloads=risk,signal_date=DAY)
    assert replay_allocator_return_history(frozen,payloads=original,signal_date=DAY)==frozen['return_history']
    ready=True
    repaired=load_canonical_risk_payloads(payloads=original,held_payloads=[],signal_date=DAY,lookback=60,query=query)
    assert repaired[0]['prices'][20]['adj_close']==before[0]['prices'][20]['adj_close']
    assert frozen['canonical_risk_payloads'][0]['prices'][20]['adj_close'] is None
    assert original[0]['prices'][10]['adj_close']==9999
    # A later backfill changes only the next decision, never sealed history.
    after=capture_allocator_return_history(payloads=original,held_payloads=[],canonical_risk_payloads=repaired,signal_date=DAY)
    assert after['content_checksum']!=frozen['content_checksum']

def test_unsupported_observed_pair_gets_conservative_loading():
    a=payload('A');b=payload('B');a['prices']=a['prices'][:26];b['prices']=b['prices'][30:]
    packet=build_dated_risk([a,b],signal_date=DAY,lookback=60);risk=estimate_risk(packet,['A','B'])
    assert all(c['observations']>=20 for c in risk['coverage'].values())
    assert risk['unsupported_pairs']==1 and all(v>0 for v in risk['unknown_pair_diagonal_loading'])
    assert risk['graph_correlation'][0][1]==1
