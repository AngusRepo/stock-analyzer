"""Verify the original immutable model owner of a resumed OOF fold."""
import hashlib
import json
import re


def verified_forward_source_version(bucket: object, manifest: dict, window: dict) -> str:
    """A reused fold keeps its original immutable model version."""
    cohort = str(manifest.get('cohort_id') or '')
    fold = f"w{int(window.get('window_id') or 0)}"
    if not window.get('source_cohort_id'):
        return f'{cohort}-{fold}'
    source = str(window['source_cohort_id'])
    source_fold = str(window.get('source_fold_id') or '')
    if (any(token in source for token in ('/', '\\', '..'))
            or not re.fullmatch(r'w[0-9]+', source_fold)):
        raise ValueError('oof_forward_reused_source_identity_invalid')
    original = json.loads(bucket.blob(f'walk_forward/oof_cohorts/{source}/manifest.json').download_as_text())
    checksum = hashlib.sha256(json.dumps({k:v for k,v in original.items() if k != 'manifest_checksum'},
        sort_keys=True, default=str).encode('utf-8')).hexdigest()
    if (original.get('cohort_id') != source or original.get('status') != 'ready'
            or original.get('generation_mode') != 'purged_oof'
            or original.get('manifest_checksum') != checksum
            or window.get('source_manifest_checksum') != checksum
            or original.get('model_profile_schema_version') != manifest.get('model_profile_schema_version')
            or original.get('model_set') != manifest.get('model_set')):
        raise ValueError('oof_forward_reused_source_manifest_invalid')
    matches = [w for w in original.get('windows', []) if f"w{w.get('window_id')}" == source_fold]
    fields = ('train_range','test_range','model_metrics','tree_result','TabM_result','GNN_result',
              'source_prep_manifest_checksum','source_sequence_manifest_checksum','source_producer_source_sha')
    if len(matches) != 1 or any(matches[0].get(k) != window.get(k) for k in fields):
        raise ValueError('oof_forward_reused_source_fold_changed')
    return f'{source}-{source_fold}'
