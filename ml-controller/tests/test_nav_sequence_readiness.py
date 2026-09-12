"""Readiness shares runtime structure and original NAV authority; no ROI."""
import asyncio
from copy import deepcopy
import json

import pytest

from routers import model_pool
from services import model_artifact_registry as registry
from test_nav_l3_adoption import ready, publish
from test_paired_nav_l3_candidate import prepared
from test_paired_nav_candidate_collection import environment


def test_original_nav_offline_fail_still_has_truthful_readiness(ready, monkeypatch):
    client, candidate, *_ = ready
    publish(ready)
    monkeypatch.setattr(model_pool, 'list_champion_pointers', registry.list_champion_pointers)
    monkeypatch.setattr(model_pool, 'list_artifact_registry', registry.list_artifact_registry)
    monkeypatch.setattr(model_pool, 'load_active8_ensemble_serving_bundle', registry.load_active8_ensemble_serving_bundle)
    result = asyncio.run(model_pool.artifact_registry_champion_pointers())
    assert result['migration_ready'] is True
    assert result['ready_count'] == len(json.loads(candidate['payload_json'])['selected_models'])
    assert result['active8_bundle']['adoption_basis'] == 'committed_paired_nav'
    assert result['active8_bundle']['qualifications']['ranking']['decision'] == 'FAIL'
    assert result['active8_bundle']['qualifications']['source_payload_checksum'] == json.loads(candidate['payload_json'])['payload_checksum']
    assert all(row['serving_block_reason'] is None for row in result['models'].values())
    # Pagination is presentation only; do not lose runtime membership evidence.
    filtered = asyncio.run(model_pool.artifact_registry_champion_pointers(model_name='DLinear', limit=1))
    assert filtered['ready_count'] == result['ready_count']
    assert filtered['migration_ready'] is True
    assert client.batches == 1


def test_missing_sequence_semantics_block_offline_diagnostic_before_write(monkeypatch):
    from test_active8_ensemble_bundle_promotion import _fixture, AtomicD1
    rows, pointers, ensemble = _fixture()
    model = next(row for row in rows if row['model_name'] == 'DLinear')
    evidence = json.loads(model['offline_evidence_json'])
    evidence['registration']['metadata'].pop('rank_ic_semantic_version')
    model['offline_evidence_json'] = json.dumps(evidence)
    before = deepcopy(rows)
    db = AtomicD1(rows, ensemble)
    monkeypatch.setattr(registry, 'd1_client', db)
    result = registry.run_active8_ensemble_bundle_promotion_controller(training_run_id='run-new',
        registry_rows=rows, d1_pointers=pointers, ensemble_rows=[ensemble], confirm=False)
    assert result['can_promote'] is False
    assert 'DLinear:artifact_sequence_contract_missing_or_invalid' in result['blockers']
    assert rows == before and db.statements is None


def test_empty_bundle_cannot_report_migration_ready(monkeypatch):
    monkeypatch.setattr(model_pool, 'list_champion_pointers', lambda **kwargs: [])
    monkeypatch.setattr(model_pool, 'list_artifact_registry', lambda **kwargs: [])
    monkeypatch.setattr(model_pool, 'load_active8_ensemble_serving_bundle',
        lambda: {'status': 'production', 'production_effect': True, 'base_artifacts': {}})
    result = asyncio.run(model_pool.artifact_registry_champion_pointers())
    assert result['migration_ready'] is False and result['ready_count'] == 0
