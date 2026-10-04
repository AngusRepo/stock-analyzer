import json
import pytest
from app import l4_tabpack_stages as stage
from test_l4_tabpack_monthly import Bucket


class Preempted(BaseException): pass


@pytest.mark.parametrize('retry_owner,partial', [('same',False),('other',False),('missing',False),('same',True)])
def test_only_same_provider_input_resumes_unfinished_gpu(monkeypatch,retry_owner,partial):
    payload={'expected_source_sha':'a'*40,'run_key':'b'*64,'training_recipe':stage.RECIPE}
    monkeypatch.setenv('STOCKVISION_SOURCE_SHA','a'*40)
    owner={'function_call_id':'fc-original','input_id':'in-original'}
    monkeypatch.setattr(stage,'_stage_owner',lambda:owner)
    bucket=Bucket();bucket.list_blobs=lambda **kw:iter(['partial'] if partial else [])
    calls=[]
    def interrupted(*a,**kw): calls.append('first');raise Preempted()
    monkeypatch.setattr(stage,'gpu_stage',interrupted)
    with pytest.raises(Preempted):stage.run_stage(payload,'gpu',bucket=bucket)
    if retry_owner=='other':monkeypatch.setattr(stage,'_stage_owner',lambda:{**owner,'input_id':'in-other'})
    if retry_owner=='missing':monkeypatch.setattr(stage,'_stage_owner',lambda:None)
    def complete(p,b,**kw):
        calls.append('retry')
        return stage._seal(b,stage._root(p)+'gpu_output.json',{'payload_checksum':stage.digest(p),'files':{}})
    monkeypatch.setattr(stage,'gpu_stage',complete)
    monkeypatch.setattr(stage,'launch',lambda *a:{'status':'pending','reason':'finalize_dispatched'})
    if retry_owner=='same' and partial:
        with pytest.raises(ValueError,match='partial_gpu_exports'):stage.run_stage(payload,'gpu',bucket=bucket)
        assert calls==['first'];return
    result=stage.run_stage(payload,'gpu',bucket=bucket)
    assert calls==(['first','retry'] if retry_owner=='same' else ['first'])
    assert result['reason']==('finalize_dispatched' if retry_owner=='same' else 'tabpack_gpu_already_claimed')
    if retry_owner=='same':
        stage.run_stage(payload,'gpu',bucket=bucket)
        assert calls==['first','retry']  # sealed output reuses work, never fits again
