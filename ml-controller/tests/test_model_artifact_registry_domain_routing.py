from services import model_artifact_registry as registry
from services.d1_domain_client import D1DataDomain


def test_registry_adapter_routes_all_calls_to_learning_domain(monkeypatch):
    calls: list[tuple[str, object]] = []

    class FakeLearningClient:
        def query(self, sql, params=None, timeout=60.0):
            calls.append(("query", (sql, params, timeout)))
            return [{"ok": 1}]

        def execute(self, sql, params=None, timeout=60.0):
            calls.append(("execute", (sql, params, timeout)))
            return {"success": True}

        def atomic_batch_execute(self, statements, timeout=30.0):
            calls.append(("atomic", (statements, timeout)))
            return {"atomic": True}

    def fake_client_for_domain(domain):
        calls.append(("domain", domain))
        return FakeLearningClient()

    monkeypatch.setattr(registry, "client_for_domain", fake_client_for_domain)

    assert registry.d1_client.query("SELECT 1") == [{"ok": 1}]
    assert registry.d1_client.execute("UPDATE x SET y=1") == {"success": True}
    assert registry.d1_client.atomic_batch_execute([("UPDATE x SET y=1", [])]) == {"atomic": True}
    assert [value for kind, value in calls if kind == "domain"] == [
        D1DataDomain.LEARNING,
        D1DataDomain.LEARNING,
        D1DataDomain.LEARNING,
    ]
