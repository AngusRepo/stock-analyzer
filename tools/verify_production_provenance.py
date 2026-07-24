from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any


SOURCE_COMPONENTS = ("cloud_run", "modal", "worker", "pages")
SHA40 = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")


def verify_production_provenance(snapshot: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    for component in (*SOURCE_COMPONENTS, "scheduler"):
        if not isinstance(snapshot.get(component), dict):
            errors.append(f"missing component: {component}")

    source_shas: dict[str, str] = {}
    for component in SOURCE_COMPONENTS:
        value = str((snapshot.get(component) or {}).get("source_sha", "")).strip().lower()
        if not SHA40.fullmatch(value):
            errors.append(f"{component}.source_sha must be a full 40-character Git SHA")
        else:
            source_shas[component] = value
    if len(set(source_shas.values())) > 1:
        errors.append("source SHA split: " + ", ".join(f"{key}={value}" for key, value in source_shas.items()))

    cloud_run = snapshot.get("cloud_run") or {}
    image_digest = str(cloud_run.get("image_digest", ""))
    if "@sha256:" not in image_digest:
        errors.append("cloud_run.image_digest must be an immutable @sha256 reference")

    worker = snapshot.get("worker") or {}
    if not str(worker.get("version_id", "")).strip():
        errors.append("worker.version_id is required")

    expected_manifest = str((snapshot.get("scheduler") or {}).get("manifest_sha256", "")).strip().lower()
    if not SHA256.fullmatch(expected_manifest):
        errors.append("scheduler.manifest_sha256 must be a 64-character SHA-256")
    for component in ("cloud_run", "pages"):
        observed = str((snapshot.get(component) or {}).get("scheduler_manifest_sha256", "")).strip().lower()
        if not SHA256.fullmatch(observed):
            errors.append(f"{component}.scheduler_manifest_sha256 must be a 64-character SHA-256")
        elif expected_manifest and observed != expected_manifest:
            errors.append(f"scheduler manifest split: {component}={observed} scheduler={expected_manifest}")

    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description="Fail closed on split StockVision production provenance")
    parser.add_argument("snapshot", type=Path)
    args = parser.parse_args()
    snapshot = json.loads(args.snapshot.read_text(encoding="utf-8"))
    errors = verify_production_provenance(snapshot)
    print(json.dumps({"ok": not errors, "errors": errors}, ensure_ascii=False, indent=2))
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
