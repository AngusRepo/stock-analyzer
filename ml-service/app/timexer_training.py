"""Official TimeXer training using the accepted causal windows and purged recipe.

Only explicit training jobs call this module. Inference never fits a model.
Window tensors are generated lazily to bound RAM for 137-channel histories.
"""
from pathlib import Path
import json
import numpy as np
import torch
from torch.utils.data import Dataset, DataLoader
from .timexer_runtime import official_model, validate_settings, SCORE_SEMANTIC

TRAINING_SETTINGS = {"epochs": 10, "learning_rate": 0.0001, "batch_size": 64, "seed": 42}


class Windows(Dataset):
    def __init__(self, series, rows, exogenous, length=168):
        self.series, self.rows, self.exogenous, self.length = series, rows, exogenous, length

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, index):
        row = self.rows[index]
        source = self.series[row['series']]
        end, fend = row['end'], row['feature_end']
        prices = source['close'][end - self.length + 1:end + 1]
        mean, scale = float(prices.mean()), float(prices.std()) + 1e-4
        price = ((prices - mean) / scale).reshape(-1, 1)
        indices = source['feature_indices'][end - self.length + 1:end + 1]
        x = np.concatenate([source['X'][indices], price], axis=1) if self.exogenous else price
        target = (source['close'][end + 1:end + 6] - mean) / scale
        return torch.from_numpy(np.asarray(x, dtype=np.float32)), torch.from_numpy(target.astype(np.float32)), mean, scale


def load_windows(inputs, job):
    from .sequence_training import canonical_session_calendar
    validate_settings(job['settings'], job['exogenous'])
    features = {}
    for path in sorted((inputs / 'features-ready/prep').glob('batch_*.npz')):
        with np.load(path, allow_pickle=True) as values:
            # NPZ members decompress on every indexing operation. Materialize
            # each column once per batch, not once per stock in that batch.
            symbols = values['symbols'].astype(str)
            dates = values['dates'].astype(str)
            matrix = values['X'].astype(np.float32)
            if matrix.shape != (len(dates),137) or len(symbols) != len(dates):
                raise ValueError('timexer_training_feature_shape_invalid')
            if not np.isfinite(matrix).all():
                raise ValueError('nonfinite_native_feature_matrix')
            for symbol in np.unique(symbols):
                mask = symbols == symbol
                order = np.argsort(dates[mask], kind='stable')
                if symbol in features:
                    raise ValueError('duplicate_feature_symbol')
                sorted_dates = dates[mask][order]
                if np.any(sorted_dates[1:] <= sorted_dates[:-1]):
                    raise ValueError('timexer_training_duplicate_feature_dates')
                features[symbol] = {'dates': sorted_dates, 'X': matrix[mask][order]}
    records = []
    for path in sorted((inputs / 'sequence/prep').glob('batch_*.npz')):
        with np.load(path, allow_pickle=True) as values:
            records.extend(values['sequence_records'].tolist())
    markets = json.loads((inputs / 'canonical/prep/symbol_market.json').read_text(encoding='utf-8'))
    calendar = canonical_session_calendar(records)
    positions = {day: i for i, day in enumerate(calendar)}
    series, rows, coverage = [], [], {'missing_features_or_market': [], 'insufficient_aligned_context': 0,
                                     'windows_with_one_session_stale_features': 0}
    length = job['settings']['seq_len']
    seen_symbols = set()
    for record in records:
        symbol = str(record['symbol'])
        if symbol in seen_symbols:
            raise ValueError('timexer_training_duplicate_price_symbol')
        seen_symbols.add(symbol)
        if symbol not in features or symbol not in markets:
            coverage['missing_features_or_market'].append(symbol)
            continue
        feature = features[symbol]
        dates = np.asarray(record['dates'], dtype=str)
        close = np.asarray(record['close'], dtype=np.float32)
        opening_values = np.asarray(record['open'], dtype=np.float32)
        if (close.shape != dates.shape or opening_values.shape != dates.shape
                or np.any(dates[1:] <= dates[:-1])
                or not np.isfinite(close).all() or np.any(close <= 0)
                or not np.isfinite(opening_values).all() or np.any(opening_values <= 0)):
            raise ValueError('timexer_training_price_order_or_values_invalid')
        # As-of alignment never backfills from future observations. A one-session
        # source gap may retain the last observed exogenous values; target prices
        # are never changed and a signal-day feature row is still mandatory.
        indices = np.searchsorted(feature['dates'], dates, side='right') - 1
        safe_indices = np.maximum(indices, 0)
        observed = feature['dates'][safe_indices]
        calendar_array = np.asarray(calendar)
        age = np.searchsorted(calendar_array, dates, side='right') - np.searchsorted(calendar_array, observed, side='right')
        invalid = (indices < 0) | (observed > dates) | (age > job['settings'].get('max_exogenous_staleness_sessions', 1))
        invalid_prefix = np.r_[0, np.cumsum(invalid)]
        stale_prefix = np.r_[0, np.cumsum(age > 0)]
        source = {'close': np.asarray(record['close'], dtype=np.float32), 'X': feature['X'],
                  'feature_indices': indices}
        series_index = len(series)
        series.append(source)
        for end in range(length - 1, len(dates) - 5):
            day = str(dates[end])
            if day < job['train_start'] or day > job['test_end']:
                continue
            ci = positions[day]
            if ci + 5 >= len(calendar) or dates[end + 1] != calendar[ci + 1] or dates[end + 5] != calendar[ci + 5]:
                continue
            fend = int(indices[end])
            if observed[end] != day or invalid_prefix[end + 1] != invalid_prefix[end - length + 1]:
                coverage['insufficient_aligned_context'] += 1
                continue
            stale_points = int(stale_prefix[end + 1] - stale_prefix[end - length + 1])
            coverage['windows_with_one_session_stale_features'] += int(stale_points > 0)
            opening = float(record['open'][end + 1])
            target = float(record['close'][end + 5]) / opening - 1 - 0.0018
            rows.append({'series': series_index, 'end': end, 'feature_end': fend, 'symbol': symbol,
                         'date': day, 'label_known_date': str(dates[end + 5]), 'market': markets[symbol],
                         'target': target, 'last_close': float(record['close'][end]), 'stale_feature_context_points': stale_points})
    rows.sort(key=lambda r: (r['date'], r['symbol']))
    return series, rows, coverage


def train(job, inputs, *, device="cuda", full_fit=False):
    from .sequence_training import forecast_return_from_signal_close
    settings = job['settings']
    validate_settings(settings, job['exogenous'])
    if any(settings.get(key) != value for key, value in TRAINING_SETTINGS.items()):
        raise ValueError('timexer_unapproved_training_settings')
    if device not in ('cpu', 'cuda') or (device == 'cuda' and not torch.cuda.is_available()):
        raise ValueError('timexer_training_device_unavailable')
    series, rows, coverage = load_windows(inputs, job)
    training = [r for r in rows if r['date'] <= job['train_end'] and r['label_known_date'] < job['test_start']]
    testing = [] if full_fit else [r for r in rows if job['test_start'] <= r['date'] <= job['test_end']]
    days = sorted({r['date'] for r in training})
    if len(days) < 20 or (not testing and not full_fit):
        raise ValueError('insufficient_timexer_train_or_test_dates')
    valid_start = days[int(len(days) * 0.8)]
    inner = [r for r in training if r['label_known_date'] < valid_start]
    valid = [r for r in training if r['date'] >= valid_start]
    assert inner and valid and max(r['label_known_date'] for r in inner) < min(r['date'] for r in valid)
    exogenous = job['exogenous']
    torch.set_num_threads(8)
    torch.set_float32_matmul_precision("high")

    def fit(fit_rows, epochs, validation=None):
        torch.manual_seed(settings['seed'])
        torch.cuda.manual_seed_all(settings['seed']) if device == 'cuda' else None
        model = official_model(settings, exogenous).to(device)
        optimizer = torch.optim.Adam(model.parameters(), lr=settings['learning_rate'])
        loader = DataLoader(Windows(series, fit_rows, exogenous), batch_size=settings['batch_size'],
                            shuffle=True, num_workers=0, pin_memory=device == 'cuda')
        validation_loader = DataLoader(Windows(series, validation, exogenous), batch_size=settings['batch_size'],
                                       shuffle=False, num_workers=0) if validation else None
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
            print('TIMEXER_EPOCH', job['name'], 'selection' if validation else 'refit', item, flush=True)
            if validation_loader and stale >= 3:
                break
        return model, selected, history

    selection_model, epochs, inner_history = fit(inner, settings['epochs'], valid)
    del selection_model
    if device == 'cuda':
        torch.cuda.empty_cache()
    model, _, history = fit(training, epochs)
    model.eval()
    predictions = []
    with torch.inference_mode():
        loader = DataLoader(Windows(series, testing, exogenous), batch_size=settings['batch_size'], shuffle=False)
        for x, _, mean, scale in loader:
            forecast = model(x.to(device), None, None, None)[:, -1, 0].cpu().numpy()
            predictions.extend((forecast * scale.numpy() + mean.numpy()).tolist())
    scores = forecast_return_from_signal_close(np.asarray(predictions), np.asarray([r['last_close'] for r in testing])) if testing else np.empty(0)
    report = {'train_rows': len(training), 'inner_rows': len(inner), 'validation_rows': len(valid), 'test_rows': len(testing),
              'training_label_known_max': max(r['label_known_date'] for r in training), 'inner_validation_start': valid_start,
              'selected_epochs': epochs, 'inner_history': inner_history, 'refit_history': history, 'coverage': coverage,
              'settings': settings, 'price_scaling': 'input-window mean/std only; target uses same transform',
              'exogenous': exogenous, 'production_effect': False, 'full_fit_only': full_fit,
              'torch_float32_matmul_precision': 'high', 'device': device,
              'checkpoint_selection': 'purged_inner_epoch_then_full_train_refit',
              'score_semantic_version': SCORE_SEMANTIC}
    return {"checkpoint": {"state_dict": model.cpu().state_dict(), "settings": settings,
                           "exogenous": exogenous},
            "report": report, "oof_rows": testing, "oof_scores": scores}
