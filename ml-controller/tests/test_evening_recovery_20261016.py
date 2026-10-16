from datetime import datetime
import pytest
from services import premarket_pipeline as m

@pytest.mark.parametrize('clock,capture', [
    ('08:45:00','06:45:00'), ('23:59:59','06:45:00'), ('12:00:00','11:00:00')])
def test_authorized_day_keeps_actual_frozen_or_fresh_context(monkeypatch,clock,capture):
    monkeypatch.setenv('PIPELINE_DAILY_PLAN_OWNER',m.OWNER)
    context={'trade_date':'2026-10-16','cutoff':'2026-10-16T'+capture+'+08:00'}
    context['checksum']=m.digest(context)
    before=dict(context)
    m.validate_context({'run_date':'2026-10-15'},context,now=datetime.fromisoformat('2026-10-16T'+clock+'+08:00'))
    assert context==before
    context['checksum']='0'*64
    with pytest.raises(ValueError,match='checksum'):
        m.validate_context({'run_date':'2026-10-15'},context,now=datetime.fromisoformat('2026-10-16T'+clock+'+08:00'))

@pytest.mark.parametrize('signal,trade,owner,capture',[
    ('2026-10-15','2026-10-19',m.OWNER,'2026-10-19T07:00:00+08:00'),
    ('2026-10-14','2026-10-16',m.OWNER,'2026-10-16T07:00:00+08:00'),
    ('2026-10-15','2026-10-16','other','2026-10-16T07:00:00+08:00'),
    ('2026-10-15','2026-10-16',m.OWNER,'2026-10-15T07:00:00+08:00'),
    ('2026-10-15','2026-10-16',m.OWNER,'2026-10-16T09:00:00+08:00'),
    ('2026-10-15','2026-10-16',m.OWNER,'2026-10-16T13:00:00+08:00')])
def test_recovery_does_not_expand_date_owner_freshness_or_future_time(monkeypatch,signal,trade,owner,capture):
    monkeypatch.setenv('PIPELINE_DAILY_PLAN_OWNER',owner)
    context={'trade_date':trade,'cutoff':capture};context['checksum']=m.digest(context)
    with pytest.raises(ValueError,match='cutoff|stale'):
        m.validate_context({'run_date':signal},context,now=datetime.fromisoformat(trade+'T12:00:00+08:00'))
