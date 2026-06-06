from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_finlab_backfill_modal_function_and_spawn_contract_exist() -> None:
    modal_app = (ROOT / "ml-service" / "modal_app.py").read_text(encoding="utf-8")
    modal_client = (ROOT / "ml-controller" / "services" / "modal_client.py").read_text(encoding="utf-8")
    finlab_router = (ROOT / "ml-controller" / "routers" / "finlab.py").read_text(encoding="utf-8")

    assert "def finlab_v4_backfill(payload: dict)" in modal_app
    assert "tools import finlab_v4_remote_backfill" in modal_app
    assert "tools import finlab_macro_context_snapshot" in modal_app
    assert "macro_context_writeback" in modal_app
    assert "api/admin/scheduler-callback" in modal_app
    assert "continue_evening_chain" in modal_app
    assert "def spawn_finlab_v4_backfill(payload: dict)" in modal_client
    assert '"status": "triggered"' in modal_client
    assert "callback_url" in finlab_router
    assert "STOCKVISION_WORKER_URL" in finlab_router


def test_modal_deploy_packages_finlab_tool_and_controller_services() -> None:
    admin_router = (ROOT / "ml-controller" / "routers" / "admin.py").read_text(encoding="utf-8")
    modal_app = (ROOT / "ml-service" / "modal_app.py").read_text(encoding="utf-8")
    requirements = (ROOT / "ml-service" / "requirements.txt").read_text(encoding="utf-8")
    dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")

    assert '"tools": repo_root / "tools"' in admin_router
    assert '"services": repo_root / "ml-controller" / "services"' in admin_router
    assert 'remote_path="/root/tools"' in modal_app
    assert 'remote_path="/root/services"' in modal_app
    assert "finlab==2.0.7" in requirements
    assert "COPY tools/finlab_macro_context_snapshot.py" in dockerfile
