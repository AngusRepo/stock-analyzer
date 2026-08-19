"""Domain-aware D1 clients with explicit legacy fallback during cutover."""
from __future__ import annotations

import os
import re
from dataclasses import dataclass
from enum import Enum
from typing import Any

from services import d1_client
from services.allocator_contract_guard import allocator_contract_guard_enabled


class D1DataDomain(str, Enum):
    CORE = "core"
    MARKET = "market"
    LEARNING = "learning"
    OPS = "ops"
    EXECUTION = "execution"
    PAPER = "paper"
    RESEARCH = "research"


_DOMAIN_ENV = {
    D1DataDomain.CORE: "CF_D1_CORE_DB_ID",
    D1DataDomain.MARKET: "CF_D1_MARKET_DB_ID",
    D1DataDomain.LEARNING: "CF_D1_LEARNING_DB_ID",
    D1DataDomain.OPS: "CF_D1_OPS_DB_ID",
    D1DataDomain.EXECUTION: "CF_D1_EXECUTION_DB_ID",
    D1DataDomain.PAPER: "CF_D1_PAPER_DB_ID",
    D1DataDomain.RESEARCH: "CF_D1_RESEARCH_DB_ID",
}

MULTI_D1_STRICT_ROUTING_READY = False

_SHADOW_READ_MUTATION = re.compile(
    r"\b(alter|attach|create|delete|detach|drop|insert|replace|truncate|update|vacuum)\b",
    re.IGNORECASE,
)


def _assert_shadow_read_only_sql(sql: str) -> None:
    token = d1_client._first_sql_token(sql)
    if token not in {"select", "with", "explain"} or _SHADOW_READ_MUTATION.search(sql or ""):
        raise RuntimeError("d1_shadow_client_read_only_violation")


def shadow_database_id_for_domain(domain: D1DataDomain | str) -> str:
    resolved_domain = D1DataDomain(domain)
    specific = os.environ.get(_DOMAIN_ENV[resolved_domain], "").strip()
    if not specific:
        raise RuntimeError(f"D1 shadow database id missing: {resolved_domain.value}")
    return specific


def _active_domains() -> set[D1DataDomain]:
    values = {
        value.strip().lower()
        for value in os.environ.get("MULTI_D1_ACTIVE_DOMAINS", "").split(",")
        if value.strip()
    }
    allowed = {domain.value for domain in D1DataDomain}
    invalid = sorted(values - allowed)
    if invalid:
        raise RuntimeError(f"multi_d1_active_domain_invalid:{','.join(invalid)}")
    return {domain for domain in D1DataDomain if domain.value in values}


def _domain_routing_contract_version(domain: D1DataDomain) -> str:
    return f'{domain.value}-single-writer-epoch-v1'


def _routing_closed_domains() -> frozenset[D1DataDomain]:
    closed: set[D1DataDomain] = set()
    for domain in D1DataDomain:
        prefix = f'MULTI_D1_{domain.value.upper()}'
        contract = os.environ.get(f'{prefix}_ROUTING_CONTRACT', '').strip()
        receipt = os.environ.get(f'{prefix}_CUTOVER_RECEIPT_ID', '').strip()
        writer_epoch = os.environ.get(f'{prefix}_WRITER_EPOCH', '').strip()
        if (
            contract == _domain_routing_contract_version(domain)
            and receipt.startswith(f'data-domain-cutover-probe:{domain.value}:')
            and writer_epoch.isdigit()
            and int(writer_epoch) > 0
        ):
            closed.add(domain)
    return frozenset(closed)


def database_id_for_domain(domain: D1DataDomain | str) -> str:
    resolved_domain = D1DataDomain(domain)
    strict = os.environ.get("MULTI_D1_STRICT", "").strip().lower() in {"1", "true", "yes", "on"}
    active_domains = _active_domains()
    unclosed = sorted(
        domain.value for domain in active_domains
        if not MULTI_D1_STRICT_ROUTING_READY and domain not in _routing_closed_domains()
    )
    if (strict or active_domains) and unclosed:
        raise RuntimeError(f"multi_d1_strict_routing_not_closed:{','.join(unclosed)}")
    if strict and not active_domains:
        raise RuntimeError("multi_d1_strict_active_domains_missing")
    domain_active = resolved_domain in active_domains
    if domain_active:
        specific = os.environ.get(_DOMAIN_ENV[resolved_domain], "").strip()
        if specific:
            return specific
        raise RuntimeError(f"D1 domain database id missing: {resolved_domain.value}")

    legacy = os.environ.get("CF_D1_DB_ID", d1_client.CF_D1_DB_ID).strip()
    if not legacy:
        raise RuntimeError(f"Legacy CF_D1_DB_ID missing for domain: {resolved_domain.value}")
    return legacy


@dataclass(frozen=True)
class DomainD1Client:
    domain: D1DataDomain

    @property
    def database_id(self) -> str:
        return database_id_for_domain(self.domain)

    def query(
        self,
        sql: str,
        params: list[Any] | None = None,
        timeout: float = 60.0,
    ) -> list[dict]:
        if allocator_contract_guard_enabled() and d1_client._is_mutating_sql(sql):
            return []
        body: dict[str, Any] = {"sql": sql}
        if params:
            body["params"] = params
        data = d1_client._post(body, timeout=timeout, database_id=self.database_id)
        results = data.get("result") or []
        return (results[0].get("results") or []) if results else []

    def execute(
        self,
        sql: str,
        params: list[Any] | None = None,
        timeout: float = 60.0,
    ) -> dict:
        if allocator_contract_guard_enabled():
            return {"success": True, "meta": d1_client._noop_write_meta(1), "results": []}
        body: dict[str, Any] = {"sql": sql}
        if params:
            body["params"] = params
        data = d1_client._post(body, timeout=timeout, database_id=self.database_id)
        results = data.get("result") or []
        if not results:
            return {"success": True, "meta": {}, "results": []}
        return {
            "success": True,
            "meta": results[0].get("meta") or {},
            "results": results[0].get("results") or [],
        }

    def batch_execute(
        self,
        statements: list[tuple[str, list[Any]]],
        timeout: float = 30.0,
        chunk_size: int = 250,
    ) -> dict:
        if allocator_contract_guard_enabled():
            total = len(statements)
            return {
                "total": total,
                "success_count": total,
                "error_count": 0,
                "changes_total": total,
                "mode": "allocator_contract_noop",
            }
        return d1_client._raw_batch_execute(
            statements,
            timeout=timeout,
            chunk_size=chunk_size,
            database_id=self.database_id,
        )

    def atomic_batch_execute(
        self,
        statements: list[tuple[str, list[Any]]],
        timeout: float = 30.0,
    ) -> dict:
        if not statements:
            return {
                "total": 0,
                "success_count": 0,
                "error_count": 0,
                "changes_total": 0,
                "mode": "atomic_empty",
                "atomic": True,
            }
        if len(statements) > 500:
            raise RuntimeError(f"Atomic D1 batch exceeds 500 statements: {len(statements)}")
        if allocator_contract_guard_enabled():
            raise RuntimeError("Atomic D1 batch cannot run while allocator contract guard is enabled")

        result = d1_client._raw_batch_execute(
            statements,
            timeout=timeout,
            chunk_size=len(statements),
            database_id=self.database_id,
        )
        if (
            int(result.get("success_count") or 0) != len(statements)
            or int(result.get("error_count") or 0) != 0
            or bool(result.get("partial_failure"))
        ):
            raise RuntimeError(f"Atomic domain D1 batch did not fully commit: {result}")
        return {**result, "atomic": True}


@dataclass(frozen=True)
class ShadowDomainD1Client:
    """Explicit target-domain reader that can never mutate or activate routing."""

    domain: D1DataDomain

    @property
    def database_id(self) -> str:
        return shadow_database_id_for_domain(self.domain)

    def query(
        self,
        sql: str,
        params: list[Any] | None = None,
        timeout: float = 60.0,
    ) -> list[dict]:
        _assert_shadow_read_only_sql(sql)
        body: dict[str, Any] = {"sql": sql}
        if params:
            body["params"] = params
        data = d1_client._post(body, timeout=timeout, database_id=self.database_id)
        results = data.get("result") or []
        return (results[0].get("results") or []) if results else []


def client_for_domain(domain: D1DataDomain | str) -> DomainD1Client:
    return DomainD1Client(D1DataDomain(domain))


class DomainD1ClientProxy:
    """Mutable test seam that resolves active-domain routing for every call."""

    def __init__(self, domain: D1DataDomain | str) -> None:
        self.domain = D1DataDomain(domain)

    def query(self, *args: Any, **kwargs: Any) -> list[dict]:
        return client_for_domain(self.domain).query(*args, **kwargs)

    def execute(self, *args: Any, **kwargs: Any) -> dict:
        return client_for_domain(self.domain).execute(*args, **kwargs)

    def batch_execute(self, *args: Any, **kwargs: Any) -> dict:
        return client_for_domain(self.domain).batch_execute(*args, **kwargs)


def client_proxy_for_domain(domain: D1DataDomain | str) -> DomainD1ClientProxy:
    return DomainD1ClientProxy(domain)


def shadow_client_for_domain(domain: D1DataDomain | str) -> ShadowDomainD1Client:
    return ShadowDomainD1Client(D1DataDomain(domain))
