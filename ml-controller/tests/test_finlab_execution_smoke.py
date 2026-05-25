from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.finlab_execution_smoke import (  # noqa: E402
    finlab_execution_env_status,
    run_finlab_execution_smoke,
    sanitize_finlab_execution_error,
)


ROOT = Path(__file__).resolve().parents[2]
TEST_TMP = ROOT / ".tmp" / "finlab_execution_smoke_tests"


def _cert_file(name: str) -> Path:
    TEST_TMP.mkdir(parents=True, exist_ok=True)
    path = TEST_TMP / name
    path.write_bytes(b"fake-cert")
    return path


def test_env_status_requires_cert_file_to_exist():
    env = {
        "FINLAB_EXECUTION_LANE_ENABLED": "shadow",
        "SHIOAJI_API_KEY": "set",
        "SHIOAJI_SECRET_KEY": "set",
        "SHIOAJI_CERT_PERSON_ID": "set",
        "SHIOAJI_CERT_PASSWORD": "set",
        "SHIOAJI_ACCOUNT_ID": "set",
        "SHIOAJI_CERT_PATH": str(TEST_TMP / "missing.pfx"),
    }

    status = finlab_execution_env_status(env)

    assert status["ready"] is False
    assert status["mode"] == "shadow"
    assert "SHIOAJI_CERT_PATH_EXISTS" in status["missing"]


def test_smoke_blocks_broker_login_unless_explicitly_allowed():
    cert = _cert_file("blocked.pfx")
    env = {
        "FINLAB_EXECUTION_LANE_ENABLED": "shadow",
        "SHIOAJI_API_KEY": "set",
        "SHIOAJI_SECRET_KEY": "set",
        "SHIOAJI_CERT_PERSON_ID": "set",
        "SHIOAJI_CERT_PASSWORD": "set",
        "SHIOAJI_ACCOUNT_ID": "set",
        "SHIOAJI_CERT_PATH": str(cert),
    }

    result = run_finlab_execution_smoke(env=env, allow_broker_login=False)

    assert result["status"] == "blocked"
    assert result["blocked_reasons"] == ["broker_login_not_allowed"]
    assert result["can_submit_real_order"] is False


def test_smoke_uses_noop_view_only_preview_without_create_orders_or_cancel():
    cert = _cert_file("preview.pfx")
    env = {
        "FINLAB_EXECUTION_LANE_ENABLED": "shadow",
        "SHIOAJI_API_KEY": "set",
        "SHIOAJI_SECRET_KEY": "set",
        "SHIOAJI_CERT_PERSON_ID": "set",
        "SHIOAJI_CERT_PASSWORD": "set",
        "SHIOAJI_ACCOUNT_ID": "set",
        "SHIOAJI_CERT_PATH": str(cert),
    }

    calls: list[tuple[str, dict]] = []

    class FakePosition:
        position: list[dict] = []

        def to_list(self) -> list[dict]:
            return []

    class FakeAccount:
        def __init__(self) -> None:
            self.api = self

        def get_position(self) -> FakePosition:
            calls.append(("get_position", {}))
            return FakePosition()

        def get_cash(self) -> int:
            calls.append(("get_cash", {}))
            return 1000

        def get_settlement(self) -> int:
            calls.append(("get_settlement", {}))
            return 0

        def get_total_balance(self) -> int:
            calls.append(("get_total_balance", {}))
            return 1000

        def logout(self) -> None:
            calls.append(("logout", {}))

    class FakeExecutor:
        def __init__(self, target_position, account) -> None:
            calls.append(("executor_init", {"target": target_position, "account": account}))

        def create_orders(self, **kwargs):
            raise AssertionError("create_orders must not be used in read-only smoke")

        def cancel_orders(self, **kwargs):
            raise AssertionError("cancel_orders must not be used in read-only smoke")

        def generate_orders(self, **kwargs) -> list[dict]:
            calls.append(("generate_orders", kwargs))
            return []

        def execute_orders(self, orders, **kwargs) -> list[dict]:
            calls.append(("execute_orders", {"orders": orders, **kwargs}))
            return []

    result = run_finlab_execution_smoke(
        env=env,
        allow_broker_login=True,
        preview_noop=True,
        account_factory=FakeAccount,
        order_executor_factory=FakeExecutor,
    )

    assert result["status"] == "pass"
    assert result["can_submit_real_order"] is False
    assert result["preview"]["mode"] == "noop_current_position"
    assert ("generate_orders", {"progress": 1, "progress_precision": 0, "as_entries": False, "_internal": True}) in calls
    assert (
        "execute_orders",
        {
            "orders": [],
            "view_only": True,
            "cancel_orders": False,
            "market_order": False,
            "best_price_limit": False,
            "extra_bid_pct": 0,
            "buy_only": False,
            "sell_only": False,
        },
    ) in calls


def test_ml_controller_requirements_include_shioaji_for_sinopac_broker():
    requirements = (ROOT / "ml-controller" / "requirements.txt").read_text(encoding="utf-8")

    assert "shioaji" in requirements


def test_error_sanitizer_masks_configured_secret_values():
    env = {
        "SHIOAJI_API_KEY": "abc123secret",
        "SHIOAJI_SECRET_KEY": "def456secret",
        "SHIOAJI_CERT_PASSWORD": "password-value",
        "SHIOAJI_CERT_PERSON_ID": "person-id",
    }

    text = sanitize_finlab_execution_error(
        "key abc123secret not match def456secret password-value person-id",
        env,
    )

    assert "abc123secret" not in text
    assert "def456secret" not in text
    assert "password-value" not in text
    assert "person-id" not in text
    assert "***" in text
