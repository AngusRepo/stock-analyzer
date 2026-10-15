"""Fresh, classified R2 monthly inputs; immutable run identity before any GPU fit."""
import hashlib,io,json,tempfile,zipfile
from pathlib import Path
import polars as pl
from services.l4_distribution import digest
from services.l4_native_observation import read_reference

RECIPE='r2-causal-fourfold-three-seed-v1'
PREFIX='l4_distribution/r2_monthly_runs/'


def put(bucket,path,raw):
    from google.api_core.exceptions import PreconditionFailed
    blob=bucket.blob(path)
    try:blob.upload_from_string(raw,if_generation_match=0)
    except PreconditionFailed:pass
    if blob.download_as_bytes()!=raw:raise ValueError('l4_r2_immutable_conflict')
    return dict(path=path,sha256=hashlib.sha256(raw).hexdigest())


def seal_inputs(directory,*,protocol,provenance):
    root=Path(directory)
    manifest=json.loads((root/'matrices-manifest.json').read_bytes())
    if (manifest['training_ready'] is not True or len(manifest['eligible_dates'])<20
            or sorted(f['fold'] for f in manifest['folds'])!=['1','2','3','4','final']):
        raise ValueError('l4_r2_monthly_matrices_not_ready')
    files=[]
    for path in sorted(root.rglob('*')):
        if not path.is_file():continue
        raw=path.read_bytes()
        files.append(dict(path=path.relative_to(root).as_posix(),sha256=hashlib.sha256(raw).hexdigest(),bytes=len(raw)))
    core=dict(protocol=protocol,input_files=files,provenance=provenance)
    seal=dict(core,batch_id=digest(core))
    buffer=io.BytesIO()
    with zipfile.ZipFile(buffer,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=1) as archive:
        for record in files:
            # Fixed timestamps make retries byte-identical.
            info=zipfile.ZipInfo(record['path']);info.compress_type=zipfile.ZIP_DEFLATED
            archive.writestr(info,(root/record['path']).read_bytes())
        archive.writestr(zipfile.ZipInfo('batch-seal.json'),json.dumps(seal,sort_keys=True).encode())
    return seal,buffer.getvalue()


def prepare(bucket,*,identity,feature_schema,as_of,config,provenance):
    from scripts.l4_r2_source_refresh import classification_filter
    from services.l4_r2_sources import resolve
    from services.l4_r2_matrices import build
    protocol=json.loads(Path(__file__).with_name('l4_r2_protocol.json').read_bytes())
    classification=read_reference(bucket,config['classification'])
    # Calendar is verified against official source/price capture, not an arbitrary
    # dates[] declaration or a hardcoded historical training parquet.
    from services.training_session_calendar import verify_training_calendar,price_session_dates
    from datetime import datetime,timezone,time,date
    from services.l4_forward_materialization import TZ
    cutoff=min(datetime.now(timezone.utc),datetime.combine(date.fromisoformat(as_of),time.max,TZ))
    from services.l4_forward_refresh import current_price_capture
    capture,_=current_price_capture(bucket,as_of,cutoff=cutoff.isoformat())
    calendar_proof=verify_training_calendar(bucket,price_capture=capture)
    root=capture['capture_manifest_path'].rsplit('/',1)[0]
    raw=bucket.blob(root+'/close.parquet').download_as_bytes()
    if hashlib.sha256(raw).hexdigest()!=calendar_proof['close_sha256']:raise ValueError('l4_r2_calendar_price_changed')
    calendar=price_session_dates(raw)
    if calendar_proof['end']>as_of:raise ValueError('l4_r2_calendar_after_cutoff')
    with tempfile.TemporaryDirectory(prefix='l4-r2-monthly-') as work:
        work=Path(work);path=work/'classification.json'
        # Preserve the verified original bytes; digest is byte-level evidence.
        path.write_bytes(bucket.blob(config['classification']['path']).download_as_bytes())
        rows,receipt=resolve(bucket=bucket,identity=identity,feature_schema=feature_schema,
            cutoff=cutoff.isoformat(),work=work/'sources',
            classify=classification_filter(path,config['classification']['sha256']))
        directory=work/'matrices'
        manifest=build(rows,receipt,calendar=calendar,calendar_sha256=calendar_proof['calendar_sha256'],output=directory)
        provenance={**provenance,'as_of':as_of,'l3_identity':identity,'calendar':calendar_proof,
            'source_rows_checksum':receipt['rows_checksum'],'classification':config['classification']}
        seal,raw=seal_inputs(directory,protocol=protocol,provenance=provenance)
        prefix='l4_distribution/r2_batches/'+seal['batch_id']+'/'
        reference=put(bucket,prefix+'inputs.zip',raw)
        # CPU completion can read only the small metadata and verification matrix.
        metadata={name:put(bucket,prefix+'inputs/'+name,(directory/name).read_bytes()) for name in
            ('matrices-manifest.json','final/receipt.json','final/arrays.npz','serving-anchor.json')}
        return dict(batch_id=seal['batch_id'],inputs=reference,metadata=metadata,provenance=provenance,
            training_recipe=RECIPE,source_max_signal_date=receipt['source_max_signal_date'],
            source_dates=receipt['source_dates'],eligible_dates=manifest['eligible_dates'],
            training_started=False,promoted=False)
