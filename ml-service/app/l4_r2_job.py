"""One fixed seed fit + independent checkpoint readback; never auto-restart."""
from pathlib import Path,PurePosixPath
import hashlib,io,json,re,subprocess,tempfile,zipfile


def validate_request(payload):
    batch=payload.get('batch_id','');seed=payload.get('seed')
    if (seed not in (42,43,44) or not re.fullmatch('[a-f0-9]{64}',batch)
            or payload.get('inputs',{}).get('path')!='l4_distribution/r2_batches/'+batch+'/inputs.zip'
            or not re.fullmatch('[a-f0-9]{64}',payload['inputs'].get('sha256',''))):
        raise ValueError('l4_r2_job_contract')
    return 'l4_distribution/r2_batches/'+batch+f'/seed{seed}/'


def extract(raw,root):
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        names=archive.namelist()
        if len(names)!=len(set(names)):raise ValueError('l4_r2_duplicate_zip_entry')
        for name in names+[info.orig_filename for info in archive.infolist()]:
            path=PurePosixPath(name)
            if path.is_absolute() or '..' in path.parts or '\\' in name or ':' in name:
                raise ValueError('l4_r2_unsafe_archive')
        archive.extractall(root)


def run(payload):
    from google.cloud import storage
    from google.api_core.exceptions import PreconditionFailed
    prefix=validate_request(payload);bucket=storage.Client().bucket('stockvision-models')
    verified=bucket.blob(prefix+'checkpoint-verification.json')
    if verified.exists():return json.loads(verified.download_as_bytes())
    # A crashed fit is never restarted by delivery retries. Preserve its claim.
    bucket.blob(prefix+'claim.json').upload_from_string(json.dumps(payload,sort_keys=True),if_generation_match=0)
    try:
        raw=bucket.blob(payload['inputs']['path']).download_as_bytes()
        if hashlib.sha256(raw).hexdigest()!=payload['inputs']['sha256']:raise ValueError('l4_r2_input_hash')
        with tempfile.TemporaryDirectory(prefix='r2-input-') as root:
            extract(raw,root)
            seal=json.loads((Path(root)/'batch-seal.json').read_bytes())
            core={k:v for k,v in seal.items() if k!='batch_id'}
            checksum=hashlib.sha256(json.dumps(core,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()
            if seal['batch_id']!=payload['batch_id'] or checksum!=payload['batch_id']:
                raise ValueError('l4_r2_batch_identity')
            engine=Path(__file__).with_name('r2_engine')
            args=['--root',root,'--seed',str(payload['seed']),'--bucket',bucket.name,'--prefix',prefix]
            subprocess.run(['/opt/tabpack/.venv/bin/python',str(engine/'r2_train.py'),*args],check=True,timeout=21300)
            # No training steps here; selected CV/final states are read back.
            subprocess.run(['/opt/tabpack/.venv/bin/python',str(engine/'verify_checkpoints.py'),*args],check=True,timeout=7200)
            proof=json.loads(Path('/tmp/checkpoint-verification.json').read_bytes())
            if proof['status']!='passed' or proof['training_steps']!=0:raise ValueError('l4_r2_verification_failed')
            proof.update(batch_id=payload['batch_id'],input_sha256=payload['inputs']['sha256'])
            raw=json.dumps(proof,sort_keys=True).encode()
            verified.metadata={'sha256':hashlib.sha256(raw).hexdigest()}
            verified.upload_from_string(raw,if_generation_match=0)
            if verified.download_as_bytes()!=raw:raise ValueError('l4_r2_verification_readback')
            return proof
    except Exception as exc:
        failure=dict(status='failed',error_type=type(exc).__name__,promoted=False,retry_requires_review=True)
        try:bucket.blob(prefix+'failed.json').upload_from_string(json.dumps(failure),if_generation_match=0)
        except PreconditionFailed:pass
        raise
