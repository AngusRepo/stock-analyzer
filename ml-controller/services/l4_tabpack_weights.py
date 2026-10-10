"""Content-addressed, bounded FP32 weights. No pickle or model code is loaded."""
from functools import lru_cache
import hashlib
import io
import os
import re
import zipfile

import numpy as np

SCHEMA = 'l4-three-head-residual-tabpack-official-v2'
PREFIX = 'l4_distribution/tabpack_weights/'
MAX_BYTES = 96 * 1024 * 1024


def validate_reference(ref):
    sha = ref.get('sha256', '')
    if (not re.fullmatch('[a-f0-9]{64}', sha)
            or ref.get('path') != PREFIX + sha + '.npz'
            or type(ref.get('bytes')) is not int or not 0 < ref['bytes'] <= MAX_BYTES):
        raise ValueError('l4_tabpack_weights_reference_invalid')


def decode(raw, ref):
    validate_reference(ref)
    if len(raw) != ref['bytes'] or hashlib.sha256(raw).hexdigest() != ref['sha256']:
        raise ValueError('l4_tabpack_weights_checksum_mismatch')
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        if sum(item.file_size for item in archive.infolist()) > MAX_BYTES:
            raise ValueError('l4_tabpack_weights_uncompressed_limit')
    with np.load(io.BytesIO(raw), allow_pickle=False) as archive:
        arrays = {key: archive[key] for key in archive.files}
    if any(a.dtype != np.float32 or not np.isfinite(a).all() for a in arrays.values()):
        raise ValueError('l4_tabpack_weights_dtype_or_nonfinite')
    for value in arrays.values():
        value.setflags(write=False)
    return arrays


@lru_cache(maxsize=3)
def _load(bucket_name, path, sha, size):
    from google.cloud import storage
    blob = storage.Client().bucket(bucket_name).blob(path)
    blob.reload()
    if blob.size != size:
        raise ValueError('l4_tabpack_weights_size_mismatch')
    return decode(blob.download_as_bytes(timeout=60), {'path': path, 'sha256': sha, 'bytes': size})


def load(ref):
    validate_reference(ref)
    bucket = os.environ.get('GCS_BUCKET_NAME', '').strip()
    if not bucket:
        raise ValueError('l4_tabpack_weights_bucket_missing')
    return _load(bucket, ref['path'], ref['sha256'], ref['bytes'])


def validate_members(model, arrays):
    members = model.get('members')
    if not isinstance(members, list) or not 1 <= len(members) <= 32:
        raise ValueError('l4_tabpack_members_invalid')
    expected = set()
    total = 0.
    identities = set()
    for i, member in enumerate(members):
        mid, step, depth = member.get('member_id'), member.get('step'), member.get('depth')
        if (type(mid) is not int or not 0 <= mid < 64 or type(step) is not int or step < 1
                or type(depth) is not int or not 1 <= depth <= 4 or (mid, step) in identities):
            raise ValueError('l4_tabpack_member_identity_invalid')
        identities.add((mid, step))
        weight = member.get('weight')
        if not isinstance(weight, (int, float)) or not np.isfinite(weight) or weight <= 0:
            raise ValueError('l4_tabpack_ensemble_weight_invalid')
        total += weight
        width = 34
        for j in range(depth + 1):
            out = 1 if j == depth else 384
            wk, bk = f'm{i}_l{j}_weight', f'm{i}_l{j}_bias'
            expected.update((wk, bk))
            if wk not in arrays or bk not in arrays or arrays[wk].shape != (width, out) or arrays[bk].shape != (out,):
                raise ValueError('l4_tabpack_weight_shape_invalid')
            width = out
    if set(arrays) != expected or not np.isclose(total, 1., rtol=0, atol=1e-7):
        raise ValueError('l4_tabpack_ensemble_contract_invalid')


def infer(inputs, members, arrays):
    result = np.zeros(len(inputs), dtype=np.float64)
    for i, member in enumerate(members):
        value = inputs
        for j in range(member['depth'] + 1):
            value = value @ arrays[f'm{i}_l{j}_weight'] + arrays[f'm{i}_l{j}_bias']
            if j < member['depth']:
                value = np.maximum(value, np.float32(0))
        result += member['weight'] * value[:, 0].astype(np.float64)
    return result
