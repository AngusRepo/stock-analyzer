"""ml-service HTTP auth is fail-closed: every route but /health needs X-Service-Token."""
from __future__ import annotations

import ast
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import breeze2_reason_generation as breeze2
from app.main import app

TOKEN = "unit-test-service-token"
ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def client(monkeypatch):
    for name in ("ML_SERVICE_SECRET", "ML_SERVICE_ALLOW_UNAUTHENTICATED", "ENVIRONMENT",
                 "MODAL_TASK_ID", "MODAL_IS_REMOTE"):
        monkeypatch.delenv(name, raising=False)
    return TestClient(app)


def _protected_paths() -> list[tuple[str, str]]:
    rows = []
    for route in app.routes:
        path = getattr(route, "path", None)
        for method in sorted(getattr(route, "methods", None) or ()):
            if path and path != "/health" and method in {"GET", "POST"}:
                rows.append((method, path))
    return rows


def test_health_stays_public_without_secret(client):
    assert client.get("/health").status_code == 200


def test_missing_secret_fails_closed_on_every_route(client):
    rows = _protected_paths()
    assert ("GET", "/bandit/stats") in rows and ("POST", "/breeze2/reason-generation") in rows
    for method, path in rows:
        response = client.request(method, path, json={})
        assert response.status_code == 503, (method, path, response.status_code)


def test_openapi_and_docs_are_not_public(client, monkeypatch):
    assert client.get("/openapi.json").status_code == 503
    monkeypatch.setenv("ML_SERVICE_SECRET", TOKEN)
    assert client.get("/openapi.json").status_code == 401
    assert client.get("/docs").status_code == 401


def test_wrong_or_missing_token_is_401(client, monkeypatch):
    monkeypatch.setenv("ML_SERVICE_SECRET", TOKEN)
    assert client.get("/bandit/stats").status_code == 401
    assert client.get("/bandit/stats", headers={"X-Service-Token": "wrong"}).status_code == 401
    assert client.get("/bandit/stats", headers={"X-Service-Token": TOKEN + "x"}).status_code == 401
    assert client.post("/regime/current", json={}, headers={"X-Service-Token": ""}).status_code == 401


def test_path_and_method_variants_do_not_bypass(client, monkeypatch):
    monkeypatch.setenv("ML_SERVICE_SECRET", TOKEN)
    for method, path in (("HEAD", "/bandit/stats"), ("GET", "/bandit/stats/"), ("GET", "//bandit/stats"),
                         ("GET", "/health/"), ("GET", "//health"), ("GET", "/redoc"),
                         ("POST", "/breeze2/reason-generation/")):
        response = client.request(method, path, json={} if method == "POST" else None)
        assert response.status_code == 401, (method, path, response.status_code)
    assert client.get("/bandit/stats", headers={"X-Service-Token": "t\u00e9st".encode("latin-1")}).status_code == 401


def test_correct_token_passes_auth(client, monkeypatch):
    monkeypatch.setenv("ML_SERVICE_SECRET", TOKEN)
    # Body validation runs only after auth: an empty body is a 422, not an auth error.
    # (No handler body runs, so no GCS / model access from the test.)
    response = client.post("/factor-ic-audit", json={}, headers={"X-Service-Token": TOKEN})
    assert response.status_code == 422
    response = client.post("/arf/update", json={}, headers={"X-Service-Token": f"  {TOKEN}  "})
    assert response.status_code == 422


def test_local_dev_opt_out_is_ignored_in_modal_and_production(client, monkeypatch):
    monkeypatch.setenv("ML_SERVICE_ALLOW_UNAUTHENTICATED", "1")
    assert client.post("/factor-ic-audit", json={}).status_code == 422
    monkeypatch.setenv("MODAL_TASK_ID", "ta-unit")
    assert client.get("/bandit/stats").status_code == 503
    monkeypatch.delenv("MODAL_TASK_ID")
    monkeypatch.setenv("ENVIRONMENT", "production")
    assert client.get("/bandit/stats").status_code == 503


def test_breeze2_rejects_non_allowlisted_model_id(client, monkeypatch):
    monkeypatch.setenv("ML_SERVICE_SECRET", TOKEN)
    monkeypatch.delenv("BREEZE2_REASON_MODEL_ID", raising=False)

    def _must_not_load(*_args, **_kwargs):
        raise AssertionError("model load attempted for a rejected model_id")

    monkeypatch.setattr(breeze2, "_generate_with_transformers", _must_not_load)
    response = client.post(
        "/breeze2/reason-generation",
        json={"model_id": "attacker/remote-code-model", "candidates": []},
        headers={"X-Service-Token": TOKEN},
    )
    assert response.status_code == 400
    assert "breeze2_model_id_not_allowed" in response.json()["detail"]


def test_breeze2_allowlist_and_revision_pin(monkeypatch):
    monkeypatch.delenv("BREEZE2_REASON_MODEL_ID", raising=False)
    monkeypatch.delenv("BREEZE2_REASON_MODEL_REVISION", raising=False)
    assert breeze2.resolve_model_id({}) == breeze2.DEFAULT_MODEL_ID
    assert breeze2.resolve_model_id({"model_id": breeze2.DEFAULT_MODEL_ID}) == breeze2.DEFAULT_MODEL_ID
    with pytest.raises(breeze2.Breeze2ModelNotAllowed):
        breeze2.resolve_model_id({"model_id": "other/model"})
    monkeypatch.setenv("BREEZE2_REASON_MODEL_ID", "MediaTek-Research/configured")
    assert breeze2.resolve_model_id({"model_id": "MediaTek-Research/configured"}) == "MediaTek-Research/configured"



def test_breeze2_revision_must_be_a_full_commit_sha(monkeypatch):
    monkeypatch.setattr(breeze2, "DEFAULT_MODEL_REVISION", "")
    monkeypatch.delenv("BREEZE2_REASON_MODEL_REVISION", raising=False)
    assert breeze2.model_revision() == ""
    for not_a_pin in ("main", "v0.1", "abc123", "A" * 40):
        monkeypatch.setenv("BREEZE2_REASON_MODEL_REVISION", not_a_pin)
        assert breeze2.model_revision() == ""
    monkeypatch.setenv("BREEZE2_REASON_MODEL_REVISION", "0123456789abcdef0123456789abcdef01234567")
    assert breeze2.model_revision() == "0123456789abcdef0123456789abcdef01234567"


def test_breeze2_unpinned_never_loads_remote_code(monkeypatch):
    monkeypatch.setattr(breeze2, "DEFAULT_MODEL_REVISION", "")
    monkeypatch.setenv("BREEZE2_REASON_MODEL_REVISION", "main")
    import builtins
    real_import = builtins.__import__

    def _guard(name, *args, **kwargs):
        if name.startswith("transformers"):
            raise AssertionError("transformers imported while the revision is unpinned")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", _guard)
    report = breeze2.generate_breeze2_reason_generation({"candidates": []})
    assert report["reason_source"] != "model"
    assert "breeze2_model_revision_not_pinned" in str(report)


def test_breeze2_from_pretrained_calls_pass_revision():
    source = (ROOT / "app" / "breeze2_reason_generation.py").read_text(encoding="utf-8-sig")
    calls = [node for node in ast.walk(ast.parse(source))
             if isinstance(node, ast.Call) and getattr(node.func, "attr", None) == "from_pretrained"]
    assert calls
    for call in calls:
        keywords = {kw.arg for kw in call.keywords}
        assert "revision" in keywords or None in keywords  # **kwargs carries revision in _load_breeze2_model
    assert '"revision": revision' in source


def test_modal_web_app_binds_required_token_secret_without_fallback():
    source = (ROOT / "modal_app.py").read_text(encoding="utf-8-sig")
    tree = ast.parse(source)
    fn = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "fastapi_app")
    function_decorator = next(d for d in fn.decorator_list
                              if isinstance(d, ast.Call) and getattr(d.func, "attr", None) == "function")
    secrets = next(kw.value for kw in function_decorator.keywords if kw.arg == "secrets")
    assert [elt.id for elt in secrets.elts] == ["ml_service_token_secret"]
    assign = next(node for node in tree.body if isinstance(node, ast.Assign)
                  and any(getattr(t, "id", None) == "ml_service_token_secret" for t in node.targets))
    call = assign.value
    assert call.func.attr == "from_name"
    assert {kw.arg for kw in call.keywords} == {"required_keys"}
    # Not wrapped in try/except with a from_dict({}) fallback.
    assert "ml_service_token_secret = modal.Secret.from_dict" not in source
