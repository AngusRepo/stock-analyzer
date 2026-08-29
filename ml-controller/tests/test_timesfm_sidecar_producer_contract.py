from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_monthly_active8_emits_immutable_timesfm_sidecar_candidate() -> None:
    source = (ROOT / "ml-service" / "modal_app.py").read_text(encoding="utf-8")

    assert 'str(oof_resume.get("cadence") or "").strip().lower() == "monthly"' in source
    assert '"producer_contract": "timesfm-l2-sidecar-immutable-candidate-v1"' in source
    assert 'config_blob.download_as_bytes()' in source
    assert 'hashlib.sha256(config_bytes).hexdigest()' in source
    assert '"candidate_type": "timesfm_l175_l2_feature_release"' in source
    assert '"direct_alpha_blocked": True' in source
    assert '"production_effect": False' in source
    assert 'result["stages"]["timesfm_l2_feature_release"]' in source


def test_sidecar_candidate_remains_separate_from_active8_direct_alpha_contract() -> None:
    contract = (ROOT / "ml-controller" / "services" / "active8_release_training_contract.py").read_text(encoding="utf-8")
    source = (ROOT / "ml-service" / "modal_app.py").read_text(encoding="utf-8")

    assert 'ACTIVE8_MODEL_NAMES = (' in contract
    assert '"TimesFM"' not in contract.split("ACTIVE8_MODEL_NAMES = (", 1)[1].split(")", 1)[0]
    assert 'result["stages"]["timesfm_l2_feature_release"]' in source
