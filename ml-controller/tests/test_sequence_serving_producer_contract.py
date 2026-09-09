import asyncio
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import pytest
from services import model_serving_resolver as resolver
from services.sequence_semantic_contract import sequence_rank_ic_semantic, RANK_IC_SEMANTIC_VERSION
from routers import model_pool

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = Path(__file__).parent / "fixtures/active8_serving_20260909.json"

def fixture():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))

def metadata(name):
    row=next(row for row in fixture()["artifacts"] if row["model_name"] == name)
    return row["offline_evidence_json"]["registration"]["metadata"]

@pytest.mark.parametrize("name", ["DLinear", "PatchTST", "iTransformer"])
def test_real_immutable_producer_evidence_resolves_without_rewriting(name):
    meta=metadata(name); before=copy.deepcopy(meta)
    assert "rank_ic_semantic_version" not in meta
    assert sequence_rank_ic_semantic(meta,name) == RANK_IC_SEMANTIC_VERSION
    assert meta == before

@pytest.mark.parametrize("name", ["DLinear", "PatchTST", "iTransformer"])
def test_explicit_conflicting_semantics_are_not_overridden(name):
    meta=metadata(name);meta["rank_ic_semantic_version"]="legacy-double-argsort"
    assert sequence_rank_ic_semantic(meta,name) is None
    meta["rank_ic_semantic_version"]=RANK_IC_SEMANTIC_VERSION
    meta["model_cpcv"]["rank_ic_semantic_version"]="legacy-double-argsort"
    assert sequence_rank_ic_semantic(meta,name) is None

@pytest.mark.parametrize("change", ["unknown_source", "checksum", "geometry", "model", "refit"])
def test_legacy_nf_compatibility_is_narrowly_attested(change):
    meta=metadata("PatchTST");att=meta["model_training_config_attestation"]
    if change=="unknown_source":
        att["producer_source_sha"]="f"*40
        unsigned={key:value for key,value in att.items() if key!="attestation_checksum"}
        att["attestation_checksum"]=hashlib.sha256(json.dumps(unsigned,ensure_ascii=False,sort_keys=True,separators=(",",":")).encode()).hexdigest()
    if change=="checksum":att["attestation_checksum"]="0"*64
    if change=="geometry":meta["seq_len"]=256
    if change=="model":att["model_name"]="iTransformer"
    if change=="refit":meta["model_cpcv"]["validation_design"]["refit_each_fold"]=False
    assert sequence_rank_ic_semantic(meta,"PatchTST") is None

def test_missing_dlinear_semantics_still_fail_closed():
    meta=metadata("DLinear");meta["model_cpcv"].pop("rank_ic_semantic_version")
    assert sequence_rank_ic_semantic(meta,"DLinear") is None

def test_controller_and_modal_use_identical_contract_and_real_fixture():
    path=ROOT/"ml-service/app/sequence_semantic_contract.py"
    assert path.read_bytes() == (ROOT/"ml-controller/services/sequence_semantic_contract.py").read_bytes()
    spec=importlib.util.spec_from_file_location("modal_sequence_contract",path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    for name in ("DLinear","PatchTST","iTransformer"):
        assert module.sequence_rank_ic_semantic(metadata(name),name)==RANK_IC_SEMANTIC_VERSION
    data=fixture();names=tuple(row["model_name"] for row in data["artifacts"])
    pool=resolver.build_pool_from_champion_pointers(**data,required_models=names,sidecar_models=())
    assert all(row["serving_eligible"] for row in pool["models"].values())

def test_pointer_readiness_cannot_claim_unloadable_bundle_member(monkeypatch):
    data=fixture();rows=data["artifacts"]
    row=next(row for row in rows if row["model_name"]=="DLinear")
    row["offline_evidence_json"]["registration"]["metadata"]["model_cpcv"].pop("rank_ic_semantic_version")
    bundle={"status":"production","production_effect":True,"selected_models":[row["model_name"] for row in rows],
            "base_artifacts":{row["model_name"]:{key:row[key] for key in ("artifact_id","version","checksum")} for row in rows}}
    monkeypatch.setattr(model_pool,"list_champion_pointers",lambda **kwargs:data["pointers"])
    monkeypatch.setattr(model_pool,"list_artifact_registry",lambda **kwargs:rows)
    monkeypatch.setattr(model_pool,"load_active8_ensemble_serving_bundle",lambda:bundle)
    result=asyncio.run(model_pool.artifact_registry_champion_pointers())
    assert result["ready_count"]==4
    assert result["models"]["DLinear"]["readiness"]=="serving_contract_blocked"
    assert result["models"]["DLinear"]["serving_block_reason"]=="artifact_sequence_contract_missing_or_invalid"
    assert result["migration_ready"] is False

def test_promotion_blocks_unloadable_member_before_any_write(monkeypatch):
    from services import model_artifact_registry as registry
    from test_active8_ensemble_bundle_promotion import _fixture, AtomicD1
    rows,pointers,ensemble=_fixture();row=next(row for row in rows if row["model_name"]=="DLinear")
    offline=json.loads(row["offline_evidence_json"]);offline["registration"]["metadata"].pop("rank_ic_semantic_version")
    row["offline_evidence_json"]=json.dumps(offline)
    db=AtomicD1(rows,ensemble);monkeypatch.setattr(registry,"d1_client",db)
    result=registry.run_active8_ensemble_bundle_promotion_controller(training_run_id="run-new",registry_rows=rows,d1_pointers=pointers,ensemble_rows=[ensemble],confirm=True)
    assert result["can_promote"] is False
    assert "base_serving_contract:DLinear:artifact_sequence_contract_missing_or_invalid" in result["blockers"]
    assert db.statements is None


def test_real_five_model_bundle_normalization_and_both_scorers_agree():
    from services.active8_score_semantics import normalize_active8_cross_sectional_scores, MODEL_TARGET_SEMANTIC_VERSION
    from services.ensemble_v2 import attach_ensemble_v2, build_formal_model_input_contract
    import sys
    sys.path.insert(0, str(ROOT / "ml-service"))
    from app.active8_ensemble_runtime import score_active8_ensemble, Active8EnsembleContractError
    payload = json.loads((FIXTURE.parent / "active8_ensemble_20260909.json").read_text(encoding="utf-8"))
    data = fixture()
    pool = resolver.build_pool_from_champion_pointers(**data, required_models=tuple(payload["selected_models"]), sidecar_models=())["models"]
    predictions = {f"S{i}": {"stock_meta": {"market_segment": "LISTED"}, "rank_scores": {"TabM": i, "GNN": i * 2},
                    "dlinear": {"forecast_pct": i / 100}, "patchtst": {"forecast_pct": i / 90}, "itransformer": {"forecast_pct": i / 80}} for i in range(8)}
    # Sequence missingness is supported by the learned availability coefficients.
    predictions["S0"].pop("dlinear")
    result = normalize_active8_cross_sectional_scores(predictions, artifact_versions={name:row["version"] for name,row in pool.items()},
        artifact_target_semantics={name:MODEL_TARGET_SEMANTIC_VERSION for name in pool}, run_date="2026-09-09", active8_ensemble=payload, pool_models=pool)
    assert result["complete_symbols"] == 8
    for pred in predictions.values():
        attach_ensemble_v2(pred, payload, pool)
        assert build_formal_model_input_contract(pred)["complete"] is True
        assert pred["ensemble_v2"]["formal_model_input_contract"]["required_models"] == ["TabM", "GNN"]
        modal = score_active8_ensemble(rank_scores=pred["rank_scores"],artifact=payload,pool_models=pool,current_price=100)
        assert modal.forecast_pct == pred["ensemble_v2"]["forecast_pct"]
        assert modal.signal == pred["ensemble_v2"]["signal"]
    broken = copy.deepcopy(predictions["S1"])
    broken["rank_scores"].pop("TabM")
    broken.pop("ensemble_v2")
    attach_ensemble_v2(broken,payload,pool)
    assert broken["ensemble_v2_error"] == "formal_layer3_contract_incomplete"
    with pytest.raises(Active8EnsembleContractError, match="core_score_missing:TabM"):
        score_active8_ensemble(rank_scores=broken["rank_scores"],artifact=payload,pool_models=pool,current_price=100)
