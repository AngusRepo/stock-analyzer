from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_modal_image_build_steps_run_before_local_dirs():
    source = (ROOT / "ml-service" / "modal_app.py").read_text(encoding="utf-8")

    assert "_base_image = (" in source
    assert "image = _with_common_local_dirs(_base_image)" in source
    assert '_with_common_local_dirs(_base_image.pip_install("finlab==2.0.7"))' in source
    assert '_with_common_local_dirs(_base_image.pip_install("google-cloud-run>=0.10.0"))' in source
    assert "finlab_image = (\n    image\n    .pip_install" not in source
    assert "optuna_controller_image = (\n    image\n    .pip_install" not in source
