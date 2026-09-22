"""Cold prediction history with hot-row precedence and explicit incomplete-release errors.

Dates are never shortened to the online retention window. Reads are bounded by
one immutable chunk, and only successful exact deletion receipts are accepted.
"""
from __future__ import annotations
import json,hashlib
from services.retention_archive import download_archive,verify_archive
from services.d1_domain_client import client_proxy_for_domain
OPS=client_proxy_for_domain('ops')
LEARNING=client_proxy_for_domain('learning')

def archived_predictions(start_date, end_date, *, date_column='prediction_date', model_name=None,
                         stock_ids=None, hot_ids=(), query_ops=None, query_hot=None, download=None):
    if date_column not in {'prediction_date','generated_at'}:
        raise ValueError('retention_prediction_date_column_invalid')
    ops=query_ops or OPS.query;hot=query_hot or LEARNING.query;fetch=download or download_archive
    known=set(hot_ids);seen={};last=''
    wanted_stocks=None if stock_ids is None else set(stock_ids)
    while True:
        manifests=ops("""SELECT a.artifact_id,a.domain,a.schema_version,a.checksum,a.row_count,
           a.metadata_json,a.created_at,
           (SELECT MAX(i.completed_at) FROM data_retention_run_items i
             WHERE i.status='success' AND i.deleted_rows=a.row_count
               AND CASE WHEN json_valid(i.evidence_json) THEN json_extract(i.evidence_json,'$.artifact_id') END=a.artifact_id) release_verified_at
           FROM run_artifacts a
           WHERE a.domain='retention_learning_lineage_v1_predictions'
             AND a.schema_version='d1-retention-hot-window-drain-v1'
             AND a.retention_class='ten_year_cold_archive' AND a.status='ready'
             AND a.payload_deleted_at IS NULL AND a.artifact_id>?
           ORDER BY a.artifact_id LIMIT 100""",[last])
        if not manifests:return
        for manifest in manifests:
            last=manifest['artifact_id']
            metadata=json.loads(manifest.get('metadata_json') or '{}')
            if date_column=='prediction_date' and metadata.get('coverage_start') and metadata.get('coverage_end'):
                if metadata['coverage_start']>end_date[:10] or metadata['coverage_end']<start_date[:10]:continue
            payload=verify_archive(fetch(manifest),manifest)
            if payload['dataset_id']!='predictions' or payload['source_domain']!='learning':
                raise ValueError('retention_prediction_source_mismatch')
            relevant=[]
            for row in payload['rows']:
                when=str(row.get(date_column) or '')
                # SQL BETWEEN on generated_at uses the exact caller bounds.
                if not start_date<=when<=end_date:continue
                if model_name is not None and row.get('model_name')!=model_name:continue
                if wanted_stocks is not None and row.get('stock_id') not in wanted_stocks:continue
                if type(row.get('id')) is not int or row['id']!=row['__cursor_key']:
                    raise ValueError('retention_prediction_identity_invalid')
                if row['id'] not in known:relevant.append(row)
            if not relevant:continue
            present={r['id'] for r in hot('SELECT id FROM predictions WHERE id IN (SELECT value FROM json_each(?))',
                                        [json.dumps([r['id'] for r in relevant])])}
            for row in relevant:
                if row['id'] in present:continue  # Updated/recovered online data remains authoritative.
                if not manifest.get('release_verified_at'):
                    raise RuntimeError('retention_prediction_release_receipt_incomplete:'+manifest['artifact_id'])
                clean={k:v for k,v in row.items() if k not in {'__cursor_key','__archive_date'}}
                key=row['id']
                encoded=hashlib.sha256(json.dumps(clean,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).digest()
                if key in seen:
                    if seen[key]!=encoded:raise RuntimeError('retention_prediction_archive_revision_conflict')
                    continue
                seen[key]=encoded
                yield clean
        if len(manifests)<100:return
