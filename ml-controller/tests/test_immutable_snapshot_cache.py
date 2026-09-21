import hashlib
import pytest
from services.immutable_snapshot_cache import SnapshotPartsCache
from services import immutable_snapshot_cache, d1_domain_client, d1_client


def key(rows, snapshot="s", database="learning"):
    return database, snapshot, hashlib.sha256("".join(r["payload_text"] for r in rows).encode()).hexdigest(), len(rows)


def test_cache_roundtrip_isolated_rows_and_bounded_lru():
    cache = SnapshotPartsCache(max_bytes=300)
    rows = [{"part_no": 0, "payload_text": "資料" * 100}]
    cache.put(key(rows), rows)
    first = cache.get(key(rows))
    assert first == rows
    first[0]["payload_text"] = "mutated"
    assert cache.get(key(rows)) == rows
    assert cache.get(key(rows, database="other-db")) is None
    for i in range(8):
        cache.put(key(rows, str(i)), rows)
        assert cache.size <= cache.max_bytes
    assert cache.get(key(rows)) is None
    assert cache.get(key(rows, "7")) == rows


def test_incomplete_or_corrupt_parts_never_enter_cache():
    cache = SnapshotPartsCache()
    rows = [{"part_no": 0, "payload_text": "abc"}]
    with pytest.raises(RuntimeError, match="parts_incomplete"):
        cache.put(key(rows), [])
    with pytest.raises(RuntimeError, match="checksum_mismatch"):
        cache.put(key(rows), [{"part_no": 0, "payload_text": "changed"}])
    assert cache.size == 0 and cache.get(key(rows)) is None
    tiny = SnapshotPartsCache(max_bytes=1)
    tiny.put(key(rows), rows)
    assert tiny.size == 0 and tiny.get(key(rows)) is None


def test_only_completed_remotely_verified_seals_are_cached(monkeypatch):
    rows = [{"part_no": i, "payload_text": str(i) + "資料" * 200} for i in range(127)]
    manifest = []
    requests = []
    monkeypatch.setattr(immutable_snapshot_cache, "SNAPSHOT_PARTS_CACHE", SnapshotPartsCache())
    monkeypatch.setattr(d1_domain_client, "database_id_for_domain", lambda domain: "learning")
    monkeypatch.setattr(d1_client, "STRATEGY_MINING_D1_WORKER_ONLY", False)
    def post(body, **kwargs):
        requests.append(body)
        if "frozen_manifests" in body["sql"]:
            results = list(manifest)
        else:
            cursor = body["params"][1]
            results = [dict(r) for r in rows if r["part_no"] > cursor][:50]
        return {"result": [{"results": results}]}
    monkeypatch.setattr(d1_client, "_post", post)
    client = d1_domain_client.DomainD1Client(d1_domain_client.D1DataDomain.LEARNING)
    sql = "SELECT part_no,payload_text FROM paired_nav_frozen_parts_v1 WHERE snapshot_id=? ORDER BY part_no"
    # The first pre-manifest readback NEVER populates the cache.
    assert client.query(sql, ["s"]) == rows
    assert len(requests) == 4
    requests.clear()
    manifest.append({"payload_checksum": key(rows)[2], "part_count": len(rows)})
    assert client.query(sql, ["s"]) == rows
    assert len(requests) == 4  # First post-commit read is also fully remote.
    requests.clear()
    assert client.query(sql, ["s"]) == rows
    assert len(requests) == 1 and "frozen_manifests" in requests[0]["sql"]
    # Changed authoritative checksum cannot reuse the prior content.
    requests.clear()
    manifest[0]["payload_checksum"] = "0" * 64
    with pytest.raises(RuntimeError, match="checksum_mismatch"):
        client.query(sql, ["s"])
    assert len(requests) == 4
    # Removing a seal also forces a real read, not stale cached authority.
    requests.clear()
    manifest.clear()
    assert client.query(sql, ["s"]) == rows
    assert len(requests) == 4
