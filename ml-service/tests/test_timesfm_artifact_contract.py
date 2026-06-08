import json
import sys
from pathlib import Path

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


def test_timesfm_rejects_controller_artifact_sequence_contract_mismatch(monkeypatch):
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

    rows = timesfm_universal.timesfm_batch_predict(
        [{"symbol": "2330", "prices": list(range(DEFAULT_SEQ_LEN))}],
        version="v1",
        sequence_contract_points=60,
    )

    assert len(rows) == 1
    assert "TimesFM sequence contract mismatch" in rows[0]["error"]
    assert f"artifact_seq_len={DEFAULT_SEQ_LEN}" in rows[0]["error"]
    assert "controller=60" in rows[0]["error"]


def test_timesfm_uses_artifact_seq_len_when_contract_matches(monkeypatch):
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

    rows = timesfm_universal.timesfm_batch_predict(
        [{"symbol": "2330", "prices": list(range(60))}],
        version="v1",
        sequence_contract_points=DEFAULT_SEQ_LEN,
    )

    assert len(rows) == 1
    assert f"insufficient data (60 < {DEFAULT_SEQ_LEN})" == rows[0]["error"]


def test_timesfm_dependency_is_pinned_to_artifact_runtime():
    requirements = (
        Path(__file__)
        .resolve()
        .parents[1]
        .joinpath("requirements.txt")
        .read_bytes()
        .decode("utf-8", errors="ignore")
    )

    assert "timesfm[torch]==1.3.0" in requirements
    assert "timesfm[torch]>=" not in requirements


def test_timesfm_20_artifact_rejects_25_only_runtime(monkeypatch):
    timesfm_universal._MODEL_CACHE.clear()

    class _TwoPointFiveOnlyRuntime:
        class TimesFM_2p5_200M_torch:
            @classmethod
            def from_pretrained(cls, _model_id):
                raise AssertionError("2.5 loader must not be used for 2.0 artifact")

    monkeypatch.setitem(sys.modules, "timesfm", _TwoPointFiveOnlyRuntime)

    try:
        timesfm_universal._load_timesfm_model(
            {
                "model_id": "google/timesfm-2.0-500m-pytorch",
                "seq_len": DEFAULT_SEQ_LEN,
                "pred_len": DEFAULT_PRED_LEN,
            }
        )
    except RuntimeError as exc:
        message = str(exc)
    else:
        raise AssertionError("expected runtime/artifact mismatch to fail closed")

    assert "2.5 torch runtime" in message
    assert "google/timesfm-2.0-500m-pytorch" in message
    assert "timesfm[torch]==1.3.0" in message
