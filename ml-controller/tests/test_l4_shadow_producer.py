from copy import deepcopy
from datetime import datetime
import hashlib,json
import pytest
from services.l4_challenger_comparison import seal
from services.l4_challenger_rules import RULES_DOCUMENT_SHA256
from services.l4_shadow_producer import produce_day,initialize
from test_l4_shadow_daily import setup,reseal,read_cash
from test_native_paper_sandbox import native_runner
from test_l4_challenger_registry import Bucket,entry
from services.l4_challenger_registry import Registry


def index(accounts,entry,packet,clock):
    body={k:deepcopy(v) for k,v in packet.items() if k!='checksum'}
    body.update(schema='l4-shadow-native-day-source-v1',rules_document_sha256=RULES_DOCUMENT_SHA256,
                entry_checksum=entry['checksum'],observed_at=clock[0])
    source=seal(body);raw=json.dumps(source,sort_keys=True).encode()
    path='source/'+packet['session_date']+'/'+source['checksum']+'.json'
    blob=accounts.bucket.blob(path);blob.upload_from_string(raw,if_generation_match=0);blob.reload()
    current,_=accounts.registry.current()
    return seal(dict(schema='l4-shadow-native-day-index-v1',registry_checksum=current['checksum'],
        session_date=packet['session_date'],rules_document_sha256=RULES_DOCUMENT_SHA256,
        sources={entry['entry_id']:dict(path=path,generation=str(blob.generation),sha256=hashlib.sha256(raw).hexdigest())}))


@pytest.mark.parametrize('p6',[False,True])
def test_actual_native_daily_producer_two_days_and_duplicate_delivery(native_runner,p6):
    accounts,entry,packet,head,clock=setup(native_runner,p6=p6,full_session=True)
    for signal,day in [('2026-10-19','2026-10-20'),('2026-10-20','2026-10-21')]:
        packet=deepcopy(packet);packet['signal_date']=signal;packet['session_date']=day
        packet['next_open']=day+'T09:00:00+08:00';clock[0]=day+'T06:00:00+08:00'
        for row in packet['seed_rows']:row['date']=signal
        policy=packet['l4_allocation_inputs']['alpha_policy']['l4Distribution']
        policy['runtime']['signal_date']=signal;policy['runtime']['account']['signal_date']=signal
        if p6:policy['runtime']['p6_native_pool']['signal_date']=signal
        packet['trading_config']['l4Distribution']=policy;packet=reseal(packet)
        source=index(accounts,entry,packet,clock);now=datetime.fromisoformat(clock[0])
        result=produce_day(accounts,source,session_date=day,now=now)
        after,_=accounts.current(entry['entry_id'])
        assert result['status']=='prepared' and result['production_effect'] is False
        assert produce_day(accounts,source,session_date=day,now=now)==result
        assert accounts.current(entry['entry_id'])[0]==after
        assert read_cash(after)==read_cash(head)
        head=after


def test_bootstrap_bad_opening_is_rejected_before_registry_writes():
    champion=entry('new-B',calibration='linear');bucket=Bucket()
    registry=Registry(bucket,formal_identity=lambda:champion['serving_identity'],clock=lambda:'2026-10-20T00:00:00Z')
    from types import SimpleNamespace
    accounts=SimpleNamespace(registry=registry)
    bootstrap=seal(dict(schema='l4-shadow-bootstrap-v1',rules_document_sha256=RULES_DOCUMENT_SHA256,
        production_effect=False,champion_id=champion['entry_id'],entries={champion['entry_id']:champion},
        openings={champion['entry_id']:dict(account_id=1,state_sql='bad',state_checksum='0'*64,
            receipt=seal(dict(scope='paper_shadow',state_checksum='0'*64)))}))
    with pytest.raises(ValueError,match='opening_invalid'):initialize(accounts,bootstrap)
    assert bucket.writes==[]
