"""Restore real selected checkpoints and verify archived CV/final predictions; no fit."""
import argparse,hashlib,io,json,time
from pathlib import Path
from collections import Counter
import numpy as np
import torch
from google.cloud import storage
from r2_train import Pack,export_member

def run(root,seed,bucket_name,prefix):
    start=time.monotonic();bucket=storage.Client().bucket(bucket_name)
    def read(name):
        blob=bucket.get_blob(prefix+name)
        if blob is None:raise ValueError('verification_artifact_missing:'+name)
        raw=blob.download_as_bytes(if_generation_match=blob.generation)
        if hashlib.sha256(raw).hexdigest()!=(blob.metadata or {}).get('sha256'):
            raise ValueError('verification_artifact_checksum:'+name)
        return raw
    launch=json.loads(read('launch.json'));result=json.loads(read('completed.json'));selection=json.loads(read('selection.json'))
    if not result['training_completed'] or result['seed']!=seed:raise ValueError('verification_incomplete_training')
    counts=Counter(tuple(k) for k in selection['selected']);epochs=sorted({k[0] for k in counts})
    torch.set_num_threads(8);torch.backends.cuda.matmul.allow_tf32=False
    root=Path(root);offset=0;checks=[];reconstructed=[]
    for fold in range(1,5):
        with np.load(root/str(fold)/'arrays.npz',allow_pickle=False) as data:arrays={k:data[k] for k in data.files}
        pack=Pack(arrays,launch['configs'],seed);length=len(arrays['val_x']);aggregate=np.zeros(length,np.float64)
        for epoch in epochs:
            state=torch.load(io.BytesIO(read(f'cv/fold{fold}/epoch{epoch:03d}.pt')),map_location='cuda',weights_only=False)
            if state['epoch']!=epoch or not state['optimizer']['state']:raise ValueError('verification_checkpoint_state')
            pack.model.load_state_dict(state['model']);pack.optimizer.load_state_dict(state['optimizer'])
            actual=pack.predict(arrays['val_x'])
            with np.load(io.BytesIO(read(f'cv/predictions/epoch{epoch:03d}.npz')),allow_pickle=False) as values:
                expected=values['predictions'][:,offset:offset+length]
            np.testing.assert_allclose(actual,expected,rtol=2e-5,atol=2e-6)
            checks.append(dict(fold=fold,epoch=epoch,rows=length,members=16,max_error=float(np.max(abs(actual-expected)))))
            for (e,member),count in counts.items():
                if e==epoch:aggregate+=actual[member]*(count/len(selection['selected']))
            del state
        reconstructed.append(aggregate);offset+=length;del pack;torch.cuda.empty_cache()
        print(json.dumps(dict(seed=seed,verified_fold=fold,checkpoints=len(epochs),seconds=time.monotonic()-start)),flush=True)
    with np.load(io.BytesIO(read('selected-validation.npz')),allow_pickle=False) as data:
        np.testing.assert_allclose(np.concatenate(reconstructed),data['delta'],rtol=2e-5,atol=2e-6)
        ensemble_error=float(np.max(abs(np.concatenate(reconstructed)-data['delta'])))
    with np.load(root/'final/arrays.npz',allow_pickle=False) as data:arrays={k:data[k] for k in data.files}
    pack=Pack(arrays,launch['configs'],seed)
    export_raw=read('weights.npz');final_checks=[]
    with np.load(io.BytesIO(export_raw),allow_pickle=False) as exported:
        for epoch in epochs:
            state=torch.load(io.BytesIO(read(f'final/epoch{epoch:03d}.pt')),map_location='cuda',weights_only=False)
            pack.model.load_state_dict(state['model']);pack.optimizer.load_state_dict(state['optimizer'])
            for i,member in enumerate(result['members']):
                if member['epoch']!=epoch:continue
                depth,weights=export_member(pack,member['member_id'])
                if depth!=member['depth']:raise ValueError('verification_export_depth')
                for key,value in weights.items():np.testing.assert_array_equal(value,exported[f'm{i}_{key}'])
                final_checks.append(dict(member=member['member_id'],epoch=epoch,exact_weights=True))
    import sys,importlib.metadata
    environment=dict(python=sys.version,packages={name:importlib.metadata.version(name)
        for name in ('torch','numpy','polars','scipy','google-cloud-storage')})
    receipt=dict(status='passed',seed=seed,cv_checkpoints=checks,selected_ensemble_max_error=ensemble_error,
        final_export_checks=final_checks,optimizer_state_restored=True,training_steps=0,
        seconds=time.monotonic()-start,production_writes=0,weights_sha256=hashlib.sha256(export_raw).hexdigest(),
        environment=environment)
    Path('/tmp/checkpoint-verification.json').write_text(json.dumps(receipt))
    print(json.dumps(dict(seed=seed,status='passed',cv_checkpoint_count=len(checks),selected_final_states=len(final_checks),seconds=receipt['seconds'])),flush=True)
    return receipt

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--root');p.add_argument('--seed',type=int);p.add_argument('--bucket');p.add_argument('--prefix')
    a=p.parse_args();run(a.root,a.seed,a.bucket,a.prefix)
