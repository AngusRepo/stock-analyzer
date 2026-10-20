"""P6-a GPU engine. Separate CV and fixed-epoch final refit; no publication."""
import argparse
from collections import Counter
from datetime import date, datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import sys
import time
import numpy as np
import polars as pl
import torch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'r2_engine'))
from r2_train import Pack, Archive, fixed_configs, numpy_member, sha, canonical
from r2_selection import greedy
RECIPE='p6-a-direct-excess-pure8-ploss-fourfold-v1'


def digest(value):return hashlib.sha256(canonical(value)).hexdigest()


def checked_file(root, name):
    path=Path(name)
    base=Path(root).resolve()
    if (not name or path.is_absolute() or '..' in path.parts or '\\' in name or ':' in name
            or not (base/path).resolve().is_relative_to(base) or not (base/path).is_file()):
        raise ValueError('p6_unsafe_or_missing_file:'+name)
    return base/path


def verify_files(root, files, required):
    if not isinstance(files,dict) or not required<=set(files):raise ValueError('p6_input_files_incomplete')
    for name,checksum in files.items():
        if sha(checked_file(root,name))!=checksum:raise ValueError('p6_input_file_changed:'+name)


def verify_selection(selection, receipt, seed):
    if (selection.get('checksum')!=digest({k:v for k,v in selection.items() if k!='checksum'})
            or selection.get('recipe')!=RECIPE or selection.get('batch_id')!=receipt['batch_id']
            or selection.get('seed')!=seed
            or selection.get('fold_receipt_checksums')!=receipt['fold_receipt_checksums']
            or selection.get('selection_target')!='actual_pool_relative_return_daily_equal_rank_IC'):
        raise ValueError('p6_final_selection_identity')
    selected=selection.get('selected') or []
    if not 1<=len(selected)<=32 or any(not isinstance(k,list) or len(k)!=2
            or any(type(v) is not int for v in k) or not 1<=k[0]<=200 or not 0<=k[1]<16 for k in selected):
        raise ValueError('p6_selected_members_invalid')
    if selection.get('refit_max_epoch')!=max(e for e,_ in selected):raise ValueError('p6_final_epoch_changed')
    return [tuple(k) for k in selected]


def verify_inputs(root, seed, phase):
    root=Path(root)
    if seed not in (42,43,44) or phase not in ('cv','final'):raise ValueError('p6_job_recipe_invalid')
    seal=json.loads((root/'batch-seal.json').read_bytes())
    if seal.get('batch_id')!=digest({k:v for k,v in seal.items() if k!='batch_id'}):raise ValueError('p6_seal_invalid')
    if seal.get('recipe')!=RECIPE or seal.get('phase')!=phase:raise ValueError('p6_seal_phase_mismatch')
    expected={'p6_train.py':Path(__file__),'r2_train.py':Path(__file__).resolve().parents[1]/'r2_engine/r2_train.py',
        'r2_selection.py':Path(__file__).resolve().parents[1]/'r2_engine/r2_selection.py'}
    if set(seal.get('code_sha256',{}))!=set(expected):raise ValueError('p6_engine_sources_incomplete')
    for name,path in expected.items():
        if sha(path)!=seal['code_sha256'][name]:raise ValueError('p6_engine_source_changed:'+name)
    required={f'{f}/{n}' for f in range(1,5) for n in ('receipt.json','arrays.npz','val-rows.parquet')} if phase=='cv' else {
        'receipt.json','arrays.npz','recipe.json',*[f'seed{s}-selection.json' for s in (42,43,44)]}
    verify_files(root,seal.get('files_sha256'),required)
    actual={p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file()}-{'batch-seal.json'}
    if actual!=set(seal['files_sha256']):raise ValueError('p6_unsealed_input_files')
    if not seal.get('upstream_files'):raise ValueError('p6_upstream_source_missing')
    verify_files(Path('/opt/tabpack'),seal['upstream_files'],set())
    return seal


def arrays_at(root, phase):
    with np.load(Path(root)/'arrays.npz',allow_pickle=False) as data:arrays={k:data[k] for k in data.files}
    roles=('train','val') if phase=='cv' else ('train',)
    if set(arrays)!={r+s for r in roles for s in ('_x','_y')}:raise ValueError('p6_array_roles_invalid')
    for role in roles:
        x,y=arrays[role+'_x'],arrays[role+'_y']
        if x.ndim!=2 or x.shape[1]!=31 or not len(x) or y.shape!=(len(x),) or not np.isfinite(x).all() or not np.isfinite(y).all():
            raise ValueError('p6_array_shape_or_value_invalid')
    return arrays


def export_member(pack, member):
    # Same upstream layers as R16; the retired R2 34-column exporter is never called.
    state=pack.model.state_dict();depth=int(state['backbone.n_blocks'][member].item());arrays={}
    for j,name in enumerate([f'backbone.blocks.{b}.linear' for b in range(depth)]+['output']):
        weight=state[name+'.weight'][member].detach().float().cpu().numpy().T.copy()
        if j==0:
            expanded=np.zeros((31,weight.shape[1]),np.float32);expanded[pack.indices]=weight;weight=expanded
        arrays[f'l{j}_weight']=weight
        arrays[f'l{j}_bias']=state[name+'.bias'][member].detach().float().cpu().numpy().reshape(-1).copy()
    return depth,arrays


def read(archive,name):
    blob=archive.bucket.get_blob(archive.prefix+name)
    if blob is None:raise ValueError('p6_checkpoint_missing:'+name)
    raw=blob.download_as_bytes(if_generation_match=blob.generation)
    if hashlib.sha256(raw).hexdigest()!=(blob.metadata or {}).get('sha256'):raise ValueError('p6_checkpoint_checksum:'+name)
    return raw


def restore(pack,raw,epoch):
    # Only freshly written, checksum-verified checkpoints from this sealed run.
    state=torch.load(io.BytesIO(raw),map_location=pack.x.device,weights_only=False)
    if state['epoch']!=epoch or not state['optimizer']['state']:raise ValueError('p6_checkpoint_state_invalid')
    steps=pack.steps
    pack.model.load_state_dict(state['model'],strict=True);pack.optimizer.load_state_dict(state['optimizer'])
    if pack.steps!=steps:raise ValueError('p6_restore_trained_unexpectedly')


def cv(root, seed, archive, start):
    receipts=[];packs=[];validation=[];tables=[];configs=fixed_configs(seed)
    for fold in range(1,5):
        directory=root/str(fold);receipt=json.loads((directory/'receipt.json').read_bytes())
        if receipt.get('recipe')!=RECIPE or receipt.get('fold')!=fold or receipt.get('checksum')!=digest({k:v for k,v in receipt.items() if k!='checksum'}):
            raise ValueError('p6_cv_fold_receipt_invalid')
        if receipt.get('affected_train_rows')!=0 or receipt.get('affected_validation_rows')!=0:
            raise ValueError('p6_cv_ancestry_not_clean')
        verify_files(directory,receipt.get('files_sha256'),{'arrays.npz','val-rows.parquet','source.json','recipe.json','head-lineage.json'})
        receipts.append(receipt);arrays=arrays_at(directory,'cv')
        packs.append(Pack(arrays,configs,seed));validation.append(arrays['val_x'])
        table=pl.read_parquet(directory/'val-rows.parquet')
        if len(table)!=len(arrays['val_x']):raise ValueError('p6_cv_row_count_mismatch')
        tables.append(table)
    table=pl.concat(tables);dates=table['date'].to_numpy();target=table['relative_return'].to_numpy()
    if table.unique(['date','symbol']).height!=table.height:raise ValueError('p6_cv_duplicate_heldout')
    cutoffs=[r['requested_cutoff'] for r in receipts]
    if any(c!=cutoffs[0] for c in cutoffs):raise ValueError('p6_cv_cutoff_mismatch')
    hashes={str(r['fold']):r['checksum'] for r in receipts}
    input_id=digest(dict(recipe=RECIPE,fold_receipt_checksums=hashes,cutoff=cutoffs[0]))
    archive.json('launch.json',dict(recipe=RECIPE,phase='cv',seed=seed,configs=configs,input_id=input_id,max_epochs=200,patience=32))
    pool={};selected=[];best_score=-np.inf;best_epoch=0;chosen_prediction=None
    for epoch in range(1,201):
        if time.monotonic()-start>21000:raise TimeoutError('p6_cv_runtime_limit')
        predictions=[];losses=[]
        for fold,(pack,x) in enumerate(zip(packs,validation,strict=True),1):
            losses.append(pack.epoch());predictions.append(pack.predict(x))
            archive.state(f'cv/fold{fold}/epoch{epoch:03d}.pt',pack.model,pack.optimizer,epoch,pack.steps,pack.generator)
        combined=np.concatenate(predictions,axis=1);buffer=io.BytesIO();np.savez_compressed(buffer,predictions=combined)
        archive.put(f'cv/predictions/epoch{epoch:03d}.npz',buffer.getvalue())
        for member in range(16):pool[(epoch,member)]=combined[member]
        proposed,prediction,score=greedy(pool,target,dates)
        if score>best_score+1e-12:selected=proposed;chosen_prediction=prediction.copy();best_score=score;best_epoch=epoch
        pool={key:pool[key] for key in set(selected)}
        archive.json(f'events/epoch{epoch:03d}.json',dict(epoch=epoch,losses=losses,rank_ic=best_score,selected=selected))
        print(json.dumps(dict(phase='cv',seed=seed,epoch=epoch,best_epoch=best_epoch,rank_ic=best_score)),flush=True)
        if epoch-best_epoch>=32:break
    body=dict(seed=seed,recipe=RECIPE,batch_id=input_id,fold_receipt_checksums=hashes,
        selection_target='actual_pool_relative_return_daily_equal_rank_IC',selected=selected,score=best_score,
        best_epoch=best_epoch,stop_epoch=epoch,refit_max_epoch=max(k[0] for k in selected),scope='inner_development')
    selection={**body,'checksum':digest(body)};archive.json('selection.json',selection)
    offset=0;checks=[];reconstructed=[];counts=Counter(selected)
    # Read back every selected CV epoch; no optimizer step is permitted here.
    for fold,(pack,x) in enumerate(zip(packs,validation,strict=True),1):
        aggregate=np.zeros(len(x),np.float64)
        for chosen_epoch in sorted({e for e,_ in selected}):
            restore(pack,read(archive,f'cv/fold{fold}/epoch{chosen_epoch:03d}.pt'),chosen_epoch)
            actual=pack.predict(x)
            with np.load(io.BytesIO(read(archive,f'cv/predictions/epoch{chosen_epoch:03d}.npz')),allow_pickle=False) as values:
                expected=values['predictions'][:,offset:offset+len(x)]
            np.testing.assert_allclose(actual,expected,rtol=2e-5,atol=2e-6)
            checks.append(dict(fold=fold,epoch=chosen_epoch,max_error=float(np.max(abs(actual-expected))),training_steps=0))
            for (e,member),count in counts.items():
                if e==chosen_epoch:aggregate+=actual[member]*count/len(selected)
        reconstructed.append(aggregate);offset+=len(x)
    np.testing.assert_allclose(np.concatenate(reconstructed),chosen_prediction,rtol=2e-5,atol=2e-6)
    buffer=io.BytesIO();np.savez_compressed(buffer,prediction=chosen_prediction,dates=dates.astype(str),
        symbols=table['symbol'].to_numpy().astype(str),gross_return=table['gross_return'].to_numpy(),relative_return=target)
    archive.put('selected-validation.npz',buffer.getvalue())
    return dict(phase='cv',selection=selection,checkpoint_restoration=checks,training_completed=True,outer_rows=0,promoted=False)


def final_lineage(root, receipt, selection):
    bounds=receipt['requested_cutoff']
    signal=receipt['signal_date_max'];known=receipt['label_known_at_max']
    for value in (signal,known,bounds['signal_date_max'],bounds['label_known_at_max']):
        if date.fromisoformat(value).isoformat()!=value:raise ValueError('p6_final_cutoff_date_invalid')
    if (not signal<known or signal>bounds['signal_date_max'] or known>bounds['label_known_at_max']
            or not bounds['signal_date_max']<bounds['label_known_at_max']):
        raise ValueError('p6_final_training_after_cutoff')
    return dict(input_receipt_checksum=receipt['checksum'],input_receipt_sha256=sha(root/'receipt.json'),
        selection_checksum=selection['checksum'],signal_date_max=signal,label_known_at_max=known,
        requested_cutoff=bounds,fold_receipt_checksums=receipt['fold_receipt_checksums'],
        frozen_p_loss_sha256=receipt['files_sha256']['frozen-p-loss.json'],
        source_sha256=receipt['files_sha256']['source.json'])


def final(root,seed,archive,start):
    receipt=json.loads((root/'receipt.json').read_bytes())
    if receipt.get('schema_version')!='p6-final-refit-inputs-v1' or receipt.get('checksum')!=digest({k:v for k,v in receipt.items() if k!='checksum'}):
        raise ValueError('p6_final_receipt_invalid')
    if receipt.get('recipe')!=RECIPE or receipt.get('outer_rows')!=0 or receipt.get('epoch_reselection_allowed') is not False:
        raise ValueError('p6_final_recipe_invalid')
    verify_files(root,receipt.get('files_sha256'),{'arrays.npz','recipe.json','source.json','frozen-p-loss.json',f'seed{seed}-selection.json'})
    selection=json.loads((root/f'seed{seed}-selection.json').read_bytes())
    selected=verify_selection(selection,receipt,seed);lineage=final_lineage(root,receipt,selection);counts=Counter(selected)
    arrays=arrays_at(root,'final');configs=fixed_configs(seed);pack=Pack(arrays,configs,seed)
    archive.json('launch.json',dict(recipe=RECIPE,phase='final',seed=seed,configs=configs,selection_sha256=sha(root/f'seed{seed}-selection.json')))
    check_x=arrays['train_x'][np.linspace(0,len(arrays['train_x'])-1,min(2048,len(arrays['train_x'])),dtype=int)]
    exports={};members=[];checks=[]
    for epoch in range(1,selection['refit_max_epoch']+1):
        if time.monotonic()-start>21000:raise TimeoutError('p6_final_runtime_limit')
        loss=pack.epoch();archive.state(f'final/epoch{epoch:03d}.pt',pack.model,pack.optimizer,epoch,pack.steps,pack.generator)
        chosen=[k for k in sorted(counts) if k[0]==epoch]
        if chosen:
            expected=pack.predict(check_x);restore(pack,read(archive,f'final/epoch{epoch:03d}.pt'),epoch)
            np.testing.assert_array_equal(pack.predict(check_x),expected)
            for key in chosen:
                depth,weights=export_member(pack,key[1]);i=len(members)
                actual=numpy_member(check_x,depth,weights)*pack.scale+pack.mean
                np.testing.assert_allclose(actual,expected[key[1]],rtol=2e-5,atol=2e-6)
                checks.append(dict(member=list(key),max_error=float(np.max(abs(actual-expected[key[1]]))),training_steps=0))
                members.append(dict(member_id=key[1],epoch=epoch,depth=depth,weight=counts[key]/len(selected)))
                exports.update({f'm{i}_{name}':value for name,value in weights.items()})
        archive.json(f'events/epoch{epoch:03d}.json',dict(epoch=epoch,loss=loss))
    buffer=io.BytesIO();np.savez_compressed(buffer,**exports);weights=archive.put('weights.npz',buffer.getvalue())
    if hashlib.sha256(read(archive,'weights.npz')).hexdigest()!=weights['sha256']:raise ValueError('p6_final_export_readback')
    return dict(phase='final',training_lineage=lineage,members=members,weights=weights,final_recipe=json.loads((root/'recipe.json').read_bytes()),
        target_mean=pack.mean,target_scale=pack.scale,feature_indices=pack.indices.tolist(),checkpoint_restoration=checks,
        completed_epochs=selection['refit_max_epoch'],training_completed=True,outer_rows=0,promoted=False)


def run(root,seed,bucket,prefix,phase):
    from google.cloud import storage
    root=Path(root);started_at=datetime.now(timezone.utc).isoformat();start=time.monotonic();seal=verify_inputs(root,seed,phase)
    if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():raise ValueError('p6_native_bf16_required')
    torch.set_num_threads(8);torch.backends.cuda.matmul.allow_tf32=False
    archive=Archive(storage.Client().bucket(bucket),prefix,100*1024**3)
    result=(cv if phase=='cv' else final)(root,seed,archive,start)
    result.update(schema_version='p6-seed-result-v1',recipe=RECIPE,seed=seed,sealed_batch_id=seal['batch_id'],
        elapsed_seconds=time.monotonic()-start,stored_bytes=archive.total,training_started_at=started_at,
        training_completed_at=datetime.now(timezone.utc).isoformat(),engine_code_sha256=seal["code_sha256"])
    archive.json('objects.json',archive.objects);archive.json('completed.json',result)
    return result


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    for name in ('root','bucket','prefix','phase'):parser.add_argument('--'+name,required=True)
    parser.add_argument('--seed',required=True,type=int);a=parser.parse_args()
    print(json.dumps(run(a.root,a.seed,a.bucket,a.prefix,a.phase)),flush=True)
