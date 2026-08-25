from __future__ import annotations

from app import d1_client


def test_query_domain_uses_explicit_owner_without_legacy_fallback(monkeypatch):
    monkeypatch.setenv("CF_D1_LEARNING_DB_ID", "learning-db")
    monkeypatch.setattr(d1_client, "CF_D1_DB_ID", "legacy-db")
    captured = {}

    def fake_query(database_id, sql, params=None, timeout=60.0):
        captured.update(database_id=database_id, sql=sql, params=params, timeout=timeout)
        return [{"ok": 1}]

    monkeypatch.setattr(d1_client, "query_database", fake_query)

    assert d1_client.query_domain("learning", "SELECT 1", [7]) == [{"ok": 1}]
    assert captured["database_id"] == "learning-db"
    assert captured["database_id"] != "legacy-db"


def test_query_domain_fails_closed_when_owner_binding_missing(monkeypatch):
    monkeypatch.delenv("CF_D1_MARKET_DB_ID", raising=False)
    monkeypatch.setattr(d1_client, "CF_D1_DB_ID", "legacy-db")

    try:
        d1_client.query_domain("market", "SELECT 1")
    except RuntimeError as exc:
        assert str(exc) == "D1 domain database id missing: market"
    else:
        raise AssertionError("market query must not fall back to legacy D1")
