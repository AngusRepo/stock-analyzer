"""Exercise real NF window admission, without training or model prediction."""
from types import SimpleNamespace

import pandas as pd
import pytest
import torch

from app import neuralforecast_sequence_runtime as runtime


def make_model(name, complete):
    return runtime._make_nf_model(
        name, pred_len=5, seq_len=8, max_steps=1, batch_size=2, seed=42, n_series=2,
        training_options=dict(hidden_size=16, n_heads=4, patch_len=4, stride=2,
                              e_layers=1, encoder_layers=1, linear_hidden_size=16, d_ff=16),
        require_complete_horizon=complete,
    )


@pytest.mark.parametrize("name", ["PatchTST", "iTransformer"])
def test_scope_removes_partial_windows_after_signal_cutoff_without_dropping_targets(name):
    # The final five official sessions after 9/22 end on 10/1.
    dates = ["2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11",
             "2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17",
             "2026-09-18", "2026-09-21", "2026-09-22", "2026-09-23",
             "2026-09-24", "2026-09-29", "2026-09-30", "2026-10-01"]
    temporal = torch.stack((100 + torch.arange(len(dates), dtype=torch.float32),
                            torch.ones(len(dates)))).repeat(2, 1, 1)
    batch = {"temporal": temporal, "temporal_cols": pd.Index(["y", "available_mask"])}
    admitted = {}
    for complete in (False, True):
        model = make_model(name, complete)
        model.val_size = model.test_size = 0
        windows, _, _, indexes, _, _ = model._create_windows(batch, "train")
        selected = windows[indexes]
        signals = selected[:, 7, 0, 0].int().tolist()
        admitted[complete] = [dates[value - 100] for value in signals]
        if complete:
            assert model.min_outsample_fraction == 1.0
            assert torch.all(selected[:, 8:, 1, :] == 1)
            # The latest legitimate window still uses the 10/1 target.
            assert selected[-1, -1, 0, 0].item() == 100 + len(dates) - 1
    assert max(admitted[False]) == "2026-09-30"
    assert max(admitted[True]) == "2026-09-22"
    assert sorted(admitted[True]) == sorted(d for d in admitted[False] if d <= "2026-09-22")


def test_missing_constructor_enforcement_is_rejected_before_fit(monkeypatch):
    monkeypatch.setattr(runtime, "_make_nf_model", lambda *a, **k: SimpleNamespace(
        min_outsample_fraction=0.0, h=5, input_size=8, hparams={"start_padding_enabled": False}))
    monkeypatch.setattr(runtime, "_configure_neuralforecast_runtime", lambda: None)
    from neuralforecast import NeuralForecast
    calls = []
    monkeypatch.setattr(NeuralForecast, "fit", lambda *a, **k: calls.append(True))
    with pytest.raises(ValueError, match="complete_horizon_not_enforced"):
        runtime._train_nf([], model_name="PatchTST", pred_len=5, seq_len=8,
                          max_steps=1, batch_size=2, seed=42, n_series=2,
                          training_options={}, require_complete_horizon=True)
    assert calls == []


@pytest.mark.parametrize("scoped", [False, True])
def test_final_trainer_wires_window_policy_and_receipt_without_changing_validation(monkeypatch, scoped):
    # Exercise the public training path and its real calendar/panel builders.
    # Replace only fitting, predictions and storage with in-memory doubles.
    dates = pd.bdate_range("2026-07-01", periods=50).strftime("%Y-%m-%d").tolist()
    records = [
        dict(symbol=str(i), market_type="LISTED", dates=dates,
             close=[100 + i + j * (i + 1) / 100 for j in range(len(dates))],
             open=[99 + i + j * (i + 1) / 100 for j in range(len(dates))])
        for i in range(12)
    ]
    source = SimpleNamespace(records=records, source="local:fixture")
    monkeypatch.setattr(runtime, "_get_bucket", lambda: object())
    monkeypatch.setattr(runtime, "load_sequence_dataset", lambda payload: source)
    calls = []

    def fit(rows, **kwargs):
        calls.append(kwargs)
        return object(), pd.DataFrame(rows)

    monkeypatch.setattr(runtime, "_train_nf", fit)
    monkeypatch.setattr(runtime, "_predict_horizon_by_id_with_column",
                        lambda nf, df, **kwargs: (df.groupby("unique_id").y.last().to_dict(), "PatchTST"))
    monkeypatch.setattr(runtime, "collect_prep_lineage", lambda *a, **k: {})
    monkeypatch.setattr(runtime, "data_slice_report", lambda **k: {})
    monkeypatch.setattr(runtime, "_save_nf_artifact",
                        lambda bucket, nf, **k: dict(artifact_path="local:model", metadata_path="local:meta",
                                                    checksum="test", metadata=k["metadata"]))
    payload = dict(generation_mode="local_full_fit", oof_training_history_mode="full_pit_history",
                   run_date=dates[-1], as_of_date=dates[-1], seq_len=8, pred_len=5,
                   max_steps=1, validation_folds=3, max_series=12)
    if scoped:
        payload.update(signal_date_max=dates[-6], label_known_at_max=dates[-1])
    result = runtime.train_neuralforecast_sequence_artifact(payload, model_name="PatchTST")
    assert len(calls) == 4
    assert all(not call.get("require_complete_horizon", False) for call in calls[:-1])
    assert calls[-1]["require_complete_horizon"] is scoped
    scope = result["metadata"]["input_scope"]
    if scoped:
        assert scope["actual_signal_date_max"] == dates[-6]
        assert scope["actual_label_known_at_max"] == dates[-1]
        assert scope["window_admission"]["policy"] == "complete_horizon_only"
    else:
        assert scope is None


class _Stop(Exception):
    pass


@pytest.mark.parametrize("flag", [False, True])
def test_dense_fold_requires_complete_horizon_only_when_profile_asks(monkeypatch, flag):
    import json

    dates = pd.bdate_range("2026-07-01", periods=60).strftime("%Y-%m-%d").tolist()
    records = [dict(symbol=str(i), dates=dates, close=[100 + i + j / 10 for j in range(60)],
                    open=[99 + i + j / 10 for j in range(60)]) for i in range(12)]
    blob = SimpleNamespace(exists=lambda: True,
                           download_as_text=lambda: json.dumps({str(i): "LISTED" for i in range(12)}))
    seen = {}

    def fit(rows, **kwargs):
        seen.update(kwargs)
        raise _Stop

    monkeypatch.setattr(runtime, "_train_nf", fit)
    options = runtime._resolve_nf_training_options({"nf_require_complete_horizon": flag}, "PatchTST")
    assert ("nf_require_complete_horizon" in options) is flag
    with pytest.raises(_Stop):
        runtime._train_dense_purged_oof(
            {"train_end": dates[40], "test_start": dates[41], "test_end": dates[50]},
            model_name="PatchTST", cfg={"nf_model_name": "PatchTST"},
            bucket=SimpleNamespace(blob=lambda _path: blob), records=records, version="v",
            seq_len=8, pred_len=5, max_steps=1, batch_size=2, seed=1, max_series=12,
            gcs_prefix="p", training_options=options)
    assert seen["require_complete_horizon"] is flag
