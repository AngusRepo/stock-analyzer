import json
import sqlite3
from services import model_artifact_registry as registry
from services.model_pool_registry_view import list_workbench_artifacts
from services.verified_read_observation import verified_read_observation, observed_read
import pytest


def test_builders_equal_for_historical_latest_pointer_and_pending_rows(monkeypatch):
    db = sqlite3.connect(':memory:')
    db.row_factory = sqlite3.Row
    fields = ['artifact_id','model_name','version','candidate_type','state','source_run_date',
              'updated_at','created_at','live_gate_status','offline_gate_decision',
              'offline_evidence_json','live_evidence_json','offline_gate_failed_gates','future_column']
    db.execute('CREATE TABLE model_artifact_registry (' + ','.join(k + ' TEXT' for k in fields) + ')')
    for i in range(40):
        row = dict.fromkeys(fields)
        row.update(artifact_id=str(i), model_name='LightGBM' if i % 2 else 'retired_model',
            version=f'202609{i:02}', source_run_date='2026-09-24', updated_at=str(i).zfill(3),
            created_at=str(i).zfill(3), state=['production','archived','shadowing','registered'][i % 4],
            candidate_type=['oof_full_fit_release','manual_hotfix','legacy'][i % 3],
            offline_evidence_json=json.dumps({'registration':{'unused':'large' * 1000}}),
            live_evidence_json='{}', offline_gate_failed_gates='[]')
        db.execute('INSERT INTO model_artifact_registry VALUES(' + ','.join('?' for _ in fields) + ')', [row[k] for k in fields])
    def query(sql, args):
        return [dict(r) for r in db.execute(sql, args)]
    monkeypatch.setattr(registry.d1_client, 'query', query)
    pointers = [{'model_name':'LightGBM','champion_artifact_id':'1','champion_version':'20260901'}]
    original = registry.list_artifact_registry(limit=200)
    view = list_workbench_artifacts(pointers=pointers)
    assert len(view) == len(original)
    assert len(json.dumps(view)) < len(json.dumps(original))
    assert registry.build_candidate_selection(view, champion_pointers=pointers) == registry.build_candidate_selection(original, champion_pointers=pointers)
    assert registry.build_promotion_queue(view, champion_versions={'LightGBM':'20260901'}) == registry.build_promotion_queue(original, champion_versions={'LightGBM':'20260901'})
    db.close()


def test_schema_or_index_drift_still_fails_fresh_observation(monkeypatch):
    rows = [{'artifact_id':'a','model_name':'LightGBM','candidate_type':'legacy','future_column':None}]
    def query(sql, args):
        def fetch():
            if sql.startswith('PRAGMA'): return [{'name':k} for k in rows[0]]
            return [dict(r) for r in rows]
        return observed_read((sql, tuple(args)), sql, fetch)
    monkeypatch.setattr(registry.d1_client, 'query', query)
    with pytest.raises(RuntimeError, match='observation_changed'), verified_read_observation():
        list_workbench_artifacts(pointers=[])
        rows[0]['future_column'] = 'changed'
