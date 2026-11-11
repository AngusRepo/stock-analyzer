"""Device-resident TimeXer batches are an efficiency change only: training must be bit-identical."""
import time

import numpy as np
import pytest
import torch
from torch.overrides import TorchFunctionMode
from torch.utils.data import DataLoader

from app import timexer_training as tt
from app.formal_feature_contract import FEATURE131_SEMANTIC
from app.sequence_training import forecast_return_from_signal_close
from app.timexer_contract import ARCHITECTURE, OFFICIAL_COMMIT


def _series(count=3, days=220, width=131, seed=11, stale=True):
    rng = np.random.default_rng(seed)
    series = []
    for s in range(count):
        # Realistic price levels (single digits to thousands) exercise float32 rounding of mean/scale.
        level = [8.37, 512.5, 3871.0, 41.2][s % 4]
        # Alternate calm and volatile (8%/day) series: wide windows make float32 rounding order observable.
        close = (level * np.exp(np.cumsum(rng.normal(0, [0.02, 0.08][s % 2], days)))).astype(np.float32)
        height = days - 3 if stale else days
        indices = np.arange(days)
        if stale:  # one-session stale feature rows repeat the previous X row, as load_windows allows
            indices = np.minimum(np.searchsorted(np.sort(rng.choice(days, height, replace=False)), indices,
                                                 side='right') - 1, height - 1).clip(0)
        series.append({'close': close, 'X': rng.normal(0, 1, (height, width)).astype(np.float32),
                       'feature_indices': indices})
    return series


def _day(position):
    return str(np.datetime64('2025-01-01') + int(position))


def _rows(series, length=168):
    rows = []
    for s, source in enumerate(series):
        for end in range(length - 1, len(source['close']) - 5):
            day, known = _day(end), _day(end + 5)
            rows.append({'series': s, 'end': end, 'feature_end': end, 'symbol': f'S{s}', 'date': day,
                         'label_known_date': known, 'market': 'LISTED', 'target': 0.0,
                         'last_close': float(source['close'][end]), 'stale_feature_context_points': 0})
    rows.sort(key=lambda r: (r['date'], r['symbol']))
    return rows


@pytest.mark.parametrize('exogenous', [True, False])
def test_every_device_batch_equals_reference_windows_bitwise(exogenous):
    series = _series()
    rows = _rows(series)
    reference = tt.Windows(series, rows, exogenous)
    data = tt.DeviceWindows(series, rows, exogenous, 'cpu')
    ids = np.random.default_rng(3).permutation(len(rows))
    for start in range(0, len(ids), 64):
        chunk = ids[start:start + 64]
        x, y = data.batch(torch.as_tensor(chunk))
        expected = [reference[int(i)] for i in chunk]
        assert torch.equal(x, torch.stack([e[0] for e in expected]))
        assert torch.equal(y, torch.stack([e[1] for e in expected]))
    data.assert_matches(reference, ids)


def test_mismatch_and_cross_series_feature_windows_fail_closed():
    series = _series()
    rows = _rows(series)
    reference = tt.Windows(series, rows, True)
    first = rows[0]['end']  # row 0 belongs to series 0, whose prices/features start the flat tables
    for corrupt in ('target', 'features'):  # each changes only y or only x of row 0
        data = tt.DeviceWindows(series, rows, True, 'cpu')
        if corrupt == 'target':
            data.close[first + 1] += 1
        else:
            data.X[data.feature_rows[first]] += 1
        with pytest.raises(ValueError, match='timexer_device_window_mismatch'):
            data.assert_matches(reference, [0])
    series[1]['feature_indices'] = series[1]['feature_indices'].copy()
    series[1]['feature_indices'][rows[0]['end']] = -1  # Windows would wrap to this series' last row
    with pytest.raises(ValueError, match='timexer_window_feature_index_invalid'):
        tt.DeviceWindows(series, [r for r in rows if r['series'] == 1], True, 'cpu')


def _job(rows, exogenous):
    settings = {**ARCHITECTURE, **tt.TRAINING_SETTINGS, 'official_commit': OFFICIAL_COMMIT,
                'feature_history_schema': FEATURE131_SEMANTIC}
    days = sorted({r['date'] for r in rows})
    return {'name': 'equivalence', 'settings': settings, 'exogenous': exogenous, 'train_start': days[0],
            'train_end': days[-12], 'test_start': days[-6], 'test_end': days[-1]}


def _legacy_train(job, series, rows, device='cpu'):
    """Frozen copy of the pre-change fit loop (8938d5e1) on the same splits, num_workers=0."""
    settings, exogenous = job['settings'], job['exogenous']
    training = [r for r in rows if r['date'] <= job['train_end'] and r['label_known_date'] < job['test_start']]
    testing = [r for r in rows if job['test_start'] <= r['date'] <= job['test_end']]
    days = sorted({r['date'] for r in training})
    valid_start = days[int(len(days) * 0.8)]
    inner = [r for r in training if r['label_known_date'] < valid_start]
    valid = [r for r in training if r['date'] >= valid_start]
    torch.set_num_threads(8)
    torch.set_float32_matmul_precision("high")

    def fit(fit_rows, epochs, validation=None):
        torch.manual_seed(settings['seed'])
        model = tt.official_model(settings, exogenous).to(device)
        optimizer = torch.optim.Adam(model.parameters(), lr=settings['learning_rate'])
        loader = DataLoader(tt.Windows(series, fit_rows, exogenous), batch_size=settings['batch_size'], shuffle=True)
        validation_loader = DataLoader(tt.Windows(series, validation, exogenous), batch_size=settings['batch_size'],
                                       shuffle=False) if validation else None
        best, selected, stale, history = float('inf'), 0, 0, []
        for epoch in range(1, epochs + 1):
            model.train()
            total, count = 0.0, 0
            for x, y, _, _ in loader:
                optimizer.zero_grad(set_to_none=True)
                forecast = model(x.to(device), None, None, None).squeeze(-1)
                loss = torch.nn.functional.mse_loss(forecast, y.to(device))
                if not torch.isfinite(loss):
                    raise ValueError('nonfinite_timexer_loss')
                loss.backward()
                torch.nn.utils.clip_grad_norm_(model.parameters(), 3.0)
                optimizer.step()
                total += float(loss.detach()) * len(x)
                count += len(x)
            item = {'epoch': epoch, 'training_mse': total / count}
            if validation_loader:
                model.eval()
                total, count = 0.0, 0
                with torch.inference_mode():
                    for x, y, _, _ in validation_loader:
                        forecast = model(x.to(device), None, None, None).squeeze(-1)
                        total += float(torch.nn.functional.mse_loss(forecast, y.to(device), reduction='sum'))
                        count += y.numel()
                score = total / count
                item['validation_mse'] = score
                if score < best:
                    best, selected, stale = score, epoch, 0
                else:
                    stale += 1
            else:
                selected = epoch
            history.append(item)
            if validation_loader and stale >= 3:
                break
        return model, selected, history

    selection_model, epochs, inner_history = fit(inner, settings['epochs'], valid)
    del selection_model
    model, _, history = fit(training, epochs)
    model.eval()
    predictions = []
    with torch.inference_mode():
        for x, _, mean, scale in DataLoader(tt.Windows(series, testing, exogenous), batch_size=64, shuffle=False):
            forecast = model(x.to(device), None, None, None)[:, -1, 0].cpu().numpy()
            predictions.extend((forecast * scale.numpy() + mean.numpy()).tolist())
    scores = forecast_return_from_signal_close(np.asarray(predictions), np.asarray([r['last_close'] for r in testing]))
    return {'state_dict': model.cpu().state_dict(), 'inner_history': inner_history, 'refit_history': history,
            'selected_epochs': epochs, 'scores': scores,
            'batches': {name: -(-len(part) // 64) for name, part in (('inner', inner), ('valid', valid), ('training', training))}}


@pytest.mark.parametrize('exogenous', [True, False])
def test_training_is_bit_identical_to_legacy_loop(monkeypatch, exogenous):
    series = _series(count=10)  # several validation batches, a partial last batch
    rows = _rows(series)
    job = _job(rows, exogenous)
    torch.manual_seed(1234)  # the CPU RNG stream before train() must not matter: fit() reseeds
    expected = _legacy_train(job, series, rows)
    monkeypatch.setattr(tt, 'load_windows', lambda *_: (series, rows, {}))
    torch.manual_seed(999)
    result = tt.train(job, None, device='cpu')
    report = result['report']
    assert report['inner_history'] == expected['inner_history']
    assert report['refit_history'] == expected['refit_history']
    assert report['selected_epochs'] == expected['selected_epochs']
    assert len(report['inner_history']) > 1 and report['test_rows'] > 0 and report['validation_rows'] > 64
    state = result['checkpoint']['state_dict']
    assert state.keys() == expected['state_dict'].keys()
    assert all(torch.equal(state[k], expected['state_dict'][k]) for k in state)
    assert np.array_equal(result['oof_scores'], expected['scores'])


class _HostReads(TorchFunctionMode):
    """Counts device-to-host reads (each a CUDA synchronisation on GPU) issued directly by a fit() body."""
    names = {'item', 'tolist', '__float__', '__bool__', '__int__', '__index__', 'numpy', 'cpu'}

    def __init__(self, filename):
        super().__init__()
        self.filename, self.reads = filename, 0

    def __torch_function__(self, func, types, args=(), kwargs=None):
        import sys
        caller = sys._getframe(1).f_code
        if (getattr(func, '__name__', '') in self.names and caller.co_name == 'fit'
                and caller.co_filename == self.filename):
            self.reads += 1
        return func(*args, **(kwargs or {}))


def _epoch_kinds(monkeypatch):
    kinds = []
    original_print = print

    def capture(*args, **kwargs):
        if args and args[0] == 'TIMEXER_EPOCH':
            kinds.append(args[2])
        return original_print(*args, **kwargs)
    monkeypatch.setattr('builtins.print', capture)
    return kinds


def test_fit_reads_device_once_per_phase_not_per_step(monkeypatch):
    series = _series(count=2)
    rows = _rows(series)
    job = _job(rows, False)
    with _HostReads(__file__) as legacy:
        expected = _legacy_train(job, series, rows)
    batches = expected['batches']
    # The frozen loop syncs twice per training step and once per validation batch (validates the counter).
    assert legacy.reads == (len(expected['inner_history']) * (2 * batches['inner'] + batches['valid'])
                            + len(expected['refit_history']) * 2 * batches['training'])
    monkeypatch.setattr(tt, 'load_windows', lambda *_: (series, rows, {}))
    kinds = _epoch_kinds(monkeypatch)
    with _HostReads(tt.__file__) as mode:
        tt.train(job, None, device='cpu')
    # selection epochs: training losses + validation sums; refit epochs: training losses only.
    assert kinds and mode.reads == 2 * kinds.count('selection') + kinds.count('refit') < legacy.reads


def test_device_batches_outpace_per_sample_loader():
    series = _series(count=4, days=400, stale=False)
    rows = _rows(series)
    data = tt.DeviceWindows(series, rows, True, 'cpu')
    loader = DataLoader(tt.Windows(series, rows, True), batch_size=64, shuffle=True)
    threads = torch.get_num_threads()
    torch.set_num_threads(1)
    legacy_s = fast_s = float('inf')
    try:
        for _ in range(3):  # best of three: robust to a noisy CI neighbour
            started = time.perf_counter()
            legacy = sum(1 for _ in loader)
            legacy_s = min(legacy_s, time.perf_counter() - started)
            ids = torch.randperm(len(rows))
            started = time.perf_counter()
            fast = sum(1 for start in range(0, len(rows), 64) if data.batch(ids[start:start + 64])[0] is not None)
            fast_s = min(fast_s, time.perf_counter() - started)
    finally:
        torch.set_num_threads(threads)
    assert legacy == fast
    assert fast_s * 1.5 < legacy_s, (fast_s, legacy_s)


def test_fit_builds_no_per_sample_host_windows(monkeypatch):
    series = _series(count=2)
    rows = _rows(series)
    job = _job(rows, True)
    calls = []
    original = tt.Windows.__getitem__
    monkeypatch.setattr(tt.Windows, '__getitem__', lambda self, index: calls.append(index) or original(self, index))
    monkeypatch.setattr(tt, 'load_windows', lambda *_: (series, rows, {}))
    report = tt.train(job, None, device='cpu')['report']
    # Only the one-time equivalence probe and the unchanged test-prediction loader build host windows.
    assert len(calls) == min(len(rows), tt.EQUIVALENCE_PROBE_ROWS) + report['test_rows']


class _NaNModel(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.weight = torch.nn.Parameter(torch.ones(1))

    def forward(self, x, *_):
        return (self.weight * float('nan')).expand(len(x), 5, 1)


def test_nonfinite_training_loss_still_fails_closed(monkeypatch):
    series = _series(count=2)
    rows = _rows(series)
    monkeypatch.setattr(tt, 'load_windows', lambda *_: (series, rows, {}))
    monkeypatch.setattr(tt, 'official_model', lambda *_: _NaNModel())
    with pytest.raises(ValueError, match='nonfinite_timexer_loss'):
        tt.train(_job(rows, False), None, device='cpu')


def test_graph_runs_only_on_cuda_with_a_full_batch_to_capture():
    for device, rows, epochs, expected in (('cpu', 640, 10, False), ('cpu', 64, 1, False), ('cuda', 63, 10, False),
                                           ('cuda', 64, 10, True), ('cuda', 65, 1, True), ('cuda', 640, 0, False)):
        assert tt.graph_enabled(device, rows, 64, epochs) is expected


# CUDA graph replay must be bit-identical to the eager step. These run on a GPU (Modal L4); CPU CI skips them.
cuda = pytest.mark.skipif(not torch.cuda.is_available(), reason='needs CUDA')


def _outcome(result):
    report = result['report']
    return {'state_dict': result['checkpoint']['state_dict'], 'inner_history': report['inner_history'],
            'refit_history': report['refit_history'], 'selected_epochs': report['selected_epochs'],
            'scores': result['oof_scores']}


def _assert_same(actual, expected):
    for key in ('inner_history', 'refit_history', 'selected_epochs'):
        assert actual[key] == expected[key], key
    assert actual['state_dict'].keys() == expected['state_dict'].keys()
    assert all(torch.equal(actual['state_dict'][k], expected['state_dict'][k]) for k in actual['state_dict'])
    assert np.array_equal(actual['scores'], expected['scores'])


def _count_replays(monkeypatch):
    replays = []
    original = torch.cuda.CUDAGraph.replay
    monkeypatch.setattr(torch.cuda.CUDAGraph, 'replay', lambda self: replays.append(1) or original(self))
    return replays


def _full_batches(report):
    """Replays train() must issue: every full training batch of every selection and refit epoch."""
    return (len(report['inner_history']) * (report['inner_rows'] // 64)
            + len(report['refit_history']) * (report['train_rows'] // 64))


def _with_inner_rows(rows, job, count):
    """Drop inner rows (keeping one per date, so the splits stay put) until inner has exactly count rows."""
    training = [r for r in rows if r['date'] <= job['train_end'] and r['label_known_date'] < job['test_start']]
    days = sorted({r['date'] for r in training})
    inner = [r for r in training if r['label_known_date'] < days[int(len(days) * 0.8)]]
    seen, extra = set(), []
    for r in inner:
        extra.append(id(r)) if r['date'] in seen else seen.add(r['date'])
    drop = set(extra[:len(inner) - count])
    assert len(inner) - len(drop) == count
    return [r for r in rows if id(r) not in drop]


@cuda
@pytest.mark.parametrize('exogenous', [True, False])
def test_training_is_bit_identical_to_legacy_loop_cuda(monkeypatch, exogenous):
    series = _series(count=10)
    rows = _rows(series)
    job = _job(rows, exogenous)
    expected = _legacy_train(job, series, rows, 'cuda')
    expected_rng = torch.cuda.get_rng_state()
    monkeypatch.setattr(tt, 'load_windows', lambda *_: (series, rows, {}))
    replays = _count_replays(monkeypatch)
    result = tt.train(job, None, device='cuda')
    assert torch.equal(torch.cuda.get_rng_state(), expected_rng)
    _assert_same(_outcome(result), expected)
    report = result['report']
    assert len(replays) == _full_batches(report) > 0
    assert report['inner_rows'] % 64 or report['train_rows'] % 64  # eager partial batches interleave replays


@cuda
@pytest.mark.parametrize('exogenous', [True, False])
def test_graph_fit_is_bit_identical_to_eager_device_fit_cuda(monkeypatch, exogenous):
    series = _series(count=10)
    rows = _rows(series)
    job = _job(rows, exogenous)
    monkeypatch.setattr(tt, 'load_windows', lambda *_: (series, rows, {}))
    with monkeypatch.context() as eager:
        eager.setattr(tt, 'graph_enabled', lambda *_: False)
        expected = _outcome(tt.train(job, None, device='cuda'))
    expected_rng = torch.cuda.get_rng_state()
    replays = _count_replays(monkeypatch)
    result = tt.train(job, None, device='cuda')
    assert torch.equal(torch.cuda.get_rng_state(), expected_rng)
    _assert_same(_outcome(result), expected)
    assert len(replays) == _full_batches(result['report']) > 0


@cuda
@pytest.mark.parametrize('inner_rows', [63, 64, 65])
def test_inner_batch_boundaries_are_bit_identical_cuda(monkeypatch, inner_rows):
    series = _series(count=3)
    rows = _rows(series)
    job = _job(rows, True)
    rows = _with_inner_rows(rows, job, inner_rows)
    expected = _legacy_train(job, series, rows, 'cuda')
    monkeypatch.setattr(tt, 'load_windows', lambda *_: (series, rows, {}))
    replays = _count_replays(monkeypatch)
    result = tt.train(job, None, device='cuda')
    _assert_same(_outcome(result), expected)
    report = result['report']
    assert report['inner_rows'] == inner_rows and len(replays) == _full_batches(report) > 0


@cuda
def test_repeated_training_is_identical_and_releases_graph_memory(monkeypatch):
    import gc
    series = _series(count=10)
    rows = _rows(series)
    job = _job(rows, True)
    monkeypatch.setattr(tt, 'load_windows', lambda *_: (series, rows, {}))
    workspace = 32 * 2 ** 20  # one cuBLAS workspace under CUBLAS_WORKSPACE_CONFIG=:4096:8
    gc.collect()
    torch.cuda.empty_cache()
    before = torch.cuda.memory_allocated()
    outcomes, allocated, reserved = [], [], []
    for _ in range(3):
        outcomes.append(_outcome(tt.train(job, None, device='cuda')))
        gc.collect()
        torch.cuda.empty_cache()
        allocated.append(torch.cuda.memory_allocated())
        reserved.append(torch.cuda.memory_reserved())
    print('TIMEXER_GRAPH_MEMORY', {'before': before, 'allocated': allocated, 'reserved': reserved})
    for other in outcomes[1:]:
        _assert_same(other, outcomes[0])
    # The first run creates the per-stream handles and workspaces; later runs must leave nothing behind.
    assert max(allocated[1:]) <= allocated[0] + workspace
    assert reserved[2] <= reserved[1] + workspace


@cuda
def test_nonfinite_training_loss_fails_closed_on_the_graph_path(monkeypatch):
    series = _series(count=3)  # 72 inner rows: the selection fit captures a graph
    rows = _rows(series)
    monkeypatch.setattr(tt, 'load_windows', lambda *_: (series, rows, {}))
    monkeypatch.setattr(tt, 'official_model', lambda *_: _NaNModel())
    replays = _count_replays(monkeypatch)
    with pytest.raises(ValueError, match='nonfinite_timexer_loss'):
        tt.train(_job(rows, False), None, device='cuda')
    assert replays


@cuda
def test_graph_fit_reads_device_once_per_phase_cuda(monkeypatch):
    series = _series(count=3)
    rows = _rows(series)
    job = _job(rows, True)
    monkeypatch.setattr(tt, 'load_windows', lambda *_: (series, rows, {}))
    kinds = _epoch_kinds(monkeypatch)
    replays = _count_replays(monkeypatch)
    with _HostReads(tt.__file__) as mode:
        tt.train(job, None, device='cuda')
    assert replays and kinds and mode.reads == 2 * kinds.count('selection') + kinds.count('refit')
