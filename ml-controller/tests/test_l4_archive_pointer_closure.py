import json
import sqlite3

import pytest

from services.active8_oof_cohort_materializer import load_native_pit_component_rows
from services.worker_evidence_archive_client import resolve_legacy_screener_evidence


def test_generic_pointer_reaches_verified_resolver_and_preserves_source_time():
    db = sqlite3.connect(':memory:')
    db.row_factory = sqlite3.Row
    db.executescript('''
        CREATE TABLE screener_funnel_runs(run_id TEXT,date TEXT,status TEXT,created_at TEXT);
        CREATE TABLE screener_funnel_items(id INTEGER,run_id TEXT,symbol TEXT,stage TEXT,evidence TEXT,score_after REAL);
        CREATE TABLE stocks(id INTEGER,symbol TEXT,market TEXT);
        INSERT INTO stocks VALUES(1,'2330','LISTED');
        INSERT INTO screener_funnel_runs VALUES('source-run','2026-07-30','success','2026-07-30 14:35:29');
    ''')
    pointer = {'schema_version': 'd1-audit-json-pointer-v1', 'table': 'screener_funnel_items',
               'key_column': 'id', 'key_value': 1, 'blob_column': 'evidence', 'snapshot_id': 'snapshot',
               'r2_key': 'archive', 'checksum': 'sha256:'+'a'*64}
    db.execute('INSERT INTO screener_funnel_items VALUES(?,?,?,?,?,?)',
               (1,'source-run','2330','scoring',json.dumps(pointer),12))
    calls = []
    def query(sql, params=None):
        if 'FROM daily_recommendations' in sql:
            return []
        if 'FROM finlab_source_sessions_v1' in sql:
            return [{'trading_date': d,'price_rows': 1000} for d in ['2026-07-30','2026-07-31']]
        return [dict(r) for r in db.execute(sql, params or [])]
    def resolve(requests):
        calls.extend(requests)
        return {1: {'artifact_id': 'snapshot', 'r2_key': 'archive', 'checksum': pointer['checksum'],
                    'evidence': json.dumps({'score_components': {'version': 'score_v2', 'components': {
                        'chipFlow': 4, 'technicalStructure': 8, 'fundamentalQuality': 0}}})}}
    try:
        rows = load_native_pit_component_rows([{'prediction_date':'2026-07-30','symbol':'2330'}],
                                              query_fn=query, archive_resolver=resolve)
    finally:
        db.close()
    assert len(rows) == len(calls) == 1
    assert calls[0]['snapshot_id'] == 'snapshot'
    context = json.loads(rows[0]['alpha_context'])
    assert context['native_created_at'] == '2026-07-30 14:35:29'
    assert context['native_evidence_artifact_id'] == 'snapshot'


def test_generic_client_carries_snapshot_identity_and_rejects_response_mismatch():
    pointer = {'schema_version':'d1-audit-json-pointer-v1','snapshot_id':'snapshot','row_id':1,
               'r2_key':'archive','checksum':'sha256:'+'a'*64,'source_run_id':'source','symbol':'2330'}
    def post(body):
        request = body['artifacts'][0]
        assert request['snapshot_id'] == request['artifact_id'] == 'snapshot'
        return {'rows':[{**pointer,'artifact_id':'snapshot','stage':'scoring','evidence':'{}'}]}
    assert resolve_legacy_screener_evidence([pointer],post_fn=post)[1]['artifact_id'] == 'snapshot'
    with pytest.raises(RuntimeError,match='row_mismatch'):
        resolve_legacy_screener_evidence([pointer],post_fn=lambda _: {
            'rows':[{**pointer,'artifact_id':'wrong','stage':'scoring','evidence':'{}'}]})
