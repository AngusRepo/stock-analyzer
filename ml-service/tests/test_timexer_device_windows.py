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
        close = (level * np.exp(np.cumsum(rng.normal(0, 0.02, days)))).astype(np.float32)
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
    data = tt.DeviceWindows(series, rows, True, 'cpu')
    data.scale[0] = data.scale[0] * 2
    with pytest.raises(ValueError, match='timexer_device_window_mismatch'):
        data.assert_matches(tt.Windows(series, rows, True), [0])
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


def _legacy_train(job, series, rows):
    """Frozen copy of the pre-change fit loop (8938d5e1) on the same splits, num_workers=0."""
    settings, exogenous, device = job['settings'], job['exogenous'], 'cpu'
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
    series = _series(count=2)
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
    assert len(report['inner_history']) > 1 and report['test_rows'] > 0
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
