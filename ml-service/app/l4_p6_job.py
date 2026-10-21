"""One sealed P6 phase/seed. A delivery retry never restarts a claimed fit."""
from pathlib import Path
import hashlib
import json
import re
import subprocess
import tempfile
from app.l4_r2_job import extract  # Archive validation only; never the R2 runner.


def validate_request(payload):
    batch=payload.get('batch_id','');seed=payload.get('seed');phase=payload.get('phase')
    inputs=payload.get('inputs') or {}
    if (type(seed) is not int or seed not in (42,43,44) or phase not in ('cv','final')
            or not isinstance(batch,str) or not re.fullmatch('[a-f0-9]{64}',batch)
            or inputs.get('path')!=f'l4_distribution/p6_batches/{batch}/inputs.zip'
            or not re.fullmatch('[a-f0-9]{64}',inputs.get('sha256',''))):
        raise ValueError('p6_job_contract')
    return f'l4_distribution/p6_batches/{batch}/{phase}/seed{seed}/'


def read_verified(bucket,path):
    blob=bucket.get_blob(path)
    if blob is None:return None
    raw=blob.download_as_bytes(if_generation_match=blob.generation)
    if hashlib.sha256(raw).hexdigest()!=(blob.metadata or {}).get('sha256'):
        raise ValueError('p6_result_checksum')
    return json.loads(raw)


def verify_result(result,payload):
    if (result.get('schema_version')!='p6-seed-result-v1'
            or result.get('recipe')!='p6-a-direct-excess-pure8-ploss-fourfold-v1'
            or result.get('sealed_batch_id')!=payload['batch_id']
            or result.get('seed')!=payload['seed'] or result.get('phase')!=payload['phase']
            or result.get('training_completed') is not True or result.get('promoted') is not False
            or result.get('outer_rows')!=0 or not result.get('checkpoint_restoration')
            or any(r.get('training_steps')!=0 for r in result['checkpoint_restoration'])):
        raise ValueError('p6_completion_not_verified')
    return result


def run(payload):
    from google.cloud import storage
    from google.api_core.exceptions import PreconditionFailed
    prefix=validate_request(payload);bucket=storage.Client().bucket('stockvision-models')
    done=read_verified(bucket,prefix+'completed.json')
    if done is not None:return verify_result(done,payload)
    source=bucket.get_blob(payload['inputs']['path'])
    if source is None:raise ValueError('p6_input_missing')
    raw=source.download_as_bytes(if_generation_match=source.generation)
    if hashlib.sha256(raw).hexdigest()!=payload['inputs']['sha256']:raise ValueError('p6_input_hash')
    with tempfile.TemporaryDirectory(prefix='p6-input-') as root:
        extract(raw,root)
        seal=json.loads((Path(root)/'batch-seal.json').read_bytes())
        body={k:v for k,v in seal.items() if k!='batch_id'}
        checksum=hashlib.sha256(json.dumps(body,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()
        if seal.get('batch_id')!=payload['batch_id'] or checksum!=payload['batch_id'] or seal.get('phase')!=payload['phase']:
            raise ValueError('p6_batch_identity')
        # Only claim after source integrity checks. Crashes keep this claim.
        bucket.blob(prefix+'claim.json').upload_from_string(json.dumps(payload,sort_keys=True),if_generation_match=0)
        try:
            args=['--root',root,'--seed',str(payload['seed']),'--bucket',bucket.name,'--prefix',prefix,'--phase',payload['phase']]
            subprocess.run(['/opt/tabpack/.venv/bin/python',str(Path(__file__).with_name('p6_engine')/'p6_train.py'),*args],
                check=True,timeout=28500)
            result=read_verified(bucket,prefix+'completed.json')
            if result is None:raise ValueError('p6_completion_missing')
            return verify_result(result,payload)
        except Exception as exc:
            failure=dict(status='failed',error_type=type(exc).__name__,promoted=False,retry_requires_review=True)
            try:bucket.blob(prefix+'failed.json').upload_from_string(json.dumps(failure),if_generation_match=0)
            except PreconditionFailed:pass
            raise
