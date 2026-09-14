"""Actual native full-capacity sequence refits on frozen local source objects."""
from __future__ import annotations
import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT/'ml-service'), str(ROOT/'ml-controller'), str(ROOT/'ml-controller/scripts')]
from l4_local_full_fit import DEST, sha, inventory
from l4_local_study import DiskBucket, OUT
from l4_asof_sequence_replay import records
from services.active8_release_model_profiles import LOCAL_EXECUTION_PROFILE, model_profile


def run(model, attempt=None):
    if attempt is not None and (not attempt or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789-" for c in attempt)):
        raise ValueError("local_full_fit_attempt_invalid")
    import torch
    from app import dlinear_universal as dl, neuralforecast_sequence_runtime as nf, model_store
    torch.set_num_threads(4)
    folder = DEST/(attempt or "")/model
    folder.mkdir(parents=True,exist_ok=True)
    if (folder/'completion.json').exists():
        done=json.loads((folder/'completion.json').read_text(encoding='utf-8'))
        for path, checksum in done['artifacts'].items():
            if sha(ROOT/path)!=checksum: raise ValueError('sequence_full_fit_artifact_changed')
        print('VERIFIED_COMPLETE',model,flush=True); return
    if (folder/'start.json').exists(): raise ValueError('sequence_full_fit_prior_incomplete_requires_review')
    manifest=json.loads((OUT/'source/sequence_manifest.json').read_text())
    prefix=manifest['output_gcs_prefix']
    sources={f'{prefix}/prep/batch_{i}.npz':OUT/f'source/sequence-batch_{i}.npz' for i in range(manifest['batch_count'])}
    for name,path in sources.items():
        if sha(path)!=manifest['output_checksums'][name]:raise ValueError('sequence_full_fit_source_checksum_mismatch')
    class Bucket(DiskBucket):
        def blob(self,name):
            if name not in sources:return super().blob(name)
            path=sources[name]
            class Blob:
                generation=1
                size=path.stat().st_size
                updated=datetime.fromtimestamp(path.stat().st_mtime,timezone.utc)
                time_created=updated
                def exists(self,**kw):return True
                def reload(self,**kw):pass
                def download_as_bytes(self,**kw):return path.read_bytes()
                def download_as_text(self,**kw):return path.read_text(encoding='utf-8')
            return Blob()
    bucket=Bucket(folder)
    for module in (dl,nf,model_store):module._get_bucket=lambda:bucket
    source_paths=[*(ROOT/'ml-service/app').rglob('*.py'),Path(__file__),
        ROOT/'ml-controller/scripts/l4_asof_sequence_replay.py',
        ROOT/'ml-controller/services/active8_release_model_profiles.py']
    source_checksums=inventory(source_paths)
    input_checksums=inventory([*sources.values(),OUT/'source/sequence_manifest.json',OUT/'asof-models/original-symbol-market.json'])
    data=records()
    if any(d>'2026-09-14' for r in data for d in r['dates']):raise ValueError('sequence_full_fit_future_input')
    profile=model_profile(model,execution_profile=LOCAL_EXECUTION_PROFILE)
    config=profile['payload_config']
    started={'scope':'local_full_fit_unreleased','model':model,'started_at':datetime.now(timezone.utc).isoformat(),
        'source_checksums':source_checksums,'input_checksums':input_checksums,'profile':profile,
        'sequence_records':len(data),'data_cutoff':max(d for r in data for d in r['dates']),
        'torch_version':torch.__version__,'production_effect':False,'registration':False,'release_attestation_pending':True,'nav_maturity_credit':0}
    (folder/'start.json').write_text(json.dumps(started,indent=2),encoding='utf-8',newline='\n')
    print('SEQUENCE_FULL_FIT_START',model,len(data),flush=True)
    version=f'l4-repaired-{attempt or "full-fit"}-20260914'
    if model=='DLinear':
        result=dl.train_dlinear(series_close=[],sequence_records=data,full_fit=True,knowledge_cutoff_date="2026-09-14",**config)
        if result.get('error'):raise ValueError(result['error'])
        if result['metadata'].get('deployment_fit',{}).get('performed') is not True:
            raise ValueError('sequence_full_fit_deployment_refit_missing')
        state=result.pop('_state_dict_torch');result.pop('state_dict')
        result['metadata']['version']=version
        result['saved']=dl.save_to_gcs(state,result['metadata'],version=version)
    else:
        result=nf.train_neuralforecast_sequence_artifact({**config,'sequence_records':data,
            'sequence_gcs_prefix':prefix,'sequence_batch_count':manifest['batch_count'],
            'generation_mode':'local_full_fit','run_date':'2026-09-14','output_model_version':version},model_name=model)
        if result.get('status')!='ok':raise ValueError('sequence_full_fit_incomplete')
    if inventory(source_paths)!=source_checksums:raise ValueError('sequence_full_fit_source_changed')
    (folder/'result.json').write_text(json.dumps(result,indent=2,default=str),encoding='utf-8',newline='\n')
    done={**started,'status':'weights_complete_admission_pending','completed_at':datetime.now(timezone.utc).isoformat(),
        'artifacts':inventory(p for p in folder.rglob('*') if p.is_file())}
    (folder/'completion.json').write_text(json.dumps(done,indent=2),encoding='utf-8',newline='\n')
    print('SEQUENCE_FULL_FIT_COMPLETE',model,flush=True)


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--model',required=True,choices=['DLinear','PatchTST','iTransformer']);p.add_argument('--attempt');args=p.parse_args();run(args.model,args.attempt)
