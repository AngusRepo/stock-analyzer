from __future__ import annotations

from app import ensemble, model_pool
from app import gcs_batch_io


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

    assert first == {"XGBoost": 0.015}
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


class _FakeBytesBlob:
    def __init__(self, data: bytes | None, calls: dict[str, int]):
        self._data = data
        self._calls = calls

    def exists(self):
        return self._data is not None

    def download_as_bytes(self):
        self._calls["download_as_bytes"] = self._calls.get("download_as_bytes", 0) + 1
        return self._data


class _FakeBytesBucket:
    def __init__(self, data_by_name: dict[str, bytes | None], calls: dict[str, int]):
        self._data_by_name = data_by_name
        self._calls = calls

    def blob(self, name: str):
        return _FakeBytesBlob(self._data_by_name.get(name), self._calls)


def test_gcs_batch_download_uses_container_local_staging_cache():
    calls: dict[str, int] = {}
    bucket = _FakeBytesBucket({"a": b"alpha", "b": b"beta"}, calls)
    gcs_batch_io.clear_gcs_batch_cache()

    first = gcs_batch_io.download_existing_blobs(bucket, ["a", "b"], max_workers=2)
    second = gcs_batch_io.download_existing_blobs(bucket, ["b", "a"], max_workers=2)

    assert first == [("a", b"alpha"), ("b", b"beta")]
    assert second == [("b", b"beta"), ("a", b"alpha")]
    assert calls["download_as_bytes"] == 2
    assert gcs_batch_io.get_gcs_batch_cache_stats()["hits"] == 2
    assert gcs_batch_io.get_gcs_batch_cache_stats()["misses"] == 2
