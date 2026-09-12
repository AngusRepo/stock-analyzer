"""Frozen risk window and original adjusted returns; software fixtures only."""
from copy import deepcopy
from datetime import date, timedelta

import pytest

from services.paired_nav_collection import capture_allocator_return_history, replay_allocator_return_history
from services.paired_nav_journal import digest


def payloads():
    return [{'symbol':'2330','prices':[{'date':(date(2026,9,6)-timedelta(days=100-i)).isoformat(),
        'close':100+i, 'adj_close':50+i/2} for i in range(101)]}]


def test_original_lookback_is_frozen_not_inferred_from_history_length(monkeypatch):
    from services.recommendation_service import build_return_history_from_payloads
    monkeypatch.setenv('STOCKVISION_GNN_RETURN_HISTORY_LOOKBACK','60')
    rows=payloads()
    before=deepcopy(rows)
    context=capture_allocator_return_history(payloads=rows,signal_date='2026-09-06')
    assert context['lookback']==60 and len(context['return_history']['2330'])==60
    assert context['return_history']==build_return_history_from_payloads(rows,lookback=60)
    monkeypatch.setenv('STOCKVISION_GNN_RETURN_HISTORY_LOOKBACK','504')
    assert capture_allocator_return_history(payloads=rows,signal_date='2026-09-06',saved=context)==context
    assert rows==before and context['nav_maturity_credit']==0


def test_missing_adjusted_price_is_not_substituted_with_raw_close():
    rows=payloads()
    rows[0]['prices'][-1].pop('adj_close')
    context=capture_allocator_return_history(payloads=rows,signal_date='2026-09-06')
    assert context['return_history']=={}


@pytest.mark.parametrize('fault',['payload','result','lookback','future','source'])
def test_invalid_or_future_history_rejected(fault):
    rows=payloads()
    context=capture_allocator_return_history(payloads=rows,signal_date='2026-09-06')
    if fault=='payload': rows[0]['prices'][0]['close']+=1
    if fault=='result': context['return_history']['2330'][-1]+=1
    if fault=='lookback': context['lookback']=True
    if fault=='source': context['source_identity']={}
    if fault=='future':
        rows[0]['prices'][-1]['date']='2026-09-07'
        context['payload_checksum']=digest(rows)
    context['content_checksum']=digest({k:v for k,v in context.items() if k!='content_checksum'})
    with pytest.raises(ValueError): replay_allocator_return_history(context,payloads=rows,signal_date='2026-09-06')
