"""Reuse a sealed OOF index only while its complete D1 projection is unchanged."""
import json
from google.api_core.exceptions import PreconditionFailed
from services.l4_distribution import digest


def _path(manifest):
    return 'l4_distribution/native_index_receipts/' + digest({
        'schema': 'native-index-receipt-v1', 'cohort': manifest['cohort_id'],
        'manifest': manifest['manifest_checksum']}) + '.json'


def _projection(manifest, client):
    cohort = client.query("SELECT status,artifact_manifest_checksum,expected_models,expected_folds,completed_folds,prediction_rows,prediction_dates FROM active8_oof_cohorts WHERE cohort_id=?", [manifest['cohort_id']])
    folds = client.query("SELECT fold_id,model_name,source_cohort_id,source_manifest_checksum,artifact_path,artifact_checksum,artifact_rows,prediction_dates,train_start,train_end,test_start,test_end,target_semantic_version,score_semantic_version FROM active8_oof_fold_artifacts WHERE cohort_id=? ORDER BY fold_id,model_name", [manifest['cohort_id']])
    if (len(cohort) != 1 or cohort[0]['status'] != 'ready'
            or cohort[0]['artifact_manifest_checksum'] != manifest['manifest_checksum']
            or cohort[0]['completed_folds'] != len(manifest['windows'])
            or cohort[0]['expected_folds'] != len(manifest['windows'])
            or cohort[0]['expected_models'] != len(manifest['model_set'])
            or len(folds) != len(manifest['windows']) * len(manifest['model_set'])):
        raise ValueError('l4_native_index_projection_incomplete')
    return digest({'cohort': cohort, 'folds': folds})


def reuse_index(manifest, bucket, client):
    blob = bucket.blob(_path(manifest))
    if not blob.exists():
        return None
    receipt = json.loads(blob.download_as_bytes())
    unsigned = {k:v for k,v in receipt.items() if k != 'checksum'}
    if (receipt.get('checksum') != digest(unsigned)
            or receipt.get('manifest_checksum') != manifest['manifest_checksum']
            or receipt.get('cohort_id') != manifest['cohort_id']
            or receipt.get('schema') != 'native-index-receipt-v1'
            or receipt.get('projection_checksum') != _projection(manifest, client)):
        raise ValueError('l4_native_index_receipt_mismatch')
    return receipt['index']


def seal_index(manifest, index, bucket, client):
    receipt = {'schema': 'native-index-receipt-v1', 'cohort_id': manifest['cohort_id'],
               'manifest_checksum': manifest['manifest_checksum'], 'index': index,
               'projection_checksum': _projection(manifest, client)}
    receipt['checksum'] = digest(receipt)
    blob = bucket.blob(_path(manifest))
    raw = json.dumps(receipt, sort_keys=True)
    try:
        blob.upload_from_string(raw, content_type='application/json', if_generation_match=0)
    except PreconditionFailed:
        if json.loads(blob.download_as_bytes()) != receipt:
            raise ValueError('l4_native_index_receipt_conflict')
    if reuse_index(manifest, bucket, client) != index:
        raise ValueError('l4_native_index_receipt_readback_failed')
