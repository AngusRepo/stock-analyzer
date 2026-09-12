"""Retired five-model feature-era writer cannot change canonical ensemble bases."""
import asyncio

import pytest

from services import model_artifact_registry as registry
from routers import model_pool
from test_active8_bundle_transaction import bundle, state
from test_nav_l3_adoption import ready, prepared, environment


@pytest.mark.parametrize('confirm,approved', [(False, False), (True, False), (True, True)])
def test_feature_era_writer_has_no_separate_publication_authority(bundle, confirm, approved):
    db, rows, pointers, _ = bundle
    feature_rows = [{**row, 'candidate_type': 'timesfm_l175_l2_feature_release'} for row in rows
                    if row['model_name'] in registry.TIMESFM_L175_RELEASE_COHORT]
    before = state(db)
    result = registry.run_feature_release_promotion_controller(training_run_id='run-new',
        registry_rows=feature_rows, d1_pointers=pointers, confirm=confirm, approved=approved)
    assert result['decision'] == 'feature_era_publication_retired_use_canonical_ensemble', result
    assert result['publication_owner'] == 'daily_paired_nav' and result['can_promote'] is False
    assert state(db) == before and db.batches == 0


def test_legacy_feature_api_reports_retired_without_moving_incumbent(bundle, monkeypatch):
    db, rows, *_ = bundle
    before = state(db)
    monkeypatch.setattr(model_pool, 'list_artifact_registry', lambda **kw: rows)
    req = model_pool.FeatureReleasePromotionControllerRequest(training_run_id='run-new', confirm=True,
                                                              approved=True, approved_by='fixture')
    result = asyncio.run(model_pool.artifact_registry_feature_release_promotion_controller(req))
    assert result['status'] == 'retired' and result['readback_verified'] is False
    assert result['can_promote'] is False and state(db) == before and db.batches == 0
