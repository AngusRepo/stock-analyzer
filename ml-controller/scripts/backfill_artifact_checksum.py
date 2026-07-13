"""Backfill a missing GCS artifact checksum without weakening serving validation."""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone

from google.cloud import storage


def _sha256(raw: bytes) -> str:
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def _backup_path(metadata_path: str, *, version: str, timestamp: str) -> str:
    directory, _, filename = metadata_path.rpartition("/")
    stamp = timestamp.replace("-", "").replace(":", "").replace("T", "_").replace("Z", "Z")
    prefix = f"{directory}/" if directory else ""
    return f"{prefix}metadata_backups/{filename.removesuffix('.json')}_before_checksum_{stamp}.json"


def backfill_checksum(
    *,
    bucket_name: str,
    model_name: str,
    version: str,
    artifact_path: str,
    metadata_path: str,
    apply: bool,
) -> dict:
    client = storage.Client()
    bucket = client.bucket(bucket_name)
    artifact_blob = bucket.get_blob(artifact_path)
    metadata_blob = bucket.get_blob(metadata_path)
    if artifact_blob is None:
        raise FileNotFoundError(f"artifact not found: gs://{bucket_name}/{artifact_path}")
    if metadata_blob is None:
        raise FileNotFoundError(f"metadata not found: gs://{bucket_name}/{metadata_path}")

    raw_metadata = metadata_blob.download_as_bytes()
    metadata = json.loads(raw_metadata)
    if str(metadata.get("version") or "") != version:
        raise ValueError(
            f"metadata version mismatch: expected={version} actual={metadata.get('version')}"
        )

    artifact_raw = artifact_blob.download_as_bytes()
    actual_checksum = _sha256(artifact_raw)
    existing_checksum = str(
        metadata.get("checksum") or metadata.get("artifact_checksum") or ""
    ).strip().lower()
    if existing_checksum and existing_checksum != actual_checksum:
        raise ValueError(
            f"existing checksum mismatch: expected={existing_checksum} actual={actual_checksum}"
        )

    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    report = {
        "status": "already_present" if existing_checksum else "ready",
        "apply": apply,
        "bucket": bucket_name,
        "model_name": model_name,
        "version": version,
        "artifact_path": artifact_path,
        "metadata_path": metadata_path,
        "artifact_generation": str(artifact_blob.generation),
        "metadata_generation": str(metadata_blob.generation),
        "artifact_created_at": artifact_blob.time_created.isoformat() if artifact_blob.time_created else None,
        "metadata_created_at": metadata_blob.time_created.isoformat() if metadata_blob.time_created else None,
        "checksum": actual_checksum,
        "backup_path": None,
    }
    if existing_checksum or not apply:
        return report

    backup_path = _backup_path(metadata_path, version=version, timestamp=now)
    backup_blob = bucket.blob(backup_path)
    backup_blob.upload_from_string(
        raw_metadata,
        content_type="application/json",
        if_generation_match=0,
    )
    metadata["checksum"] = actual_checksum
    metadata["artifact_integrity_migration"] = {
        "schema_version": "artifact-checksum-backfill-v1",
        "model_name": model_name,
        "version": version,
        "artifact_path": artifact_path,
        "artifact_generation": str(artifact_blob.generation),
        "metadata_generation_before": str(metadata_blob.generation),
        "backup_path": backup_path,
        "migrated_at": now,
    }
    metadata_blob.upload_from_string(
        json.dumps(metadata, ensure_ascii=False, indent=2),
        content_type="application/json",
        if_generation_match=metadata_blob.generation,
    )
    report.update(status="applied", backup_path=backup_path)
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--model-name", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--artifact-path", required=True)
    parser.add_argument("--metadata-path", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    report = backfill_checksum(
        bucket_name=args.bucket,
        model_name=args.model_name,
        version=args.version,
        artifact_path=args.artifact_path,
        metadata_path=args.metadata_path,
        apply=args.apply,
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
