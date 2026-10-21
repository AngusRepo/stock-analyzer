import hashlib,io,json,zipfile
import pytest
from services import l4_p6_monthly as owner
from services.l4_p6_dispatch import put
from services.l4_distribution import digest
from test_l4_p6_dispatch import Bucket


def fixture():
    bucket=Bucket();identity={'artifact_id':'new-L3'};manifest={'manifest_checksum':'a'*64}
    args=dict(bucket=bucket,identity=identity,manifest=manifest,as_of='2026-10-19',cadence='monthly')
    key=owner.key_for(identity=identity,manifest_checksum=manifest['manifest_checksum'],as_of=args['as_of'],cadence='monthly')
    source=dict(recipe=owner.RECIPE,run_key=key,l3_identity=identity,source_manifest_checksum=manifest['manifest_checksum'],
        as_of=args['as_of'],cadence='monthly',requested_cutoff=dict(signal_date_max='2026-09-22',label_known_at_max='2026-10-01'),
        ancestor_graph_sha256='b'*64,calendar_receipt_sha256='c'*64,first_evaluation_signal_date='2026-10-02',l3_training_label_known_max='2026-10-01')
    def phase(name):
        body=dict(recipe=owner.RECIPE,phase=name,provenance={k:source[k] for k in
            ('l3_identity','requested_cutoff','source_manifest_checksum','ancestor_graph_sha256','calendar_receipt_sha256','first_evaluation_signal_date')})
        batch=digest(body);seal={**body,'batch_id':batch};buffer=io.BytesIO()
        with zipfile.ZipFile(buffer,'w') as archive:archive.writestr('batch-seal.json',json.dumps(seal))
        raw=buffer.getvalue();sha=hashlib.sha256(raw).hexdigest();path=f'l4_distribution/p6_batches/{batch}/inputs.zip'
        bucket.objects[path]=(raw,{'sha256':sha})
        return dict(recipe=owner.RECIPE,phase=name,batch_id=batch,inputs=dict(path=path,sha256=sha,bytes=len(raw),generation='1'))
    source['cv_phase']=phase('cv')
    return args,source,phase


def test_missing_source_is_pending_not_old_model_or_success():
    args,source,phase=fixture();result=owner.execute(**args,spawn=lambda p:pytest.fail('training without sealed input'))
    assert result['status']=='pending' and result['stage']=='awaiting_p6_causal_inputs'
    assert result['dependency_retry_required'] and result['model_family']=='p6_a'


def test_cv_then_final_handoffs_collect_before_any_final_dispatch(monkeypatch):
    args,source,phase=fixture();bucket=args['bucket'];root=owner.PREFIX+source['run_key']+'/'
    put(bucket,root+'source.json',source);seen=[]
    def completed_phase(bucket,source,**kw):
        seen.append(source['phase']);return dict(status='phase_complete',verified_seeds=[42,43,44])
    monkeypatch.setattr(owner,'advance',completed_phase)
    final=dict(run_key=source['run_key'],cv_batch_id=source['cv_phase']['batch_id'],cv_collection_checksum='d'*64,
        requested_cutoff=source['requested_cutoff'],l3_identity=source['l3_identity'],epoch_reselection_allowed=False,
        final_phase=phase('final'))
    def prepare(*a):
        assert seen==['cv'];seen.append('collect_cv');return final
    def finish(*a):
        assert seen==['cv','collect_cv','final'];seen.append('collect_final')
    monkeypatch.setattr('services.l4_p6_monthly_collect.prepare_final_phase',prepare)
    monkeypatch.setattr('services.l4_p6_monthly_collect.finalize_candidate',finish)
    monkeypatch.setattr(owner,'completed',lambda *a,**k:dict(status='validated',promoted=False))
    result=owner.execute(**args)
    assert seen==['cv','collect_cv','final','collect_final']
    assert result==dict(status='validated',promoted=False)


def test_wrong_archive_cutoff_rejected_before_dispatch():
    args,source,phase=fixture();source['requested_cutoff']['signal_date_max']='2026-09-21'
    put(args['bucket'],owner.PREFIX+source['run_key']+'/source.json',source)
    with pytest.raises(ValueError,match='archive_provenance'):
        owner.execute(**args,spawn=lambda p:pytest.fail('wrong cutoff paid fit'))


def test_phase_order_and_completed_run_identity_required():
    args,source,phase=fixture();source['cv_phase']=phase('final')
    put(args['bucket'],owner.PREFIX+source['run_key']+'/source.json',source)
    with pytest.raises(ValueError,match='phase_order'):owner.execute(**args)
    with pytest.raises(ValueError,match='wrong_completed_run'):owner.execute(**args,completed_run_key='f'*64)


def test_monthly_asof_can_equal_label_known_cutoff_before_first_decision():
    args,source,phase=fixture();args['as_of']='2026-10-01';source['as_of']=args['as_of']
    source['run_key']=owner.key_for(identity=args['identity'],manifest_checksum=args['manifest']['manifest_checksum'],as_of=args['as_of'],cadence='monthly')
    put(args['bucket'],owner.PREFIX+source['run_key']+'/source.json',source)
    from types import SimpleNamespace
    result=owner.execute(**args,spawn=lambda p:SimpleNamespace(object_id=str(p['seed'])))
    assert result['stage']=='cv' and result['training_dispatched']
