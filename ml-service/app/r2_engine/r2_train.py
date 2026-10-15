"""Offline R2: upstream ModelPack/MuonAdamW, fixed members, four-fold IC selection.

Run only from the sealed Modal batch. All checkpoints are retained remotely;
no serving pointers, account writes, training retries, or dynamic restarts.
"""
from __future__ import annotations
import argparse
from collections import Counter
import hashlib
import io
import json
import os
from pathlib import Path
import time
import random
import numpy as np
import polars as pl
import torch
from r2_selection import daily_rank_ic,greedy

def sha(path):
    with Path(path).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()

def canonical(value):
    return json.dumps(value,sort_keys=True,separators=(',', ':'),allow_nan=False).encode()

class Archive:
    def __init__(self,bucket,prefix,limit):
        self.bucket,self.prefix,self.limit=bucket,prefix,limit
        self.total=0;self.objects=[]
    def put(self,name,raw):
        if self.total+len(raw)>self.limit:raise RuntimeError('checkpoint_storage_budget_exceeded')
        blob=self.bucket.blob(self.prefix+name)
        digest=hashlib.sha256(raw).hexdigest()
        blob.metadata={'sha256':digest}
        blob.upload_from_string(raw,if_generation_match=0,timeout=180)
        blob.reload(timeout=60)
        if blob.size!=len(raw) or blob.metadata.get('sha256')!=digest:raise ValueError('archive_readback_metadata_mismatch')
        self.total+=len(raw)
        ref=dict(path=blob.name,sha256=digest,bytes=len(raw),generation=str(blob.generation))
        self.objects.append(ref)
        return ref
    def json(self,name,value):return self.put(name,canonical(value))
    def state(self,name,model,optimizer,epoch,steps,generator):
        buffer=io.BytesIO()
        torch.save(dict(model=model.state_dict(),optimizer=optimizer.state_dict(),epoch=epoch,
            steps=steps,torch_rng=torch.get_rng_state(),cuda_rng=torch.cuda.get_rng_state_all(),
            batch_rng=generator.get_state(),numpy_rng=np.random.get_state(),python_rng=random.getstate()),buffer)
        return self.put(name,buffer.getvalue())

def fixed_configs(seed):
    import importlib.util
    import project.tabpack as upstream
    path=Path('/opt/tabpack/experiments/tabpack/make.py')
    spec=importlib.util.spec_from_file_location('r2_upstream_config',path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    # make_config resolves benchmark files; use its literal sampler space without
    # changing upstream code or requesting an unrelated benchmark dataset.
    import lib.config
    data,batch=lib.config.make_data_config,lib.config.get_batch_size
    try:
        lib.config.make_data_config=lambda *a,**k:{}
        lib.config.get_batch_size=lambda *a,**k:1024
        config=module.make_config('stockvision',seed=seed)
    finally:lib.config.make_data_config,lib.config.get_batch_size=data,batch
    sampler=upstream.HyperparameterSampler(seed=seed,**config['sampler'])
    return [sampler.ask(i) for i in range(16)]

class Pack:
    def __init__(self,arrays,configs,seed):
        import project.tabpack as up
        import lib.optim.utils
        torch.manual_seed(seed);torch.cuda.manual_seed_all(seed)
        x=np.asarray(arrays['train_x'],np.float32)
        self.indices=np.flatnonzero((x!=x[0]).any(axis=0))
        if not len(self.indices):raise ValueError('all_constant_training_features')
        self.mean=float(np.asarray(arrays['train_y'],np.float64).mean())
        self.scale=float(np.asarray(arrays['train_y'],np.float64).std())
        if self.scale<=1e-12:raise ValueError('invalid_target_scale')
        self.x=torch.from_numpy(x[:,self.indices]).cuda()
        self.y=torch.from_numpy(((arrays['train_y']-self.mean)/self.scale).astype(np.float32)).cuda()
        self.model=up.ModelPack(n_num_features=len(self.indices),cat_cardinalities=[],n_classes=None,
            pack_size=16,n_blocks=[c['model']['n_blocks'] for c in configs],max_n_blocks=4,
            d_block=384,activation='ReLU',dropout=[c['model']['dropout'] for c in configs]).cuda()
        groups=[{'params':[block.linear.weight],'muon':True,'muon_scale':up._make_muon_scale(block.linear)}
            for block in self.model.backbone._iter_blocks()]
        self.optimizer=up._make_optimizer(type='MuonAdamWPack',pack_size=16,shared_step=True,
            params=lib.optim.utils.make_parameter_groups(self.model,up._default_zero_weight_decay_condition,custom_groups=groups),
            **{k:[c['optimizer'][k] for c in configs] for k in ('lr','weight_decay','muon_lr')})
        self.generator=torch.Generator(device='cuda');self.generator.manual_seed(seed)
        self.steps=0
    def epoch(self):
        import project.tabpack as up
        self.model.train();losses=[]
        for ids in up.generate_training_batches(train_size=len(self.x),batch_size=1024,batch_generator=self.generator,pack_size=16):
            self.optimizer.zero_grad()
            with torch.autocast('cuda',dtype=torch.bfloat16):prediction=self.model(self.x[ids],None).squeeze(-1).float()
            per_member=((prediction-self.y[ids])**2).mean(dim=1)
            loss=per_member.sum()
            if not torch.isfinite(loss):raise ValueError('nonfinite_training_loss')
            loss.backward();self.optimizer.step();self.steps+=1
            losses.append(float(loss.detach())/16)
        return float(np.mean(losses))
    def predict(self,values):
        self.model.eval();outputs=[]
        with torch.no_grad():
            for start in range(0,len(values),1024):
                x=torch.from_numpy(np.asarray(values[start:start+1024,self.indices],np.float32)).cuda()
                outputs.append(self.model(x,None).squeeze(-1).float().cpu().numpy()*self.scale+self.mean)
        result=np.concatenate(outputs,axis=1)
        if not np.isfinite(result).all():raise ValueError('nonfinite_validation_predictions')
        return result

def export_member(pack,member):
    state=pack.model.state_dict();depth=int(state['backbone.n_blocks'][member].item());arrays={}
    for j,name in enumerate([f'backbone.blocks.{b}.linear' for b in range(depth)]+['output']):
        weight=state[name+'.weight'][member].detach().float().cpu().numpy().T.copy()
        if j==0:
            expanded=np.zeros((34,384),np.float32);expanded[pack.indices]=weight;weight=expanded
        arrays[f'l{j}_weight']=weight
        arrays[f'l{j}_bias']=state[name+'.bias'][member].detach().float().cpu().numpy().reshape(-1).copy()
    return depth,arrays

def numpy_member(x,depth,arrays):
    x=np.asarray(x,np.float32)
    for i in range(depth+1):
        x=x@arrays[f'l{i}_weight']+arrays[f'l{i}_bias']
        if i<depth:x=np.maximum(x,0)
    return x[:,0]

def run(root,seed,bucket,prefix,*,max_epochs=200,patience=32):
    from google.cloud import storage
    root=Path(root);start=time.monotonic()
    if seed not in (42,43,44) or max_epochs!=200 or patience!=32:raise ValueError('unsealed_recipe')
    if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():raise ValueError('native_bf16_gpu_required')
    torch.set_num_threads(8)
    # Match validation/export arithmetic, independent of BF16 training autocast.
    torch.backends.cuda.matmul.allow_tf32=False
    archive=Archive(storage.Client().bucket(bucket),prefix,100*1024**3)
    manifest=json.loads((root/'matrices-manifest.json').read_bytes())
    if manifest['training_ready'] is not True:raise ValueError('matrices_not_ready')
    seal=json.loads((root/'batch-seal.json').read_bytes())
    for name,digest in seal['protocol']['code_sha256'].items():
        if name in ('r2_train.py','r2_selection.py') and sha(Path(__file__).parent/name)!=digest:
            raise ValueError('remote_code_mismatch:'+name)
    upstream=Path('/opt/tabpack')
    for name,digest in seal['protocol']['upstream_files'].items():
        if sha(upstream/name)!=digest:raise ValueError('upstream_source_mismatch:'+name)
    for record in seal['input_files']:
        if sha(root/record['path'])!=record['sha256']:raise ValueError('sealed_input_mismatch:'+record['path'])
    for f in manifest['folds']:
        directory=root/f['fold']
        for file,key in [('arrays.npz','arrays_sha256'),('recipe.json','recipe_sha256'),('head-lineage.json','head_lineage_sha256')]:
            if sha(directory/file)!=f[key]:raise ValueError('matrix_receipt_mismatch')
    configs=fixed_configs(seed)
    archive.json('launch.json',dict(seed=seed,matrices_sha256=sha(root/'matrices-manifest.json'),
        configs=configs,max_epochs=max_epochs,patience=patience,storage_limit_bytes=archive.limit,
        selection='crossfold_daily_equal_rank_ic_online_greedy_latest_plus_selected_max32',
        target='pool_relative_residual_train_daily_linear_p01_p99_only',
        precision='BF16_train_FP32_validation_and_export',member_restart=False,
        fold_order=[1,2,3,4],gpu=torch.cuda.get_device_name(0),torch_version=torch.__version__))
    packs=[];validation=[];tables=[]
    for fold in range(1,5):
        with np.load(root/str(fold)/'arrays.npz',allow_pickle=False) as data:arrays={k:data[k] for k in data.files}
        packs.append(Pack(arrays,configs,seed));validation.append(arrays['val_x'])
        tables.append(pl.read_parquet(root/str(fold)/'val-rows.parquet'))
    table=pl.concat(tables);dates=table['date'].to_numpy();targets=table['target_unclipped'].to_numpy()
    if len(set(dates))<20:raise ValueError('fewer_than_20_inner_validation_days')
    pool={};selected=[];best_score=-np.inf;best_epoch=0;selected_prediction=None
    for epoch in range(1,max_epochs+1):
        if time.monotonic()-start>21000:raise TimeoutError('seed_gpu_runtime_budget_exceeded')
        predictions=[];losses=[];refs=[]
        for fold,(pack,x) in enumerate(zip(packs,validation,strict=True),1):
            losses.append(pack.epoch());predictions.append(pack.predict(x))
            refs.append(archive.state(f'cv/fold{fold}/epoch{epoch:03d}.pt',pack.model,pack.optimizer,epoch,pack.steps,pack.generator))
        combined=np.concatenate(predictions,axis=1)
        buffer=io.BytesIO();np.savez_compressed(buffer,predictions=combined)
        archive.put(f'cv/predictions/epoch{epoch:03d}.npz',buffer.getvalue())
        for member in range(16):pool[(epoch,member)]=combined[member]
        proposal,aggregate,score=greedy(pool,targets,dates)
        if score>best_score+1e-12:
            best_score=score;best_epoch=epoch;selected=proposal;selected_prediction=aggregate.copy()
        pool={key:pool[key] for key in set(selected)}
        _,daily,valid_dates=daily_rank_ic(combined,targets,dates)
        archive.json(f'events/epoch{epoch:03d}.json',dict(epoch=epoch,losses=losses,rank_ic=best_score,
            selected=selected,daily_member_ic=daily.tolist(),dates=valid_dates,
            elapsed_seconds=time.monotonic()-start,archive_bytes=archive.total,checkpoints=refs))
        print(json.dumps(dict(seed=seed,epoch=epoch,rank_ic=best_score,best_epoch=best_epoch,
            selected=len(selected),elapsed_seconds=round(time.monotonic()-start))),flush=True)
        if epoch-best_epoch>=patience:break
    archive.json('selection.json',dict(selected=selected,score=best_score,best_epoch=best_epoch,
        stop_epoch=epoch,refit_max_epoch=max(k[0] for k in selected),scope='inner_development'))
    buffer=io.BytesIO();np.savez_compressed(buffer,delta=selected_prediction,dates=dates.astype(str),
        symbols=table['symbol'].to_numpy().astype(str),A=table['A'].to_numpy(),y=table['gross_return'].to_numpy())
    archive.put('selected-validation.npz',buffer.getvalue())
    del packs,validation,pool
    torch.cuda.empty_cache()
    with np.load(root/'final/arrays.npz',allow_pickle=False) as data:arrays={k:data[k] for k in data.files}
    pack=Pack(arrays,configs,seed);counts=Counter(selected);exports={};members=[];parity=[]
    check_x=arrays['train_x'][np.linspace(0,len(arrays['train_x'])-1,min(2048,len(arrays['train_x'])),dtype=int)]
    for epoch in range(1,max(k[0] for k in selected)+1):
        if time.monotonic()-start>21000:raise TimeoutError('seed_gpu_runtime_budget_exceeded')
        loss=pack.epoch()
        # Preserve full weights+optimizer for arbitrary selected epochs and last.
        archive.state(f'final/epoch{epoch:03d}.pt',pack.model,pack.optimizer,epoch,pack.steps,pack.generator)
        chosen=[key for key in sorted(counts) if key[0]==epoch]
        if chosen:
            reference=pack.predict(check_x)
            for key in chosen:
                depth,weights=export_member(pack,key[1]);i=len(members)
                actual=numpy_member(check_x,depth,weights)*pack.scale+pack.mean
                error=float(np.max(np.abs(actual-reference[key[1]])))
                if not np.allclose(actual,reference[key[1]],rtol=2e-5,atol=2e-6):raise ValueError('final_export_parity_failed')
                parity.append(dict(member=list(key),max_abs_error=error,rows=len(actual)))
                members.append(dict(member_id=key[1],epoch=epoch,depth=depth,weight=counts[key]/len(selected)))
                exports.update({f'm{i}_{name}':value for name,value in weights.items()})
        archive.json(f'events/final{epoch:03d}.json',dict(epoch=epoch,loss=loss,archive_bytes=archive.total))
    buffer=io.BytesIO();np.savez_compressed(buffer,**exports)
    weights=archive.put('weights.npz',buffer.getvalue())
    # Read selected export from durable storage, not just the local serialization.
    if hashlib.sha256(archive.bucket.blob(weights['path'],generation=int(weights['generation'])).download_as_bytes()).hexdigest()!=weights['sha256']:
        raise ValueError('export_remote_readback_failed')
    result=dict(schema_version='l4-r2-seed-v1',seed=seed,members=members,weights=weights,
        target_mean=pack.mean,target_scale=pack.scale,feature_indices=pack.indices.tolist(),
        final_recipe=json.loads((root/'final/recipe.json').read_bytes()),parity=parity,
        elapsed_seconds=time.monotonic()-start,stored_bytes=archive.total,
        selected_validation_rank_ic=best_score,matrices_sha256=sha(root/'matrices-manifest.json'),
        training_completed=True,efficacy_status='unproven',promoted=False)
    archive.json('objects.json',archive.objects)
    archive.json('completed.json',result)
    print(json.dumps(result),flush=True)
    return result

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--root',required=True);p.add_argument('--seed',required=True,type=int)
    p.add_argument('--bucket',required=True);p.add_argument('--prefix',required=True)
    a=p.parse_args();run(a.root,a.seed,a.bucket,a.prefix)
