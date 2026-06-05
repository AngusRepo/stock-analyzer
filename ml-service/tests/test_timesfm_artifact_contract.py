import json

from app import timesfm_universal
from app.timesfm_universal import DEFAULT_MODEL_ID, DEFAULT_PRED_LEN, DEFAULT_SEQ_LEN


class _FakeBlob:
    def __init__(self, data: dict | None = None):
        self.data = data

    def exists(self):
        return self.data is not None

    def download_as_text(self):
        return json.dumps(self.data)


class _FakeBucket:
    def __init__(self, objects: dict[str, dict]):
        self.objects = objects

    def blob(self, path: str):
        return _FakeBlob(self.objects.get(path))


def test_timesfm_requires_config_artifact(monkeypatch):
    timesfm_universal._CONFIG_CACHE.clear()
    monkeypatch.setattr(timesfm_universal, "_get_bucket", lambda: _FakeBucket({}))

    assert timesfm_universal.load_config_from_gcs("v1") is None


def test_timesfm_loads_config_artifact(monkeypatch):
    timesfm_universal._CONFIG_CACHE.clear()
    config = {
        "version": "v1",
        "model_id": DEFAULT_MODEL_ID,
        "seq_len": DEFAULT_SEQ_LEN,
        "pred_len": DEFAULT_PRED_LEN,
        "source": "gcs_timesfm_config_artifact",
    }
    monkeypatch.setattr(
        timesfm_universal,
        "_get_bucket",
        lambda: _FakeBucket({"universal/timesfm/v1.json": config}),
    )

    assert timesfm_universal.load_config_from_gcs("v1") == config
