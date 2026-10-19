"""Pure R16 shadow inference/measurement. No broker, production or training API.

Execution must supply original allocator inputs and verified native fill ledger.
Targets never count as fills; absent evidence never becomes zero performance.
"""
from datetime import date, datetime, timezone
import hashlib
import io
import json
import math
import numpy as np


ARMS = ('raw', 'linear', 'empirical_bayes', 'pool_equal_weight')


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def infer_seed(inputs, seed, raw):
    if hashlib.sha256(raw).hexdigest() != seed['weights']['sha256']:
        raise ValueError('weights_checksum')
    x = np.asarray(inputs, np.float32)
    if x.ndim != 2 or x.shape[1] != 31 or not np.isfinite(x).all():
        raise ValueError('P6_a_requires_31_finite_features')
    members = seed['members']
    if not members or not math.isclose(sum(m['weight'] for m in members), 1., abs_tol=1e-10):
        raise ValueError('member_weights')
    out = np.zeros(len(x), np.float64); expected = set()
    with np.load(io.BytesIO(raw), allow_pickle=False) as arrays:
        for i, member in enumerate(members):
            value = x; width = 31
            if not 1 <= member['depth'] <= 4 or not 0 < member['weight'] <= 1:
                raise ValueError('member_shape')
            for layer in range(member['depth'] + 1):
                wn, bn = f'm{i}_l{layer}_weight', f'm{i}_l{layer}_bias'; expected.update((wn, bn))
                w, b = arrays[wn], arrays[bn]; output = 1 if layer == member['depth'] else 384
                if w.shape != (width, output) or b.shape != (output,) or w.dtype != np.float32 or b.dtype != np.float32 or not np.isfinite(w).all() or not np.isfinite(b).all():
                    raise ValueError('member_matrix_shape')
                value = value @ w + b
                if layer < member['depth']:
                    value = np.maximum(value, 0)
                width = output
            out += member['weight'] * (value[:, 0] * seed['target_scale'] + seed['target_mean'])
        if set(arrays.files) != expected:
            raise ValueError('unexpected_weight_arrays')
    if not np.isfinite(out).all():
        raise ValueError('nonfinite_inference')
    return out


def frozen_features(rows, recipe, head):
    names = recipe['native']['names']; pnames = recipe['p_loss_features']
    if len(names) != 30 or len(pnames) != 16 or recipe['feature_names'] != names + ['p_loss']:
        raise ValueError('feature_contract')
    for row in rows:
        f = row['features']
        for mask in (n for n in pnames if n.endswith('_available')):
            model = mask.removesuffix('_available'); available = f[mask]
            rank, raw_score = f[model + '_rank'], f[model + '_raw']
            if available not in (0, 1):
                raise ValueError('invalid_availability')
            if available and (rank is None or raw_score is None or not math.isfinite(rank) or not math.isfinite(raw_score) or not 0 <= rank <= 1):
                raise ValueError('available_model_missing_score')
            if not available and (rank is not None or raw_score is not None):
                raise ValueError('masked_model_has_score')
    raw = np.asarray([[r['features'][n] for n in names] for r in rows], float)
    mean = np.asarray(recipe['native']['mean']); scale = np.asarray(recipe['native']['scale'])
    if (scale <= 0).any() or not np.isfinite(scale).all():
        raise ValueError('invalid_native_scale')
    native = (np.where(np.isfinite(raw), raw, mean) - mean) / scale
    model = head['model']; hr = model['recipe']
    if hr['names'] != pnames:
        raise ValueError('pure_head_schema')
    pure = np.asarray([[r['features'][n] for n in pnames] for r in rows], float)
    hm, hs = np.asarray(hr['mean']), np.asarray(hr['scale'])
    pure = (np.where(np.isfinite(pure), pure, hm) - hm) / hs
    eta = model['head']['intercept'] + pure @ np.asarray(model['head']['beta'])
    from scipy.special import expit
    p = expit(eta); scaler = recipe['p_loss_scaler']
    x = np.column_stack((native, (p - scaler['mean']) / scaler['scale'])).astype(np.float32)
    if not np.isfinite(x).all():
        raise ValueError('nonfinite_features')
    return x


def score_four(score, calibration):
    score = np.asarray(score, float)
    if not len(score) or not np.isfinite(score).all() or score.std() <= 0:
        raise ValueError('unidentifiable_score_scale')
    centered = score - score.mean(); z = centered / score.std()
    edges = np.asarray([float(x) for x in calibration['z_edges']])
    bins = np.searchsorted(edges, z, side='right') - 1
    lookup = np.asarray(calibration['empirical_bayes']['calibrated'], float)
    if not np.isfinite(lookup).all():
        raise ValueError('unsupported_calibration_bin')
    eb = lookup[bins]; eb = eb - eb.mean()
    return dict(raw=centered, linear=calibration['linear_b'] * centered,
                empirical_bayes=eb, pool_equal_weight=np.full(len(score), 1. / len(score))), z


def forecast_packet(rows, *, bundle, calibration, head, load_weights, signal_date, captured_at, entry_at,
                    upstream_checksum, pool_symbols):
    body = {k:v for k,v in bundle.items() if k != 'checksum'}
    if digest(body) != bundle['checksum'] or bundle['production_enabled'] is not False:
        raise ValueError('bundle_checksum_or_scope')
    if bundle['upstream_checksum'] != upstream_checksum or bundle['calibration_checksum'] != digest(calibration) or bundle['head_checksum'] != digest(head):
        raise ValueError('frozen_dependency_changed')
    validate_forecast_timing(signal_date=signal_date, captured_at=captured_at,
        sealed_at=bundle['sealed_at'], label_known_max=bundle['training_label_known_max'], entry_at=entry_at)
    symbols = [r['symbol'] for r in rows]
    if len(symbols) != len(set(symbols)) or sorted(symbols) != sorted(set(pool_symbols)):
        raise ValueError('full_pool_identity')
    if any(r.get('date') != signal_date for r in rows):
        raise ValueError('row_date_changed')
    if any(r.get('upstream_checksum') != upstream_checksum for r in rows):
        raise ValueError('row_upstream_not_attested')
    if [s['seed'] for s in bundle['seeds']] != [42, 43, 44]:
        raise ValueError('seed_identity')
    if head['training_label_known_max'] >= signal_date or calibration['label_known_max'] >= signal_date:
        raise ValueError('dependency_not_causal')
    predictions = []; used_p_loss = None
    for seed in bundle['seeds']:
        x = frozen_features(rows, seed['final_recipe'], head)
        scaler=seed['final_recipe']['p_loss_scaler']
        probabilities=x[:,-1].astype(float)*scaler['scale']+scaler['mean']
        if used_p_loss is None: used_p_loss=probabilities
        elif not np.array_equal(used_p_loss,probabilities): raise ValueError('seed_p_loss_input_changed')
        predictions.append(infer_seed(x, seed, load_weights(seed['weights'])))
    score = np.median(np.stack(predictions), axis=0)
    arms, z = score_four(score, calibration)
    packet = dict(schema='r16-four-arm-forecast-v1', signal_date=signal_date, captured_at=captured_at, entry_at=entry_at,
        model_checksum=bundle['checksum'], upstream_checksum=upstream_checksum,
        calibration_checksum=digest(calibration), pool_checksum=digest(sorted(symbols)),
        symbols=symbols, score=score.tolist(), z=z.tolist(),p_loss=used_p_loss.tolist(),
        arms={name:value.tolist() for name,value in arms.items()},
        arm_semantics={name:('full_pool_unit_exposure_weights' if name == 'pool_equal_weight' else 'five_session_relative_expected_return') for name in ARMS},
        production_enabled=False, order_submission_allowed=False, outer_acceptance_credit=0)
    packet['checksum'] = digest(packet)
    return packet


def validate_forecast_timing(*, signal_date, captured_at, sealed_at, label_known_max, entry_at):
    signal = date.fromisoformat(signal_date)
    sealed = datetime.fromisoformat(sealed_at.replace('Z', '+00:00'))
    captured = datetime.fromisoformat(captured_at.replace('Z', '+00:00'))
    entry = datetime.fromisoformat(entry_at.replace('Z', '+00:00'))
    if sealed.tzinfo is None or captured.tzinfo is None or entry.tzinfo is None or captured < sealed or captured >= entry:
        raise ValueError('invalid_prospective_clock')
    # Same-day evening signals can be unseen when captured after the seal.
    # The production bridge must independently verify the server creation time.
    from zoneinfo import ZoneInfo
    if signal < sealed.astimezone(ZoneInfo('Asia/Taipei')).date() or date.fromisoformat(label_known_max) >= signal:
        raise ValueError('not_unseen_signal_date')
    if captured.astimezone(ZoneInfo('Asia/Taipei')).date() < signal:
        raise ValueError('capture_before_signal_day')
    if entry.astimezone(ZoneInfo('Asia/Taipei')).date() <= signal:
        raise ValueError('entry_not_next_session')
