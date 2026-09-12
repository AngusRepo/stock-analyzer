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
    import sys
    sys.path.insert(0, str(ROOT / 'ml-service'))
    from app import serving_resolver as modal_resolver
    original = copy.deepcopy(data)
    modal_pool = modal_resolver.build_pool_from_champion_pointers(**data, required_models=names, sidecar_models=())
    assert all(row['serving_eligible'] for row in modal_pool['models'].values())
    assert data == original
    for name in ('DLinear', 'PatchTST', 'iTransformer'):
        assert modal_pool['models'][name]['sequence_contract'] == pool['models'][name]['sequence_contract']

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
