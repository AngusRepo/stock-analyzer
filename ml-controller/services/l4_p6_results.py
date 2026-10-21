"""Read three completed CV seeds against this batch's four heldout partitions.

No remote mutations, fit, fallback to historical files or model registration.
"""
import hashlib
import io
import json
from pathlib import Path
import numpy as np
import polars as pl
from services import l4_p6_recipe as recipe
from services.l4_p6_final_inputs import _read_fold
from services.l4_p6_validation import inner_report
from services.l4_distribution import digest


def _read(bucket, path, reference=None):
    blob=bucket.get_blob(path)
    if blob is None:raise ValueError('p6_cv_result_missing:'+path)
    raw=blob.download_as_bytes(if_generation_match=blob.generation)
    actual=hashlib.sha256(raw).hexdigest()
    if actual!=(blob.metadata or {}).get('sha256'):raise ValueError('p6_cv_result_checksum')
    if reference is not None and (reference.get('path')!=path or reference.get('sha256')!=actual
            or reference.get('bytes')!=len(raw) or str(reference.get('generation'))!=str(blob.generation)):
        raise ValueError('p6_cv_object_reference_changed')
    return raw,dict(path=path,sha256=actual,bytes=len(raw),generation=str(blob.generation))


def collect_cv(bucket, fold_directories, *, sealed_batch_id, cutoff, output):
    if len(sealed_batch_id)!=64 or any(c not in '0123456789abcdef' for c in sealed_batch_id):
        raise ValueError('p6_cv_batch_id_invalid')
    loaded=[_read_fold(d,cutoff) for d in fold_directories]
    if [r['fold'] for r,_,_,_ in loaded]!=[1,2,3,4]:raise ValueError('p6_cv_four_ordered_folds_required')
    hashes={str(r['fold']):r['checksum'] for r,_,_,_ in loaded}
    identity=digest(dict(recipe=recipe.RECIPE,fold_receipt_checksums=hashes,cutoff=cutoff.__dict__))
    # Fold-specific ancestry metadata is verified by _read_fold, but is not
    # part of prediction/label alignment. Project before concatenating so its
    # nested Struct field order cannot change the result-reader schema.
    frame=pl.concat([f.select('date','symbol','gross_return','label_known_date') for _,f,_,_ in loaded])
    if frame.unique(['date','symbol']).height!=frame.height:raise ValueError('p6_cv_duplicate_heldout')
    targets=pl.concat([pl.read_parquet(Path(d)/'val-rows.parquet') for d in fold_directories])
    if not targets.select('date','symbol').equals(frame.select('date','symbol')):
        raise ValueError('p6_cv_partition_order_changed')
    predictions=[];selections={};proofs=[]
    for seed in recipe.PROTOCOL['seeds']:
        prefix=f'l4_distribution/p6_batches/{sealed_batch_id}/cv/seed{seed}/'
        raw,proof=_read(bucket,prefix+'completed.json');result=json.loads(raw);proofs.append(proof)
        if (result.get('schema_version')!='p6-seed-result-v1' or result.get('recipe')!=recipe.RECIPE
                or result.get('sealed_batch_id')!=sealed_batch_id or result.get('seed')!=seed or result.get('phase')!='cv'
                or result.get('training_completed') is not True or result.get('promoted') is not False
                or result.get('outer_rows')!=0 or not result.get('checkpoint_restoration')
                or any(x.get('training_steps')!=0 for x in result['checkpoint_restoration'])
                or {x.get('fold') for x in result['checkpoint_restoration']}!={1,2,3,4}):
            raise ValueError('p6_cv_completion_invalid')
        selection=result['selection']
        if (selection.get('checksum')!=digest({k:v for k,v in selection.items() if k!='checksum'})
                or selection.get('seed')!=seed or selection.get('recipe')!=recipe.RECIPE
                or selection.get('batch_id')!=identity or selection.get('fold_receipt_checksums')!=hashes
                or selection.get('selection_target')!=recipe.PROTOCOL['selection_target']):
            raise ValueError('p6_cv_selection_identity')
        selections[seed]=selection
        raw,proof=_read(bucket,prefix+'objects.json');objects=json.loads(raw);proofs.append(proof)
        refs=[r for r in objects if r.get('path')==prefix+'selected-validation.npz']
        if len(refs)!=1:raise ValueError('p6_cv_prediction_reference_missing')
        raw,proof=_read(bucket,refs[0]['path'],refs[0]);proofs.append(proof)
        with np.load(io.BytesIO(raw),allow_pickle=False) as saved:
            expected={'dates':frame['date'].to_numpy(),'symbols':frame['symbol'].to_numpy(),
                'gross_return':frame['gross_return'].to_numpy(),
                'relative_return':targets['relative_return'].to_numpy()}
            if set(saved.files)!=set(expected)|{'prediction'}:raise ValueError('p6_cv_prediction_fields')
            for name,value in expected.items():
                if not np.array_equal(saved[name],value):raise ValueError('p6_cv_row_or_target_changed:'+name)
            prediction=saved['prediction']
            if prediction.shape!=(frame.height,) or not np.isfinite(prediction).all():raise ValueError('p6_cv_prediction_invalid')
            predictions.append(prediction.copy())
    frame=frame.with_columns(pl.Series('score',np.median(np.stack(predictions),axis=0)),pl.lit('oof').alias('prediction_kind')).sort('date','symbol')
    buffer=io.BytesIO();frame.write_parquet(buffer);panel=buffer.getvalue()
    report=inner_report(frame,source_sha256=hashlib.sha256(panel).hexdigest(),cutoff=cutoff,
        expected_keys_checksum=digest(frame.select('date','symbol').to_dicts()))
    calibration=report['calibration']
    receipt=dict(schema_version='p6-cv-collection-v1',sealed_batch_id=sealed_batch_id,input_identity=identity,
        fold_receipt_checksums=hashes,source_objects=proofs,requested_cutoff=cutoff.__dict__,rows=frame.height,
        dates=sorted(frame['date'].unique()),panel_sha256=hashlib.sha256(panel).hexdigest(),
        calibration_checksum=calibration['checksum'],validation_report_checksum=report['checksum'],selection_checksums={str(s):v['checksum'] for s,v in selections.items()},
        evidence_scope='inner_development_only',outer_rows=0,promoted=False)
    receipt={**receipt,'checksum':digest(receipt)}
    directory=Path(output);directory.mkdir(parents=True,exist_ok=True)
    recipe._write(directory/'oof-panel.parquet',panel);recipe._json(directory/'calibration.json',calibration)
    for seed,selection in selections.items():recipe._json(directory/f'seed{seed}-selection.json',selection)
    recipe._json(directory/'inner-validation.json',report)
    recipe._json(directory/'receipt.json',receipt)
    return receipt,selections,calibration


def collect_final(bucket, *, sealed_batch_id, final_directory, cv_directory,
                  l3_identity, l3_training_label_known_max, calibration_kind,
                  signal_date, output):
    """Read authenticated final outputs and construct an unreleased candidate.

    All remote reads are generation-bound; local selections must be the exact
    files used for final refit and the exact selections returned by this CV.
    """
    from services.l4_p6_bundle import assemble
    if len(sealed_batch_id)!=64 or any(c not in '0123456789abcdef' for c in sealed_batch_id):
        raise ValueError('p6_final_batch_id_invalid')
    source=Path(final_directory);cv=Path(cv_directory)
    final=json.loads((source/'receipt.json').read_bytes())
    collection=json.loads((cv/'receipt.json').read_bytes())
    report=json.loads((cv/'inner-validation.json').read_bytes())
    if (collection.get('schema_version')!='p6-cv-collection-v1'
            or collection.get('checksum')!=digest({k:v for k,v in collection.items() if k!='checksum'})
            or collection.get('input_identity')!=final['batch_id']
            or collection.get('fold_receipt_checksums')!=final['fold_receipt_checksums']
            or collection.get('requested_cutoff')!=final['requested_cutoff']
            or collection.get('validation_report_checksum')!=report.get('checksum')
            or collection.get('calibration_checksum')!=report['calibration']['checksum']
            or collection.get('evidence_scope')!='inner_development_only'
            or collection.get('outer_rows')!=0 or collection.get('promoted') is not False):
        raise ValueError('p6_final_cv_collection_binding')
    # Include the OOF panel itself, not just a self-consistent report checksum.
    panel=(cv/'oof-panel.parquet').read_bytes()
    if hashlib.sha256(panel).hexdigest()!=collection['panel_sha256']:
        raise ValueError('p6_final_cv_panel_changed')
    if (report.get('source_sha256')!=collection['panel_sha256']
            or report['calibration'].get('source_sha256')!=collection['panel_sha256']):
        raise ValueError('p6_final_report_source_not_cv_panel')
    def local(name):
        raw=(source/name).read_bytes()
        if hashlib.sha256(raw).hexdigest()!=final['files_sha256'][name]:
            raise ValueError('p6_final_input_file_changed:'+name)
        return raw
    headraw=local('frozen-p-loss.json');selections={}
    for seed in recipe.PROTOCOL['seeds']:
        name=f'seed{seed}-selection.json';raw=local(name)
        if raw!=(cv/name).read_bytes():raise ValueError('p6_final_selection_not_cv')
        selections[seed]=json.loads(raw)
        if selections[seed]['checksum']!=collection['selection_checksums'][str(seed)]:
            raise ValueError('p6_final_cv_selection_checksum')
    proofs=[];results=[];weights={}
    for seed in recipe.PROTOCOL['seeds']:
        prefix=f'l4_distribution/p6_batches/{sealed_batch_id}/final/seed{seed}/'
        raw,proof=_read(bucket,prefix+'completed.json');result=json.loads(raw);proofs.append(proof)
        if (result.get('schema_version')!='p6-seed-result-v1' or result.get('sealed_batch_id')!=sealed_batch_id
                or result.get('seed')!=seed or result.get('phase')!='final'):
            raise ValueError('p6_final_completion_identity')
        raw,proof=_read(bucket,prefix+'objects.json');objects=json.loads(raw);proofs.append(proof)
        refs=[r for r in objects if r.get('path')==prefix+'weights.npz']
        if len(refs)!=1 or refs[0]!=result['weights']:
            raise ValueError('p6_final_weight_reference_mismatch')
        raw,proof=_read(bucket,refs[0]['path'],refs[0]);proofs.append(proof)
        weights[refs[0]['path']]=raw;results.append(result)
    bundle=assemble(results=results,final_receipt=final,frozen_p_loss=json.loads(headraw),
        frozen_p_loss_raw=headraw,inner_report=report,selections=selections,l3_identity=l3_identity,
        l3_training_label_known_max=l3_training_label_known_max,calibration_kind=calibration_kind,
        signal_date=signal_date,load_bytes=lambda ref:weights[ref['path']])
    receipt=dict(schema_version='p6-final-collection-v1',sealed_batch_id=sealed_batch_id,
        source_objects=proofs,final_input_receipt_checksum=final['checksum'],
        cv_collection_checksum=collection['checksum'],model_checksum=bundle['model_checksum'],
        bundle_checksum=digest(bundle),l3_identity=l3_identity,calibration_kind=calibration_kind,
        checkpoint_bytes_verified=True,outer_rows=0,promoted=False)
    receipt={**receipt,'checksum':digest(receipt)}
    directory=Path(output);directory.mkdir(parents=True,exist_ok=True)
    recipe._json(directory/'candidate.json',bundle);recipe._json(directory/'receipt.json',receipt)
    return bundle,receipt
