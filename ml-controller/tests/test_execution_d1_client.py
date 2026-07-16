from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import sys

import pytest


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.execution_d1_client import (  # noqa: E402
    ExecutionD1AmbiguousWriteError,
    ExecutionD1Client,
    ExecutionD1Config,
    ExecutionD1ConfigurationError,
    ExecutionD1Error,
)


@dataclass
class Response:
    status_code: int
    payload: dict

    def json(self) -> dict:
        return self.payload


def _config(**overrides) -> ExecutionD1Config:
    values = {
        "account_id": "account",
        "database_id": "execution-db",
        "instance_id": "execution-instance-test",
        "api_token": "",
        "proxy_url": "https://execution-ledger.invalid/v1/d1/query",
        "proxy_token": "proxy-token",
        "environment": "production",
        "require_primary": True,
        "read_retries": 2,
    }
    values.update(overrides)
    return ExecutionD1Config(**values)


def _success(rows=None, *, changes=0, primary=True) -> dict:
    return {
        "success": True,
        "result": [
            {
                "success": True,
                "results": rows or [],
                "meta": {
                    "changes": changes,
                    "rows_written": changes,
                    "served_by_primary": primary,
                },
            }
        ],
    }


def test_production_requires_independent_execution_database_and_token() -> None:
    with pytest.raises(ExecutionD1ConfigurationError, match="EXECUTION_D1_PROXY"):
        ExecutionD1Config.from_env(
            {
                "ENVIRONMENT": "production",
                "CF_ACCOUNT_ID": "account",
                "CF_EXECUTION_D1_DB_ID": "execution-db",
            }
        )


def test_production_proxy_url_is_https_exact_path_and_allowlisted() -> None:
    env = {
        "ENVIRONMENT": "production",
        "CF_EXECUTION_D1_DB_ID": "execution-db",
        "CF_EXECUTION_D1_INSTANCE_ID": "execution-instance-test",
        "EXECUTION_D1_PROXY_URL": "https://ledger.example.com/v1/d1/query",
        "EXECUTION_D1_PROXY_TOKEN": "token",
        "EXECUTION_D1_PROXY_ALLOWED_HOSTS": "ledger.example.com",
    }
    assert ExecutionD1Config.from_env(env).proxy_url == env["EXECUTION_D1_PROXY_URL"]
    with pytest.raises(ExecutionD1ConfigurationError, match="contract invalid"):
        ExecutionD1Config.from_env({
            **env,
            "EXECUTION_D1_PROXY_URL": "https://ledger.example.com@169.254.169.254/v1/d1/query",
        })
    with pytest.raises(ExecutionD1ConfigurationError, match="not allowlisted"):
        ExecutionD1Config.from_env({
            **env,
            "EXECUTION_D1_PROXY_URL": "https://evil.example/v1/d1/query",
        })
    with pytest.raises(ExecutionD1ConfigurationError, match="must not share"):
        ExecutionD1Config.from_env(
            {
                "ENVIRONMENT": "production",
                "CF_ACCOUNT_ID": "account",
                "CF_D1_DB_ID": "same-db",
                "CF_EXECUTION_D1_DB_ID": "same-db",
                "CF_EXECUTION_D1_INSTANCE_ID": "execution-instance-test",
                "EXECUTION_D1_PROXY_URL": "https://proxy.invalid/v1/d1/query",
                "EXECUTION_D1_PROXY_TOKEN": "token",
                "EXECUTION_D1_PROXY_ALLOWED_HOSTS": "proxy.invalid",
            }
        )


def test_read_retries_retryable_response_and_requires_primary() -> None:
    responses = [Response(503, {}), Response(200, _success([{"n": 1}]))]
    sleeps: list[float] = []

    def post(*args, **kwargs):
        return responses.pop(0)

    client = ExecutionD1Client(_config(), post_fn=post, sleep_fn=sleeps.append)
    assert client.query("SELECT 1 AS n") == [{"n": 1}]
    assert client._headers["X-Execution-Ledger-Instance-ID"] == "execution-instance-test"
    assert sleeps

    replica = ExecutionD1Client(
        _config(),
        post_fn=lambda *args, **kwargs: Response(200, _success([{"n": 1}], primary=False)),
    )
    with pytest.raises(ExecutionD1Error, match="primary execution not proven"):
        replica.query("SELECT 1 AS n")


def test_write_network_failure_is_ambiguous_and_never_retried() -> None:
    calls = 0

    def post(*args, **kwargs):
        nonlocal calls
        calls += 1
        raise TimeoutError("response lost")

    client = ExecutionD1Client(_config(), post_fn=post)
    with pytest.raises(ExecutionD1AmbiguousWriteError, match="response unavailable"):
        client.execute("UPDATE broker_execution_legs SET status='UNKNOWN'")
    assert calls == 1


def test_atomic_batch_rejects_partial_or_unproven_results() -> None:
    client = ExecutionD1Client(
        _config(),
        post_fn=lambda *args, **kwargs: Response(200, _success(changes=1)),
    )
    with pytest.raises(ExecutionD1AmbiguousWriteError, match="result count"):
        client.atomic_batch([("INSERT INTO a VALUES (?)", [1]), ("INSERT INTO b VALUES (?)", [2])])


def test_atomic_batch_preserves_statement_order_and_validates_every_result() -> None:
    captured = {}

    def post(*args, **kwargs):
        captured.update(kwargs["json"])
        item = _success(changes=1)["result"][0]
        return Response(200, {"success": True, "result": [item, item]})

    client = ExecutionD1Client(_config(), post_fn=post)
    result = client.atomic_batch(
        [("INSERT INTO a VALUES (?)", [1]), ("UPDATE b SET n=?", [2])]
    )
    assert result["atomic"] is True
    assert result["statement_count"] == 2
    assert captured["batch"] == [
        {"sql": "INSERT INTO a VALUES (?)", "params": [1]},
        {"sql": "UPDATE b SET n=?", "params": [2]},
    ]
