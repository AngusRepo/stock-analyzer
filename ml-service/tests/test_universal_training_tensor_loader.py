from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def test_ftt_training_contract_keeps_gpu_amp_path():
    source = (Path(__file__).resolve().parent.parent / "app" / "universal_training.py").read_text(encoding="utf-8")

    assert 'device = torch.device("cuda" if torch.cuda.is_available() else "cpu")' in source
    assert "model_ftt = _FTT(n_features, D_MODEL, N_HEADS, N_LAYERS).to(device)" in source
    assert 'use_amp = device.type == "cuda"' in source
    assert 'with torch.amp.autocast(device_type="cuda", dtype=amp_dtype, enabled=use_amp):' in source
    assert 'pin_batches = device.type == "cuda"' in source
    assert ".to(device, non_blocking=pin_batches)" in source
    assert "torch.tensor(Xt_trn" not in source
    assert "torch.tensor(yt_trn" not in source
    assert "torch.tensor(Xt_val" not in source


def test_ftt_oos_test_inference_keeps_existing_cpu_artifact_path():
    source = (Path(__file__).resolve().parent.parent / "app" / "universal_training.py").read_text(encoding="utf-8")

    assert 'model_ftt.to("cpu").eval()' in source
    assert "xb = torch.tensor(Xt_test[ts:ts + BATCH_SIZE])" in source


def test_ftt_tensor_loader_reuses_float32_tensors_for_training_batches():
    torch = pytest.importorskip("torch")
    from app import universal_training

    X = np.arange(30, dtype=np.float64).reshape(10, 3)
    y = np.linspace(-1.0, 1.0, 10, dtype=np.float64)

    loader = universal_training._ftt_tensor_loader(
        torch,
        X,
        y,
        batch_size=4,
        shuffle=False,
        pin_memory=False,
    )
    batches = list(loader)

    assert len(batches) == 3
    xb, yb = batches[0]
    assert xb.dtype == torch.float32
    assert yb.dtype == torch.float32
    assert xb.shape == (4, 3)
    assert yb.shape == (4,)
    assert torch.equal(xb[0], torch.tensor([0.0, 1.0, 2.0]))


def test_ftt_tensor_loader_supports_validation_batches_without_labels():
    torch = pytest.importorskip("torch")
    from app import universal_training

    X = np.arange(15, dtype=np.float32).reshape(5, 3)

    loader = universal_training._ftt_tensor_loader(
        torch,
        X,
        None,
        batch_size=2,
        shuffle=False,
        pin_memory=False,
    )
    batches = list(loader)

    assert [batch[0].shape for batch in batches] == [
        torch.Size([2, 3]),
        torch.Size([2, 3]),
        torch.Size([1, 3]),
    ]
