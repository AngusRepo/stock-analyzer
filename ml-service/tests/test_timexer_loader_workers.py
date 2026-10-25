"""TimeXer loader workers are an efficiency change only: every batch must be unchanged."""
import multiprocessing

import numpy as np
import torch
from torch.utils.data import DataLoader

from app import timexer_training as tt


def _fixture():
    rng = np.random.default_rng(7)
    series = [{"close": rng.random(220, dtype=np.float32) + 50, "X": rng.random((220, 3), dtype=np.float32),
               "feature_indices": np.arange(220)} for _ in range(3)]
    rows = [{"series": s, "end": e, "feature_end": e, "symbol": str(s)} for s in range(3) for e in range(167, 214)]
    return series, rows


def _batches(dataset, **options):
    torch.manual_seed(42)
    out = []
    for _epoch in range(2):  # a second epoch re-draws the sampler seed from the same RNG stream
        out.extend(torch.cat([x.flatten(1), y], 1) for x, y, _, _ in DataLoader(dataset, batch_size=16, shuffle=True,
                                                                                  **options))
    return out


def test_compact_index_matches_row_dict_windows():
    series, rows = _fixture()
    dataset = tt.Windows(series, rows, True)
    assert dataset.index.shape == (len(rows), 2) and len(dataset) == len(rows)
    row = rows[5]
    x, y, mean, scale = dataset[5]
    close = series[row["series"]]["close"]
    prices = close[row["end"] - 167:row["end"] + 1]
    assert mean == float(prices.mean()) and scale == float(prices.std()) + 1e-4
    assert torch.equal(y, torch.from_numpy(((close[row["end"] + 1:row["end"] + 6] - mean) / scale).astype(np.float32)))
    assert x.shape == (168, 4)
    assert tt.Windows(series, [], True).index.shape == (0, 2)


def test_worker_loader_yields_identical_batches():
    series, rows = _fixture()
    dataset = tt.Windows(series, rows, True)
    serial = _batches(dataset, num_workers=0)
    context = "fork" if "fork" in multiprocessing.get_all_start_methods() else "spawn"
    parallel = _batches(dataset, num_workers=2, multiprocessing_context=context)
    assert len(serial) == len(parallel) and all(torch.equal(a, b) for a, b in zip(serial, parallel))


def test_loader_options_only_fork_workers_on_cuda():
    assert tt.loader_options("cpu") == {"num_workers": 0, "pin_memory": False}
    options = tt.loader_options("cuda")
    if "fork" in multiprocessing.get_all_start_methods():
        assert options["num_workers"] == tt.LOADER_WORKERS and options["multiprocessing_context"] == "fork"
        assert "persistent_workers" not in options  # persistent workers would change the per-epoch RNG draws
    else:
        assert options == {"num_workers": 0, "pin_memory": True}
