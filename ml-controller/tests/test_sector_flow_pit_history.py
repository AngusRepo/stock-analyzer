from __future__ import annotations

import json
import hashlib
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from services.sector_flow_pit_history import publish_sector_generation, load_sector_generation, LAYERS


class LocalClient:
    def __init__(self):
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        migration = Path(__file__).resolve().parents[2] / "worker/domain-migrations/market/0006_sector_flow_pit_generations.sql"
        self.db.executescript(migration.read_text(encoding="utf-8"))
        self.db.executescript("""
          CREATE TABLE sector_taxonomy_membership_snapshots_v1 (
            snapshot_id TEXT, symbol TEXT, tag TEXT, tag_type TEXT, source TEXT, source_as_of_date TEXT);
          CREATE TABLE sector_taxonomy_snapshot_runs_v1 (
            snapshot_id TEXT, tag_type TEXT, membership_checksum TEXT,
            expected_row_count INTEGER, persisted_row_count INTEGER, status TEXT, completed_at TEXT);
        """)
        self.rows = [{"date": "2026-09-04", "sector": layer, "classification": layer,
                      "pit_lineage_version": "sector-flow-pit-v1", "taxonomy_snapshot_id": layer,
                      "rs_ratio": 1.0} for layer in LAYERS]
        for layer in LAYERS:
            self.db.execute("INSERT INTO sector_taxonomy_membership_snapshots_v1 VALUES (?,?,?,?,?,?)",
                            [layer, "2330", layer, layer,
                             "finlab.security_categories" if layer == "industry" else "finlab.security_industry_themes", "2026-09-04"])
            digest = hashlib.sha256(json.dumps([[layer, "2330"]], separators=(",", ":")).encode()).hexdigest()
            self.db.execute("INSERT INTO sector_taxonomy_snapshot_runs_v1 VALUES (?,?,?,?,?,?,?)",
                            [layer, layer, digest, 1, 1, "ready", "2026-09-04T00:00:00+00:00"])
            next(row for row in self.rows if row["classification"] == layer)["taxonomy_membership_checksum"] = digest

    def execute(self, sql, params):
        self.db.execute(sql, params)

    def query(self, sql, params):
        if "FROM sector_flow WHERE" in sql:
            return list(self.rows)
        return [dict(r) for r in self.db.execute(sql, params)]


def publish(client, identity="g1"):
    return publish_sector_generation(client, generation_id=identity, signal_date="2026-09-04",
                                     snapshot_ids={layer: layer for layer in LAYERS}, expected_rows=3)


def test_generation_keeps_original_after_rebuild_and_uses_frozen_memberships(monkeypatch):
    import services.sector_flow_pit_history as history
    class Clock(datetime):
        tick = 0
        @classmethod
        def now(cls, tz=None):
            cls.tick += 1
            return datetime(2026, 9, 5, tzinfo=timezone.utc) + timedelta(microseconds=cls.tick)
    monkeypatch.setattr(history, "datetime", Clock)
    client = LocalClient()
    first = publish(client)
    same = publish(client)
    assert same == first  # Retry does not refresh publication time.
    client.rows[0] = {**client.rows[0], "rs_ratio": -10.0}
    publish(client, "g2")
    old = load_sector_generation(client.query, signal_date="2026-09-07",
                                  cutoff=first["available_at"], symbols=["2330"])
    assert old["rows"][0]["rs_ratio"] == 1.0
    assert len(old["memberships"]) == 3
    assert old["meta"]["generation_id"] == "g1"
    with pytest.raises(RuntimeError, match="immutable_readback"):
        publish(client)
    with pytest.raises(sqlite3.IntegrityError, match="immutable"):
        client.execute("UPDATE sector_flow_pit_generations_v1 SET row_count=10", [])


def test_historical_reconstruction_cannot_be_backdated_or_consumed_same_session():
    client = LocalClient()
    publish(client)
    assert load_sector_generation(client.query, signal_date="2026-09-04", cutoff="2099-01-01", symbols=["2330"]) is None
    assert load_sector_generation(client.query, signal_date="2026-09-07", cutoff="2026-09-04", symbols=["2330"]) is None


def test_partial_or_wrong_taxonomy_generations_are_not_published():
    client = LocalClient()
    client.rows.pop()
    with pytest.raises(RuntimeError, match="incomplete"):
        publish(client)
    assert client.query("SELECT * FROM sector_flow_pit_generations_v1", []) == []


def test_corrupt_readback_is_not_silently_replaced_by_mutable_source():
    client = LocalClient()
    publish(client)
    real_query = client.query
    def corrupt(sql, params):
        rows = real_query(sql, params)
        if "FROM sector_flow_pit_generations_v1" in sql:
            rows[0]["payload_json"] = json.dumps({"rows": []})
        return rows
    with pytest.raises(RuntimeError, match="checksum"):
        load_sector_generation(corrupt, signal_date="2026-09-07", cutoff="2099-01-01", symbols=["2330"])


def test_missing_frozen_membership_is_an_explicit_integrity_failure():
    client = LocalClient()
    publish(client)
    client.execute("DELETE FROM sector_taxonomy_membership_snapshots_v1 WHERE tag_type='industry_theme'", [])
    with pytest.raises(RuntimeError, match="membership_integrity_failed"):
        load_sector_generation(client.query, signal_date="2026-09-07", cutoff="2099-01-01", symbols=["2330"])


@pytest.mark.parametrize("change", ["wrong_checksum", "late_taxonomy"])
def test_flow_and_taxonomy_must_share_identity_and_publication_time(change):
    client = LocalClient()
    if change == "wrong_checksum":
        client.rows[0]["taxonomy_membership_checksum"] = "wrong"
    else:
        client.execute("UPDATE sector_taxonomy_snapshot_runs_v1 SET completed_at='2098-01-01'", [])
    with pytest.raises(RuntimeError, match="membership_integrity_failed"):
        publish(client)
    assert client.query("SELECT * FROM sector_flow_pit_generations_v1", []) == []
