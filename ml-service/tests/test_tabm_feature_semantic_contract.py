from app.features import FEATURE_IMPUTATION_SEMANTIC_VERSION, FEATURE_SEMANTIC_VERSION
from app.formal_feature_contract import FEATURE131_SEMANTIC, LEGACY_SEMANTIC, R33_PROFILE, payload_semantic
from app import tabm_training


def test_tabm_artifact_metadata_declares_current_pit_feature_semantics():
    source = open(tabm_training.__file__, encoding="utf-8").read()

    # The artifact declares the semantic its payload trained on (b0fed84d), not a fixed 137 constant.
    assert "feature_semantic = payload_semantic(payload)" in source
    assert '"feature_semantic_version": feature_semantic' in source
    assert '"feature_imputation_semantic": FEATURE_IMPUTATION_SEMANTIC_VERSION' in source
    assert payload_semantic({}) == LEGACY_SEMANTIC == FEATURE_SEMANTIC_VERSION == "formal137-pit-asof-source-quality-v3"
    assert payload_semantic({"model_profile_schema_version": R33_PROFILE}) == FEATURE131_SEMANTIC
    assert FEATURE_IMPUTATION_SEMANTIC_VERSION == "prior_252_row_median_then_zero_v2"
