"""P6 CV -> fixed final inputs -> validated candidate, with immutable receipts."""
from datetime import datetime,timezone
from pathlib import Path,PurePosixPath
import hashlib,io,json,tempfile,zipfile
from services.l4_distribution import digest
from services.l4_p6_recipe import RECIPE,PROTOCOL
from services.l4_p6_dispatch import put,read
from services.l4_p6_results import _read,collect_cv,collect_final
from services.training_dual_cutoff import TrainingCutoff


def extract(raw,root):
    root=Path(root)
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        names=archive.namelist()
        if len(names)!=len(set(names)):raise ValueError('p6_collect_duplicate_archive_member')
        for info in archive.infolist():
            name=info.orig_filename;p=PurePosixPath(name)
            if (p.is_absolute() or '..' in p.parts or '\\' in name or ':' in name or '\x00' in name
                    or ((info.external_attr>>16)&0o170000)==0o120000):
                raise ValueError('p6_collect_unsafe_archive')
        archive.extractall(root)


def archive_directory(directory):
    stream=io.BytesIO()
    with zipfile.ZipFile(stream,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=1) as archive:
        for p in sorted(Path(directory).rglob('*')):
            if p.is_symlink():raise ValueError('p6_collect_symlink')
            if p.is_file():
                info=zipfile.ZipInfo(p.relative_to(directory).as_posix());info.compress_type=zipfile.ZIP_DEFLATED
                archive.writestr(info,p.read_bytes())
    return stream.getvalue()


def upload(bucket,path,raw):
    from google.api_core.exceptions import PreconditionFailed
    blob=bucket.blob(path);sha=hashlib.sha256(raw).hexdigest();blob.metadata={'sha256':sha}
    try:blob.upload_from_string(raw,if_generation_match=0)
    except PreconditionFailed:pass
    loaded,ref=_read(bucket,path)
    if loaded!=raw:raise ValueError('p6_collection_immutable_conflict')
    return ref


def claim(bucket,path):
    from google.api_core.exceptions import PreconditionFailed
    blob=bucket.blob(path)
    raw=json.dumps(dict(created_at=datetime.now(timezone.utc).isoformat())).encode()
    blob.metadata={'sha256':hashlib.sha256(raw).hexdigest()}
    try:blob.upload_from_string(raw,if_generation_match=0)
    except PreconditionFailed:raise ValueError('p6_collection_claim_requires_recovery') from None


def prepare_final_phase(bucket,source,root):
    from services.l4_p6_final_inputs import prepare_final
    prior=read(bucket,root+'final-source.json')
    if prior:return prior
    rejected=read(bucket,root+'B-gate-not-passed.json')
    if rejected:return rejected
    claim(bucket,root+'prepare-final-claim.json')
    with tempfile.TemporaryDirectory(prefix='p6-cv-collect-') as temp:
        temp=Path(temp);folds=temp/'folds';results=temp/'cv';final=temp/'final'
        ref=source['cv_phase']['inputs'];raw,_=_read(bucket,ref['path'],ref)
        extract(raw,folds);seal=json.loads((folds/'batch-seal.json').read_bytes())
        cutoff=TrainingCutoff(**source['requested_cutoff'])
        receipt,selections,calibration=collect_cv(bucket,[folds/str(f) for f in (1,2,3,4)],
            sealed_batch_id=source['cv_phase']['batch_id'],cutoff=cutoff,output=results)
        report=json.loads((results/'inner-validation.json').read_bytes())
        cv_ref=upload(bucket,root+'cv-collection.zip',archive_directory(results))
        if report['champion_B_gate']['status']!='pass':
            return put(bucket,root+'B-gate-not-passed.json',dict(status='needs_user_decision',
                stage='R32_B_gate',run_key=source['run_key'],model_family='p6_a',training_recipe=RECIPE,
                cv_collection=cv_ref,gate=report['champion_B_gate'],dependency_retry_required=False,
                final_training_dispatched=False,promoted=False))
        final_receipt=prepare_final([folds/str(f) for f in (1,2,3,4)],selections=selections,cutoff=cutoff,output=final)
        # Preserve the exact CV code and vendor pins; change only phase and data.
        # Final epoch/member recipes are the CV selections, never newly selected.
        body={k:v for k,v in seal.items() if k not in ('batch_id','phase','files_sha256')}
        body.update(phase='final',files_sha256={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(final.iterdir())})
        if (seal['recipe']!=RECIPE or seal['protocol']!=PROTOCOL
                or set(body['files_sha256'])!=set(final_receipt['files_sha256'])|{'receipt.json'}):
            raise ValueError('p6_final_sealed_protocol_mismatch')
        final_seal={**body,'batch_id':digest(body)}
        (final/'batch-seal.json').write_bytes(json.dumps(final_seal,sort_keys=True).encode())
        final_ref=upload(bucket,f"l4_distribution/p6_batches/{final_seal['batch_id']}/inputs.zip",archive_directory(final))
        result=dict(run_key=source['run_key'],cv_batch_id=source['cv_phase']['batch_id'],
            cv_collection_checksum=receipt['checksum'],cv_collection=cv_ref,
            requested_cutoff=source['requested_cutoff'],l3_identity=source['l3_identity'],
            first_evaluation_signal_date=source['first_evaluation_signal_date'],epoch_reselection_allowed=False,
            final_phase=dict(recipe=RECIPE,phase='final',batch_id=final_seal['batch_id'],inputs=final_ref))
        return put(bucket,root+'final-source.json',result)


def finalize_candidate(bucket,source,final,root):
    prior=read(bucket,root+'completed.json')
    if prior:return prior
    claim(bucket,root+'collect-final-claim.json')
    with tempfile.TemporaryDirectory(prefix='p6-final-collect-') as temp:
        temp=Path(temp);cv=temp/'cv';inputs=temp/'inputs';output=temp/'candidate'
        ref=final['cv_collection'];raw,_=_read(bucket,ref['path'],ref);extract(raw,cv)
        ref=final['final_phase']['inputs'];raw,_=_read(bucket,ref['path'],ref);extract(raw,inputs)
        if json.loads((cv/'receipt.json').read_bytes())['checksum']!=final['cv_collection_checksum']:
            raise ValueError('p6_monthly_cv_collection_changed')
        candidate,receipt=collect_final(bucket,sealed_batch_id=final['final_phase']['batch_id'],
            final_directory=inputs,cv_directory=cv,l3_identity=source['l3_identity'],
            l3_training_label_known_max=source['l3_training_label_known_max'],calibration_kind='linear',
            signal_date=source['first_evaluation_signal_date'],output=output)
        candidate.update(cadence=source['cadence'],challenger_training_source={k:source[k] for k in
            ('run_key','as_of','source_manifest_checksum','first_evaluation_signal_date')},
            training_source=dict(source_manifest_checksum=source['source_manifest_checksum']),
            collection_receipt_checksum=receipt['checksum'])
        reference=upload(bucket,root+'candidate.json',json.dumps(candidate,sort_keys=True,allow_nan=False).encode())
        put(bucket,root+'collection-receipt.json',receipt)
        return put(bucket,root+'completed.json',dict(status='validated',model_family='p6_a',training_recipe=RECIPE,
            run_key=source['run_key'],artifact_path=reference['path'],artifact_reference=reference,
            artifact_checksum=digest(candidate),promoted=False,dependency_retry_required=False,
            collection_receipt_checksum=receipt['checksum']))
