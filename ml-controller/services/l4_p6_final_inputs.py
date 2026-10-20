"""P6-a final-refit inputs from this batch's verified heldout partitions only.

This prepares CPU data and the serving pure p_loss head, not a neural fit.
No outer observations or old fixed parquet/checkpoint can be supplied.
"""
from datetime import datetime, timezone
from pathlib import Path
import hashlib
import io
import json
import numpy as np
import polars as pl
from services import l4_p6_recipe as recipe
from services import l4_p6_pure_head as pure
from services import l4_distribution as native
from services.l4_distribution_lifecycle import chronological_validation_blocks


def _sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _read_fold(directory, cutoff):
    directory=Path(directory)
    receipt=json.loads((directory/'receipt.json').read_bytes())
    if (receipt.get('recipe')!=recipe.RECIPE or receipt.get('requested_cutoff')!=cutoff.__dict__
            or receipt.get('checksum')!=native.digest({k:v for k,v in receipt.items() if k!='checksum'})
            or receipt.get('affected_train_rows')!=0 or receipt.get('affected_validation_rows')!=0):
        raise ValueError('p6_final_fold_receipt_invalid')
    required={'source.json','native-rows.parquet','arrays.npz','recipe.json','head-lineage.json',
        'train-rows.parquet','val-rows.parquet','train-pure-p-loss.parquet','val-pure-p-loss.parquet'}
    files=receipt.get('files_sha256') or {}
    if not required<=set(files):raise ValueError('p6_final_fold_files_incomplete')
    for name,checksum in files.items():
        if Path(name).name!=name or _sha(directory/name)!=checksum:
            raise ValueError('p6_final_fold_file_changed:'+name)
    source=json.loads((directory/'source.json').read_bytes())
    if (source.get('protocol')!=recipe.PROTOCOL or source.get('requested_cutoff')!=cutoff.__dict__
            or source.get('ancestry_checksum')!=receipt['ancestry_checksum']):
        raise ValueError('p6_final_fold_source_mismatch')
    days=receipt['partitions']['val']['dates']
    frame=pl.read_parquet(directory/'native-rows.parquet').filter(pl.col('date').is_in(days)).sort('date','symbol')
    target=pl.read_parquet(directory/'val-rows.parquet').sort('date','symbol')
    probability=pl.read_parquet(directory/'val-pure-p-loss.parquet').sort('date','symbol')
    if (frame.is_empty() or frame.height!=receipt['partitions']['val']['rows']
            or sorted(frame['date'].unique())!=sorted(days)
            or not frame.select('date','symbol').equals(target.select('date','symbol'))
            or not frame.select('date','symbol').equals(probability.select('date','symbol'))
            or not frame['gross_return'].equals(target['gross_return'])):
        raise ValueError('p6_final_heldout_rows_mismatch')
    for row in frame.select('date','label_known_date').iter_rows(named=True):
        if not cutoff.admits(row['date'],row['label_known_date']):raise ValueError('p6_final_row_after_cutoff')
    lineage=json.loads((directory/'head-lineage.json').read_bytes())
    for day in days:
        found=[r for r in lineage if r.get('date')==day]
        if len(found)!=1 or found[0].get('forbidden_label_ancestors')!=0:
            raise ValueError('p6_final_head_ancestry_missing')
        head=found[0]
        if head['source_file'] not in files or head['receipt']['label_known_at_max']>=day:
            raise ValueError('p6_final_head_not_causal')
    return receipt,frame,probability,source


def prepare_final(fold_directories, *, selections, cutoff, output):
    if len(fold_directories)!=recipe.PROTOCOL['folds']:
        raise ValueError('p6_final_four_folds_required')
    loaded=[_read_fold(d,cutoff) for d in fold_directories]
    folds={r['fold'] for r,_,_,_ in loaded}
    if folds!={1,2,3,4}:raise ValueError('p6_final_fold_identity_invalid')
    fold_checksums={str(r['fold']):r['checksum'] for r,_,_,_ in loaded}
    expected_batch=native.digest(dict(recipe=recipe.RECIPE,fold_receipt_checksums=fold_checksums,cutoff=cutoff.__dict__))
    if set(selections)!=set(recipe.PROTOCOL['seeds']):raise ValueError('p6_final_seed_roster_invalid')
    for seed,selection in selections.items():
        if (selection.get('seed')!=seed or selection.get('recipe')!=recipe.RECIPE
                or selection.get('fold_receipt_checksums')!=fold_checksums
                or selection.get('batch_id')!=expected_batch
                or selection.get('selection_target')!=recipe.PROTOCOL['selection_target']
                or selection.get('checksum')!=native.digest({k:v for k,v in selection.items() if k!='checksum'})):
            raise ValueError('p6_final_selection_binding_invalid')
        selected=selection.get('selected') or []
        if not 1<=len(selected)<=recipe.PROTOCOL['max_selected_members'] or any(
                not isinstance(k,list) or len(k)!=2 or any(type(v) is not int for v in k)
                or not 1<=k[0]<=recipe.PROTOCOL['max_epochs'] or not 0<=k[1]<recipe.PROTOCOL['member_count'] for k in selected):
            raise ValueError('p6_final_selected_members_invalid')
        if selection.get('refit_max_epoch')!=max(k[0] for k in selected):
            raise ValueError('p6_final_epoch_changed')
    frame=pl.concat([f for _,f,_,_ in loaded]).sort('date','symbol')
    probabilities=pl.concat([p for _,_,p,_ in loaded]).sort('date','symbol')
    if frame.unique(['date','symbol']).height!=frame.height:
        raise ValueError('p6_final_heldout_overlap')
    if not frame.select('date','symbol').equals(probabilities.select('date','symbol')):
        raise ValueError('p6_final_probability_alignment')
    rows=frame.to_dicts()
    x,final_recipe=recipe.matrix(rows,probabilities['p_loss'].to_numpy())
    target=recipe.targets(rows,training=True)
    directory=Path(output);directory.mkdir(parents=True,exist_ok=True)
    binding=dict(recipe=recipe.RECIPE,batch_id=expected_batch,fold_receipt_checksums=fold_checksums,
        selection_checksums={str(seed):s['checksum'] for seed,s in selections.items()},
        cutoff=cutoff.__dict__,rows_checksum=native.digest(rows),protocol=recipe.PROTOCOL)
    recipe._json(directory/'source.json',binding)
    recipe._parquet(directory/'crossfitted-native.parquet',frame)
    recipe._parquet(directory/'crossfitted-p-loss.parquet',probabilities)
    recipe._parquet(directory/'train-rows.parquet',target)
    arrays=io.BytesIO();np.savez_compressed(arrays,train_x=x,train_y=target['target'].to_numpy().astype(np.float32))
    recipe._write(directory/'arrays.npz',arrays.getvalue());recipe._json(directory/'recipe.json',final_recipe)
    # A serving head is fitted separately. It never replaces cross-fitted p_loss in train_x.
    head_path=directory/'frozen-p-loss.json'
    head_binding=dict(batch_id=expected_batch,native_sha256=_sha(directory/'crossfitted-native.parquet'),
        pure_head_source_sha256=_sha(Path(pure.__file__)),cutoff=cutoff.__dict__)
    if head_path.exists():
        saved=json.loads(head_path.read_bytes())
        if (saved.get('binding')!=head_binding or saved.get('checksum')!=native.digest({k:v for k,v in saved.items() if k!='checksum'})):
            raise ValueError('p6_final_serving_head_changed')
    else:
        head=pure.fit(pure.extract(rows),frame['gross_return'].to_numpy(),frame['date'].to_list(),
            frame['label_known_date'].to_list(),chronological_validation_blocks(rows))
        proof=cutoff.attest(component='p_loss_final',signals=frame['date'].to_list(),known_dates=frame['label_known_date'].to_list(),
            feature_vintage=[s['ancestry_checksum'] for _,_,_,s in loaded],ancestor_cutoff=max(frame['label_known_date']),
            trained_at=datetime.now(timezone.utc).isoformat())
        saved=dict(binding=head_binding,model=head,receipt=proof,training_head_replaced=False,outer_updates_allowed=False)
        recipe._json(head_path,{**saved,'checksum':native.digest(saved)})
    for seed,selection in selections.items():recipe._json(directory/f'seed{seed}-selection.json',selection)
    names=['source.json','crossfitted-native.parquet','crossfitted-p-loss.parquet','train-rows.parquet',
        'arrays.npz','recipe.json','frozen-p-loss.json',*[f'seed{s}-selection.json' for s in recipe.PROTOCOL['seeds']]]
    body=dict(schema_version='p6-final-refit-inputs-v1',recipe=recipe.RECIPE,batch_id=expected_batch,
        rows=len(rows),dates=sorted(frame['date'].unique()),feature_count=x.shape[1],
        signal_date_max=max(frame['date']),label_known_at_max=max(frame['label_known_date']),requested_cutoff=cutoff.__dict__,
        source_policy='this_batch_clean_heldout_partitions',training_p_loss='causal_crossfitted_not_final_head',
        fold_receipt_checksums=fold_checksums,files_sha256={n:_sha(directory/n) for n in names},
        epoch_reselection_allowed=False,outer_rows=0,neural_training_started=False,promoted=False)
    result={**body,'checksum':native.digest(body)}
    recipe._json(directory/'receipt.json',result)
    return result
