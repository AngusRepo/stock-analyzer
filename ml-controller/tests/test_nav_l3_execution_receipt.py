"""Original NAV publication/math/writer with private SQL; not economic evidence."""
from copy import deepcopy
import asyncio
import json
from pathlib import Path
import re

import pytest

from services import active8_nav_execution as execution, ensemble_v2 as ensemble
from services import recommendation_service as writer
from services.active8_nav_inference import restore_frozen_nav_inference
from test_nav_l3_frozen_inference import frozen, ready, prepared, environment
from test_pipeline_terminal_truth import _closed_metrics, _closed_nav
from graphs import daily_pipeline_v2 as graph


@pytest.fixture
def persisted(frozen, monkeypatch):
    original, pool, artifact, manifest, _ = frozen
    db = original[0]
    schema = (Path(__file__).parents[2] / 'worker/domain-schemas/learning.sql').read_text(encoding='utf-8')
    db.conn.executescript(re.search(r'CREATE TABLE IF NOT EXISTS predictions \([\s\S]*?\n\);', schema).group())
    from nav_bundle_sqlite import ensure_prediction_schema
    ensure_prediction_schema(db.conn)
    control = {'fault': None, 'writes': 0}
    def sql_clock(sql):
        return sql.replace("datetime('now')", "'2026-09-22 12:00:00'")
    def query(sql, params=None, timeout=None):
        return db.query(sql_clock(sql), params)
    def batch(statements):
        control['writes'] += 1
        for sql, params in statements:
            db.conn.execute(sql_clock(sql), params)
        if control['fault'] == 'drop':
            db.conn.execute("DELETE FROM predictions WHERE stock_id=1 AND model_name='ensemble'")
        elif control['fault'] == 'output':
            db.conn.execute("UPDATE predictions SET forecast_data=json_set(forecast_data,'$.ensemble_v2.ml_expected_net_return',42) WHERE stock_id=1 AND model_name='ensemble'")
        elif control['fault'] == 'time':
            db.conn.execute("UPDATE predictions SET generated_at='2026-08-01 00:00:00' WHERE model_name='ensemble'")
        db.conn.commit()
        return {'success_count': len(statements), 'error_count': 0}
    monkeypatch.setattr(writer, '_predictions_batch_execute', batch)
    monkeypatch.setattr(writer, '_predictions_query', query)
    from services.active8_score_semantics import MODEL_SCORE_LINEAGE_SCHEMA_VERSION, MODEL_SCORE_SEMANTIC_VERSION, MODEL_TARGET_SEMANTIC_VERSION
    grant = restore_frozen_nav_inference(manifest['active8_nav_inference'], artifact=artifact, pool_models=pool['models'])
    predictions = {}
    for index, symbol in enumerate(('2330','2317')):
        row = {'rank_scores': {name: .6 + index*.1 for name in ensemble.ACTIVE_ALPHA_MODELS},
            'feature_version': 'isolated-canonical', 'model_score_lineage': {
                'schema_version': MODEL_SCORE_LINEAGE_SCHEMA_VERSION, 'semantic_version': MODEL_SCORE_SEMANTIC_VERSION,
                'target_semantic_version': MODEL_TARGET_SEMANTIC_VERSION, 'complete': True, 'blockers': []}}
        ensemble.attach_ensemble_v2(row, artifact, pool['models'], nav_authority=grant)
        predictions[symbol] = row
    receipt = execution.attach_execution_receipt(predictions=predictions, manifest=manifest,
        pool_models=pool['models'], run_id='isolated-original-pipeline', run_date='2026-09-22')
    return db, predictions, receipt, query, control, manifest, original


def test_original_writer_readback_and_retry_close_same_execution(persisted):
    db, predictions, receipt, query, control, *_ = persisted
    observations = []
    count = writer.write_predictions_to_d1(predictions, {'2330':1,'2317':2}, '2026-09-22', execution_sink=observations.append)
    assert count >= 2 and len(observations) == 1
    observed = execution.read_execution(query=query, receipt=receipt)
    assert observations[0] == observed and observed['executed'] and observed['nav_maturity_credit'] == 0
    before = db.query("SELECT stock_id,model_name,forecast_data FROM predictions ORDER BY stock_id,model_name")
    writer.write_predictions_to_d1(predictions, {'2330':1,'2317':2}, '2026-09-22')
    assert execution.read_execution(query=query, receipt=receipt) == observed
    assert db.query("SELECT stock_id,model_name,forecast_data FROM predictions ORDER BY stock_id,model_name") == before
    assert control['writes'] == 2


@pytest.mark.parametrize('fault', ['drop','output','time'])
def test_successful_batch_ack_cannot_hide_bad_nav_rows(persisted, fault):
    _, predictions, _, _, control, *_ = persisted
    control['fault'] = fault
    observations = []
    with pytest.raises(ValueError, match='active8_nav_execution_'):
        writer.write_predictions_to_d1(predictions, {'2330':1,'2317':2}, '2026-09-22', execution_sink=observations.append)
    assert control['writes'] == 1 and not observations


def test_changed_l3_output_rejected_before_writes_but_l4_append_allowed(persisted):
    _, predictions, _, _, control, *_ = persisted
    predictions['2330']['ensemble_v2']['l4_alpha_ev'] = {'owner': 'l4', 'value': -.1}
    writer.write_predictions_to_d1(predictions, {'2330':1,'2317':2}, '2026-09-22')
    predictions['2330']['ensemble_v2']['signal'] = 'FORGED'
    with pytest.raises(ValueError, match='output_changed_before_write'):
        writer.write_predictions_to_d1(predictions, {'2330':1,'2317':2}, '2026-09-22')
    assert control['writes'] == 1


def test_terminal_cannot_claim_nav_execution_from_counts_only(persisted):
    _, predictions, receipt, query, _, manifest, _ = persisted
    state = {'metrics': _closed_metrics(), 'errors': [], 'paired_nav_collection': _closed_nav(),
        'nav_inference_receipt': receipt,
        'pipeline_modal_serving_context': {'serving_manifest': manifest}}
    result = graph._pipeline_terminal_result(state, run_date='2026-09-22', elapsed=1)
    assert result['status'] == 'error'
    assert 'pipeline_terminal_invariant:nav_inference_execution_unverified' in result['terminal_invariant_errors']
    writer.write_predictions_to_d1(predictions, {'2330':1,'2317':2}, '2026-09-22')
    state['metrics']['active8_nav_execution'] = execution.read_execution(query=query, receipt=receipt)
    assert graph._pipeline_terminal_result(state, run_date='2026-09-22', elapsed=1)['status'] == 'completed'
    state.pop('pipeline_modal_serving_context')
    assert graph._pipeline_terminal_result(state, run_date='2026-09-22', elapsed=1)['status'] == 'error'


def test_original_write_node_projects_verified_receipt(persisted, monkeypatch):
    _, predictions, receipt, _, _, manifest, _ = persisted
    seeds = [{'symbol': s, 'id': i+1} for i, s in enumerate(predictions)]
    state = {'run_date': '2026-09-22', 'predictions': predictions, 'nav_inference_receipt': receipt,
        'active_stocks': seeds, 'screener_recs': seeds, 'final_recommendations': seeds,
        'pipeline_modal_serving_context': {'schema_version': 'pipeline-modal-serving-context-v1',
            'serving_manifest': manifest, 'serving_manifest_digest': graph._pipeline_modal_canonical_digest(manifest)}}
    # Replace unrelated recommendation/audit I/O, not inference persistence or readback.
    for name, count in (('prune_predictions_outside_universe',0), ('write_layer2_timesfm_enrichment_audit',2),
                        ('write_layer3_formal_gate_audit',2), ('update_recommendations_in_d1',2),
                        ('delete_filtered_recommendations',0), ('re_rank_recommendations',0)):
        monkeypatch.setattr(graph, name, lambda *a, _count=count, **k: _count)
    result = asyncio.run(graph.node_write_d1(state))
    assert result['metrics']['active8_nav_execution']['readback_verified'] is True
    assert result['metrics']['active8_nav_execution']['execution_checksum'] == receipt['execution_checksum']
    assert result['metrics']['active8_nav_execution']['nav_maturity_credit'] == 0


def test_daily_recovery_observes_original_persisted_inference_without_respending(persisted, monkeypatch):
    from services.paired_nav_daily_adoption import run_daily_ev_adoption
    from test_nav_l3_daily_publication import candidate_entry
    from routers import model_pool
    db, predictions, _, _, _, _, original = persisted
    monkeypatch.setattr(model_pool, 'LEARNING_D1_CLIENT', db)
    before = db.query('SELECT * FROM paired_nav_review_records_v1 ORDER BY record_id')
    writer.write_predictions_to_d1(predictions, {'2330':1,'2317':2}, '2026-09-22')
    entry = candidate_entry(original, state='production')
    entry['payload']['evaluation_business_date'] = '2026-09-22'  # Daily request, not a rewrite of original NAV evidence.
    result = asyncio.run(run_daily_ev_adoption(candidates=[entry], business_date='2026-09-22'))
    assert result['status'] == 'completed', result
    assert result['ensemble']['completion_scope'] == 'publication'
    assert result['ensemble']['serving_activation_verified'] is True
    assert result['ensemble']['inference']['observation_scope'] == 'persisted_inference_only'
    assert result['ensemble']['inference']['executed'] is True
    assert result['ensemble']['inference']['nav_maturity_credit'] == 0
    assert db.batches == 1 and db.query('SELECT * FROM paired_nav_review_records_v1 ORDER BY record_id') == before


def test_readback_exhausts_transport_pages_not_a_symbol_cap(persisted, frozen):
    _, predictions, _, query, _, manifest, _ = persisted
    _, pool, *_ = frozen
    many = {f'{i:04d}': deepcopy(predictions['2330']) for i in range(83)}
    receipt = execution.attach_execution_receipt(predictions=many, manifest=manifest,
        pool_models=pool['models'], run_id='full-universe-83', run_date='2026-09-22')
    writer.write_predictions_to_d1(many, {s:i+1 for i,s in enumerate(many)}, '2026-09-22')
    assert execution.read_execution(query=query, receipt=receipt)['symbol_count'] == 83


def test_removed_nav_marker_cannot_downgrade_to_unverified_legacy_write(persisted):
    _, predictions, _, _, control, *_ = persisted
    for row in predictions.values():
        row['ensemble_v2'].pop('adoption_basis')
    with pytest.raises(ValueError, match='active8_nav_execution_'):
        writer.write_predictions_to_d1(predictions, {'2330':1,'2317':2}, '2026-09-22')
    assert control['writes'] == 0
