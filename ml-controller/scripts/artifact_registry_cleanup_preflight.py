from __future__ import annotations

import argparse
import json
import shutil
import subprocess
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


PROTECTED_TAG_PREFIXES = (
    "latest",
    "prod-",
    "rollback-",
    "job-",
    "canary-",
    "sizing-canary-",
    "security-hardening-",
)
PROTECTED_PACKAGE_PREFIXES = (
    "ml-controller",
    "shioaji-proxy",
    "shioaji-research",
    "stockvision-execution-gateway",
)


def _run_json(command: list[str]) -> list[dict[str, Any]]:
    completed = subprocess.run(command, check=True, capture_output=True, text=True, encoding="utf-8")
    payload = json.loads(completed.stdout)
    if not isinstance(payload, list):
        raise ValueError(f"Expected JSON list from {' '.join(command)}")
    return payload


def _load_or_run(path: Path | None, command: list[str]) -> list[dict[str, Any]]:
    if path is not None:
        payload = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(payload, list):
            raise ValueError(f"Expected JSON list in {path}")
        return payload
    return _run_json(command)


def _walk_images(value: Any) -> Iterable[str]:
    if isinstance(value, dict):
        for key, child in value.items():
            if key == "image" and isinstance(child, str):
                yield child
            else:
                yield from _walk_images(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk_images(child)


def collect_runtime_references(resources: list[dict[str, Any]], source_kind: str) -> list[dict[str, str]]:
    references: list[dict[str, str]] = []
    for resource in resources:
        metadata = resource.get("metadata") if isinstance(resource.get("metadata"), dict) else {}
        source_name = str(metadata.get("name") or resource.get("name") or "unknown")
        for image in sorted(set(_walk_images(resource))):
            references.append({"source": f"{source_kind}/{source_name}", "image": image})
    return references


def _parse_registry_reference(image: str, repository_prefix: str) -> tuple[str, str, str] | None:
    prefix = repository_prefix.rstrip("/") + "/"
    if not image.startswith(prefix):
        return None
    remainder = image[len(prefix) :]
    if "@" in remainder:
        package, digest = remainder.split("@", 1)
        return package, "digest", digest
    if ":" in remainder:
        package, tag = remainder.rsplit(":", 1)
        return package, "tag", tag
    return remainder, "tag", "latest"


def _parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def build_preflight_report(
    *,
    images: list[dict[str, Any]],
    services: list[dict[str, Any]],
    jobs: list[dict[str, Any]],
    repository_prefix: str,
    now: datetime,
) -> dict[str, Any]:
    by_package_digest: dict[tuple[str, str], dict[str, Any]] = {}
    by_package_tag: dict[tuple[str, str], dict[str, Any]] = {}
    versions_by_package: dict[str, list[dict[str, Any]]] = defaultdict(list)

    for image in images:
        package_full = str(image.get("package") or "")
        package = package_full.removeprefix(repository_prefix.rstrip("/") + "/")
        digest = str(image.get("version") or "")
        record = {
            "package": package,
            "digest": digest,
            "tags": sorted(str(tag) for tag in image.get("tags") or []),
            "create_time": str(image.get("createTime") or ""),
            "size_bytes": int((image.get("metadata") or {}).get("imageSizeBytes") or 0),
        }
        by_package_digest[(package, digest)] = record
        versions_by_package[package].append(record)
        for tag in record["tags"]:
            by_package_tag[(package, tag)] = record

    latest_keys: set[tuple[str, str]] = set()
    for package, versions in versions_by_package.items():
        versions.sort(key=lambda item: item["create_time"], reverse=True)
        if package.startswith(PROTECTED_PACKAGE_PREFIXES):
            latest_keys.update((package, item["digest"]) for item in versions[:10])

    raw_references = collect_runtime_references(services, "service") + collect_runtime_references(jobs, "job")
    resolved_references: list[dict[str, Any]] = []
    unprotected: list[dict[str, Any]] = []
    referenced_packages: set[str] = set()
    for reference in raw_references:
        parsed = _parse_registry_reference(reference["image"], repository_prefix)
        if parsed is None:
            continue
        package, reference_type, value = parsed
        referenced_packages.add(package)
        record = by_package_digest.get((package, value)) if reference_type == "digest" else by_package_tag.get((package, value))
        tags = record["tags"] if record else []
        protected_by_tag = package.startswith(PROTECTED_PACKAGE_PREFIXES) and any(
            tag.startswith(PROTECTED_TAG_PREFIXES) for tag in tags
        )
        protected_by_recency = bool(record and (package, record["digest"]) in latest_keys)
        resolved = {
            **reference,
            "package": package,
            "reference_type": reference_type,
            "reference_value": value,
            "resolved_digest": record["digest"] if record else None,
            "tags": tags,
            "protected_by_tag": protected_by_tag,
            "protected_by_latest_10": protected_by_recency,
            "protected": bool(record and (protected_by_tag or protected_by_recency)),
        }
        resolved_references.append(resolved)
        if not resolved["protected"]:
            unprotected.append(resolved)

    deletion_candidates: list[dict[str, Any]] = []
    for package, versions in versions_by_package.items():
        for record in versions:
            tags = record["tags"]
            protected_by_tag = package.startswith(PROTECTED_PACKAGE_PREFIXES) and any(
                tag.startswith(PROTECTED_TAG_PREFIXES) for tag in tags
            )
            protected_by_recency = (package, record["digest"]) in latest_keys
            if protected_by_tag or protected_by_recency or not record["create_time"]:
                continue
            age_days = (now - _parse_time(record["create_time"])).total_seconds() / 86400
            threshold = 30 if tags else 7
            if age_days >= threshold:
                deletion_candidates.append({**record, "age_days": round(age_days, 2)})

    package_summary = []
    for package, versions in sorted(versions_by_package.items()):
        package_summary.append(
            {
                "package": package,
                "versions": len(versions),
                "size_bytes": sum(item["size_bytes"] for item in versions),
                "runtime_referenced": package in referenced_packages,
            }
        )

    return {
        "status": "pass" if not unprotected else "blocked",
        "generated_at": now.isoformat(),
        "repository": repository_prefix,
        "policy": {
            "delete_untagged_after_days": 7,
            "delete_tagged_after_days": 30,
            "keep_latest_per_package": 10,
            "protected_tag_prefixes": list(PROTECTED_TAG_PREFIXES),
            "protected_package_prefixes": list(PROTECTED_PACKAGE_PREFIXES),
        },
        "summary": {
            "packages": len(versions_by_package),
            "versions": len(images),
            "size_bytes": sum(item["size_bytes"] for versions in versions_by_package.values() for item in versions),
            "runtime_references": len(resolved_references),
            "unprotected_runtime_references": len(unprotected),
            "deletion_candidate_versions": len(deletion_candidates),
            "deletion_candidate_bytes": sum(item["size_bytes"] for item in deletion_candidates),
        },
        "packages": package_summary,
        "runtime_references": resolved_references,
        "unprotected_runtime_references": unprotected,
        "unreferenced_packages": sorted(set(versions_by_package) - referenced_packages),
        "deletion_candidates": sorted(deletion_candidates, key=lambda item: (item["package"], item["create_time"])),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only Artifact Registry cleanup safety preflight")
    parser.add_argument("--project", default="gen-lang-client-0602998820")
    parser.add_argument("--location", default="asia-east1")
    parser.add_argument("--repository", default="cloud-run-source-deploy")
    parser.add_argument("--services-json", type=Path)
    parser.add_argument("--jobs-json", type=Path)
    parser.add_argument("--images-json", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    gcloud = shutil.which("gcloud.cmd") or shutil.which("gcloud")
    if gcloud is None and not (args.services_json and args.jobs_json and args.images_json):
        raise RuntimeError("gcloud CLI was not found on PATH")
    gcloud = gcloud or "gcloud"

    repository_prefix = f"{args.location}-docker.pkg.dev/{args.project}/{args.repository}"
    services = _load_or_run(
        args.services_json,
        [gcloud, "run", "services", "list", "--project", args.project, "--region", args.location, "--format=json"],
    )
    jobs = _load_or_run(
        args.jobs_json,
        [gcloud, "run", "jobs", "list", "--project", args.project, "--region", args.location, "--format=json"],
    )
    images = _load_or_run(
        args.images_json,
        [gcloud, "artifacts", "docker", "images", "list", repository_prefix, "--include-tags", "--format=json"],
    )
    report = build_preflight_report(
        images=images,
        services=services,
        jobs=jobs,
        repository_prefix=repository_prefix,
        now=datetime.now(timezone.utc),
    )
    rendered = json.dumps(report, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)
    return 0 if report["status"] == "pass" else 2


if __name__ == "__main__":
    raise SystemExit(main())
