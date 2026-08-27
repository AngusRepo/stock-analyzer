from app.features import FEATURE_IMPUTATION_SEMANTIC_VERSION, FEATURE_SEMANTIC_VERSION
from app import tabm_training


def test_tabm_artifact_metadata_declares_current_pit_feature_semantics():
    source = open(tabm_training.__file__, encoding="utf-8").read()

    assert '"feature_semantic_version": FEATURE_SEMANTIC_VERSION' in source
    assert '"feature_imputation_semantic": FEATURE_IMPUTATION_SEMANTIC_VERSION' in source
    assert FEATURE_SEMANTIC_VERSION == "formal137-pit-rolling-rank-and-imputation-v2"
    assert FEATURE_IMPUTATION_SEMANTIC_VERSION == "prior_252_row_median_then_zero_v2"
