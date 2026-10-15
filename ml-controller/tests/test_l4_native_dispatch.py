import asyncio,json
from datetime import datetime,timedelta,timezone
import pytest
from services.l4_native_dispatch import advance
from test_l4_forward_refresh import Bucket


def test_pending_retry_resumes_exact_call_and_transmits_only_reference():
    bucket=Bucket();calls=[];polls=[]
    request={'payloads':[{'symbol':str(i)} for i in range(2300)]}
    ref={'path':'request','sha256':'a'*64}
    async def spawn(value):calls.append(value);return 'fc-one'
    async def poll(call):
        polls.append(call)
        return {'status':'running'} if len(polls)==1 else {'status':'completed','result':{'value':42}}
    def run(value=request):return asyncio.run(advance(bucket,'key',{'path':'envelope'},value,
        request_ref=ref,spawn=spawn,poll=poll))
    assert run()['status']=='pending'
    completed=run();assert completed['result']=={'value':42}
    assert run()==completed
    assert polls==['fc-one','fc-one'] and len(calls)==1
    assert calls[0]['request_reference']==ref and 'payloads' not in calls[0]
    with pytest.raises(ValueError,match='input_changed'):run({'payloads':[]})


def test_lost_spawn_reply_cannot_dispatch_again():
    bucket=Bucket();calls=[]
    async def spawn(value):calls.append(value);raise TimeoutError('lost response')
    def run():return asyncio.run(advance(bucket,'key',{}, {},request_ref={},spawn=spawn))
    with pytest.raises(TimeoutError):run()
    with pytest.raises(ValueError,match='acknowledgement_missing'):run()
    assert len(calls)==1


@pytest.mark.parametrize('status',['running','unknown'])
def test_wait_has_deadline_without_replacement(status):
    bucket=Bucket();now=datetime.now(timezone.utc);calls=[]
    async def spawn(value):calls.append(value);return 'fc-one'
    async def poll(call):return {'status':status}
    def run(clock):return asyncio.run(advance(bucket,'key',{}, {},request_ref={},spawn=spawn,poll=poll,now=clock))
    result=run(now)
    assert result['status']=='pending' and result['external_compute_pending']==(status=='running')
    with pytest.raises(ValueError,match='deadline_exceeded'):run(now+timedelta(hours=3))
    assert len(calls)==1


def test_prepared_observation_resume_never_recaptures_inputs(monkeypatch):
    from services import l4_native_observation as native
    from services.l4_forward_refresh import publish
    from services.l4_forward_materialization import digest
    bucket=Bucket();day='2026-10-15'
    config={'l3_identity':{},'serving_context':publish(bucket,'fixture',{}),
        'training_cutoffs':publish(bucket,'fixture',{'source_references':[]})}
    key=digest(dict(day=day,identity={},policy=config))
    request=publish(bucket,'fixture',{'payloads':[]})
    envelope=publish(bucket,'fixture',{'request':request})
    bucket.data[native.PREFIX+'requests/'+key+'.json']=json.dumps(envelope).encode()
    monkeypatch.setattr(native,'validate_context',lambda *a:'2026-10-01')
    async def forbidden(**kwargs):pytest.fail('retry must not prepare or rerun L2')
    monkeypatch.setattr(native,'prepare',forbidden)
    calls=[]
    async def spawn(value):calls.append(value);return 'fc-one'
    async def poll(call):return {'status':'running'}
    for _ in range(2):
        result=asyncio.run(native.collect(bucket=bucket,config=config,day=day,spawn=spawn,poll=poll))
        assert result['status']=='pending'
    assert len(calls)==1
