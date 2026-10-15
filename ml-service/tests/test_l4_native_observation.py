import pytest
from app.l4_native_observation import run,SCOPE


def request(n=2207):
    return dict(execution_scope=SCOPE,max_symbols=5000,payloads=[{'symbol':str(i)} for i in range(n)])


def test_whole_pool_above_formal_capacity_is_not_split_or_truncated():
    seen=[]
    def compute(value):
        seen.append(len(value['payloads']))
        return {'schema_version':'pipeline-modal-prediction-bundle-v1'}
    result=run(request(),compute=compute)
    assert seen==[2207]
    assert result['execution_scope']==SCOPE
    assert result['capacity_contract']['max_symbols']==5000


@pytest.mark.parametrize('key',['callback_url','callback_token','paired_nav_l3_requests','paired_nav_atomic_slates'])
def test_no_formal_callback_or_account_dispatch(key):
    value=request();value[key]='forbidden'
    with pytest.raises(ValueError,match='scope_or_capacity'):
        run(value,compute=lambda p:pytest.fail('must fail before inference'))


def test_capacity_error_does_not_silently_subset():
    with pytest.raises(ValueError,match='scope_or_capacity'):
        run(request(5001),compute=lambda p:pytest.fail('must fail before inference'))


def test_reference_transport_checks_bytes_before_inference():
    import json,hashlib
    from app.l4_native_observation import run_reference
    raw=json.dumps(request()).encode();checksum=hashlib.sha256(raw).hexdigest()
    envelope=dict(schema_version='l4-native-request-reference-v1',request_reference={
        'path':'l4_distribution/forward_data/v1/native_requests/'+checksum+'.json','sha256':checksum})
    seen=[]
    def compute(value):
        seen.append(len(value['payloads']))
        return {'schema_version':'pipeline-modal-prediction-bundle-v1'}
    run_reference(envelope,read=lambda p:raw,compute=compute)
    assert seen==[2207]
    with pytest.raises(ValueError,match='request_hash'):
        run_reference(envelope,read=lambda p:b'{}',compute=compute)
    assert seen==[2207]
