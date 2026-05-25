from pathlib import Path
import os
import shutil

from routers.admin import _prepare_stable_modal_source


def test_prepare_stable_modal_source_copies_modal_sidecars():
    tmp_root = Path(__file__).resolve().parents[2] / ".tmp" / "admin_modal_deploy_staging"
    if tmp_root.exists():
        shutil.rmtree(tmp_root)
    repo = tmp_root / "repo"
    ml_service = repo / "ml-service"
    ml_service.mkdir(parents=True)
    (ml_service / "modal_app.py").write_text("# modal app\n", encoding="utf-8")
    (ml_service / "requirements.txt").write_text("modal==1.4.0\n", encoding="utf-8")
    (ml_service / "app").mkdir()
    (ml_service / "app" / "runtime_env.py").write_text("VALUE = 1\n", encoding="utf-8")
    (ml_service / "scripts").mkdir()
    (ml_service / "scripts" / "helper.py").write_text("VALUE = 2\n", encoding="utf-8")

    for rel in ("routers", "services", "optuna_scripts"):
        target = repo / "ml-controller" / rel
        target.mkdir(parents=True)
        (target / f"{rel}_fixture.py").write_text("VALUE = 3\n", encoding="utf-8")

    (repo / "tools").mkdir()
    (repo / "tools" / "finlab_backfill_job_guard.py").write_text("VALUE = 4\n", encoding="utf-8")

    previous_staging_root = os.environ.get("MODAL_DEPLOY_STAGING_ROOT")
    os.environ["MODAL_DEPLOY_STAGING_ROOT"] = str(tmp_root / "modal_deploy")
    try:
        stable_app, stable_dir = _prepare_stable_modal_source(str(ml_service / "modal_app.py"))
        stable_root = Path(stable_dir).parent

        assert Path(stable_app).is_file()
        assert (Path(stable_dir) / "app" / "runtime_env.py").is_file()
        assert (Path(stable_dir) / "scripts" / "helper.py").is_file()
        assert (stable_root / "ml-controller" / "routers" / "routers_fixture.py").is_file()
        assert (stable_root / "ml-controller" / "services" / "services_fixture.py").is_file()
        assert (stable_root / "ml-controller" / "optuna_scripts" / "optuna_scripts_fixture.py").is_file()
        assert (stable_root / "tools" / "finlab_backfill_job_guard.py").is_file()
    finally:
        if previous_staging_root is None:
            os.environ.pop("MODAL_DEPLOY_STAGING_ROOT", None)
        else:
            os.environ["MODAL_DEPLOY_STAGING_ROOT"] = previous_staging_root

    shutil.rmtree(tmp_root)


def test_prepare_stable_modal_source_supports_cloud_run_flat_controller_layout():
    tmp_root = Path(__file__).resolve().parents[2] / ".tmp" / "admin_modal_deploy_flat_staging"
    if tmp_root.exists():
        shutil.rmtree(tmp_root)
    repo = tmp_root / "app"
    ml_service = repo / "ml-service"
    ml_service.mkdir(parents=True)
    (ml_service / "modal_app.py").write_text("# modal app\n", encoding="utf-8")

    for rel in ("routers", "services", "optuna_scripts"):
        target = repo / rel
        target.mkdir(parents=True)
        (target / f"{rel}_fixture.py").write_text("VALUE = 5\n", encoding="utf-8")

    (repo / "tools").mkdir()
    (repo / "tools" / "finlab_v4_remote_backfill.py").write_text("VALUE = 6\n", encoding="utf-8")

    previous_staging_root = os.environ.get("MODAL_DEPLOY_STAGING_ROOT")
    os.environ["MODAL_DEPLOY_STAGING_ROOT"] = str(tmp_root / "modal_deploy")
    try:
        _, stable_dir = _prepare_stable_modal_source(str(ml_service / "modal_app.py"))
        stable_root = Path(stable_dir).parent

        assert (stable_root / "ml-controller" / "routers" / "routers_fixture.py").is_file()
        assert (stable_root / "ml-controller" / "services" / "services_fixture.py").is_file()
        assert (stable_root / "ml-controller" / "optuna_scripts" / "optuna_scripts_fixture.py").is_file()
        assert (stable_root / "tools" / "finlab_v4_remote_backfill.py").is_file()
    finally:
        if previous_staging_root is None:
            os.environ.pop("MODAL_DEPLOY_STAGING_ROOT", None)
        else:
            os.environ["MODAL_DEPLOY_STAGING_ROOT"] = previous_staging_root

    shutil.rmtree(tmp_root)
