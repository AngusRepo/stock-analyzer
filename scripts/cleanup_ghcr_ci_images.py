#!/usr/bin/env python3
"""Delete only expired, explicitly temporary StockVision GHCR image versions."""

from __future__ import annotations

import argparse
import dataclasses
import datetime as dt
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Iterable, Mapping, Sequence
from typing import Any


UTC = dt.timezone.utc
PROTECTED_PREFIXES = ("release-", "prod-")
TEMPORARY_RETENTION_DAYS = {
    "ci-": 7,
    "quarantine-": 7,
    "candidate-": 30,
}


@dataclasses.dataclass(frozen=True)
class RetentionDecision:
    delete: bool
    reason: str


def _container_tags(version: Mapping[str, Any]) -> list[str]:
    metadata = version.get("metadata")
    container = metadata.get("container") if isinstance(metadata, Mapping) else None
    raw_tags = container.get("tags") if isinstance(container, Mapping) else None
    return [tag for tag in raw_tags or [] if isinstance(tag, str) and tag]


def _parse_github_timestamp(raw: Any) -> dt.datetime | None:
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        parsed = dt.datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(UTC)


def decide_version_retention(
    version: Mapping[str, Any],
    *,
    now: dt.datetime,
    retention_days: Mapping[str, int] = TEMPORARY_RETENTION_DAYS,
) -> RetentionDecision:
    """Fail closed unless every tag is an understood temporary retention tag."""

    tags = _container_tags(version)
    if not tags:
        return RetentionDecision(False, "untagged version retained")
    if any(tag.startswith(PROTECTED_PREFIXES) for tag in tags):
        return RetentionDecision(False, "release/prod tag retained")

    required_days: list[int] = []
    for tag in tags:
        matching = [days for prefix, days in retention_days.items() if tag.startswith(prefix)]
        if len(matching) != 1:
            return RetentionDecision(False, f"unknown tag retained: {tag}")
        required_days.append(matching[0])

    created_at = _parse_github_timestamp(version.get("created_at"))
    if created_at is None:
        return RetentionDecision(False, "invalid created_at retained")
    if now.tzinfo is None:
        raise ValueError("now must be timezone-aware")

    effective_days = max(required_days)
    expires_at = created_at + dt.timedelta(days=effective_days)
    if now.astimezone(UTC) < expires_at:
        return RetentionDecision(False, f"temporary version retained until {expires_at.isoformat()}")
    return RetentionDecision(True, f"temporary version expired after {effective_days} days")


class GitHubPackagesClient:
    def __init__(self, token: str, *, api_url: str = "https://api.github.com") -> None:
        if not token:
            raise ValueError("GitHub token is required")
        self._token = token
        self._api_url = api_url.rstrip("/")

    def _request(self, method: str, path: str) -> Any:
        request = urllib.request.Request(
            f"{self._api_url}{path}",
            method=method,
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {self._token}",
                "User-Agent": "stockvision-ghcr-retention",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            body = response.read()
        return json.loads(body) if body else None

    def owner_scope(self, owner: str) -> str:
        profile = self._request("GET", f"/users/{urllib.parse.quote(owner, safe='')}")
        if not isinstance(profile, Mapping):
            raise RuntimeError("GitHub owner lookup returned an invalid response")
        owner_type = profile.get("type")
        if owner_type == "Organization":
            return f"/orgs/{urllib.parse.quote(owner, safe='')}"
        if owner_type == "User":
            return f"/users/{urllib.parse.quote(owner, safe='')}"
        raise RuntimeError(f"Unsupported GitHub owner type: {owner_type!r}")

    def list_versions(self, scope: str, package: str) -> list[Mapping[str, Any]]:
        encoded = urllib.parse.quote(package, safe="")
        versions: list[Mapping[str, Any]] = []
        for page in range(1, 101):
            path = f"{scope}/packages/container/{encoded}/versions?per_page=100&page={page}"
            try:
                response = self._request("GET", path)
            except urllib.error.HTTPError as error:
                if error.code == 404:
                    return []
                raise
            if not isinstance(response, list):
                raise RuntimeError(f"Invalid versions response for {package}")
            page_items = [item for item in response if isinstance(item, Mapping)]
            versions.extend(page_items)
            if len(response) < 100:
                return versions
        raise RuntimeError(f"Pagination limit exceeded for {package}")

    def delete_version(self, scope: str, package: str, version_id: int) -> None:
        encoded = urllib.parse.quote(package, safe="")
        self._request("DELETE", f"{scope}/packages/container/{encoded}/versions/{version_id}")


def clean_packages(
    client: GitHubPackagesClient,
    *,
    owner: str,
    packages: Iterable[str],
    now: dt.datetime,
    dry_run: bool,
    max_deletes_per_package: int,
) -> int:
    scope = client.owner_scope(owner)
    total_deleted = 0
    for package in packages:
        deleted_for_package = 0
        versions = client.list_versions(scope, package)
        print(f"package={package} versions={len(versions)} dry_run={dry_run}")
        for version in sorted(versions, key=lambda item: str(item.get("created_at", ""))):
            decision = decide_version_retention(version, now=now)
            version_id = version.get("id")
            tags = _container_tags(version)
            print(f"  id={version_id} tags={tags!r} delete={decision.delete} reason={decision.reason}")
            if not decision.delete:
                continue
            if deleted_for_package >= max_deletes_per_package:
                print(f"  delete limit reached ({max_deletes_per_package}); remaining versions wait for next run")
                break
            if not isinstance(version_id, int):
                print("  invalid version id retained", file=sys.stderr)
                continue
            if not dry_run:
                client.delete_version(scope, package, version_id)
            deleted_for_package += 1
            total_deleted += 1
    return total_deleted


def _parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--owner", required=True)
    parser.add_argument("--package", action="append", dest="packages", required=True)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--max-deletes-per-package", type=int, default=25)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = _parse_args(argv or sys.argv[1:])
    if args.max_deletes_per_package < 1 or args.max_deletes_per_package > 100:
        raise SystemExit("--max-deletes-per-package must be between 1 and 100")
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN") or ""
    client = GitHubPackagesClient(token, api_url=os.environ.get("GITHUB_API_URL", "https://api.github.com"))
    deleted = clean_packages(
        client,
        owner=args.owner,
        packages=args.packages,
        now=dt.datetime.now(UTC),
        dry_run=args.dry_run,
        max_deletes_per_package=args.max_deletes_per_package,
    )
    print(f"eligible_versions={'reported' if args.dry_run else 'deleted'} count={deleted}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
