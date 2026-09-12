"""Original NAV -> publisher -> serving readers. Synthetic transport, NOT ROI."""
from copy import deepcopy
import json

import pytest

from services import model_artifact_registry as registry, model_serving_resolver as resolver
from services import active8_nav_adoption as authority
from services.paired_nav_journal import digest
from test_nav_l3_adoption import ready, publish
from test_paired_nav_l3_candidate import prepared
from test_paired_nav_candidate_collection import environment
from test_nav_l3_mature_evidence import stamp, SESSIONS


def test_original_bundle_reader_accepts_committed_nav_without_rewriting_offline_fail(ready):
    client, candidate, nav, *_ = ready
    publish(ready)
    before = client.query('SELECT * FROM paired_nav_review_records_v1 ORDER BY record_id')
    bundle = registry.load_active8_ensemble_serving_bundle()
    assert bundle['status'] == 'production', bundle
    assert bundle['artifact_id'] == candidate['artifact_id']
    assert bundle['adoption_basis'] == 'committed_paired_nav'
    assert bundle['nav_decision_checksum'] == nav['decision_checksum']
    assert client.query('SELECT validation_decision FROM active8_ensemble_artifacts_v1 WHERE artifact_id=?',
                        [candidate['artifact_id']])[0]['validation_decision'] == 'FAIL'
    assert client.query('SELECT * FROM paired_nav_review_records_v1 ORDER BY record_id') == before
    assert client.batches == 1


def test_original_pool_reader_uses_nav_only_for_exact_selected_models(ready):
    client, candidate, *_ = ready
    publish(ready)
    pool = resolver.load_d1_champion_pool(sidecar_models=())
    artifact = json.loads(candidate['payload_json'])
    for name in artifact['selected_models']:
        entry = pool['models'][name]
        assert entry['serving_eligible'], entry
        assert entry['serving_artifact_id'] == artifact['base_artifacts'][name]['artifact_id']
        assert entry['offline_gate_decision'] == 'FAIL'
        assert entry['serving_ic_prior'] is None  # NAV does not invent individual IC.
        assert entry['efficacy_owner'] == 'committed_paired_nav'
    assert client.batches == 1


@pytest.mark.parametrize('fault', ['receipt', 'review', 'history', 'pointer', 'configuration', 'clock'])
def test_committed_nav_cannot_serve_with_broken_authority(ready, fault):
    client, candidate, _, _, current = ready
    publish(ready)
    pointer = client.query('SELECT * FROM active8_ensemble_pointer_v1')[0]
    if fault in {'receipt', 'review'}:
        receipt = json.loads(pointer['promotion_evidence_json'])
        nav = receipt['nav_validation']
        if fault == 'receipt':
            nav['candidate_checksum'] = '1' * 64
        else:
            nav['review_record_checksum'] = '1' * 64
        body = {k: v for k, v in nav.items() if k not in ('decision_checksum','decision_payload_json')}
        nav.update(decision_checksum=digest(body), decision_payload_json=json.dumps(body, sort_keys=True))
        raw = json.dumps(receipt)
        # Even a coordinated edit of all mutable receipts cannot replace the
        # immutable original family review or change the reviewed artifact.
        client.conn.execute('UPDATE active8_ensemble_pointer_v1 SET promotion_evidence_json=?', [raw])
        client.conn.execute('UPDATE model_champion_pointers SET promotion_evidence_json=? WHERE promotion_evidence_json IS NOT NULL', [raw])
        client.conn.execute('UPDATE model_champion_history SET evidence_json=?', [raw])
    elif fault == 'history':
        client.conn.execute("UPDATE model_champion_history SET evidence_grade='unknown'")
    elif fault == 'pointer':
        client.conn.execute("UPDATE model_champion_pointers SET champion_version='wrong'")
    elif fault == 'configuration':
        current['risk_config']['changed_after_publication'] = True
    else:
        client.conn.execute("UPDATE active8_ensemble_pointer_v1 SET promoted_at='2026-09-22 14:00:00'")
    client.conn.commit()
    with pytest.raises((ValueError, RuntimeError)):
        resolver.load_d1_champion_pool(sidecar_models=())
    assert registry.load_active8_ensemble_serving_bundle()['production_effect'] is False
    assert client.batches == 1


@pytest.mark.parametrize('fault', ['extension', 'feature', 'sequence', 'archived'])
def test_nav_does_not_authorize_structurally_unusable_base_artifacts(ready, fault):
    client, candidate, *_ = ready
    model = 'DLinear' if fault == 'sequence' else 'LightGBM'
    identity = json.loads(candidate['payload_json'])['base_artifacts'][model]
    row = client.query('SELECT * FROM model_artifact_registry WHERE artifact_id=?', [identity['artifact_id']])[0]
    if fault == 'extension':
        client.conn.execute('UPDATE model_artifact_registry SET artifact_path=? WHERE artifact_id=?',
                            ['test://wrong.exe', identity['artifact_id']])
    elif fault == 'archived':
        client.conn.execute("UPDATE model_artifact_registry SET state='archived' WHERE artifact_id=?", [identity['artifact_id']])
    else:
        evidence = json.loads(row['offline_evidence_json'])
        evidence['registration']['metadata'].pop('seq_len' if fault == 'sequence' else 'feature_semantic_version')
        client.conn.execute('UPDATE model_artifact_registry SET offline_evidence_json=? WHERE artifact_id=?',
                            [json.dumps(evidence), identity['artifact_id']])
    client.conn.commit()
    before = client.query('SELECT * FROM active8_ensemble_pointer_v1')
    result = publish(ready)
    assert result['can_promote'] is False and result['blockers']
    assert client.batches == 0 and client.query('SELECT * FROM active8_ensemble_pointer_v1') == before


def test_json_pass_is_not_a_process_local_serving_grant():
    with pytest.raises(ValueError, match='active8_nav_serving_grant_not_original'):
        resolver.build_pool_from_champion_pointers(pointers=[], artifacts=[], nav_grant={'decision':'PASS'})


def test_historical_publication_is_not_a_live_serving_grant_or_drift_permission(ready):
    client, _, _, _, current = ready
    publish(ready)
    current['risk_config']['changed_after_publication'] = True
    publication = authority.load_committed_nav_publication(query=client.query)
    assert publication is not None and not authority.is_serving_grant(publication)
    with pytest.raises(ValueError, match='active8_nav_serving_grant_not_original'):
        resolver.build_pool_from_champion_pointers(pointers=[], artifacts=[], nav_grant=publication)
    with pytest.raises(RuntimeError, match='active8_nav_current_configuration_changed_or_unverified'):
        authority.load_committed_nav_serving_grant(query=client.query)


def test_historical_nav_is_not_rejudged_or_respent_on_next_serving_day(ready, monkeypatch):
    client, _, nav, *_ = ready
    publish(ready)
    before = client.query('SELECT * FROM paired_nav_review_records_v1 ORDER BY record_id')
    monkeypatch.setattr(authority, 'read_nav_candidate_decision',
        lambda **kw: (_ for _ in ()).throw(AssertionError('must not rerun a committed review')))
    grant = authority.load_committed_nav_serving_grant(query=client.query, now=stamp('2026-09-22'))
    assert json.loads(grant.receipt_json)['nav_validation'] == nav
    assert client.query('SELECT * FROM paired_nav_review_records_v1 ORDER BY record_id') == before
    assert client.batches == 1


@pytest.mark.parametrize('fault', ['metadata_snapshot', 'pointer_snapshot', 'unselected_model'])
def test_verified_grant_cannot_be_reused_for_other_or_stale_pool_inputs(ready, fault):
    client, candidate, *_ = ready
    publish(ready)
    grant = authority.load_committed_nav_serving_grant(query=client.query)
    pointers = registry.list_champion_pointers()
    artifacts = registry.list_artifacts_by_ids([p['champion_artifact_id'] for p in pointers], max_ids=8)
    name = json.loads(candidate['payload_json'])['selected_models'][0]
    artifact = next(row for row in artifacts if row['model_name'] == name)
    if fault == 'unselected_model':
        assert not grant.authorizes('TimesFM', artifact)
        assert not grant.authorizes('Unrelated', artifact)
        return
    if fault == 'metadata_snapshot':
        artifact['offline_evidence_json']['registration']['metadata']['seq_len'] += 1
    else:
        pointer = next(row for row in pointers if row['model_name'] == name)
        pointer['promotion_evidence_json'] = '{}'
    pool = resolver.build_pool_from_champion_pointers(pointers=pointers, artifacts=artifacts,
        sidecar_models=(), nav_grant=grant)
    assert pool['models'][name]['serving_eligible'] is False
    assert pool['models'][name]['serving_block_reason'] == 'active8_nav_serving_snapshot_mismatch'


def test_serving_grant_rechecks_sources_after_loading_review(ready):
    client, *_ = ready
    publish(ready)
    changed = False
    def racing_query(sql, params=None):
        nonlocal changed
        result = client.query(sql, params)
        if not changed and 'paired_nav_review_records_v1' in sql and sql.startswith('SELECT *'):
            changed = True
            client.conn.execute("UPDATE model_champion_pointers SET champion_version='concurrent-change'")
            client.conn.commit()
        return result
    with pytest.raises(RuntimeError, match='active8_bundle_committed_receipt_invalid'):
        authority.load_committed_nav_serving_grant(query=racing_query)
    assert changed and client.batches == 1
