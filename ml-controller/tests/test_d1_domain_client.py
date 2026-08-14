from services import d1_domain_client


def test_domain_database_id_prefers_specific_then_legacy(monkeypatch):
    monkeypatch.setenv("CF_D1_DB_ID", "legacy")
    monkeypatch.delenv("CF_D1_MARKET_DB_ID", raising=False)
    monkeypatch.delenv("MULTI_D1_STRICT", raising=False)
    assert d1_domain_client.database_id_for_domain("market") == "legacy"

    monkeypatch.setenv("CF_D1_MARKET_DB_ID", "market-db")
    assert d1_domain_client.database_id_for_domain("market") == "legacy"

    monkeypatch.setenv("MULTI_D1_ACTIVE_DOMAINS", "market")
    try:
        d1_domain_client.database_id_for_domain("market")
    except RuntimeError as exc:
        assert str(exc) == "multi_d1_strict_routing_not_closed"
    else:
        raise AssertionError("active domains must remain closed while the routing contract is incomplete")
    monkeypatch.setattr(d1_domain_client, "MULTI_D1_STRICT_ROUTING_READY", True)
    assert d1_domain_client.database_id_for_domain("market") == "market-db"


def test_domain_database_id_fails_closed_in_strict_mode(monkeypatch):
    monkeypatch.setattr(d1_domain_client, "MULTI_D1_STRICT_ROUTING_READY", True)
    monkeypatch.setenv("CF_D1_DB_ID", "legacy")
    monkeypatch.setenv("MULTI_D1_ACTIVE_DOMAINS", "learning")
    monkeypatch.delenv("CF_D1_LEARNING_DB_ID", raising=False)
    monkeypatch.setenv("MULTI_D1_STRICT", "true")
    try:
        d1_domain_client.database_id_for_domain("learning")
    except RuntimeError as exc:
        assert "learning" in str(exc)
    else:
        raise AssertionError("strict mode must reject an unbound data domain")


def test_domain_client_routes_query_to_resolved_database(monkeypatch):
    monkeypatch.setattr(d1_domain_client, "MULTI_D1_STRICT_ROUTING_READY", True)
    monkeypatch.setenv("CF_D1_OPS_DB_ID", "ops-db")
    monkeypatch.setenv("MULTI_D1_ACTIVE_DOMAINS", "ops")
    monkeypatch.delenv("MULTI_D1_STRICT", raising=False)
    captured = {}

    def fake_post(body, timeout=60.0, database_id=None):
        captured.update(body=body, timeout=timeout, database_id=database_id)
        return {"result": [{"results": [{"ok": 1}]}]}

    monkeypatch.setattr(d1_domain_client.d1_client, "_post", fake_post)
    rows = d1_domain_client.client_for_domain("ops").query("SELECT 1", timeout=12)
    assert rows == [{"ok": 1}]
    assert captured["database_id"] == "ops-db"


def test_domain_client_routes_atomic_batch_to_resolved_database(monkeypatch):
    monkeypatch.setattr(d1_domain_client, "MULTI_D1_STRICT_ROUTING_READY", True)
    monkeypatch.setenv("CF_D1_LEARNING_DB_ID", "learning-db")
    monkeypatch.setenv("MULTI_D1_ACTIVE_DOMAINS", "learning")
    monkeypatch.delenv("MULTI_D1_STRICT", raising=False)
    captured = {}

    def fake_raw(statements, timeout=30.0, chunk_size=250, database_id=None):
        captured.update(statements=statements, timeout=timeout, chunk_size=chunk_size, database_id=database_id)
        return {
            "total": len(statements),
            "success_count": len(statements),
            "error_count": 0,
            "partial_failure": False,
        }

    monkeypatch.setattr(d1_domain_client.d1_client, "_raw_batch_execute", fake_raw)
    result = d1_domain_client.client_for_domain("learning").atomic_batch_execute([("UPDATE x SET y=1", [])])

    assert result["atomic"] is True
    assert captured["database_id"] == "learning-db"
    assert captured["chunk_size"] == 1
    assert captured["statements"] == [("UPDATE x SET y=1", [])]


def test_active_domain_fails_closed_when_specific_id_is_missing(monkeypatch):
    monkeypatch.setattr(d1_domain_client, "MULTI_D1_STRICT_ROUTING_READY", True)
    monkeypatch.setenv("CF_D1_DB_ID", "legacy")
    monkeypatch.setenv("MULTI_D1_ACTIVE_DOMAINS", "execution")
    monkeypatch.delenv("CF_D1_EXECUTION_DB_ID", raising=False)
    monkeypatch.delenv("MULTI_D1_STRICT", raising=False)

    try:
        d1_domain_client.database_id_for_domain("execution")
    except RuntimeError as exc:
        assert "execution" in str(exc)
    else:
        raise AssertionError("an active domain must not silently fall back to legacy")


def test_invalid_active_domain_fails_closed(monkeypatch):
    monkeypatch.setenv("CF_D1_DB_ID", "legacy")
    monkeypatch.setenv("MULTI_D1_ACTIVE_DOMAINS", "market,typo")
    try:
        d1_domain_client.database_id_for_domain("market")
    except RuntimeError as exc:
        assert str(exc) == "multi_d1_active_domain_invalid:typo"
    else:
        raise AssertionError("invalid active domain configuration must fail closed")


def test_strict_requires_an_explicit_active_domain_set(monkeypatch):
    monkeypatch.setattr(d1_domain_client, "MULTI_D1_STRICT_ROUTING_READY", True)
    monkeypatch.setenv("CF_D1_DB_ID", "legacy")
    monkeypatch.delenv("MULTI_D1_ACTIVE_DOMAINS", raising=False)
    monkeypatch.setenv("MULTI_D1_STRICT", "true")
    try:
        d1_domain_client.database_id_for_domain("market")
    except RuntimeError as exc:
        assert str(exc) == "multi_d1_strict_active_domains_missing"
    else:
        raise AssertionError("strict routing must not silently activate every domain")
