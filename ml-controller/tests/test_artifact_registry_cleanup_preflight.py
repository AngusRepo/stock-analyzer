from __future__ import annotations

from datetime import datetime, timezone
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "ml-controller" / "scripts" / "artifact_registry_cleanup_preflight.py"
SPEC = spec_from_file_location("artifact_registry_cleanup_preflight", SCRIPT)
assert SPEC and SPEC.loader
MODULE = module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


REPO = "asia-east1-docker.pkg.dev/test-project/cloud-run-source-deploy"
NOW = datetime(2026, 7, 22, tzinfo=timezone.utc)


def image(package: str, digest: str, created: str, tags: list[str] | None = None, size: int = 100) -> dict:
    return {
        "package": f"{REPO}/{package}",
        "version": digest,
        "tags": tags or [],
        "createTime": created,
        "metadata": {"imageSizeBytes": str(size)},
    }


def resource(name: str, image_ref: str) -> dict:
    return {
        "metadata": {"name": name},
        "spec": {"template": {"spec": {"containers": [{"image": image_ref}]}}},
    }


def test_active_digest_is_protected_by_latest_ten() -> None:
    images = [
        image("ml-controller", f"sha256:{index:064x}", f"2026-07-{21-index:02d}T00:00:00Z")
        for index in range(3)
    ]
    active = images[-1]
    report = MODULE.build_preflight_report(
        images=images,
        services=[resource("ml-controller", f"{REPO}/ml-controller@{active['version']}")],
        jobs=[],
        repository_prefix=REPO,
        now=NOW,
    )
    assert report["status"] == "pass"
    assert report["runtime_references"][0]["protected_by_latest_10"] is True


def test_old_active_job_digest_blocks_cleanup_until_tagged() -> None:
    images = [
        image("ml-controller", f"sha256:{index:064x}", f"2026-07-{20-index:02d}T00:00:00Z")
        for index in range(11)
    ]
    old = image("ml-controller", "sha256:" + "f" * 64, "2026-06-01T00:00:00Z")
    images.append(old)
    report = MODULE.build_preflight_report(
        images=images,
        services=[],
        jobs=[resource("backfill", f"{REPO}/ml-controller@{old['version']}")],
        repository_prefix=REPO,
        now=NOW,
    )
    assert report["status"] == "blocked"
    assert report["summary"]["unprotected_runtime_references"] == 1
    assert report["unprotected_runtime_references"][0]["source"] == "job/backfill"


def test_protected_job_tag_overrides_age_delete_policy() -> None:
    old = image("ml-controller", "sha256:" + "e" * 64, "2026-01-01T00:00:00Z", ["job-backfill"])
    report = MODULE.build_preflight_report(
        images=[old],
        services=[],
        jobs=[resource("backfill", f"{REPO}/ml-controller:job-backfill")],
        repository_prefix=REPO,
        now=NOW,
    )
    assert report["status"] == "pass"
    assert report["deletion_candidates"] == []


def test_unreferenced_legacy_package_and_deletion_bytes_are_reported() -> None:
    images = [
        image("active", "sha256:" + "a" * 64, "2026-07-21T00:00:00Z", ["latest"], 200),
        image("legacy", "sha256:" + "b" * 64, "2026-01-01T00:00:00Z", [], 500),
    ]
    report = MODULE.build_preflight_report(
        images=images,
        services=[resource("active", f"{REPO}/active:latest")],
        jobs=[],
        repository_prefix=REPO,
        now=NOW,
    )
    assert report["unreferenced_packages"] == ["legacy"]
    assert report["summary"]["deletion_candidate_bytes"] == 500
    assert report["packages"][1]["runtime_referenced"] is False


def test_cleanup_policy_matches_preflight_protection_contract() -> None:
    import json

    policies = json.loads((ROOT / "infra" / "artifact-registry-cleanup-policy.json").read_text(encoding="utf-8"))
    by_name = {policy["name"]: policy for policy in policies}
    assert by_name["delete-untagged-after-7d"]["condition"]["olderThan"] == "7d"
    assert by_name["delete-unprotected-tagged-after-30d"]["condition"]["olderThan"] == "30d"
    keep_tags = by_name["keep-protected-tags"]["condition"]
    assert tuple(keep_tags["tagPrefixes"]) == MODULE.PROTECTED_TAG_PREFIXES
    assert tuple(keep_tags["packageNamePrefixes"]) == MODULE.PROTECTED_PACKAGE_PREFIXES
    keep_recent = by_name["keep-latest-10-per-package"]["mostRecentVersions"]
    assert keep_recent["keepCount"] == 10
    assert tuple(keep_recent["packageNamePrefixes"]) == MODULE.PROTECTED_PACKAGE_PREFIXES