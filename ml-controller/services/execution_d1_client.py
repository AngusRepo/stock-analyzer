"""Fail-closed Cloudflare D1 client for the real-trading execution ledger.

This client intentionally does not reuse the general-purpose D1 client.  Live
execution writes must never inherit dry-run no-op behavior, partial-write
fallbacks, or the CORE database identifier.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from typing import Any, Callable, Mapping
from urllib.parse import urlsplit

try:
    import httpx
except ModuleNotFoundError:  # pragma: no cover - exercised by image/runtime gates
    httpx = None


class ExecutionD1Error(RuntimeError):
    """Base error for execution-ledger access."""


class ExecutionD1ConfigurationError(ExecutionD1Error):
    """Raised when the execution database is not independently configured."""


class ExecutionD1AmbiguousWriteError(ExecutionD1Error):
    """A write may have committed but its response could not be proven."""


PostFn = Callable[..., Any]
SleepFn = Callable[[float], None]


def _truthy(value: Any) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "enabled", "on"}


@dataclass(frozen=True)
class ExecutionD1Config:
    account_id: str
    database_id: str
    instance_id: str
    api_token: str
    proxy_url: str
    proxy_token: str
    environment: str
    require_primary: bool
    read_retries: int

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "ExecutionD1Config":
        values = env or os.environ
        environment = str(values.get("ENVIRONMENT") or "development").strip().lower()
        account_id = str(values.get("CF_ACCOUNT_ID") or "").strip()
        database_id = str(values.get("CF_EXECUTION_D1_DB_ID") or "").strip()
        instance_id = str(values.get("CF_EXECUTION_D1_INSTANCE_ID") or "").strip()
        api_token = str(values.get("CF_EXECUTION_D1_API_TOKEN") or "").strip()
        proxy_url = str(values.get("EXECUTION_D1_PROXY_URL") or "").strip().rstrip("/")
        proxy_token = str(values.get("EXECUTION_D1_PROXY_TOKEN") or "").strip()
        allowed_proxy_hosts = {
            host.strip().lower()
            for host in str(values.get("EXECUTION_D1_PROXY_ALLOWED_HOSTS") or "").split(",")
            if host.strip()
        }
        core_database_id = str(values.get("CF_D1_DB_ID") or "").strip()
        required = [("CF_EXECUTION_D1_DB_ID", database_id)]
        if environment == "production":
            required.extend(
                [
                    ("EXECUTION_D1_PROXY_URL", proxy_url),
                    ("EXECUTION_D1_PROXY_TOKEN", proxy_token),
                    ("EXECUTION_D1_PROXY_ALLOWED_HOSTS", ",".join(sorted(allowed_proxy_hosts))),
                    ("CF_EXECUTION_D1_INSTANCE_ID", instance_id),
                ]
            )
        elif not (proxy_url and proxy_token):
            required.extend(
                [
                    ("CF_ACCOUNT_ID", account_id),
                    ("CF_EXECUTION_D1_API_TOKEN", api_token),
                ]
            )
        missing = [key for key, value in required if not value]
        if missing:
            raise ExecutionD1ConfigurationError(
                f"execution D1 configuration missing: {','.join(missing)}"
            )
        if core_database_id and database_id == core_database_id:
            raise ExecutionD1ConfigurationError(
                "execution D1 must not share CF_D1_DB_ID with CORE"
            )
        if environment == "production" and instance_id == "UNPROVISIONED":
            raise ExecutionD1ConfigurationError(
                "CF_EXECUTION_D1_INSTANCE_ID must be provisioned"
            )
        if proxy_url:
            parsed = urlsplit(proxy_url)
            hostname = str(parsed.hostname or "").lower()
            if (
                parsed.scheme != "https"
                or not hostname
                or parsed.username is not None
                or parsed.password is not None
                or parsed.query
                or parsed.fragment
                or parsed.path != "/v1/d1/query"
            ):
                raise ExecutionD1ConfigurationError("EXECUTION_D1_PROXY_URL contract invalid")
            if environment == "production" and hostname not in allowed_proxy_hosts:
                raise ExecutionD1ConfigurationError("execution D1 proxy host is not allowlisted")
        retries_raw = str(values.get("EXECUTION_D1_READ_RETRIES") or "2").strip()
        try:
            read_retries = max(0, min(int(retries_raw), 3))
        except ValueError as exc:
            raise ExecutionD1ConfigurationError("EXECUTION_D1_READ_RETRIES must be an integer") from exc
        require_primary_raw = values.get("EXECUTION_D1_REQUIRE_PRIMARY")
        require_primary = environment == "production" if require_primary_raw is None else _truthy(require_primary_raw)
        return cls(
            account_id=account_id,
            database_id=database_id,
            instance_id=instance_id,
            api_token=api_token,
            proxy_url=proxy_url,
            proxy_token=proxy_token,
            environment=environment,
            require_primary=require_primary,
            read_retries=read_retries,
        )


class ExecutionD1Client:
    """Small synchronous client with explicit read and ambiguous-write policy."""

    def __init__(
        self,
        config: ExecutionD1Config,
        *,
        post_fn: PostFn | None = None,
        sleep_fn: SleepFn = time.sleep,
    ) -> None:
        if httpx is None and post_fn is None:
            raise ExecutionD1ConfigurationError("httpx is required for execution D1")
        self.config = config
        self._post_fn = post_fn or httpx.post
        self._sleep = sleep_fn
        self._url = config.proxy_url or (
            f"https://api.cloudflare.com/client/v4/accounts/{config.account_id}"
            f"/d1/database/{config.database_id}/query"
        )
        self._headers = {
            "Authorization": f"Bearer {config.proxy_token or config.api_token}",
            "Content-Type": "application/json",
        }
        if config.proxy_url:
            self._headers["X-Execution-Ledger-Instance-ID"] = config.instance_id

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "ExecutionD1Client":
        return cls(ExecutionD1Config.from_env(env))

    def _post(self, body: dict[str, Any], *, timeout: float, write: bool) -> list[dict[str, Any]]:
        attempts = 1 if write else self.config.read_retries + 1
        last_error: Exception | None = None
        for attempt in range(attempts):
            try:
                response = self._post_fn(
                    self._url,
                    headers=self._headers,
                    json=body,
                    timeout=timeout,
                )
            except Exception as exc:
                if write:
                    raise ExecutionD1AmbiguousWriteError(
                        f"execution D1 write response unavailable:{exc.__class__.__name__}"
                    ) from exc
                last_error = exc
                if attempt + 1 < attempts:
                    self._sleep(min(0.1 * (2**attempt), 0.5))
                    continue
                raise ExecutionD1Error(
                    f"execution D1 read unavailable:{exc.__class__.__name__}"
                ) from exc

            if int(response.status_code) != 200:
                status = int(response.status_code)
                if not write and status in {429, 500, 502, 503, 504} and attempt + 1 < attempts:
                    self._sleep(min(0.1 * (2**attempt), 0.5))
                    continue
                error_cls = ExecutionD1AmbiguousWriteError if write else ExecutionD1Error
                raise error_cls(f"execution D1 HTTP {status}")
            try:
                payload = response.json()
            except Exception as exc:
                error_cls = ExecutionD1AmbiguousWriteError if write else ExecutionD1Error
                raise error_cls("execution D1 returned invalid JSON") from exc
            if not isinstance(payload, Mapping) or payload.get("success") is not True:
                error_cls = ExecutionD1AmbiguousWriteError if write else ExecutionD1Error
                raise error_cls("execution D1 response unsuccessful")
            results = payload.get("result")
            if not isinstance(results, list):
                error_cls = ExecutionD1AmbiguousWriteError if write else ExecutionD1Error
                raise error_cls("execution D1 result list missing")
            normalized = [dict(item) for item in results if isinstance(item, Mapping)]
            if len(normalized) != len(results):
                error_cls = ExecutionD1AmbiguousWriteError if write else ExecutionD1Error
                raise error_cls("execution D1 result item invalid")
            return normalized
        raise ExecutionD1Error(f"execution D1 request exhausted:{last_error.__class__.__name__ if last_error else 'unknown'}")

    def _validate_result(self, result: Mapping[str, Any], *, write: bool) -> dict[str, Any]:
        error_cls = ExecutionD1AmbiguousWriteError if write else ExecutionD1Error
        if result.get("success") is not True:
            raise error_cls("execution D1 statement unsuccessful")
        meta = result.get("meta") if isinstance(result.get("meta"), Mapping) else {}
        if self.config.require_primary and meta.get("served_by_primary") is not True:
            raise error_cls("execution D1 primary execution not proven")
        return {
            "success": True,
            "results": list(result.get("results") or []),
            "meta": dict(meta),
        }

    def query(self, sql: str, params: list[Any] | None = None, timeout: float = 5.0) -> list[dict[str, Any]]:
        results = self._post({"sql": sql, "params": params or []}, timeout=timeout, write=False)
        if len(results) != 1:
            raise ExecutionD1Error("execution D1 single read returned unexpected result count")
        item = self._validate_result(results[0], write=False)
        rows = item.get("results") or []
        if not all(isinstance(row, Mapping) for row in rows):
            raise ExecutionD1Error("execution D1 read row invalid")
        return [dict(row) for row in rows]

    def execute(self, sql: str, params: list[Any] | None = None, timeout: float = 5.0) -> dict[str, Any]:
        results = self._post({"sql": sql, "params": params or []}, timeout=timeout, write=True)
        if len(results) != 1:
            raise ExecutionD1AmbiguousWriteError(
                "execution D1 single write returned unexpected result count"
            )
        return self._validate_result(results[0], write=True)

    def atomic_batch(
        self,
        statements: list[tuple[str, list[Any]]],
        timeout: float = 5.0,
    ) -> dict[str, Any]:
        if not statements:
            raise ExecutionD1Error("execution D1 atomic batch must not be empty")
        if len(statements) > 100:
            raise ExecutionD1Error("execution D1 atomic batch exceeds 100 statements")
        body = {
            "batch": [
                {"sql": sql, "params": params or []}
                for sql, params in statements
            ]
        }
        results = self._post(body, timeout=timeout, write=True)
        if len(results) != len(statements):
            raise ExecutionD1AmbiguousWriteError(
                f"execution D1 batch result count {len(results)}/{len(statements)}"
            )
        validated = [self._validate_result(item, write=True) for item in results]
        return {
            "success": True,
            "statement_count": len(validated),
            "results": validated,
            "atomic": True,
        }
