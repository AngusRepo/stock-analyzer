import json
from pathlib import Path
import sys

import numpy as np
import pytest


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


class _Blob:
    def __init__(self):
        self.payload = None

    def upload_from_string(self, payload, content_type=None):
        self.payload = payload


class _Bucket:
    def __init__(self):
        self.objects = {}

    def blob(self, path):
        return self.objects.setdefault(path, _Blob())


def test_oof_artifact_requires_real_symbol_and_label_lineage():
    from app.oof_lineage import save_oof_prediction_artifact

    with pytest.raises(ValueError, match="oof_symbols_missing"):
        save_oof_prediction_artifact(
            bucket=_Bucket(),
            gcs_prefix="universal",
            cohort_id="cohort",
            fold_id="w1",
            model_name="TabM",
            artifact_version="v1",
            raw_scores=np.asarray([0.1]),
            targets=np.asarray([0.02]),
            dates=np.asarray(["2026-06-01"]),
            symbols=np.asarray([""]),
            markets=np.asarray(["TW"]),
            label_known_dates=np.asarray(["2026-06-08"]),
            split_metadata={},
        )


def test_oof_rank_is_same_date_same_market_and_artifact_is_immutable_payload():
    from app.oof_lineage import save_oof_prediction_artifact

    bucket = _Bucket()
    result = save_oof_prediction_artifact(
        bucket=bucket,
        gcs_prefix="universal",
        cohort_id="cohort",
        fold_id="w1",
        model_name="TabM",
        artifact_version="v1",
        raw_scores=np.asarray([0.3, 0.1, 0.9]),
        targets=np.asarray([0.03, -0.01, 0.02]),
        dates=np.asarray(["2026-06-01"] * 3),
        symbols=np.asarray(["A", "B", "C"]),
        markets=np.asarray(["TWSE", "TWSE", "TPEX"]),
        label_known_dates=np.asarray(["2026-06-08"] * 3),
        split_metadata={"method": "test"},
    )
    assert result["rows"] == 3
    assert result["schema_version"] == "active8-oof-predictions-v1"
    assert result["payload_checksum"]
    assert bucket.objects[result["path"]].payload


def test_purged_indices_use_actual_per_symbol_label_known_date():
    from app.purged_cv import purged_explicit_walk_forward_indices

    train_idx, test_idx, metadata = purged_explicit_walk_forward_indices(
        np.asarray(["2026-06-01", "2026-06-02", "2026-06-10"]),
        train_start="2026-06-01",
        train_end="2026-06-02",
        test_start="2026-06-10",
        test_end="2026-06-10",
        label_horizon_days=5,
        label_known_dates=np.asarray(["2026-06-08", "2026-06-11", "2026-06-17"]),
    )
    assert train_idx.tolist() == [0]
    assert test_idx.tolist() == [2]
    assert metadata["purge_method"] == "actual_label_known_date"


def test_frozen_forward_artifact_is_explicit_and_invalid_modes_fail_closed():
    from app.oof_lineage import save_oof_prediction_artifact

    bucket = _Bucket()
    result = save_oof_prediction_artifact(
        bucket=bucket,
        gcs_prefix="forward",
        cohort_id="extension",
        fold_id="frozen_forward",
        model_name="LightGBM",
        artifact_version="frozen-v1",
        raw_scores=np.asarray([0.1, 0.2]),
        targets=np.asarray([0.01, 0.02]),
        dates=np.asarray(["2026-07-08", "2026-07-08"]),
        symbols=np.asarray(["A", "B"]),
        markets=np.asarray(["TWSE", "TWSE"]),
        label_known_dates=np.asarray(["2026-07-15", "2026-07-15"]),
        split_metadata={"method": "frozen_fold_forward_inference"},
        generation_mode="frozen_forward_oos",
    )
    assert result["generation_mode"] == "frozen_forward_oos"

    with pytest.raises(ValueError, match="oof_generation_mode_invalid"):
        save_oof_prediction_artifact(
            bucket=bucket,
            gcs_prefix="forward",
            cohort_id="extension",
            fold_id="frozen_forward",
            model_name="LightGBM",
            artifact_version="frozen-v1",
            raw_scores=np.asarray([0.1]),
            targets=np.asarray([0.01]),
            dates=np.asarray(["2026-07-08"]),
            symbols=np.asarray(["A"]),
            markets=np.asarray(["TWSE"]),
            label_known_dates=np.asarray(["2026-07-15"]),
            split_metadata={},
            generation_mode="renamed_fake_oof",
        )