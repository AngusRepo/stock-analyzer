from __future__ import annotations

from types import SimpleNamespace

from services import kv_client


def test_kv_client_url_encodes_colon_scoped_keys(monkeypatch):
    calls: list[str] = []

    class Response:
        status_code = 200
        text = "{}"

    def fake_get(url, headers=None, timeout=30.0):
        calls.append(url)
        return Response()

    monkeypatch.setattr(kv_client, "CF_API_TOKEN", "token")
    monkeypatch.setattr(kv_client, "CF_ACCOUNT_ID", "account")
    monkeypatch.setattr(kv_client, "CF_KV_NAMESPACE_ID", "namespace")
    monkeypatch.setattr(kv_client, "httpx", SimpleNamespace(get=fake_get, RequestError=Exception))

    assert kv_client.get("ml:adaptive_params:2026-07-06") == "{}"

    assert calls == [
        "https://api.cloudflare.com/client/v4/accounts/account"
        "/storage/kv/namespaces/namespace/values/ml%3Aadaptive_params%3A2026-07-06"
    ]
