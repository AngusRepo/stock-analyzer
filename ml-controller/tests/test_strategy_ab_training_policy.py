from copy import deepcopy
from datetime import date, timedelta
import pytest

from services.active8_release_model_profiles import (
    TIMEXER_PRICE_PROFILE_SCHEMA, TIMEXER_EXO_PROFILE_SCHEMA, model_profiles)


@pytest.mark.parametrize("schema", [TIMEXER_PRICE_PROFILE_SCHEMA, TIMEXER_EXO_PROFILE_SCHEMA])
def test_full137_tree_profile_survives_child_dispatch_and_attestation(schema, monkeypatch):
    from app.features import FEATURE_COLS
    from app.training_policy import build_group_train_payload, build_model_feature_policy_metadata
    from services.active8_release_training_contract import (
        build_release_training_contract, build_model_training_config_attestation,
        validate_model_training_config_attestation)
    contract = build_release_training_contract(run_date="2026-09-18",
        dataset_snapshot={"snapshot_id": "test", "business_date": "2026-09-18"},
        producer_source_sha="a"*40, model_profile_schema_version=schema)
    for name in ("LightGBM", "ExtraTrees", "XGBoost"):
        profile = model_profiles(schema_version=schema)[name]
        payload = build_group_train_payload(profile["payload_config"], "tree")
        assert payload["skip_feature_pool"] is True
        assert payload["feature_policy"]["selection_required"] is False
        meta = build_model_feature_policy_metadata(name, FEATURE_COLS,
            feature_release_mode=payload["feature_release_mode"])
        assert meta["family_feature_contract"]["family_schema"] == "formal137_full_tabular_v1"
        config = deepcopy(profile["required_effective_config"])
        attestation = build_model_training_config_attestation(contract=contract, model_name=name, effective_config=config)
        validate_model_training_config_attestation(attestation, expected_model_name=name)
        config["feature_count"] = 30
        with pytest.raises(ValueError, match="feature_count"):
            build_model_training_config_attestation(contract=contract, model_name=name, effective_config=config)
        with pytest.raises(ValueError, match="inventory_mismatch"):
            build_model_feature_policy_metadata(name, FEATURE_COLS[:-1], feature_release_mode="accepted_ab_full137")


def test_v4_expands_train_history_without_moving_test_boundary(monkeypatch):
    from routers import walk_forward as wf
    import services.walk_forward_retrain as retrain
    days = [(date(2025, 1, 1)+timedelta(days=i)).isoformat() for i in range(160)]
    monkeypatch.setattr(retrain, "_get_bucket", lambda: object())
    monkeypatch.setattr(wf, "_oof_lifecycle_calendar", lambda *a, **kw: (days, {}))
    common = dict(start_date=days[50], end_date=days[-1], train_window_days=60,
                  test_window_days=10, prep_gcs_prefix="immutable/test")
    _, _, legacy = wf._walk_forward_calendar_and_windows(wf.WalkForwardRequest(**common))
    _, evidence, expanded = wf._walk_forward_calendar_and_windows(wf.WalkForwardRequest(
        **common, model_profile_schema_version=TIMEXER_PRICE_PROFILE_SCHEMA))
    assert len(expanded) == len(legacy) == 5
    assert all(w.train_start == days[0] for w in expanded)
    assert [(w.train_end, w.test_start, w.test_end) for w in expanded] == [
        (w.train_end, w.test_start, w.test_end) for w in legacy]
    assert evidence["history_policy"] == "expanding_verified_source"


def test_v4_full_fit_cannot_accept_legacy_fs_consensus():
    from app.features import FEATURE_COLS
    from routers.walk_forward import build_oof_full_fit_feature_consensus
    manifest = {"model_profile_schema_version": TIMEXER_PRICE_PROFILE_SCHEMA,
        "aggregate": {"oof_ready_folds": 5}, "windows": [{"window_id": i,
            "fs_result": {"selection_method": "predeclared_full137", "feature_pool": {
                "tree_active": list(FEATURE_COLS)}}} for i in range(5)]}
    result = build_oof_full_fit_feature_consensus(manifest)
    assert result["status"] == "ready"
    assert result["selection_method"] == "predeclared_full137"
    assert result["selected_count"] == 137
    manifest["windows"][2]["fs_result"]["selection_method"] = "outer_fold_majority_vote"
    assert build_oof_full_fit_feature_consensus(manifest)["status"] == "blocked"


@pytest.mark.parametrize('vix,bias',[(35.,-.1),(20.,0.),(12.,.05)])
def test_v4_prep_retains_expanded_history_in_every_regime(vix,bias):
    from services.training_policy import TrainingPolicy
    policy=TrainingPolicy()
    for schema in [TIMEXER_PRICE_PROFILE_SCHEMA,TIMEXER_EXO_PROFILE_SCHEMA]:
        assert policy.resolve_history(vix=vix,twii_bias=bias,model_profile_schema_version=schema)[1]==1280
    assert policy.resolve_history(vix=vix,twii_bias=bias,model_profile_schema_version='active8-release-model-profiles-v3')==policy.resolve_regime(vix=vix,twii_bias=bias)



def test_v4_prep_selector_cannot_reuse_newer_short_history(monkeypatch):
    import json
    from routers import walk_forward as wf
    monkeypatch.setattr(wf, "_runtime_source_sha", lambda: "a" * 40)
    common = {"schema_version": "active8-canonical-adjusted-prep-v3", "status": "ready",
        "target_semantic_version": wf._OOF_TARGET_SEMANTIC_VERSION,
        "feature_semantic_version": wf.OOF_FEATURE_SEMANTIC_VERSION,
        "feature_imputation_semantic": wf.OOF_FEATURE_IMPUTATION_SEMANTIC_VERSION,
        "producer_source_sha": "a" * 40, "roundtrip_cost_bps": 18., "signal_date_max": "2026-09-18"}
    class Blob:
        def __init__(self, prefix, created):
            self.name = prefix + "/prep/manifest.json"
            self.payload = {**common, "output_gcs_prefix": prefix, "created_at": created}
        def download_as_text(self): return json.dumps(self.payload)
    class Bucket:
        def list_blobs(self, **kwargs):
            return [Blob("universal/canonical_adjusted/long-expanded1280", "2026-09-19"),
                    Blob("universal/canonical_adjusted/short", "2026-09-20")]
    assert wf._latest_canonical_prep_prefix(Bucket()).endswith("/short")
    assert wf._latest_canonical_prep_prefix(Bucket(), expanded_history=True).endswith("-expanded1280")



@pytest.mark.parametrize("profile,role", [(TIMEXER_PRICE_PROFILE_SCHEMA,"A"), (TIMEXER_EXO_PROFILE_SCHEMA,"B")])
def test_native_oof_completion_refreshes_matching_l4_role(profile,role,monkeypatch):
    import asyncio
    from services import l4_oof_lifecycle as native
    from services import active8_oof_cohort_materializer as materializer
    from routers import walk_forward as wf
    from scripts import l4_distribution_refresh_job as refresh
    manifest={"cohort_id":"test-pair", "model_profile_schema_version":profile, "end_date":"2026-09-11"}
    assert native.uses_native_l4(manifest)
    assert not native.uses_native_l4({"model_profile_schema_version":"active8-release-model-profiles-v3"})
    monkeypatch.setattr(materializer,"load_verified_oof_manifest",lambda *a,**kw:(manifest,{}))
    monkeypatch.setattr(materializer,"load_oof_prediction_rows",lambda *a,**kw:[])
    monkeypatch.setattr(native,"persist_base_index",lambda **kw:{"prediction_dates":20,"min_date":"2026-08-03","max_date":"2026-09-11"})
    async def full_fit(**kw): return {"status":"completed","retry_required":False,"release_registry":{"ensemble_candidate":{"artifact_id":"verified-"+role}}}
    monkeypatch.setattr(wf,"dispatch_oof_full_fit_training",full_fit)
    monkeypatch.setattr(wf,"_materialize_nav_with_reviews",lambda **kw:{"status":"unproven"})
    calls=[]
    def execute(**kw): calls.append(kw);return {"promoted":False}
    monkeypatch.setattr(refresh,"execute",execute)
    class Blob:
        def exists(self): return False
        def upload_from_string(self,*a,**kw): pass
    class Bucket:
        def blob(self,path): return Blob()
    result=asyncio.run(native.materialize_native_base(manifest_path="test",cohort_id="test-pair",as_of="2026-09-18",cadence="weekly",dry_run=False,dispatch_full_fit=True,poll_only=False,bucket=Bucket(),client=object()))
    assert calls[0].get("strategy_role","A")==role
    assert calls[0]["target_l3_artifact_id"]=="verified-"+role
    assert result["promotion_allowed"] is False



def test_accepted_profiles_do_not_truncate_the_market_inventory(monkeypatch):
    import sqlite3
    from routers import retrain_trigger as rt
    db=sqlite3.connect(':memory:');db.row_factory=sqlite3.Row
    db.execute('CREATE TABLE stocks(id INTEGER,symbol TEXT,market TEXT)')
    db.executemany('INSERT INTO stocks VALUES(?,?,?)',[(i,str(i),'TWSE') for i in range(1,2790)])
    db.execute("INSERT INTO stocks VALUES(9999,'FOREIGN','USA')")
    class Client:
        def query(self,sql,params): return [dict(r) for r in db.execute(sql,params)]
    monkeypatch.setattr(rt,'CORE_D1_CLIENT',Client())
    for schema in (TIMEXER_PRICE_PROFILE_SCHEMA,TIMEXER_EXO_PROFILE_SCHEMA):
        request=rt.UniversalRetrainTriggerRequest(limit=2500,model_profile_schema_version=schema)
        rows=rt._training_stock_rows(request)
        assert len(rows)==2789 and rows[-1]['id']==2789
    legacy=rt._training_stock_rows(rt.UniversalRetrainTriggerRequest(limit=2500))
    assert len(legacy)==2500
    db.close()
