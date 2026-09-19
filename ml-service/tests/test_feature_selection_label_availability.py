import ast
import io
from pathlib import Path

import numpy as np
import pytest

from app import feature_selection as fs


class Batch:
    def __init__(self, dates, known=None, offset=0):
        data = {"X": np.arange(offset, offset + len(dates), dtype=np.float32)[:, None],
                "y": np.arange(len(dates), dtype=np.float32), "dates": np.asarray(dates),
                "sectors": np.asarray(["sector"] * len(dates))}
        if known is not None:
            data["label_known_dates"] = np.asarray(known)
        with io.BytesIO() as buffer:
            np.savez_compressed(buffer, **data)
            self.raw = buffer.getvalue()

    def download_to_file(self, buffer):
        buffer.write(self.raw)


def test_selector_excludes_labels_not_yet_known_at_cutoff_across_batches():
    batches = [Batch(["2026-06-01", "2026-06-02", "2026-06-05"],
                     ["2026-06-04", "2026-06-08", "2026-06-12"]),
               Batch(["2026-05-29", "2026-06-01"], ["2026-06-03", ""], offset=10)]
    x, y, dates, sectors, evidence = fs._load_selection_prep(batches, train_end_date="2026-06-04")
    np.testing.assert_array_equal(x[:, 0], [0, 10])
    assert dates.tolist() == ["2026-06-01", "2026-05-29"]
    assert len(y) == len(sectors) == 2
    assert evidence["source_rows"] == 5
    assert evidence["unavailable_label_rows"] == 2


def test_asof_selector_rejects_missing_maturity_metadata():
    with pytest.raises(ValueError, match="label_known_dates_required"):
        fs._load_selection_prep([Batch(["2026-06-01"])], train_end_date="2026-06-04")


def test_asof_selector_rejects_no_mature_rows():
    with pytest.raises(ValueError, match="no_available_samples"):
        fs._load_selection_prep([Batch(["2026-06-01"], ["2026-06-08"])], train_end_date="2026-06-04")


def test_monthly_prepared_data_without_asof_cutoff_retains_existing_scope():
    x, _, dates, _, _ = fs._load_selection_prep([Batch(["2026-06-01"])], train_end_date=None)
    assert x.shape == (1, 1)
    assert dates.tolist() == ["2026-06-01"]


def test_window_entry_uses_native_evidence_cache_even_if_old_pool_exists(monkeypatch):
    # Execute the actual entrypoint body without allocating a Modal container.
    path = Path(__file__).resolve().parents[1] / "modal_app.py"
    tree = ast.parse(path.read_text(encoding="utf-8-sig"))
    fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "feature_selection_per_window")
    fn.decorator_list = []
    calls = []
    monkeypatch.setattr(fs, "run_feature_selection_pipeline", lambda **kw: calls.append(kw) or {"feature_pool": {"tree_active": ["a"]}})
    from google.cloud import storage
    class ExistingPool:
        def exists(self):return True
        def download_as_text(self):return '{"tree_active": ["stale"]}'
    class Store:
        def bucket(self, *a):return self
        def blob(self, *a):return ExistingPool()
    monkeypatch.setattr(storage, "Client", lambda: Store())
    ns = {"_setup_env": lambda: None, "_get_gcs_bucket_name": lambda: "private"}
    exec(compile(ast.Module(body=[fn], type_ignores=[]), str(path), "exec"), ns)
    result = ns["feature_selection_per_window"]({"window_id": 1, "train_end_date": "2026-06-04", "gcs_prefix": "window", "prep_gcs_prefix": "canonical"})
    assert result.get("feature_pool") == {"tree_active": ["a"]}
    assert calls[0]["train_end_date"] == "2026-06-04"
    assert calls[0]["prep_gcs_prefix"] == "canonical"


def test_native_pipeline_reports_maturity_filter_before_signal_gate(monkeypatch):
    dates = [f"2026-06-{day:02d}" for day in range(1, 21)]
    known = [f"2026-06-{day + 5:02d}" for day in range(1, 21)]
    batch = Batch(dates, known)
    batch.name = "canonical/prep/batch_0.npz"
    batch.generation = "1"
    batch.size = len(batch.raw)
    class FeatureNames:
        name = "canonical/prep/feature_names.json"
        generation = "1"
        size = 5
        def download_as_text(self):return '["a"]'
    class Store:
        def list_blobs(self, **kwargs):return [batch]
        def blob(self, name):return FeatureNames()
    monkeypatch.setattr(fs, "_get_bucket", lambda: Store())
    monkeypatch.setattr(fs, "load_feature_selection_cache", lambda *args: None)
    monkeypatch.setattr(fs, "run_feature_selection_stage", lambda *args, **kwargs: kwargs["compute"]())
    monkeypatch.setattr(fs, "signal_sanity_gate", lambda *args, **kwargs: {"passed": False, "p_value": 1.0})
    result = fs.run_feature_selection_pipeline(train_end_date="2026-06-20", prep_gcs_prefix="canonical")
    assert result["error"] == "signal_gate_failed"
    assert result["split"]["input_availability"]["retained_rows"] == 15
    assert result["split"]["input_availability"]["unavailable_label_rows"] == 5
