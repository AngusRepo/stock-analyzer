"""Exercise the real refresh entrypoint up to, but never through, paid dispatch."""
import pytest
from types import SimpleNamespace

@pytest.mark.parametrize('profile,accepted', [
    ('active8-release-model-profiles-v6-timexer-exo131',True),
    ('active8-release-model-profiles-v4-timexer-exo137',True),
    ('active8-release-model-profiles-v6-timexer-price131',False),
    ('unknown',False),
])
def test_exact_exogenous_profiles_reach_dispatch_boundary(monkeypatch,profile,accepted):
    from scripts import l4_distribution_refresh_job as job
    from services import active8_oof_cohort_materializer as materializer
    from services import training_source_preflight,walk_forward_retrain,d1_domain_client,l4_tabpack_dispatch
    from services.alpha_model_roster import TIMEXER_MODELS
    monkeypatch.setenv('STOCKVISION_SOURCE_SHA','a'*40)
    monkeypatch.setattr(job,'load_target_parent',lambda *a:({'cohort_id':'new131','model_order':list(TIMEXER_MODELS)}, {'artifact_id':'new'}))
    monkeypatch.setattr(job,'training_recipe_signature',lambda:'b'*64)
    monkeypatch.setattr(d1_domain_client,'client_proxy_for_domain',lambda *_:object())
    monkeypatch.setattr(walk_forward_retrain,'_get_bucket',lambda:object())
    manifest={'manifest_checksum':'c'*64,'model_profile_schema_version':profile}
    monkeypatch.setattr(materializer,'load_verified_oof_manifest',lambda *a,**k:(manifest,{}))
    calls=[]
    monkeypatch.setattr(training_source_preflight,'require_oof_training_sources',lambda *a:calls.append('source_gate'))
    def boundary(*args):
        calls.append('dispatch_boundary')
        return {'status':'pending','promoted':False}
    monkeypatch.setattr(l4_tabpack_dispatch,'dispatch',boundary)
    if accepted:
        assert job.execute(as_of='2026-10-10',cadence='monthly',target_l3_artifact_id='new',strategy_role='B',model_family='tabpack')['status']=='pending'
        assert calls==['source_gate','dispatch_boundary']
    else:
        with pytest.raises(ValueError,match='requires_exogenous_B_oof_profile'):
            job.execute(as_of='2026-10-10',cadence='monthly',target_l3_artifact_id='new',strategy_role='B',model_family='tabpack')
        assert calls==['source_gate']
