"""Bounded, generation-pinned P6 weights; serving performs no training writes."""
from functools import lru_cache
import hashlib
import os
import re
from services.l4_p6_recipe import PROTOCOL
from services.l4_tabpack_weights import MAX_BYTES


def validate_reference(ref):
    if (not isinstance(ref,dict) or not re.fullmatch(
            r'l4_distribution/p6_batches/[a-f0-9]{64}/final/seed(?:42|43|44)/weights\.npz',ref.get('path',''))
            or not re.fullmatch('[a-f0-9]{64}',ref.get('sha256',''))
            or type(ref.get('bytes')) is not int or not 0<ref['bytes']<=MAX_BYTES
            or not str(ref.get('generation','')).isdigit() or int(ref['generation'])<1):
        raise ValueError('p6_weights_reference_invalid')


def read(bucket,ref):
    validate_reference(ref)
    blob=bucket.blob(ref['path'],generation=int(ref['generation']))
    blob.reload(if_generation_match=int(ref['generation']),timeout=30)
    if (blob.size!=ref['bytes'] or str(blob.generation)!=str(ref['generation'])
            or (blob.metadata or {}).get('sha256')!=ref['sha256']):
        raise ValueError('p6_weights_object_changed')
    raw=blob.download_as_bytes(if_generation_match=int(ref['generation']),timeout=60)
    if len(raw)!=ref['bytes'] or hashlib.sha256(raw).hexdigest()!=ref['sha256']:
        raise ValueError('p6_weights_checksum_mismatch')
    return raw


@lru_cache(maxsize=len(PROTOCOL['seeds']))
def _load(bucket_name,path,sha,size,generation):
    from google.cloud import storage
    return read(storage.Client().bucket(bucket_name),dict(path=path,sha256=sha,bytes=size,generation=generation))


def load(ref):
    validate_reference(ref)
    bucket=os.environ.get('GCS_BUCKET_NAME','').strip()
    if not bucket:raise ValueError('p6_weights_bucket_missing')
    return _load(bucket,ref['path'],ref['sha256'],ref['bytes'],str(ref['generation']))
