from __future__ import annotations

from app import ensemble, model_pool


class _FakeBlob:
    def __init__(self, text: str, calls: dict[str, int]):
        self._text = text
        self._calls = calls

    def exists(self):
        return True

    def download_as_text(self):
        self._calls["download_as_text"] = self._calls.get("download_as_text", 0) + 1
        return self._text


class _FakeBucket:
    def __init__(self, text_by_name: dict[str, str], calls: dict[str, int]):
        self._text_by_name = text_by_name
        self._calls = calls

    def blob(self, name: str):
        return _FakeBlob(self._text_by_name[name], self._calls)


def test_model_pool_load_pool_uses_container_cache(monkeypatch):
    calls: dict[str, int] = {}
    monkeypatch.setattr(model_pool, "_POOL_CACHE", None)
    monkeypatch.setattr(model_pool, "_POOL_CACHE_LOADED_AT", 0.0)
    monkeypatch.setenv("MODEL_POOL_CACHE_TTL_SECONDS", "300")
    monkeypatch.setattr(
        model_pool,
        "_get_bucket",
        lambda: _FakeBucket(
            {"universal/model_pool.json": '{"models":{"XGBoost":{"weekly_ic":[0.1]}}}'},
            calls,
        ),
    )

    assert model_pool.load_pool()["models"]["XGBoost"]["weekly_ic"] == [0.1]
    assert model_pool.load_pool()["models"]["XGBoost"]["weekly_ic"] == [0.1]
    assert calls["download_as_text"] == 1


def test_ic_weights_reuse_model_pool_cache(monkeypatch):
    calls: dict[str, int] = {}
    monkeypatch.setattr(ensemble, "_IC_WEIGHTS_CACHE", None)
    monkeypatch.setattr(ensemble, "_IC_WEIGHTS_CACHE_LOADED_AT", 0.0)
    monkeypatch.setattr(model_pool, "_POOL_CACHE", None)
    monkeypatch.setattr(model_pool, "_POOL_CACHE_LOADED_AT", 0.0)
    monkeypatch.setenv("IC_WEIGHTS_CACHE_TTL_SECONDS", "300")
    monkeypatch.setenv("MODEL_POOL_CACHE_TTL_SECONDS", "300")
    monkeypatch.setattr(
        model_pool,
        "_get_bucket",
        lambda: _FakeBucket(
            {"universal/model_pool.json": '{"models":{"XGBoost":{"ic_4w_avg":0.2}}}'},
            calls,
        ),
    )
    first = ensemble.load_ic_weights()
    second = ensemble.load_ic_weights()

    assert first == {"XGBoost": 0.2}
    assert second == first
    assert calls["download_as_text"] == 1


def test_model_pool_cache_respects_ttl(monkeypatch):
    calls: dict[str, int] = {}
    now = {"t": 1000.0}
    monkeypatch.setattr(model_pool, "_POOL_CACHE", None)
    monkeypatch.setattr(model_pool, "_POOL_CACHE_LOADED_AT", 0.0)
    monkeypatch.setenv("MODEL_POOL_CACHE_TTL_SECONDS", "5")
    monkeypatch.setattr(model_pool.time, "time", lambda: now["t"])
    monkeypatch.setattr(
        model_pool,
        "_get_bucket",
        lambda: _FakeBucket(
            {"universal/model_pool.json": '{"models":{"XGBoost":{"weekly_ic":[0.1]}}}'},
            calls,
        ),
    )

    model_pool.load_pool()
    now["t"] = 1003.0
    model_pool.load_pool()
    now["t"] = 1006.0
    model_pool.load_pool()

    assert calls["download_as_text"] == 2
