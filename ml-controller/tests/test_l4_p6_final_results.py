import hashlib
import json
from pathlib import Path
import pytest
from services.l4_distribution import digest
from services.l4_p6_results import collect_final
from test_l4_p6_results import Bucket
from test_l4_p6_bundle import fixture,sealed


def setup(tmp_path):
    args=fixture();bucket=Bucket();source=tmp_path/'final';cv=tmp_path/'cv'
    source.mkdir();cv.mkdir()
    final=args['final_receipt'];panel=b'checksum-bound-oof-panel'
    def save(path,value):
        raw=json.dumps(value,sort_keys=True).encode();path.write_bytes(raw);return hashlib.sha256(raw).hexdigest()
    (source/'frozen-p-loss.json').write_bytes(args['frozen_p_loss_raw'])
    for seed,selection in args['selections'].items():
        name=f'seed{seed}-selection.json';final['files_sha256'][name]=save(source/name,selection)
        save(cv/name,selection)
    final['checksum']=digest({k:v for k,v in final.items() if k!='checksum'})
    save(source/'receipt.json',final)
    report=args['inner_report'];report['source_sha256']=hashlib.sha256(panel).hexdigest()
    report['calibration']['source_sha256']=report['source_sha256']
    report['calibration']['checksum']=digest({k:v for k,v in report['calibration'].items() if k!='checksum'})
    report['checksum']=digest({k:v for k,v in report.items() if k!='checksum'})
    save(cv/'inner-validation.json',report);(cv/'oof-panel.parquet').write_bytes(panel)
    save(cv/'receipt.json',sealed(dict(schema_version='p6-cv-collection-v1',input_identity=final['batch_id'],
        fold_receipt_checksums=final['fold_receipt_checksums'],requested_cutoff=final['requested_cutoff'],
        validation_report_checksum=report['checksum'],calibration_checksum=report['calibration']['checksum'],
        evidence_scope='inner_development_only',outer_rows=0,promoted=False,
        panel_sha256=hashlib.sha256(panel).hexdigest(),
        selection_checksums={str(s):v['checksum'] for s,v in args['selections'].items()})))
    for result in args['results']:
        prefix=f"l4_distribution/p6_batches/{'b'*64}/final/seed{result['seed']}/"
        ref=bucket.put(prefix+'weights.npz',args['load_bytes'](result['weights']))
        result['weights']=ref;result['schema_version']='p6-seed-result-v1'
        result['training_lineage']['input_receipt_checksum']=final['checksum']
        bucket.json(prefix+'objects.json',[ref]);bucket.json(prefix+'completed.json',result)
    kwargs=dict(sealed_batch_id='b'*64,final_directory=source,cv_directory=cv,l3_identity=args['l3_identity'],
        l3_training_label_known_max='2026-10-01',calibration_kind='linear',signal_date='2026-10-19',output=tmp_path/'out')
    return bucket,kwargs


def test_final_collection_binds_actual_weights_and_never_releases(tmp_path):
    bucket,kwargs=setup(tmp_path)
    bundle,receipt=collect_final(bucket,**kwargs)
    assert receipt['checkpoint_bytes_verified'] and len(receipt['source_objects'])==9
    assert 'release' not in bundle and receipt['promoted'] is False
    assert collect_final(bucket,**kwargs)==(bundle,receipt)


@pytest.mark.parametrize('change',['generation','manifest','selection','panel','batch'])
def test_final_collection_rejects_wrong_provenance_without_output(tmp_path,change):
    bucket,kwargs=setup(tmp_path)
    prefix=f"l4_distribution/p6_batches/{'b'*64}/final/seed42/"
    if change=='generation':
        raw,ref=bucket.saved[prefix+'weights.npz'];ref['generation']='2'
    elif change=='manifest':bucket.json(prefix+'objects.json',[])
    elif change=='selection':
        path=kwargs['cv_directory']/'seed42-selection.json';path.write_bytes(b'{}')
    elif change=='panel':(kwargs['cv_directory']/'oof-panel.parquet').write_bytes(b'changed')
    else:
        path=prefix+'completed.json';result=json.loads(bucket.saved[path][0]);result['sealed_batch_id']='c'*64
        bucket.json(path,result)
    with pytest.raises((ValueError,AssertionError)):collect_final(bucket,**kwargs)
    assert not kwargs['output'].exists()


@pytest.mark.parametrize('source',['report','calibration'])
def test_other_oof_source_rejected_even_with_consistent_checksums(tmp_path,source):
    bucket,kwargs=setup(tmp_path)
    cv=kwargs['cv_directory']
    report=json.loads((cv/'inner-validation.json').read_bytes())
    target=report if source=='report' else report['calibration']
    target['source_sha256']='f'*64
    report['calibration']=sealed({k:v for k,v in report['calibration'].items() if k!='checksum'})
    report=sealed({k:v for k,v in report.items() if k!='checksum'})
    (cv/'inner-validation.json').write_text(json.dumps(report),encoding='utf-8')
    collection=json.loads((cv/'receipt.json').read_bytes())
    collection.update(validation_report_checksum=report['checksum'],calibration_checksum=report['calibration']['checksum'])
    (cv/'receipt.json').write_text(json.dumps(sealed({k:v for k,v in collection.items() if k!='checksum'})),encoding='utf-8')
    with pytest.raises(ValueError,match='report_source_not_cv_panel'):
        collect_final(bucket,**kwargs)
    assert not kwargs['output'].exists()
