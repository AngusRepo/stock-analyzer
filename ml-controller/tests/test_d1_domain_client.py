from services import d1_domain_client


def test_domain_database_id_prefers_specific_then_legacy(monkeypatch):
    monkeypatch.setenv("CF_D1_DB_ID", "legacy")
    monkeypatch.delenv("CF_D1_MARKET_DB_ID", raising=False)
    monkeypatch.delenv("MULTI_D1_STRICT", raising=False)
    assert d1_domain_client.database_id_for_domain("market") == "legacy"

    monkeypatch.setenv("CF_D1_MARKET_DB_ID", "market-db")
    assert d1_domain_client.database_id_for_domain("market") == "market-db"


def test_domain_database_id_fails_closed_in_strict_mode(monkeypatch):
    monkeypatch.setenv("CF_D1_DB_ID", "legacy")
    monkeypatch.delenv("CF_D1_LEARNING_DB_ID", raising=False)
    monkeypatch.setenv("MULTI_D1_STRICT", "true")
    try:
        d1_domain_client.database_id_for_domain("learning")
    except RuntimeError as exc:
        assert "learning" in str(exc)
    else:
        raise AssertionError("strict mode must reject an unbound data domain")


def test_domain_client_routes_query_to_resolved_database(monkeypatch):
    monkeypatch.setenv("CF_D1_OPS_DB_ID", "ops-db")
    monkeypatch.delenv("MULTI_D1_STRICT", raising=False)
    captured = {}

    def fake_post(body, timeout=60.0, database_id=None):
        captured.update(body=body, timeout=timeout, database_id=database_id)
        return {"result": [{"results": [{"ok": 1}]}]}

    monkeypatch.setattr(d1_domain_client.d1_client, "_post", fake_post)
    rows = d1_domain_client.client_for_domain("ops").query("SELECT 1", timeout=12)
    assert rows == [{"ok": 1}]
    assert captured["database_id"] == "ops-db"
