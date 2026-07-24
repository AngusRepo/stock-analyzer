from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_serving_router_does_not_publish_deployment_control_plane() -> None:
    source = (ROOT / "ml-controller" / "routers" / "admin.py").read_text(encoding="utf-8")

    assert '@router.post("/modal-deploy")' not in source
    assert '@router.post("/quantaalpha-' not in source
    assert "def modal_deploy(" not in source
    assert "subprocess.run" not in source


def test_controller_image_excludes_modal_deployment_sources() -> None:
    dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")

    assert "COPY ml-service/ /app/ml-service/" not in dockerfile
