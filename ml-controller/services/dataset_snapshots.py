from __future__ import annotations

from typing import Any, Literal, TypedDict

from services import d1_client

SnapshotPrimaryStore = Literal["d1", "gcs", "r2"]
SnapshotAccessTier = Literal["serving", "compute", "report", "preview", "archive"]


class SnapshotStoreRole(TypedDict):
    primary_store: SnapshotPrimaryStore
    access_tier: SnapshotAccessTier
    requires_gcs: bool
    requires_r2: bool
    reason: str


STORE_ROLE_BY_ACCESS_TIER: dict[str, SnapshotStoreRole] = {
    "serving": {
        "primary_store": "d1",
        "access_tier": "serving",
        "requires_gcs": False,
        "requires_r2": False,
        "reason": "Serving state stays in D1 for low-latency UI and trading reads.",
    },
    "compute": {
        "primary_store": "gcs",
        "access_tier": "compute",
        "requires_gcs": True,
        "requires_r2": False,
        "reason": "ML, Modal, backtest, Optuna, CPCV, and PBO compute read GCS snapshots.",
    },
    "report": {
        "primary_store": "r2",
        "access_tier": "report",
        "requires_gcs": False,
        "requires_r2": True,
        "reason": "Human-readable OBS, report, and dashboard artifacts are read from R2.",
    },
    "preview": {
        "primary_store": "r2",
        "access_tier": "preview",
        "requires_gcs": False,
        "requires_r2": True,
        "reason": "Frontend drilldown previews use R2 instead of scanning D1 history.",
    },
    "archive": {
        "primary_store": "r2",
        "access_tier": "archive",
        "requires_gcs": False,
        "requires_r2": True,
        "reason": "Cold audit artifacts are object-store records, not D1 serving rows.",
    },
}


def resolve_snapshot_store_role(access_tier: str) -> SnapshotStoreRole:
    return STORE_ROLE_BY_ACCESS_TIER.get(access_tier, STORE_ROLE_BY_ACCESS_TIER["preview"])


def validate_dataset_snapshot_manifest(row: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    role = resolve_snapshot_store_role(str(row.get("access_tier") or ""))

    for key in ("snapshot_id", "kind", "business_date", "schema_version", "checksum", "producer_run_id"):
        if not row.get(key):
            errors.append(f"{key}_missing")

    if not row.get("access_tier"):
        errors.append("access_tier_missing")
    if not row.get("primary_store"):
        errors.append("primary_store_missing")

    try:
        if int(row.get("row_count", -1)) < 0:
            errors.append("row_count_invalid")
    except (TypeError, ValueError):
        errors.append("row_count_invalid")

    primary = row.get("primary_store")
    if primary and primary != role["primary_store"]:
        errors.append(f"primary_store_mismatch:{primary}->{role['primary_store']}")
    if role["requires_gcs"] and not row.get("gcs_uri"):
        errors.append("gcs_uri_required")
    if role["requires_r2"] and not row.get("r2_key"):
        errors.append("r2_key_required")
    return errors


def build_dataset_snapshot_manifest(
    *,
    snapshot_id: str,
    kind: str,
    business_date: str,
    schema_version: str,
    row_count: int,
    checksum: str,
    access_tier: SnapshotAccessTier,
    producer_run_id: str,
    gcs_uri: str | None = None,
    r2_key: str | None = None,
    market_segment: str | None = None,
    metadata_json: str | None = None,
) -> dict[str, Any]:
    role = resolve_snapshot_store_role(access_tier)
    manifest = {
        "snapshot_id": snapshot_id,
        "kind": kind,
        "business_date": business_date,
        "market_segment": market_segment,
        "schema_version": schema_version,
        "row_count": int(row_count),
        "checksum": checksum,
        "primary_store": role["primary_store"],
        "access_tier": access_tier,
        "gcs_uri": gcs_uri,
        "r2_key": r2_key,
        "producer_run_id": producer_run_id,
        "status": "ready",
        "metadata_json": metadata_json,
    }
    errors = validate_dataset_snapshot_manifest(manifest)
    if errors:
        raise ValueError(f"dataset_snapshot_manifest_invalid:{','.join(errors)}")
    return manifest


def latest_dataset_snapshot(
    *,
    kind: str,
    business_date: str | None = None,
    as_of_business_date: str | None = None,
    access_tier: SnapshotAccessTier = "compute",
    market_segment: str | None = None,
) -> dict[str, Any] | None:
    if business_date and as_of_business_date:
        raise ValueError("dataset_snapshot_date_filter_conflict")

    where = ["kind = ?", "access_tier = ?", "status = 'ready'"]
    params: list[Any] = [kind, access_tier]
    if business_date:
        where.append("business_date = ?")
        params.append(business_date)
    if as_of_business_date:
        where.append("business_date <= ?")
        params.append(as_of_business_date)
    if market_segment:
        where.append("(market_segment = ? OR market_segment IS NULL)")
        params.append(market_segment)

    rows = d1_client.query(
        f"""
        SELECT *
        FROM dataset_snapshots
        WHERE {' AND '.join(where)}
        ORDER BY business_date DESC, created_at DESC
        LIMIT 1
        """,
        params,
    )
    if not rows:
        return None
    row = rows[0]
    row["manifest_errors"] = validate_dataset_snapshot_manifest(row)
    return row


def upsert_dataset_snapshot_manifest(manifest: dict[str, Any]) -> dict:
    errors = validate_dataset_snapshot_manifest(manifest)
    if errors:
        raise ValueError(f"dataset_snapshot_manifest_invalid:{','.join(errors)}")

    return d1_client.execute(
        """
        INSERT OR REPLACE INTO dataset_snapshots (
          snapshot_id, kind, business_date, market_segment, schema_version,
          row_count, checksum, primary_store, access_tier, gcs_uri, r2_key,
          producer_run_id, status, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP)
        """,
        [
            manifest["snapshot_id"],
            manifest["kind"],
            manifest["business_date"],
            manifest.get("market_segment"),
            manifest["schema_version"],
            int(manifest["row_count"]),
            manifest["checksum"],
            manifest["primary_store"],
            manifest["access_tier"],
            manifest.get("gcs_uri"),
            manifest.get("r2_key"),
            manifest["producer_run_id"],
            manifest.get("status", "ready"),
            manifest.get("metadata_json"),
            manifest.get("created_at"),
        ],
    )
