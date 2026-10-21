import hashlib,json
from pathlib import Path
import pytest
from services import l4_p6_monthly_collect as owner
from services.l4_p6_recipe import RECIPE,PROTOCOL,_json
from services.l4_distribution import digest
from test_l4_p6_final_inputs import batch
from test_l4_p6_dispatch import Bucket


def prepared(batch,tmp_path,monkeypatch,gate='pass'):
    directories,selections,cutoff,out=batch;bucket=Bucket()
    root=tmp_path/'source';root.mkdir()
    import shutil
    for i,d in enumerate(directories,1):shutil.copytree(d,root/str(i))
    seal=dict(recipe=RECIPE,phase='cv',protocol=PROTOCOL,provenance={'requested_cutoff':cutoff.__dict__},
        code_sha256={'p6_train.py':'f'*64},upstream_commit='frozen',upstream_files={},files_sha256={})
    seal['batch_id']=digest(seal);_json(root/'batch-seal.json',seal)
    raw=owner.archive_directory(root);path=f"l4_distribution/p6_batches/{seal['batch_id']}/inputs.zip"
    ref=owner.upload(bucket,path,raw)
    source=dict(run_key='a'*64,requested_cutoff=cutoff.__dict__,l3_identity={'artifact_id':'new'},first_evaluation_signal_date='2026-10-02',
        cv_phase=dict(recipe=RECIPE,phase='cv',batch_id=seal['batch_id'],inputs=ref))
    def collect(bucket,folds,**kwargs):
        # Collector metrics already covered by real three-seed tests; inject
        # explicit gate outcome here to exercise side-effect sequencing.
        dest=Path(kwargs['output']);dest.mkdir()
        _json(dest/'inner-validation.json',{'champion_B_gate':{'status':gate}})
        receipt={'checksum':'b'*64};_json(dest/'receipt.json',receipt)
        return receipt,selections,{}
    monkeypatch.setattr(owner,'collect_cv',collect)
    return bucket,source,'l4_distribution/p6_monthly_runs/'+source['run_key']+'/'


def test_final_preparation_keeps_selection_and_pins_cv_engine(batch,tmp_path,monkeypatch):
    bucket,source,root=prepared(batch,tmp_path,monkeypatch)
    final=owner.prepare_final_phase(bucket,source,root)
    assert final['epoch_reselection_allowed'] is False
    ref=final['final_phase']['inputs'];raw=bucket.objects[ref['path']][0]
    dest=tmp_path/'verified';owner.extract(raw,dest)
    seal=json.loads((dest/'batch-seal.json').read_bytes())
    assert seal['phase']=='final' and seal['code_sha256']=={'p6_train.py':'f'*64}
    assert seal['batch_id']==digest({k:v for k,v in seal.items() if k!='batch_id'})
    receipt=json.loads((dest/'receipt.json').read_bytes())
    assert receipt['epoch_reselection_allowed'] is False and receipt['outer_rows']==0
    for seed in (42,43,44):
        assert json.loads((dest/f'seed{seed}-selection.json').read_bytes())==batch[1][seed]
    monkeypatch.setattr(owner,'collect_cv',lambda *a,**kw:pytest.fail('repeated collection/fit'))
    assert owner.prepare_final_phase(bucket,source,root)==final


def test_B_gate_failure_saves_report_and_does_not_fit_final_head(batch,tmp_path,monkeypatch):
    bucket,source,root=prepared(batch,tmp_path,monkeypatch,gate='incomplete')
    monkeypatch.setattr('services.l4_p6_final_inputs.prepare_final',lambda *a,**kw:pytest.fail('final fit after failed gate'))
    result=owner.prepare_final_phase(bucket,source,root)
    assert result['status']=='needs_user_decision' and result['final_training_dispatched'] is False
    assert result['cv_collection']['path']==root+'cv-collection.zip'
    assert owner.prepare_final_phase(bucket,source,root)==result


def test_interrupted_final_preparation_does_not_silently_refit(batch,tmp_path,monkeypatch):
    bucket,source,root=prepared(batch,tmp_path,monkeypatch)
    owner.claim(bucket,root+'prepare-final-claim.json')
    with pytest.raises(ValueError,match='claim_requires_recovery'):owner.prepare_final_phase(bucket,source,root)


@pytest.mark.parametrize('cadence',['monthly','manual'])
def test_actual_final_collection_and_completion_readback(tmp_path,monkeypatch,cadence):
    from test_l4_p6_final_results import setup
    from services import l4_p6_monthly as monthly
    saved,args=setup(tmp_path)
    bucket=Bucket()
    for path,(raw,ref) in saved.saved.items():
        bucket.objects[path]=(raw,{'sha256':ref['sha256']})
    identity=args['l3_identity'];as_of='2026-10-01';manifest_sha='d'*64
    key=monthly.key_for(identity=identity,manifest_checksum=manifest_sha,as_of=as_of,cadence=cadence)
    root=monthly.PREFIX+key+'/'
    source=dict(run_key=key,l3_identity=identity,as_of=as_of,cadence=cadence,
        source_manifest_checksum=manifest_sha,first_evaluation_signal_date='2026-10-02',
        l3_training_label_known_max='2026-10-01')
    cv_ref=owner.upload(bucket,root+'cv-collection.zip',owner.archive_directory(args['cv_directory']))
    final_ref=owner.upload(bucket,root+'final-inputs.zip',owner.archive_directory(args['final_directory']))
    final=dict(cv_collection=cv_ref,
        cv_collection_checksum=json.loads((args['cv_directory']/'receipt.json').read_bytes())['checksum'],
        final_phase=dict(batch_id=args['sealed_batch_id'],inputs=final_ref))
    result=owner.finalize_candidate(bucket,source,final,root)
    assert result['status']=='validated' and result['promoted'] is False
    assert monthly.completed(bucket,key,identity=identity,manifest_checksum=manifest_sha,as_of=as_of,cadence=cadence)==result
    # No refit, no second final claim, no new artifact on retry.
    before=dict(bucket.objects)
    monkeypatch.setattr(owner,'collect_final',lambda *a,**kw:pytest.fail('repeated final collection'))
    assert owner.finalize_candidate(bucket,source,final,root)==result
    assert bucket.objects==before
    candidate=json.loads(bucket.objects[root+'candidate.json'][0])
    assert 'release' not in candidate and candidate['cadence']==cadence
