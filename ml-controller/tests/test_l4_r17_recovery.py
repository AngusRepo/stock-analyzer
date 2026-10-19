from datetime import datetime, timezone
from types import SimpleNamespace
import pytest
from test_l4_r17_native import Objects
from services.l4_r17_recovery import SealedSourceReplay
from services.paired_nav_journal import digest
from services.l4_r17_session import identity, collect
from services import l4_r17_session as session


class Receipts(Objects):
    def receipt_clock(self, ref, delivery):
        assert self.lookup_delivery(delivery) == ref
        return {'authority': 'object_store_server', 'available_at': self.available}


def test_recovery_uses_only_server_verified_original_reads():
    obj=Receipts();obj.available='2026-10-20T01:00:20Z'
    frame={'input_id':'minute','observed_at':'2026-10-20T01:00:00Z','stage':'intraday'}
    key={'frame_id':'minute','observed_at':frame['observed_at'],'operation':'source_sql',
         'request':{'sql':'SELECT 1'},'source_context':None}
    record={'identity':key,'captured_at':obj.available,'response':{'results':[]}}
    ref=obj.put(record);obj.publish_delivery(digest(key),ref)
    replay=SealedSourceReplay(SimpleNamespace(inference_reads={}),obj)
    assert replay.read('source_sql',key['request'],frame)==record
    replay.verify()
    obj.available='2026-10-20T01:02:00Z'
    with pytest.raises(ValueError,match='not_captured_on_time'):
        replay.read('source_sql',key['request'],frame)
    with pytest.raises(ValueError,match='original_read_missing'):replay.verify()


def test_missing_read_cannot_be_swallowed_by_native_fallback():
    replay=SealedSourceReplay(SimpleNamespace(inference_reads={}),Receipts())
    frame={'input_id':'missing','observed_at':'2026-10-20T01:00:00Z','stage':'intraday'}
    try:replay.read('source_kv',{'key':'market:quote'},frame)
    except ValueError:pass
    with pytest.raises(ValueError,match='original_read_missing'):replay.verify()


def test_interrupted_four_arm_frame_recovers_finished_arms(monkeypatch):
    obj=Objects();frame={'input_id':'x','observed_at':'2026-10-20T01:00:00Z','stage':'intraday'}
    reg={'identity':identity('registration','test','2026-10-20'),'session_date':'2026-10-20',
         'schedule':[frame],'states':{a:{'state_checksum':a,'state_sql':a} for a in session.ARMS},
         'source_tables':{},'configuration':{'kv_read_policy':{}},'account_id':1,
         'variables':{},'execution_owner':'fixed'}
    ref=obj.put(reg);calls=[];interrupt=[True]
    def run(**kwargs):
        arm=kwargs['state_checksum'];calls.append(arm)
        if arm=='C' and interrupt[0]:raise RuntimeError('process interrupted')
        return {'state_checksum':arm+'1','state_sql':arm+'1','frames':[{'ok':True}],
                'captured_inputs':{'x':frame},'execution_metrics':[]}
    monkeypatch.setattr(session,'run_native_paper_frames',run)
    args=dict(registration_ref=ref,index=0,objects=obj,capture_by_arm={a:None for a in session.ARMS},
              runner=None,now=datetime(2026,10,20,1,0,10,tzinfo=timezone.utc))
    with pytest.raises(RuntimeError,match='interrupted'):collect(**args)
    interrupt[0]=False
    out=collect(**args)
    assert calls==['A','B','C','C','L']
    assert set(obj.get(out)['states'])==set(session.ARMS)
    assert collect(**{**args,'now':datetime(2026,10,21,tzinfo=timezone.utc)})==out


@pytest.mark.parametrize('stage',['intraday','morning','preopen'])
def test_missing_interval_preserves_completed_arms_and_cannot_skip_settlement(stage):
    from services.l4_r17_session import record_unobserved_interval,publish
    obj=Objects();day='2026-10-20';exp='gap-fixture'
    schedule=[{'input_id':'open','stage':'settlement','observed_at':day+'T00:45:00Z'},
              {'input_id':'minute','stage':stage,'observed_at':day+'T01:00:00Z'}]
    reg={'identity':identity('registration',exp,day),'session_date':day,'schedule':schedule}
    ref=obj.put(reg);states={a:{'state_sql':a,'state_checksum':a} for a in session.ARMS}
    prior=publish(obj,identity('frame',exp,day,0),{'identity':identity('frame',exp,day,0),'states':states})
    key=identity('frame_arm_A',exp,day,1)
    publish(obj,key,{'identity':key,'registration_ref':ref,'previous_ref':prior,'initial_state_checksum':'A',
        'state_sql':'A1','state_checksum':'A1','output':{'frames':[{'native':'executed'}],
            'captured_inputs':{'minute':{'original':'source'}},'execution_metrics':[]}})
    clock=datetime(2026,10,20,1,2,tzinfo=timezone.utc)
    result=record_unobserved_interval(registration_ref=ref,index=1,objects=obj,now=clock)
    row=obj.get(result)
    assert row['unobserved_arms']==['B','C','L']
    assert row['states']['A']['state_checksum']=='A1' and row['frames']['A']=={'native':'executed'}
    assert row['states']['B']==states['B'] and row['frames']['B'] is None
    assert row['outer_credit']==0
    assert record_unobserved_interval(registration_ref=ref,index=1,objects=obj,now=clock)==result
    with pytest.raises(ValueError,match='required_frame_cannot_be_omitted'):
        record_unobserved_interval(registration_ref=ref,index=0,objects=obj,now=clock)


def test_single_solver_failure_is_recorded_without_stopping_other_arms(monkeypatch):
    obj=Objects();day='2026-10-20'
    frame={'input_id':'morning','stage':'morning','observed_at':day+'T00:45:00Z'}
    states={a:{'state_sql':a,'state_checksum':a} for a in session.ARMS}
    reg={'identity':identity('registration','solver-fixture',day),'session_date':day,'schedule':[frame],
        'states':states,'source_tables':{},'configuration':{'kv_read_policy':{}},'account_id':1,
        'variables':{},'execution_owner':'fixed'}
    ref=obj.put(reg);calls=[]
    def run(**kwargs):
        arm=kwargs['state_checksum'];calls.append(arm)
        if arm=='C':raise RuntimeError('native_paper_private_ValueError:l4_portfolio_optimality_not_certified:l4_allocate:ValueError')
        return {'state_sql':arm+'1','state_checksum':arm+'1','frames':[{'executed':arm}],
            'captured_inputs':{'morning':frame},'execution_metrics':[]}
    monkeypatch.setattr(session,'run_native_paper_frames',run)
    out=collect(registration_ref=ref,index=0,objects=obj,capture_by_arm={a:None for a in session.ARMS},
        runner=None,now=datetime(2026,10,20,0,45,tzinfo=timezone.utc))
    result=obj.get(out)
    assert calls==list(session.ARMS)
    assert result['failed_arms']=={'C':'l4_portfolio_optimality_not_certified'}
    assert result['states']['C']==states['C'] and result['frames']['C'] is None
    assert result['states']['L']['state_checksum']=='L1'
