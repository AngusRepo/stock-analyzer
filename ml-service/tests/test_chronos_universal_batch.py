from __future__ import annotations

import pandas as pd

from app import chronos_universal


class _DummyChronosPipeline:
    def __init__(self):
        self.calls = 0
        self.ids_seen: list[str] = []

    def predict_df(self, context_df, **_kwargs):
        self.calls += 1
        self.ids_seen = list(context_df["id"].drop_duplicates())
        rows = []
        for symbol in self.ids_seen:
            last = float(context_df[context_df["id"] == symbol]["target"].iloc[-1])
            rows.append({
                "id": symbol,
                "timestamp": pd.Timestamp("2026-05-04"),
                "0.1": last * 0.99,
                "0.5": last * 1.02,
                "0.9": last * 1.05,
            })
        return pd.DataFrame(rows)


def test_chronos_batch_uses_one_multi_series_predict_df(monkeypatch):
    pipeline = _DummyChronosPipeline()
    monkeypatch.setattr(chronos_universal, "_get_pipeline", lambda _model_id: pipeline)
    monkeypatch.delenv("CHRONOS2_LORA_MODEL_ID", raising=False)

    results = chronos_universal.chronos_batch_predict([
        {"symbol": "2330", "prices": [100.0] * 12},
        {"symbol": "2317", "prices": [50.0] * 12},
    ])

    assert pipeline.calls == 1
    assert pipeline.ids_seen == ["2330", "2317"]
    assert [r["symbol"] for r in results] == ["2330", "2317"]
    assert all(r["batch_mode"] == "multi_series_predict_df" for r in results)
    assert results[0]["model"] == "Chronos"


def test_chronos_batch_preserves_original_order_with_invalid_series(monkeypatch):
    pipeline = _DummyChronosPipeline()
    monkeypatch.setattr(chronos_universal, "_get_pipeline", lambda _model_id: pipeline)
    monkeypatch.delenv("CHRONOS2_LORA_MODEL_ID", raising=False)

    results = chronos_universal.chronos_batch_predict([
        {"symbol": "TOO_SHORT", "prices": [10.0] * 3},
        {"symbol": "2330", "prices": [100.0] * 12},
        {"symbol": "2317", "prices": [50.0] * 12},
    ])

    assert pipeline.calls == 1
    assert [r["symbol"] for r in results] == ["TOO_SHORT", "2330", "2317"]
    assert "insufficient data" in results[0]["error"]
    assert results[1]["batch_mode"] == "multi_series_predict_df"
