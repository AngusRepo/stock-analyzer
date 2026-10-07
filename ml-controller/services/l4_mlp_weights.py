"""Complete bounded FP32 MLP state, content addressed; no pickle at serving."""
from collections import OrderedDict
from copy import deepcopy
import hashlib
import io
import os
from pathlib import Path
import re
import zipfile
import numpy as np

from services.l4_distribution import digest

SCHEMA = 'l4-three-head-residual-mlp-weights-v2'
PREFIX = 'l4_distribution/mlp_weights/'
MAX_BYTES = 4*1024*1024
_cache = OrderedDict()


def validate_reference(ref):
    sha=ref.get('sha256','')
    if (not re.fullmatch('[a-f0-9]{64}',sha) or ref.get('path')!=PREFIX+sha+'.npz'
            or type(ref.get('bytes')) is not int or not 0<ref['bytes']<=MAX_BYTES):
        raise ValueError('l4_mlp_weights_reference_invalid')


def decode(raw,ref):
    validate_reference(ref)
    if len(raw)!=ref['bytes'] or hashlib.sha256(raw).hexdigest()!=ref['sha256']:
        raise ValueError('l4_mlp_weights_checksum_mismatch')
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        entries=archive.infolist()
        if (len(entries)!=22 or len({v.filename for v in entries})!=len(entries)
                or sum(v.file_size for v in entries)>MAX_BYTES):
            raise ValueError('l4_mlp_weights_archive_invalid')
    with np.load(io.BytesIO(raw),allow_pickle=False) as archive:
        values={key:archive[key] for key in archive.files}
    if any(v.dtype!=np.float32 or not np.isfinite(v).all() for v in values.values()):
        raise ValueError('l4_mlp_weights_dtype_or_nonfinite')
    for value in values.values():value.setflags(write=False)
    return values


def prime(ref,raw):
    values=decode(raw,ref)
    key=(ref['sha256'],ref['bytes'])
    _cache[key]=values
    _cache.move_to_end(key)
    while len(_cache)>9:_cache.popitem(last=False)
    return values


def load(ref):
    validate_reference(ref)
    key=(ref['sha256'],ref['bytes'])
    if key in _cache:
        values=_cache[key];_cache.move_to_end(key);return values
    bucket=os.environ.get('GCS_BUCKET_NAME','').strip()
    if not bucket:raise ValueError('l4_mlp_weights_bucket_missing')
    from google.cloud import storage
    blob=storage.Client().bucket(bucket).blob(ref['path']);blob.reload()
    if blob.size!=ref['bytes']:raise ValueError('l4_mlp_weights_size_mismatch')
    return prime(ref,blob.download_as_bytes(timeout=60))


def pack(member):
    value=deepcopy(member);model=value['model']
    if model['schema_version']!='l4-three-head-residual-mlp-v1' or 'weights' in model:
        raise ValueError('l4_mlp_pack_requires_complete_inline_state')
    buffer=io.BytesIO()
    np.savez_compressed(buffer,**{k:np.asarray(v,np.float32) for k,v in model.pop('state').items()})
    raw=buffer.getvalue();sha=hashlib.sha256(raw).hexdigest()
    ref={'path':PREFIX+sha+'.npz','sha256':sha,'bytes':len(raw)}
    model.update(schema_version=SCHEMA,weights=ref)
    model['payload_checksum']=digest({k:v for k,v in model.items() if k!='payload_checksum'})
    prime(ref,raw)
    return value,raw


def prime_folder(candidate,folder):
    """Explicit local verification only; serving always reads the immutable GCS key."""
    for member in candidate['model']['residual_mlp']['members']:
        ref=member['model'].get('weights')
        if ref is not None:
            validate_reference(ref)
            prime(ref,(Path(folder)/(ref['sha256']+'.npz')).read_bytes())


def compact_candidate(candidate):
    value=deepcopy(candidate);residual=value['model']['residual_mlp'];packed=[];objects={}
    for member in residual['members']:
        converted,raw=pack(member);packed.append(converted)
        objects[converted['model']['weights']['path']]=raw
    residual['members']=packed
    residual['payload_checksum']=digest({k:v for k,v in residual.items() if k!='payload_checksum'})
    value['model_checksum']=digest(value['model'])
    return value,objects
