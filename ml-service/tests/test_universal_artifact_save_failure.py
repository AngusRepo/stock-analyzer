"""Native training cannot report success after a metadata write failed."""
import io
import numpy as np
import pytest
from app import universal_training as ut
from tests.test_tree_cpcv_outer_scope import panel


def test_metadata_failure_is_fatal_after_weights_saved(monkeypatch):
    data = panel()
    raw = io.BytesIO()
    np.savez(raw, X=data.X, y=data.y, target_returns=data.target_returns, dates=data.dates,
             symbols=data.symbols, markets=data.markets, label_known_dates=data.label_known_dates)
    saved = {}

    class Bucket:
        def blob(self, name):
            class Blob:
                def exists(self, **kwargs): return name in saved
                def download_as_text(self, **kwargs): return saved[name].decode()
                def upload_from_file(self, stream, **kwargs): saved[name] = stream.read()
                def upload_from_string(self, value, **kwargs):
                    if '/metadata_' in name:
                        raise OSError('injected_sidecar_write_failure')
                    saved[name] = value.encode() if isinstance(value, str) else value
            return Blob()

    monkeypatch.setattr(ut, '_get_bucket', Bucket)
    monkeypatch.setattr(ut, 'download_existing_blobs', lambda *a, **k: [('universal/prep/batch_0.npz', raw.getvalue())])
    monkeypatch.setattr(ut, 'collect_prep_lineage', lambda *a, **k: {})
    request = ut.UniversalTrainRequest(batch_count=1, models_filter=['LightGBM'],
        run_date='2026-03-10', register_challengers=False, disable_stale_prep_guard=True,
        enable_model_cpcv=False, output_model_version='fixture-sidecar-failure')
    with pytest.raises(RuntimeError, match='universal_model_artifact_save_failed:LightGBM'):
        ut.train_universal_from_gcs(request)
    assert any(name.endswith('.joblib') for name in saved)
    assert not any('/metadata_' in name for name in saved)
