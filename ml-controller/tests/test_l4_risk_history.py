from copy import deepcopy
from datetime import date, timedelta
import pytest
from services.l4_risk_history import aligned_dated_history, load_held_risk_payloads
from services.paired_nav_collection import capture_allocator_return_history, replay_allocator_return_history


def payload(symbol, skip=None):
    return {'symbol':symbol,'prices':[{'date':str(date(2026,7,1)+timedelta(days=i)), 'adj_close':100+i+i*i*.001}
                                    for i in range(40) if i != skip]}


def test_held_risk_is_frozen_separately_and_replays_without_l3_pool_expansion():
    original=[payload('A'),payload('B',skip=20)]
    before=deepcopy(original)
    held=[{**payload('H'),'source':'market.stock_prices.adj_close','as_of_date':'2026-09-11',
           'role':'held_only_risk_not_l3_candidate'}]
    context=capture_allocator_return_history(payloads=original,signal_date='2026-09-11',held_payloads=held)
    assert original==before
    assert context['schema_version']=='allocator-return-history-context-v3'
    assert set(context['return_history']['returns'])=={'A','B','H'}
    assert ['2026-07-20','2026-07-22'] not in context['return_history']['intervals']
    assert len({len(v) for v in context['return_history']['returns'].values()})==1
    assert replay_allocator_return_history(context,payloads=original,signal_date='2026-09-11')==context['return_history']
    context['held_payloads'][0]['prices'][0]['adj_close']=999
    with pytest.raises(ValueError,match='context_invalid'):
        replay_allocator_return_history(context,payloads=original,signal_date='2026-09-11')


def test_no_future_unadjusted_duplicate_or_fake_covariance():
    with pytest.raises(ValueError,match='future_price'):
        aligned_dated_history([payload('A')],signal_date='2026-07-02',lookback=60)
    broken=payload('A');broken['prices'][5]['adj_close']=None
    with pytest.raises(ValueError,match='adjusted_price_invalid'):
        aligned_dated_history([broken],signal_date='2026-09-11',lookback=60)
    with pytest.raises(ValueError,match='duplicate_or_missing_symbol'):
        aligned_dated_history([payload('A'),payload('A')],signal_date='2026-09-11',lookback=60)
    with pytest.raises(ValueError,match='aligned_history_insufficient'):
        aligned_dated_history([{'symbol':'H','prices':[]}],signal_date='2026-09-11',lookback=60)


def test_held_loader_resolves_core_identity_and_keeps_delisted_holdings(monkeypatch):
    from services import domain_stock_read_models as core,payload_builder as market
    def identities(*,tradable_only):
        assert tradable_only is False
        return {2:{'symbol':'H','delisted_date':'2026-09-01'}}
    def prices(ids,limit,*,as_of_date):
        assert ids==[2] and limit==61 and as_of_date=='2026-09-11'
        return {2:payload('H')['prices']}
    monkeypatch.setattr(core,'load_core_stock_identities',identities)
    monkeypatch.setattr(market,'_bulk_load_prices',prices)
    result=load_held_risk_payloads(holdings=[{'symbol':'A'},{'symbol':'H'}],payloads=[payload('A')],signal_date='2026-09-11',lookback=60)
    assert len(result)==1 and result[0]['symbol']=='H' and result[0]['stock_id']==2
