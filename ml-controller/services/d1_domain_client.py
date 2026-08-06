"""Domain-aware D1 clients with explicit legacy fallback during cutover."""
from __future__ import annotations

import os
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


def database_id_for_domain(domain: D1DataDomain | str) -> str:
    resolved_domain = D1DataDomain(domain)
    strict = os.environ.get("MULTI_D1_STRICT", "").strip().lower() in {"1", "true", "yes", "on"}
    active_domains = _active_domains()
    if (strict or active_domains) and not MULTI_D1_STRICT_ROUTING_READY:
        raise RuntimeError("multi_d1_strict_routing_not_closed")
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


def client_for_domain(domain: D1DataDomain | str) -> DomainD1Client:
    return DomainD1Client(D1DataDomain(domain))
