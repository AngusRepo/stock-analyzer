from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_execution_gateway_image_contains_domain_router_dependency() -> None:
    dockerfile = (ROOT / "Dockerfile.execution-gateway").read_text(encoding="utf-8")
    repository = (ROOT / "ml-controller/services/broker_execution_repository.py").read_text(encoding="utf-8")

    assert "services/d1_domain_client.py /app/services/d1_domain_client.py" in dockerfile
    assert "from services.d1_domain_client import D1DataDomain, client_for_domain" in repository
    assert "client_for_domain(D1DataDomain.EXECUTION)" in repository
