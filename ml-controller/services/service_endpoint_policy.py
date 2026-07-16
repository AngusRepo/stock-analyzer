"""Central validation for every credential-bearing controller egress base URL."""
from __future__ import annotations

import ipaddress
import os
from urllib.parse import urlsplit


class ServiceEndpointPolicyError(RuntimeError):
    pass


def validate_service_base_url(raw: str, *, name: str) -> str:
    value = raw.strip().rstrip("/")
    parsed = urlsplit(value)
    environment = os.environ.get("ENVIRONMENT", "production").strip().lower()
    cloud_runtime = bool(os.environ.get("K_SERVICE") or os.environ.get("K_REVISION"))
    local = environment in {"development", "dev", "local", "test"} and not cloud_runtime
    if parsed.scheme != "https" and not (
        local and parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    ):
        raise ServiceEndpointPolicyError(f"{name}: HTTPS is required")
    if not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ServiceEndpointPolicyError(f"{name}: origin-only URL required")
    hostname = parsed.hostname.lower()
    if hostname in {"metadata.google.internal", "localhost"} or hostname.endswith((".internal", ".local")):
        if not (local and hostname == "localhost"):
            raise ServiceEndpointPolicyError(f"{name}: private or metadata target forbidden")
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        address = None
    if address and (address.is_private or address.is_loopback or address.is_link_local or address.is_reserved):
        if not (local and address.is_loopback):
            raise ServiceEndpointPolicyError(f"{name}: private or metadata target forbidden")
    if parsed.path not in {"", "/"}:
        raise ServiceEndpointPolicyError(f"{name}: origin-only URL required")
    return value


def service_url(raw_base: str, path: str, *, name: str) -> str:
    base = validate_service_base_url(raw_base, name=name)
    if not path.startswith("/") or ".." in path or "?" in path or "#" in path:
        raise ServiceEndpointPolicyError(f"{name}: invalid service path")
    return f"{base}{path}"


def validate_discord_webhook_url(raw: str) -> str:
    value = raw.strip()
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or parsed.hostname not in {"discord.com", "discordapp.com"}
        or not parsed.path.startswith("/api/webhooks/")
        or parsed.username
        or parsed.password
        or parsed.fragment
    ):
        raise ServiceEndpointPolicyError("DISCORD_WEBHOOK_URL: unsupported webhook origin")
    return value


def validate_configured_service_endpoints() -> None:
    for name in ("ML_SERVICE_URL", "STOCKVISION_WORKER_URL"):
        value = os.environ.get(name, "").strip()
        if value:
            validate_service_base_url(value, name=name)
    webhook = os.environ.get("DISCORD_WEBHOOK_URL", "").strip()
    if webhook:
        validate_discord_webhook_url(webhook)
