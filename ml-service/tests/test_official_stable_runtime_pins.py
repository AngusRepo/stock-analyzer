from pathlib import Path


def test_active_9_runtime_dependencies_are_tightly_pinned_to_reviewed_versions():
    requirements = (
        Path(__file__)
        .resolve()
        .parents[1]
        .joinpath("requirements.txt")
        .read_text(encoding="utf-8", errors="ignore")
    )

    expected_pins = [
        "scikit-learn==1.9.0",
        "networkx==3.6.1",
        "scikit-learn-extra==0.3.0",
        # XGBoost 3.2.0 is intentionally accepted for runtime bug/perf fixes
        # even though the local 2026-06-11 replay showed slightly weaker IC.
        "xgboost==3.2.0",
        "lightgbm==4.6.0",
        "torch==2.12.0",
        "torch-geometric==2.8.0",
        "neuralforecast==3.1.9",
        "tabm==0.0.3",
        "timesfm[torch]==2.0.1",
        "optuna==4.9.0",
        "finlab==2.0.13",
    ]
    for pin in expected_pins:
        assert pin in requirements

    drifting_specs = [
        "xgboost==2.1.1",
        "networkx>=",
        "scikit-learn-extra>=",
        "lightgbm>=",
        "torch==2.8.0",
        "torch-geometric>=",
        "darts[torch]",
        "tabm>=",
        "timesfm[torch]==1.3.0",
        "timesfm[torch]==2.0.0",
        "optuna>=",
        "finlab==2.0.7",
    ]
    for spec in drifting_specs:
        assert spec not in requirements


def test_cloud_run_image_uses_python_runtime_compatible_with_stable_pins():
    dockerfile = (
        Path(__file__)
        .resolve()
        .parents[1]
        .joinpath("Dockerfile")
        .read_text(encoding="utf-8", errors="ignore")
    )

    assert "FROM python:3.11-slim" in dockerfile
    assert "FROM python:3.12-slim" not in dockerfile
    assert "FROM python:3.10-slim" not in dockerfile
