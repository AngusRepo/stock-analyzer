"""Paid-entry check of sealed prep observations, not a PIT completeness certificate."""
from __future__ import annotations

import hashlib
import io
import json

import numpy as np


def _read_sealed(bucket, path, digest):
    if not isinstance(digest, str) or len(digest) != 64:
        raise ValueError('training_feature_source_checksum_missing:' + path)
    blob = bucket.blob(path)
    if not blob.exists():
        raise ValueError('training_feature_source_file_missing:' + path)
    raw = blob.download_as_bytes()
    if hashlib.sha256(raw).hexdigest() != digest:
        raise ValueError('training_feature_source_checksum_mismatch:' + path)
    return raw


def require_feature_source_observations(bucket, manifest):
    prefix = manifest['output_gcs_prefix']
    source = manifest.get('source_gcs_prefix')
    if not isinstance(source, str) or not source or source != source.strip().rstrip('/'):
        raise ValueError('training_feature_source_prefix_invalid')
    names_path = prefix + '/prep/feature_names.json'
    names_hash = (manifest.get('source_checksums') or {}).get(source + '/prep/feature_names.json')
    names = json.loads(_read_sealed(bucket, names_path, names_hash))
    from .formal_feature_contract import feature_count, FEATURE131_SEMANTIC, FEATURES131, LEGACY_SEMANTIC
    semantic = manifest.get('feature_semantic_version', LEGACY_SEMANTIC)
    count = feature_count(semantic)
    if (not isinstance(names, list) or len(names) != count
            or any(not isinstance(n, str) or not n for n in names) or len(set(names)) != count
            or (semantic == FEATURE131_SEMANTIC and names != list(FEATURES131))):
        raise ValueError('training_feature_source_names_invalid')
    rows = manifest.get('batch_rows')
    if (not isinstance(rows, list) or not rows
            or any(type(n) is not int or n < 0 for n in rows)
            or sum(rows) <= 0 or sum(rows) != manifest.get('output_rows')):
        raise ValueError('training_feature_source_rows_invalid')
    paths = [prefix + f'/prep/batch_{i}.npz' for i in range(len(rows))]
    checksums = manifest.get('output_checksums') or {}
    if set(paths) != set(checksums):
        raise ValueError('training_feature_source_inventory_invalid')
    observed = np.zeros(len(names), dtype=bool)
    for path, count in zip(paths, rows):
        raw = _read_sealed(bucket, path, checksums[path])
        # Never load the object-valued lineage arrays or permit pickle execution.
        with np.load(io.BytesIO(raw), allow_pickle=False) as data:
            if 'X' not in data.files or 'missingness_rates' not in data.files:
                raise ValueError('training_feature_source_missingness_required:' + path)
            x = data['X']
            rates = data['missingness_rates']
            if x.shape != (count, len(names)) or not np.issubdtype(x.dtype, np.number) or not np.isfinite(x).all():
                raise ValueError('training_feature_source_matrix_invalid:' + path)
            if (rates.shape != (len(names),) or not np.issubdtype(rates.dtype, np.number)
                    or not np.isfinite(rates).all() or (rates < 0).any() or (rates > 1).any()):
                raise ValueError('training_feature_source_missingness_invalid:' + path)
            if count:
                observed |= rates < 1
    missing = [name for name, present in zip(names, observed) if not present]
    if missing:
        raise ValueError('training_feature_source_entirely_missing:' + ','.join(missing))
    return {'status': 'sealed_prep_observations_verified', 'coordinates': len(names),
            'rows': sum(rows), 'batches': len(rows), 'feature_names_sha256': names_hash,
            'historical_publication_vintage_certified': False,
            'scope': 'prep source missingness; not per-row canonical or full historical coverage'}
