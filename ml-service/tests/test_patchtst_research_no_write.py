from __future__ import annotations

import json

import numpy as np

from app import neuralforecast_sequence_runtime as runtime


class _ReadOnlyMarketBlob:
    def __init__(self, market_by_symbol: dict[str, str]):
        self._payload = json.dumps(market_by_symbol)

    def exists(self) -> bool:
        return True

    def download_as_text(self) -> str:
        return self._payload


class _ReadOnlyBucket:
    def __init__(self, market_by_symbol: dict[str, str]):
        self._market_blob = _ReadOnlyMarketBlob(market_by_symbol)
        self.requested_paths: list[str] = []

    def blob(self, path: str) -> _ReadOnlyMarketBlob:
        self.requested_paths.append(path)
        return self._market_blob


def test_patchtst_research_path_returns_metrics_without_writing_oof(monkeypatch):
    calendar = [f"2026-01-{day:02d}" for day in range(1, 13)]
    records = [
        {
            "symbol": f"S{index:02d}",
            "market_type": "LISTED" if index < 6 else "OTC",
            "dates": calendar,
            "close": [100.0 + index + day for day in range(len(calendar))],
            "open": [99.5 + index + day for day in range(len(calendar))],
        }
        for index in range(12)
    ]
    market_by_symbol = {
        record["symbol"]: record["market_type"]
        for record in records
    }
    bucket = _ReadOnlyBucket(market_by_symbol)

    monkeypatch.setattr(runtime, "_train_nf", lambda *args, **kwargs: (object(), object()))

    def fake_predict(_nf, frame, *, horizon_idx, model_name):  # noqa: ANN001
        ids = sorted(set(frame["unique_id"].astype(str).tolist()))
        return {uid: 110.0 + idx for idx, uid in enumerate(ids)}, model_name

    monkeypatch.setattr(runtime, "_predict_horizon_by_id_with_column", fake_predict)
    monkeypatch.setattr(
        runtime,
        "_save_immutable_oof_fold_evidence",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("research path attempted evidence write")),
    )

    result = runtime._train_dense_purged_oof(
        {
            "train_start": "2026-01-01",
            "train_end": "2026-01-08",
            "test_start": "2026-01-09",
            "test_end": "2026-01-10",
            "cohort_id": "research-only",
            "fold_id": "w0",
            "persist_oof_artifact": False,
            "research_source_bundle_checksum": "a" * 64,
        },
        model_name="PatchTST",
        cfg=runtime.MODEL_CONFIG["PatchTST"],
        bucket=bucket,
        records=records,
        version="research-v1",
        seq_len=4,
        pred_len=2,
        max_steps=1,
        batch_size=8,
        seed=42,
        max_series=20,
        gcs_prefix="immutable-source",
        training_options=runtime._resolve_nf_training_options(
            {"oof_training_history_mode": "full_pit_history"},
            "PatchTST",
        ),
    )

    assert result["allowed_use"] == "research_only"
    assert result["production_effect"] is False
    assert result["oof_artifact"] is None
    assert result["oof_evidence_path"] is None
    assert result["metrics"]["oos_samples"] > 0
    assert bucket.requested_paths == ["immutable-source/prep/symbol_market.json"]
