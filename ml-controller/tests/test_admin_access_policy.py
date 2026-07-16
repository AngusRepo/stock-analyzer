from __future__ import annotations

import asyncio
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi import HTTPException
from starlette.requests import Request

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.admin_access_policy import (  # noqa: E402
    evaluate_admin_access,
    evaluate_admin_mutation_approval,
    require_admin_access,
    require_admin_mutation_scope,
)
from routers.admin import ModalDeployRequest, modal_deploy, router as admin_router  # noqa: E402


NOW = datetime(2026, 7, 16, 8, 30, tzinfo=timezone.utc)


def _env(**overrides: str) -> dict[str, str]:
    values = {
        "ADMIN_API_TOKEN": "admin-secret",
        "ML_CONTROLLER_SECRET": "controller-secret",
        "ADMIN_PRODUCTION_MUTATION_ENABLED": "1",
        "ADMIN_MUTATION_APPROVAL_ID": "wei-approval-20260716",
        "ADMIN_MUTATION_APPROVAL_SCOPE": "modal_deploy,quantaalpha_cancel",
        "ADMIN_MUTATION_APPROVAL_EXPIRES_AT": (NOW + timedelta(minutes=15)).isoformat(),
    }
    values.update(overrides)
    return values


def _request(headers: list[tuple[bytes, bytes]]) -> Request:
    return Request({"type": "http", "method": "POST", "path": "/admin/test", "headers": headers})


def test_admin_identity_is_independent_from_controller_token():
    assert evaluate_admin_access("admin-secret", env=_env()).allowed is True
    assert evaluate_admin_access("controller-secret", env=_env()).code == "invalid_admin_token"
    shared = evaluate_admin_access("shared", env=_env(ADMIN_API_TOKEN="shared", ML_CONTROLLER_SECRET="shared"))
    assert shared.allowed is False
    assert shared.status_code == 503


def test_admin_mutation_requires_enabled_exact_scope_and_approval_id():
    assert evaluate_admin_mutation_approval(
        "modal_deploy", "wei-approval-20260716", env=_env(), now=NOW
    ).allowed is True
    assert evaluate_admin_mutation_approval(
        "quantaalpha_run", "wei-approval-20260716", env=_env(), now=NOW
    ).code == "admin_mutation_scope_not_approved"
    assert evaluate_admin_mutation_approval(
        "modal_deploy", "wrong", env=_env(), now=NOW
    ).code == "admin_mutation_approval_id_mismatch"
    assert evaluate_admin_mutation_approval(
        "modal_deploy",
        "wei-approval-20260716",
        env=_env(ADMIN_PRODUCTION_MUTATION_ENABLED="0"),
        now=NOW,
    ).code == "admin_production_mutation_disabled"


def test_admin_mutation_rejects_expired_naive_and_unbounded_windows():
    assert evaluate_admin_mutation_approval(
        "modal_deploy",
        "wei-approval-20260716",
        env=_env(ADMIN_MUTATION_APPROVAL_EXPIRES_AT=(NOW - timedelta(seconds=1)).isoformat()),
        now=NOW,
    ).code == "admin_mutation_approval_expired"
    assert evaluate_admin_mutation_approval(
        "modal_deploy",
        "wei-approval-20260716",
        env=_env(ADMIN_MUTATION_APPROVAL_EXPIRES_AT="2026-07-16T09:00:00"),
        now=NOW,
    ).code == "admin_mutation_expiry_not_configured"
    assert evaluate_admin_mutation_approval(
        "modal_deploy",
        "wei-approval-20260716",
        env=_env(ADMIN_MUTATION_APPROVAL_EXPIRES_AT=(NOW + timedelta(minutes=31)).isoformat()),
        now=NOW,
    ).code == "admin_mutation_approval_window_too_long"


def test_fastapi_dependencies_fail_closed(monkeypatch):
    for name in (
        "ADMIN_API_TOKEN",
        "ML_CONTROLLER_SECRET",
        "ADMIN_PRODUCTION_MUTATION_ENABLED",
        "ADMIN_MUTATION_APPROVAL_ID",
        "ADMIN_MUTATION_APPROVAL_SCOPE",
        "ADMIN_MUTATION_APPROVAL_EXPIRES_AT",
    ):
        monkeypatch.delenv(name, raising=False)
    with pytest.raises(HTTPException) as admin_error:
        asyncio.run(require_admin_access(_request([])))
    assert admin_error.value.status_code == 503

    mutation_dependency = require_admin_mutation_scope("modal_deploy")
    with pytest.raises(HTTPException) as mutation_error:
        asyncio.run(mutation_dependency(_request([])))
    assert mutation_error.value.status_code == 403


def test_admin_router_and_all_external_mutations_use_central_policies():
    assert any(dependency.dependency is require_admin_access for dependency in admin_router.dependencies)
    expected = {
        "/admin/modal-deploy": "require_admin_mutation_modal_deploy",
        "/admin/quantaalpha-bootstrap": "require_admin_mutation_quantaalpha_bootstrap",
        "/admin/quantaalpha-run": "require_admin_mutation_quantaalpha_run",
        "/admin/quantaalpha-cancel": "require_admin_mutation_quantaalpha_cancel",
    }
    actual = {
        route.path: {dependency.dependency.__name__ for dependency in route.dependencies}
        for route in admin_router.routes
        if route.path in expected
    }
    assert set(actual) == set(expected)
    for path, dependency_name in expected.items():
        assert dependency_name in actual[path]


def test_modal_deploy_rejects_arbitrary_container_paths_before_subprocess():
    with pytest.raises(HTTPException) as error:
        modal_deploy(ModalDeployRequest(app_path="/app/ml-controller/main.py"))
    assert error.value.status_code == 403
    assert error.value.detail == "modal_deploy_app_path_not_approved"
