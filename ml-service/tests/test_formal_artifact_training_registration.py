from __future__ import annotations

import json
import inspect

import numpy as np
from app import gnn_training, itransformer_training, patchtst_universal, tabm_training
from app.neuralforecast_sequence_runtime import train_neuralforecast_sequence_artifact
from app.training_promotion_policy import resolve_training_promotion_intent


class _FakeBlob:
    def __init__(self, text: str | None = None):
        self.text = text

    def exists(self):
        return self.text is not None

    def download_as_text(self):
        assert self.text is not None
        return self.text

    def upload_from_string(self, text: str, content_type: str | None = None):
        self.text = text
        self.content_type = content_type


class _FakeBucket:
    def __init__(self, pool: dict):
        self.blobs = {
            "universal/model_pool.json": _FakeBlob(json.dumps(pool)),
        }

    def blob(self, key: str):
        return self.blobs.setdefault(key, _FakeBlob())


def test_tabm_model_pool_registration_updates_formal_slot_alias():
    bucket = _FakeBucket({
        "models": {
            "TabM": {
                "version": "old",
                "gcs_path": "universal/tabm/old.joblib",
                "rolling_ic": 0.12,
                "weekly_ic": [0.12],
            }
        },
        "formal_layer3_slots": {
            "TabM": {
                "status": "production_adapter_active",
                "direct_prediction": True,
                "vote_weight": 1.0,
            }
        },
    })

    tabm_training._update_model_pool_active(
        bucket,
        version="new",
        artifact_path="universal/tabm/new.pt",
        metadata={
            "oos_ic": 0.03,
            "direction_accuracy": 0.54,
            "validation_range": ["2026-02-01", "2026-05-01"],
            "metrics": {"pred_std": 0.11},
            "prep_lineage": {"date_max": "2026-06-04", "feature_hash": "sha256:tabm"},
        },
        reason="test",
    )

    updated = json.loads(bucket.blob("universal/model_pool.json").download_as_text())
    entry = updated["models"]["TabM"]
    slot = updated["formal_layer3_slots"]["TabM"]
    assert entry["status"] == "active"
    assert entry["gcs_path"] == "universal/tabm/new.pt"
    assert entry["last_ic_status"] == "awaiting_live_ic"
    assert "rolling_ic" not in entry
    assert "weekly_ic" not in entry
    assert entry["last_artifact_evidence"]["prep_lineage"]["date_max"] == "2026-06-04"
    assert slot["status"] == "artifact_backed_model_pool_active"
    assert slot["direct_prediction"] is False
    assert slot["vote_weight"] == 0.0


def test_gnn_model_pool_registration_updates_formal_slot_alias():
    bucket = _FakeBucket({
        "models": {
            "GNN": {
                "version": "old",
                "gcs_path": "universal/gnn/old.joblib",
                "rolling_ic": 0.12,
                "weekly_ic": [0.12],
            }
        },
        "formal_layer3_slots": {
            "GNN": {
                "status": "production_adapter_active",
                "direct_prediction": True,
                "vote_weight": 1.0,
            }
        },
    })

    gnn_training._update_model_pool_active(
        bucket,
        version="new",
        artifact_path="universal/gnn/new.pt",
        metadata={
            "oos_ic": 0.07,
            "daily_ic_count": 12,
            "validation_range": ["2026-02-01", "2026-05-01"],
            "prep_lineage": {"date_max": "2026-06-04", "feature_hash": "sha256:gnn"},
        },
        reason="test",
    )

    updated = json.loads(bucket.blob("universal/model_pool.json").download_as_text())
    entry = updated["models"]["GNN"]
    slot = updated["formal_layer3_slots"]["GNN"]
    assert entry["status"] == "active"
    assert entry["gcs_path"] == "universal/gnn/new.pt"
    assert entry["last_ic_root_cause"] == "new_graphsage_artifact_awaiting_verified_predictions"
    assert "rolling_ic" not in entry
    assert "weekly_ic" not in entry
    assert entry["last_artifact_evidence"]["prep_lineage"]["feature_hash"] == "sha256:gnn"
    assert slot["status"] == "artifact_backed_model_pool_active"
    assert slot["direct_prediction"] is False
    assert slot["vote_weight"] == 0.0


def test_itransformer_model_pool_registration_updates_formal_slot_alias():
    bucket = _FakeBucket({
        "models": {
            "iTransformer": {
                "version": "old",
                "gcs_path": "universal/itransformer/old.zip",
                "ic_4w_avg": -0.02,
                "weekly_ic": [-0.02],
            }
        }
    })

    itransformer_training._update_model_pool_active(
        bucket,
        version="new",
        artifact_path="universal/itransformer/new.zip",
        metadata={
            "oos_ic": 0.04,
            "direction_accuracy": 0.56,
            "validation_range": ["2026-02-01", "2026-05-01"],
            "metrics": {"oos_samples": 500},
            "prep_lineage": {"date_max": "2026-06-04", "feature_hash": "sha256:itransformer"},
            "artifact_schema": "neuralforecast_itransformer_universal_v1",
            "runtime_package": "neuralforecast",
            "seq_len": 1024,
            "pred_len": 5,
            "metadata_path": "universal/itransformer/metadata_new.json",
        },
        reason="test",
    )

    updated = json.loads(bucket.blob("universal/model_pool.json").download_as_text())
    entry = updated["models"]["iTransformer"]
    slot = updated["formal_layer3_slots"]["iTransformer"]
    assert entry["status"] == "active"
    assert entry["gcs_path"] == "universal/itransformer/new.zip"
    assert entry["last_ic_root_cause"] == "new_neuralforecast_itransformer_artifact_awaiting_verified_predictions"
    assert "ic_4w_avg" not in entry
    assert "weekly_ic" not in entry
    assert entry["artifact_schema"] == "neuralforecast_itransformer_universal_v1"
    assert entry["runtime_package"] == "neuralforecast"
    assert entry["seq_len"] == 1024
    assert entry["pred_len"] == 5
    assert entry["metadata_path"] == "universal/itransformer/metadata_new.json"
    assert entry["last_artifact_evidence"]["prep_lineage"]["date_max"] == "2026-06-04"
    assert slot["status"] == "artifact_backed_model_pool_active"
    assert slot["seq_len"] == 1024


def test_patchtst_model_pool_registration_updates_formal_slot_alias():
    bucket = _FakeBucket({
        "models": {
            "PatchTST": {
                "version": "old",
                "gcs_path": "universal/patchtst/old.pt",
                "ic_4w_avg": -0.03,
                "weekly_ic": [-0.03],
                "challenger": {"version": "shadow"},
            }
        }
    })

    patchtst_universal._update_model_pool_active(
        bucket,
        version="new",
        artifact_path="universal/patchtst/new.zip",
        metadata={
            "oos_ic": 0.05,
            "direction_accuracy": 0.57,
            "metrics": {"oos_samples": 600, "pbo": 0.2},
            "prep_lineage": {"date_max": "2026-06-04", "feature_hash": "sha256:patchtst"},
            "artifact_schema": "neuralforecast_patchtst_universal_v1",
            "runtime_package": "neuralforecast",
            "seq_len": 512,
            "pred_len": 5,
            "metadata_path": "universal/patchtst/metadata_new.json",
        },
        reason="test",
    )

    updated = json.loads(bucket.blob("universal/model_pool.json").download_as_text())
    entry = updated["models"]["PatchTST"]
    slot = updated["formal_layer3_slots"]["PatchTST"]
    assert entry["status"] == "active"
    assert entry["gcs_path"] == "universal/patchtst/new.zip"
    assert entry["model_type"] == "time_series_transformer_neuralforecast_patchtst"
    assert entry["last_ic_root_cause"] == "new_neuralforecast_patchtst_artifact_awaiting_verified_predictions"
    assert "ic_4w_avg" not in entry
    assert "weekly_ic" not in entry
    assert "challenger" not in entry
    assert entry["artifact_schema"] == "neuralforecast_patchtst_universal_v1"
    assert entry["runtime_package"] == "neuralforecast"
    assert entry["seq_len"] == 512
    assert entry["pred_len"] == 5
    assert entry["metadata_path"] == "universal/patchtst/metadata_new.json"
    assert entry["last_artifact_evidence"]["prep_lineage"]["date_max"] == "2026-06-04"
    assert slot["status"] == "artifact_backed_model_pool_active"
    assert slot["seq_len"] == 512
    assert slot["direct_prediction"] is False
    assert slot["vote_weight"] == 0.0


def test_tabm_date_fold_metrics_builds_cpcv_ready_folds():
    dates = np.asarray(["2026-01-01"] * 3 + ["2026-01-02"] * 3)
    pred = np.asarray([0.1, 0.2, 0.3, 0.5, 0.4, 0.6])
    actual = np.asarray([0.1, 0.25, 0.35, 0.45, 0.5, 0.55])

    folds = tabm_training._date_fold_metrics(dates, pred, actual)

    assert [fold["fold_id"] for fold in folds] == ["date_panel_1", "date_panel_2"]
    assert all(fold["coverage"] == 1.0 for fold in folds)
    assert all(fold["test_rows"] == 3 for fold in folds)


def test_formal_artifact_trainers_return_model_cpcv_bundle_contract():
    sources = {
        "GNN": inspect.getsource(gnn_training.train_graphsage_universal),
        "TabM": inspect.getsource(tabm_training.train_tabm_universal),
        "PatchTST": inspect.getsource(patchtst_universal.train_patchtst),
        "iTransformer": inspect.getsource(itransformer_training.train_itransformer_universal),
    }

    for source in sources.values():
        assert "model_cpcv" in source
    assert '"model_cpcv": saved["metadata"]["model_cpcv"]' in sources["GNN"]
    assert '"model_cpcv": saved["metadata"]["model_cpcv"]' in sources["TabM"]
    assert '"model_cpcv": model_cpcv' in sources["PatchTST"]


def test_training_promotion_intent_is_explicit():
    assert resolve_training_promotion_intent({}, model_name="GNN") == (False, None)
    assert resolve_training_promotion_intent({"promote_to_active": False}, model_name="GNN") == (False, None)
    assert resolve_training_promotion_intent(
        {"promote_to_active": True, "promotion_reason": "approved lifecycle test"},
        model_name="GNN",
    ) == (True, "approved lifecycle test")

    for payload in (
        {"promote_to_active": True},
        {"promote_to_active": "true", "promotion_reason": "string true is ambiguous"},
    ):
        try:
            resolve_training_promotion_intent(payload, model_name="GNN")
        except ValueError:
            pass
        else:
            raise AssertionError("promotion intent must reject missing reason or non-boolean values")


def test_formal_artifact_trainers_do_not_default_to_active_promotion():
    sources = {
        "GNN": inspect.getsource(gnn_training.train_graphsage_universal),
        "TabM": inspect.getsource(tabm_training.train_tabm_universal),
        "PatchTST": inspect.getsource(patchtst_universal.train_patchtst),
        "iTransformer": inspect.getsource(itransformer_training.train_itransformer_universal),
        "NeuralForecastSequence": inspect.getsource(train_neuralforecast_sequence_artifact),
    }

    for source in sources.values():
        assert 'payload.get("promote_to_active", True)' not in source
        assert 'bool(payload.get("promote_to_active", False))' not in source
        assert 'bool(kwargs.get("promote_to_active", False))' not in source
        assert "approved by Wei" not in source
        assert "resolve_training_promotion_intent" in source
