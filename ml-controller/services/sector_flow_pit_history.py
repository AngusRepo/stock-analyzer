"""Immutable generations for PIT consumers; mutable UI rows are never historical truth."""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any, Callable

LAYERS = ("industry", "industry_theme", "subindustry")
Query = Callable[[str, list[Any]], list[dict[str, Any]]]


def _encode(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _utc(value: str) -> str:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat(timespec="microseconds")


def publish_sector_generation(client: Any, *, generation_id: str, signal_date: str,
                              snapshot_ids: dict[str, str], expected_rows: int) -> dict[str, Any]:
    rows = client.query("""
        SELECT date, sector, classification, rs_ratio, rs_momentum, rotation_score,
               rotation_regime, total_net, stock_count, up_count, turnover_share_delta,
               pit_lineage_version, taxonomy_snapshot_id, taxonomy_membership_checksum,
               knowledge_cutoff_date, reconstruction_mode
          FROM sector_flow WHERE date=?
           AND classification IN ('industry','industry_theme','subindustry')
         ORDER BY classification, sector
    """, [signal_date])
    if len(rows) != expected_rows or {r["classification"] for r in rows} != set(LAYERS):
        raise RuntimeError("sector_generation_projection_readback_incomplete")
    for row in rows:
        if row.get("taxonomy_snapshot_id") != snapshot_ids.get(row["classification"]):
            raise RuntimeError("sector_generation_taxonomy_identity_mismatch")
        if row.get("pit_lineage_version") != "sector-flow-pit-v1":
            raise RuntimeError("sector_generation_lineage_mismatch")
    # Publication time is now, never the historical date being reconstructed.
    available_at = datetime.now(timezone.utc).isoformat(timespec="microseconds")
    load_frozen_memberships(client.query, snapshot_ids=snapshot_ids, rows=rows,
                            available_at=available_at, symbols=[])
    payload = _encode({"schema_version": "sector-flow-pit-generation-v1",
                       "date": signal_date, "rows": rows, "snapshot_ids": snapshot_ids})
    checksum = hashlib.sha256(payload.encode()).hexdigest()
    client.execute("""
        INSERT OR IGNORE INTO sector_flow_pit_generations_v1
          (generation_id, signal_date, available_at, payload_json, payload_checksum, row_count)
        VALUES (?, ?, ?, ?, ?, ?)
    """, [generation_id, signal_date, available_at, payload, checksum, len(rows)])
    stored = client.query("SELECT * FROM sector_flow_pit_generations_v1 WHERE generation_id=?", [generation_id])
    if len(stored) != 1 or stored[0]["payload_checksum"] != checksum or stored[0]["payload_json"] != payload:
        raise RuntimeError("sector_generation_immutable_readback_failed")
    return {"generation_id": generation_id, "available_at": stored[0]["available_at"],
            "row_count": len(rows), "checksum": checksum}


def load_sector_generation(query: Query, *, signal_date: str, cutoff: str,
                           symbols: list[str]) -> dict[str, Any] | None:
    records = query("""
        SELECT * FROM sector_flow_pit_generations_v1
         WHERE signal_date < ? AND available_at <= ?
         ORDER BY signal_date DESC, available_at DESC, generation_id DESC LIMIT 1
    """, [signal_date, _utc(cutoff)])
    if not records:
        return None
    record = records[0]
    raw = record["payload_json"]
    if hashlib.sha256(raw.encode()).hexdigest() != record["payload_checksum"]:
        raise RuntimeError("sector_generation_checksum_mismatch")
    payload = json.loads(raw)
    rows = payload.get("rows") or []
    ids = payload.get("snapshot_ids") or {}
    if (payload.get("schema_version") != "sector-flow-pit-generation-v1"
            or payload.get("date") != record["signal_date"]
            or len(rows) != record["row_count"] or set(ids) != set(LAYERS)
            or {r.get("classification") for r in rows} != set(LAYERS)):
        raise RuntimeError("sector_generation_payload_invalid")
    memberships = load_frozen_memberships(query, snapshot_ids=ids, rows=rows,
                                          available_at=record["available_at"], symbols=symbols)
    return {"meta": {"date": record["signal_date"], "source_available_at": record["available_at"],
                      "source_row_count": len(rows), "source_layer_count": len(ids),
                      "generation_id": record["generation_id"]},
            "rows": rows, "memberships": memberships}


def load_frozen_memberships(query: Query, *, snapshot_ids: dict[str, str], rows: list[dict[str, Any]],
                            available_at: str, symbols: list[str]) -> list[dict[str, Any]]:
    """Both generation and legacy flows must use their own immutable taxonomy."""
    memberships = []
    ids = snapshot_ids
    if set(ids) != set(LAYERS) or not all(ids.values()):
        raise RuntimeError("sector_generation_taxonomy_identity_missing")
    requested_symbols = set(symbols)
    for layer in LAYERS:
        manifests = query("""SELECT membership_checksum, expected_row_count, persisted_row_count, status, completed_at
            FROM sector_taxonomy_snapshot_runs_v1 WHERE snapshot_id=? AND tag_type=?""", [ids[layer], layer])
        members = query("""
                SELECT symbol, tag, tag_type, source, source_as_of_date AS as_of_date,
                       1.0 AS weight
                  FROM sector_taxonomy_membership_snapshots_v1
                 WHERE snapshot_id=? AND tag_type=?
                 ORDER BY tag, symbol
            """, [ids[layer], layer])
        digest = hashlib.sha256(_encode([(r["tag"], r["symbol"]) for r in members]).encode()).hexdigest()
        expected_source = "finlab.security_categories" if layer == "industry" else "finlab.security_industry_themes"
        if (len(manifests) != 1 or manifests[0]["status"] != "ready"
                or len(members) != manifests[0]["expected_row_count"]
                or len(members) != manifests[0]["persisted_row_count"]
                or digest != manifests[0]["membership_checksum"]
                or not manifests[0].get("completed_at")
                or _utc(manifests[0]["completed_at"]) > _utc(available_at)
                or any(r.get("taxonomy_snapshot_id") != ids[layer]
                       or r.get("taxonomy_membership_checksum") != digest
                       for r in rows if r.get("classification") == layer)
                or any(r["source"] != expected_source for r in members)):
            raise RuntimeError(f"sector_generation_membership_integrity_failed:{layer}")
        memberships.extend(row for row in members if row["symbol"] in requested_symbols)
    return memberships
