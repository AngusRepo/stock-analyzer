from copy import deepcopy
from pathlib import Path
import pytest
from services.timexer_contract import canonical_checksum,metadata_contract,ARCHITECTURE,OFFICIAL_COMMIT,SCHEMA,SCORE_SEMANTIC


@pytest.mark.parametrize("value", ["a"*64, "sha256:"+"a"*64])
def test_same_bytes_have_one_registry_identity(value):
    assert canonical_checksum(value)=="sha256:"+"a"*64


@pytest.mark.parametrize("value", [None,"", "a"*63,"g"*64,"sha1:"+"a"*64,"sha256:sha256:"+"a"*64])
def test_invalid_digest_is_not_accepted(value):
    with pytest.raises(ValueError,match="timexer_checksum_invalid"):
        canonical_checksum(value)


def test_controller_and_service_contracts_are_identical():
    root=Path(__file__).resolve().parents[2]
    assert (root/"ml-controller/services/timexer_contract.py").read_bytes()==(root/"ml-service/app/timexer_contract.py").read_bytes()


def test_registry_normalizes_legacy_sidecar_without_rewriting_it():
    from services.model_artifact_registry import _artifact_record_from_registration
    raw={"version":"v1","checksum":"a"*64,"gcs_path":"universal/timexer/v1/model.pt",
         "metadata_path":"universal/timexer/v1/metadata.json","metadata":{"checksum":"a"*64}}
    before=deepcopy(raw)
    record=_artifact_record_from_registration(payload_dict={"run_id":"run1","run_date":"2026-09-21","candidate_version":"v1"},
        model_name="TimeXer",raw_registration=raw,candidate_type="oof_full_fit_release",now="2026-09-21T00:00:00Z",source="test")
    assert record["checksum"]=="sha256:"+"a"*64
    assert raw==before


def test_ab_binding_reconciles_same_digest_and_rejects_different_bytes(monkeypatch):
    from services.strategy_ab import bind
    from services.alpha_model_roster import TIMEXER_MODELS
    from services import paired_nav_strategy_bundle
    monkeypatch.setattr(paired_nav_strategy_bundle,"validate_strategy_bundle",lambda bundle,**_:bundle)
    metadata={"schema_version":SCHEMA+"-metadata","checksum":"a"*64,"version":"v1","seq_len":168,"pred_len":5,
      "raw_score_semantic_version":SCORE_SEMANTIC,"timexer":{"variant":"price","official_commit":OFFICIAL_COMMIT,
      "architecture":ARCHITECTURE,"inference_device":"cuda","matmul_precision":"high",
      "feature_history_schema":"formal137-pit-asof-source-quality-v3","max_exogenous_staleness_sessions":1}}
    ensemble={"model_order":list(TIMEXER_MODELS),"payload_checksum":"b"*64,
      "observation_artifacts":{"TimeXer":{"checksum":"sha256:"+"a"*64,"version":"v1"}}}
    bundle={"candidate_l3_identity":{"payload_checksum":"b"*64},"declared_signal_date":"2026-09-21",
      "candidate_trading_config":{"l4Distribution":{"artifact":{"model":{}}}}}
    result=bind(bundle,role="A",experiment_id="c"*64,ensemble=ensemble,timexer_metadata=metadata)
    assert result["strategy_ab"]["role"]=="A"
    metadata["checksum"]="d"*64
    with pytest.raises(ValueError,match="timexer_variant_or_identity_mismatch"):
        bind(bundle,role="A",experiment_id="c"*64,ensemble=ensemble,timexer_metadata=metadata)
