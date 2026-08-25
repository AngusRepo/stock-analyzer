from services import d1_domain_client


def test_domain_database_id_prefers_specific_then_legacy(monkeypatch):
    monkeypatch.setenv("CF_D1_DB_ID", "legacy")
    monkeypatch.delenv("CF_D1_MARKET_DB_ID", raising=False)
    monkeypatch.delenv("MULTI_D1_STRICT", raising=False)
    assert d1_domain_client.database_id_for_domain("market") == "legacy"

    monkeypatch.setenv("CF_D1_MARKET_DB_ID", "market-db")
    assert d1_domain_client.database_id_for_domain("market") == "legacy"

    monkeypatch.setenv("MULTI_D1_ACTIVE_DOMAINS", "market")
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


def test_execution_domain_is_independently_closed(monkeypatch):
    monkeypatch.setenv('MULTI_D1_EXECUTION_WRITER_EPOCH', '1')
    monkeypatch.setattr(d1_domain_client, "MULTI_D1_STRICT_ROUTING_READY", False)
    monkeypatch.setenv("CF_D1_DB_ID", "legacy")
    monkeypatch.setenv("CF_D1_EXECUTION_DB_ID", "execution-db")
    monkeypatch.setenv("MULTI_D1_ACTIVE_DOMAINS", "execution")
    monkeypatch.setenv("MULTI_D1_EXECUTION_ROUTING_CONTRACT", "execution-single-writer-epoch-v1")
    monkeypatch.setenv("MULTI_D1_EXECUTION_CUTOVER_RECEIPT_ID", "data-domain-cutover-probe:execution:test")
    monkeypatch.delenv("MULTI_D1_STRICT", raising=False)

    assert d1_domain_client.database_id_for_domain("execution") == "execution-db"
    assert d1_domain_client.database_id_for_domain("paper") == "legacy"


def test_execution_domain_stays_closed_without_bound_receipt(monkeypatch):
    monkeypatch.setattr(d1_domain_client, "MULTI_D1_STRICT_ROUTING_READY", False)
    monkeypatch.setenv("CF_D1_DB_ID", "legacy")
    monkeypatch.setenv("CF_D1_EXECUTION_DB_ID", "execution-db")
    monkeypatch.setenv("MULTI_D1_ACTIVE_DOMAINS", "execution")
    monkeypatch.delenv("MULTI_D1_EXECUTION_ROUTING_CONTRACT", raising=False)
    monkeypatch.delenv("MULTI_D1_EXECUTION_CUTOVER_RECEIPT_ID", raising=False)

    try:
        d1_domain_client.database_id_for_domain("execution")
    except RuntimeError as exc:
        assert str(exc) == "multi_d1_strict_routing_not_closed:execution"
    else:
        raise AssertionError("execution routing must require an attested cutover receipt")

def test_paper_domain_is_independently_closed_by_attested_epoch(monkeypatch):
    monkeypatch.setattr(d1_domain_client, "MULTI_D1_STRICT_ROUTING_READY", False)
    monkeypatch.setenv("CF_D1_DB_ID", "legacy")
    monkeypatch.setenv("CF_D1_PAPER_DB_ID", "paper-db")
    monkeypatch.setenv("MULTI_D1_ACTIVE_DOMAINS", "paper")
    monkeypatch.setenv("MULTI_D1_STRICT", "true")
    monkeypatch.setenv("MULTI_D1_PAPER_ROUTING_CONTRACT", "paper-single-writer-epoch-v1")
    monkeypatch.setenv(
        "MULTI_D1_PAPER_CUTOVER_RECEIPT_ID",
        "data-domain-cutover-probe:paper:test",
    )
    monkeypatch.setenv("MULTI_D1_PAPER_WRITER_EPOCH", "5")

    assert d1_domain_client.database_id_for_domain("paper") == "paper-db"
    assert d1_domain_client.database_id_for_domain("research") == "legacy"


def test_paper_domain_stays_closed_without_attested_epoch(monkeypatch):
    monkeypatch.setattr(d1_domain_client, "MULTI_D1_STRICT_ROUTING_READY", False)
    monkeypatch.setenv("CF_D1_DB_ID", "legacy")
    monkeypatch.setenv("CF_D1_PAPER_DB_ID", "paper-db")
    monkeypatch.setenv("MULTI_D1_ACTIVE_DOMAINS", "paper")
    monkeypatch.setenv("MULTI_D1_PAPER_ROUTING_CONTRACT", "paper-single-writer-epoch-v1")
    monkeypatch.setenv(
        "MULTI_D1_PAPER_CUTOVER_RECEIPT_ID",
        "data-domain-cutover-probe:paper:test",
    )
    monkeypatch.setenv("MULTI_D1_PAPER_WRITER_EPOCH", "0")

    try:
        d1_domain_client.database_id_for_domain("paper")
    except RuntimeError as exc:
        assert str(exc) == "multi_d1_strict_routing_not_closed:paper"
    else:
        raise AssertionError("paper routing must require a positive attested epoch")

def test_learning_domain_is_independently_closed_by_attested_epoch(monkeypatch):
    monkeypatch.setattr(d1_domain_client, "MULTI_D1_STRICT_ROUTING_READY", False)
    monkeypatch.setenv("CF_D1_DB_ID", "legacy")
    monkeypatch.setenv("CF_D1_LEARNING_DB_ID", "learning-db")
    monkeypatch.setenv("MULTI_D1_ACTIVE_DOMAINS", "learning")
    monkeypatch.setenv("MULTI_D1_STRICT", "true")
    monkeypatch.setenv("MULTI_D1_LEARNING_ROUTING_CONTRACT", "learning-single-writer-epoch-v1")
    monkeypatch.setenv(
        "MULTI_D1_LEARNING_CUTOVER_RECEIPT_ID",
        "data-domain-cutover-probe:learning:test",
    )
    monkeypatch.setenv("MULTI_D1_LEARNING_WRITER_EPOCH", "260906")

    assert d1_domain_client.database_id_for_domain("learning") == "learning-db"
    assert d1_domain_client.database_id_for_domain("paper") == "legacy"


def test_learning_domain_stays_closed_without_valid_receipt_and_epoch(monkeypatch):
    monkeypatch.setattr(d1_domain_client, "MULTI_D1_STRICT_ROUTING_READY", False)
    monkeypatch.setenv("CF_D1_DB_ID", "legacy")
    monkeypatch.setenv("CF_D1_LEARNING_DB_ID", "learning-db")
    monkeypatch.setenv("MULTI_D1_ACTIVE_DOMAINS", "learning")
    monkeypatch.setenv("MULTI_D1_LEARNING_ROUTING_CONTRACT", "learning-single-writer-epoch-v1")
    monkeypatch.setenv("MULTI_D1_LEARNING_CUTOVER_RECEIPT_ID", "unattested")
    monkeypatch.setenv("MULTI_D1_LEARNING_WRITER_EPOCH", "260906")

    try:
        d1_domain_client.database_id_for_domain("learning")
    except RuntimeError as exc:
        assert str(exc) == "multi_d1_strict_routing_not_closed:learning"
    else:
        raise AssertionError("learning routing must require an attested cutover receipt and epoch")


def test_every_domain_supports_independent_attested_cutover(monkeypatch):
    monkeypatch.setattr(d1_domain_client, 'MULTI_D1_STRICT_ROUTING_READY', False)
    monkeypatch.setenv('CF_D1_DB_ID', 'legacy')
    monkeypatch.setenv('MULTI_D1_ACTIVE_DOMAINS', 'core,market,learning,ops,execution,paper,research')
    monkeypatch.setenv('MULTI_D1_STRICT', 'true')
    for domain in d1_domain_client.D1DataDomain:
        prefix = f'MULTI_D1_{domain.value.upper()}'
        monkeypatch.setenv(f'CF_D1_{domain.value.upper()}_DB_ID', f'{domain.value}-db')
        monkeypatch.setenv(f'{prefix}_ROUTING_CONTRACT', f'{domain.value}-single-writer-epoch-v1')
        monkeypatch.setenv(f'{prefix}_CUTOVER_RECEIPT_ID', f'data-domain-cutover-probe:{domain.value}:test')
        monkeypatch.setenv(f'{prefix}_WRITER_EPOCH', '1')

    for domain in d1_domain_client.D1DataDomain:
        assert d1_domain_client.database_id_for_domain(domain) == f'{domain.value}-db'



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


def test_shadow_domain_client_uses_specific_id_without_activating_routing(monkeypatch):
    monkeypatch.setenv("CF_D1_DB_ID", "legacy")
    monkeypatch.setenv("CF_D1_CORE_DB_ID", "core-shadow")
    monkeypatch.delenv("MULTI_D1_ACTIVE_DOMAINS", raising=False)
    captured = {}

    def fake_post(body, timeout=60.0, database_id=None):
        captured.update(body=body, timeout=timeout, database_id=database_id)
        return {"result": [{"results": [{"ok": 1}]}]}

    monkeypatch.setattr(d1_domain_client.d1_client, "_post", fake_post)
    rows = d1_domain_client.shadow_client_for_domain("core").query("SELECT 1")

    assert rows == [{"ok": 1}]
    assert captured["database_id"] == "core-shadow"


def test_shadow_domain_client_rejects_every_mutation_surface(monkeypatch):
    monkeypatch.setenv("CF_D1_OPS_DB_ID", "ops-shadow")
    client = d1_domain_client.shadow_client_for_domain("ops")

    for sql in (
        "UPDATE x SET y=1",
        "WITH selected AS (SELECT 1) DELETE FROM x",
        "CREATE TABLE x(y INTEGER)",
        "PRAGMA journal_mode=WAL",
    ):
        try:
            client.query(sql)
        except RuntimeError as exc:
            assert str(exc) == "d1_shadow_client_read_only_violation"
        else:
            raise AssertionError(f"shadow client accepted mutation: {sql}")
