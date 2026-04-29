from app.artifact_contract import (
    ArtifactValidationError,
    build_model_artifact_metadata,
    build_training_run_manifest,
    validate_serving_feature_compatibility,
    validate_model_artifact_metadata,
)


def test_validate_model_artifact_metadata_requires_lineage_and_features():
    metadata = {
        "model_name": "XGBoost",
        "feature_names": ["rsi14", "macd"],
        "feature_medians": {"rsi14": 55.0, "macd": 0.1},
        "sample_count": 1200,
        "trained_at": "2026-04-29T00:00:00Z",
        "gcs_prefix": "universal",
        "schema_version": "model-artifact-v2",
        "artifact_checksum": "sha256:abc123",
        "training_run_id": "train-20260429",
    }

    result = validate_model_artifact_metadata(metadata, serving_features=["macd", "rsi14"])

    assert result["status"] == "ok"
    assert result["feature_count"] == 2
    assert result["missing_features"] == []
    assert result["extra_features"] == []


def test_validate_model_artifact_metadata_rejects_missing_feature_alignment():
    metadata = {
        "model_name": "LightGBM",
        "feature_names": ["rsi14", "missing_at_serve"],
        "sample_count": 800,
        "trained_at": "2026-04-29T00:00:00Z",
        "schema_version": "model-artifact-v2",
        "artifact_checksum": "sha256:def456",
        "training_run_id": "train-20260429",
    }

    try:
        validate_model_artifact_metadata(metadata, serving_features=["rsi14", "macd"])
    except ArtifactValidationError as exc:
        assert "feature compatibility" in str(exc)
        assert exc.report["missing_features"] == ["missing_at_serve"]
        assert exc.report["extra_features"] == ["macd"]
    else:
        raise AssertionError("expected ArtifactValidationError")


def test_build_training_run_manifest_is_deterministic_and_auditable():
    manifest = build_training_run_manifest(
        run_id="train-20260429",
        model_names=["LightGBM", "XGBoost"],
        feature_names=["macd", "rsi14"],
        dataset={
            "rows": 100,
            "date_min": "2026-01-01",
            "date_max": "2026-04-28",
            "source": "universal/prep",
        },
        params={"alpha": 0.01, "max_rounds": 100},
        code_version="abc1234",
    )

    assert manifest["schema_version"] == "training-run-manifest-v1"
    assert manifest["run_id"] == "train-20260429"
    assert manifest["models"] == ["LightGBM", "XGBoost"]
    assert manifest["feature_count"] == 2
    assert manifest["dataset"]["rows"] == 100
    assert manifest["reproducibility"]["code_version"] == "abc1234"
    assert manifest["reproducibility"]["params_hash"].startswith("sha256:")


def test_build_model_artifact_metadata_adds_serving_contract_fields():
    metadata = build_model_artifact_metadata(
        model_name="CatBoost",
        feature_names=["rsi14"],
        sample_count=77,
        training_run_id="train-20260429",
        artifact_payload={"blob_sha256": "sha256:model-bytes"},
        feature_medians={"rsi14": 50.0},
        gcs_prefix="universal",
    )

    assert metadata["schema_version"] == "model-artifact-v2"
    assert metadata["model_name"] == "CatBoost"
    assert metadata["artifact_checksum"].startswith("sha256:")
    assert metadata["training_run_id"] == "train-20260429"
    assert metadata["feature_medians"] == {"rsi14": 50.0}


def test_validate_serving_feature_compatibility_allows_median_backfill():
    report = validate_serving_feature_compatibility(
        training_features=["rsi14", "macd"],
        serving_features=["rsi14", "bias20"],
        feature_medians={"macd": 0.0},
    )

    assert report["status"] == "degraded"
    assert report["missing_features"] == ["macd"]
    assert report["missing_without_median"] == []
    assert report["extra_features"] == ["bias20"]


def test_validate_serving_feature_compatibility_rejects_missing_without_median():
    try:
        validate_serving_feature_compatibility(
            training_features=["rsi14", "macd"],
            serving_features=["rsi14"],
            feature_medians={},
        )
    except ArtifactValidationError as exc:
        assert exc.report["status"] == "error"
        assert exc.report["missing_without_median"] == ["macd"]
    else:
        raise AssertionError("expected ArtifactValidationError")
