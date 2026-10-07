"""Original 700-name E0 golden forecast and feature-adapter verification."""
import argparse,gzip,json,sys,time
from copy import deepcopy
from pathlib import Path
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'ml-controller'))
from services.l4_distribution import digest,predict
from services.l4_mlp_weights import prime_folder
from services.l4_distribution_runtime import native_features


def verify(candidate,*,weights_folder,fixture,projection=None,original_model_folder=None):
    prime_folder(candidate,weights_folder)
    expected=json.loads(gzip.decompress(Path(fixture).read_bytes()))
    rows=expected['native_rows'];start=time.monotonic();output=predict(rows,candidate['model'])
    full_error=float(np.max(np.abs([p['expected_return_gross']-r['M'] for p,r in zip(output,expected['forecasts'],strict=True)])))
    model=deepcopy(candidate['model']);m=model['residual_mlp'];m['residual_multiplier']=.5
    m['payload_checksum']=digest({k:v for k,v in m.items() if k!='payload_checksum'})
    half=predict(rows,model)
    half_error=float(np.max(np.abs([p['expected_return_gross']-r['H'] for p,r in zip(half,expected['forecasts'],strict=True)])))
    member_errors={}
    for seed in (42,43,44):
        delta=np.asarray([p['residual_member_corrections'][str(seed)] for p in output],np.float32)
        anchor=np.asarray([p['three_head_expected_return_gross'] for p in output],np.float32)
        for arm,scale in (('M',1.),('H',.5)):
            value=anchor+delta*np.float32(scale)
            member_errors[arm+str(seed)]=float(np.max(np.abs(value-np.asarray([r[arm+str(seed)] for r in expected['forecasts']]))))
    if max(full_error,half_error,*member_errors.values())>1e-6:raise ValueError('mlp_original_checkpoint_parity_failed')
    all_layers=None
    if original_model_folder:
        import torch
        from services.l4_mlp_weights import load
        folder=Path(original_model_folder)
        original=json.loads((folder/'w22-anchor-original.json').read_text(encoding='utf8'))
        if {k:candidate['model'][k] for k in ('recipe','heads')}!=original['model']:
            raise ValueError('mlp_original_anchor_changed')
        for member in candidate['model']['residual_mlp']['members']:
            checkpoint=folder/f"w22-MLP-{member['seed']}.pt"
            import hashlib
            if hashlib.sha256(checkpoint.read_bytes()).hexdigest()!=member['provenance']['checkpoint_sha256']:
                raise ValueError('mlp_original_checkpoint_sha_changed')
            state=torch.load(checkpoint,map_location='cpu',weights_only=True);arrays=load(member['model']['weights'])
            if set(state)!=set(arrays) or any(not np.array_equal(v.numpy(),arrays[k]) for k,v in state.items()):
                raise ValueError('mlp_original_complete_layer_weights_changed')
        all_layers=True
    adapter=None
    if projection:
        source=json.loads(gzip.decompress(Path(projection).read_bytes()))['payload']['content']
        predictions=source['recommendation_context'].get('post_predictions') or source['recommendation_context']['inputs']['predictions']
        actual=[{'symbol':r['symbol'],'features':native_features(r,predictions[r['symbol']],source['formal_baseline_identity'])}
                for r in source['inputs']['recommendations']]
        adapter=actual==[{'symbol':r['symbol'],'features':r['features']} for r in rows]
        if not adapter:raise ValueError('mlp_native_input_adapter_parity_failed')
    return {'status':'CHECKPOINT_AND_ADAPTER_PARITY_PASS','rows':len(rows),'model_checksum':candidate['model_checksum'],
        'Full_max_absolute_error':full_error,'Half_max_absolute_error':half_error,'native_adapter_exact':adapter,
        'member_max_absolute_errors':member_errors,'all_original_layers_exact':all_layers,
        'runtime_seconds':time.monotonic()-start,'training_calls':0,'remote_mutations_executed':False}


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for name in ('candidate','weights-folder','fixture','output'):p.add_argument('--'+name,required=True)
    p.add_argument('--projection');p.add_argument('--original-model-folder');a=p.parse_args()
    candidate=json.loads(Path(a.candidate).read_text(encoding='utf8'))
    result=verify(candidate,weights_folder=a.weights_folder,fixture=a.fixture,projection=a.projection,original_model_folder=a.original_model_folder)
    Path(a.output).write_text(json.dumps(result,indent=2),encoding='utf8');print(json.dumps(result))
