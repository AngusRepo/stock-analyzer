from pathlib import Path


def test_active8_and_timesfm_sidecar_runtime_dependencies_are_tightly_pinned_to_reviewed_versions():
    root = Path(__file__).resolve().parents[1]
    requirements = "\n".join(
        path.read_text(encoding="utf-8", errors="ignore")
        for path in (root / "requirements.txt", root / "requirements-neuralforecast.txt")
    )

    expected_pins = [
        "scikit-learn==1.9.0",
        "networkx==3.6.1",
        "scikit-learn-extra==0.3.0",
        # XGBoost 3.2.0 is intentionally accepted for runtime bug/perf fixes
        # even though the local 2026-06-11 replay showed slightly weaker IC.
        "xgboost==3.2.0",
        "lightgbm==4.6.0",
        "torch==2.13.0",
        "transformers==5.13.1",
        "torch-geometric==2.8.0",
        "pytorch-lightning==2.6.1",
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

    dockerfile = (root / "Dockerfile").read_text(encoding="utf-8", errors="ignore")
    modal_app = (root / "modal_app.py").read_text(encoding="utf-8", errors="ignore")
    assert "--no-deps -r requirements-neuralforecast.txt" in dockerfile
    assert 'extra_options="--no-deps"' in modal_app
    assert "pytorch_lightning.__version__ == '2.6.1'" in dockerfile
    assert "pytorch_lightning.__version__ == '2.6.1'" in modal_app


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
