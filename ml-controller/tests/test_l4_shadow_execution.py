from copy import deepcopy
from datetime import datetime
import pytest
from services.l4_challenger_comparison import digest
from services.l4_shadow_execution import collect_due
from services.paired_native_session import session_schedule,STRATEGY_SESSION_POLICY
from test_native_paper_sandbox import native_runner
from test_l4_shadow_daily import setup,reseal,read_cash

@pytest.mark.parametrize('p6',[False,True])
def test_registered_native_full_schedule_continues_across_days(native_runner,p6,monkeypatch):
    import services.l4_shadow_accounts as module
    original=module.run_native_paper_frames;failures=[]
    def inspect_failure(**kwargs):
        try:return original(**kwargs)
        except Exception as exc:failures.append(str(exc));raise
    monkeypatch.setattr(module,'run_native_paper_frames',inspect_failure)
    a,model,packet,head,record_clock=setup(native_runner,p6,full_session=True)
    key=model['entry_id'];seen=[]
    def capture(**kwargs):
        seen.append(kwargs['entry']['serving_identity'])
        class NoExternalInput:
            def read(self,operation,request,frame):
                assert operation=='source_kv',(operation,request)
                return {'request':request,'captured_at':frame['observed_at'],'response':None}
        return NoExternalInput()
    for signal,day,cash in [('2026-10-19','2026-10-20',1000100),('2026-10-20','2026-10-21',1000300)]:
        p=deepcopy(packet);p.update(signal_date=signal,session_date=day,next_open=day+'T09:00:00+08:00')
        for row in p['seed_rows']:row['date']=signal
        policy=p['l4_allocation_inputs']['alpha_policy']['l4Distribution']
        policy['runtime']['signal_date']=signal;policy['runtime']['account']['signal_date']=signal
        if p6:policy['runtime']['p6_native_pool']['signal_date']=signal
        p['trading_config']['l4Distribution']=policy;p=reseal(p)
        record_clock[0]=day+'T00:00:00Z'
        a.prepare_day(key,expected_state_checksum=head['checksum'],packet=p)
        schedule=session_schedule(day,policy=STRATEGY_SESSION_POLICY)
        # Invoke the production collector at each actual due instant; never
        # execute an expired historical frame with a synthetic current clock.
        for frame in schedule:
            result=collect_due(accounts=a,session_date=day,capture_factory=capture,
                clock=lambda f=frame:datetime.fromisoformat(f['observed_at']))
            assert result['status']=='ok',(result,failures)
        assert result['accounts'][0]['completed_frames']==281
        assert result['accounts'][0]['status']=='execution_complete'
        assert result['accounts'][0]['accounting_verified'] is False
        assert result['outer_acceptance_credit']==0
        head=a.current(key)[0];assert read_cash(head)=={1:cash,2:12345}
        checksum=head['checksum'];count=len(seen)
        again=collect_due(accounts=a,session_date=day,capture_factory=capture,
            clock=lambda:datetime.fromisoformat(schedule[-1]['observed_at']))
        assert again['accounts'][0]['state_checksum']==checksum and len(seen)==count


def test_late_tick_does_not_backfill_and_missing_daily_inputs_are_visible(native_runner):
    a,model,p,head,_=setup(native_runner,full_session=True)
    called=[]
    def forbidden(**kwargs):called.append(kwargs);raise AssertionError('must_not_capture')
    clock=lambda:datetime.fromisoformat('2026-10-20T09:01:00+08:00')
    result=collect_due(accounts=a,session_date='2026-10-20',capture_factory=forbidden,clock=clock)
    assert result['accounts'][0]['status']=='awaiting_daily_inputs'
    a.prepare_day(model['entry_id'],expected_state_checksum=head['checksum'],packet=p)
    before=a.current(model['entry_id'])[0]['checksum']
    result=collect_due(accounts=a,session_date='2026-10-20',capture_factory=forbidden,clock=clock)
    assert result['accounts'][0]['reason']=='shadow_expired_frame_without_receipt'
    assert a.current(model['entry_id'])[0]['checksum']==before and not called
