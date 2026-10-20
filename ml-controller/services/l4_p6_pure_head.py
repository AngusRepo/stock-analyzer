"""Research-only p_loss: no stacker, raw score, gain/loss or A dependency.

Same date weighting, scaler floors, logistic objective, solver and lambda
selection as the sealed P1 head. Only the authorized input dimension changes.
"""
from collections import Counter
import math
import numpy as np
from scipy.optimize import minimize
from scipy.special import expit

MODELS = ('TimeXer', 'ExtraTrees', 'GNN', 'LightGBM', 'PatchTST', 'TabM', 'XGBoost', 'iTransformer')
NAMES = [f'{model}_{suffix}' for model in MODELS for suffix in ('available', 'rank')]
LAMBDAS = (.01, .1, 1., 10.)


def weights(dates):
    counts = Counter(dates)
    w = np.array([1 / counts[d] for d in dates], dtype=float)
    return w / w.sum()


def extract(rows):
    values = []
    for row in rows:
        f = row['features']; value = []
        for model in MODELS:
            available, rank = f[model + '_available'], f[model + '_rank']
            if available not in (0, 1) or available is None:
                raise ValueError('invalid_availability:' + model)
            if available:
                if rank is None or not np.isfinite(rank) or not 0 <= rank <= 1:
                    raise ValueError('invalid_rank:' + model)
            elif rank is not None:
                raise ValueError('masked_rank:' + model)
            value.extend((available, rank))
        values.append(value)
    return np.asarray(values, dtype=float)


def design(raw, dates, recipe=None):
    raw = np.asarray(raw, dtype=float)
    if raw.ndim != 2 or raw.shape[1] != 16 or not len(raw):
        raise ValueError('invalid_pure_shape')
    if recipe is None:
        w = weights(dates)[:, None]; observed = np.isfinite(raw)
        safe = np.where(observed, raw, 0)
        denominator = (w * observed).sum(0)
        mean = (w * safe).sum(0) / np.maximum(denominator, 1e-15)
        variance = (w * np.where(observed, (safe - mean) ** 2, 0)).sum(0) / np.maximum(denominator, 1e-15)
        recipe = dict(names=NAMES, mean=mean.tolist(),
                      scale=np.maximum(np.sqrt(variance), .001).tolist(), observed_weight=denominator.tolist())
    if recipe['names'] != NAMES:
        raise ValueError('pure_feature_order_changed')
    mean, scale = np.array(recipe['mean']), np.array(recipe['scale'])
    if mean.shape != (16,) or scale.shape != (16,) or not np.isfinite(mean).all() or not np.isfinite(scale).all() or (scale <= 0).any():
        raise ValueError('invalid_pure_scaler')
    return (np.where(np.isfinite(raw), raw, mean) - mean) / scale, recipe


def fit_head(x, y, w, penalty):
    binary = (y < 0).astype(float); prevalence = float(w @ binary)
    if not 0 < prevalence < 1:
        raise ValueError('both_outcomes_required')
    def objective(theta):
        eta = theta[0] + x @ theta[1:]
        residual = w * (expit(eta) - binary)
        return (float(w @ (np.logaddexp(0, eta) - binary * eta) + .5 * penalty * (theta[1:] @ theta[1:])),
                np.r_[residual.sum(), x.T @ residual + penalty * theta[1:]])
    result = minimize(objective, np.r_[math.log(prevalence / (1 - prevalence)), np.zeros(16)],
                      jac=True, method='L-BFGS-B', options={'maxiter': 700, 'ftol': 1e-12, 'gtol': 1e-8})
    if not result.success:
        raise ValueError('pure_classifier_not_converged:' + str(result.message))
    return dict(head='p_loss', beta=result.x[1:].tolist(), intercept=float(result.x[0]), **{'lambda': penalty})


def predict(x, head):
    return expit(head['intercept'] + x @ np.array(head['beta']))


def fit(raw, y, dates, known, blocks):
    dates, known = np.asarray(dates), np.asarray(known)
    folds = []; lineage = []
    for block in blocks:
        train = known < min(block); val = np.isin(dates, block)
        if not train.any() or not val.any() or set(dates[val]) != set(block):
            raise ValueError('empty_inner_fold')
        tx, recipe = design(raw[train], dates[train])
        vx, _ = design(raw[val], dates[val], recipe)
        folds.append((tx, y[train], weights(dates[train]), vx, y[val], weights(dates[val])))
        lineage.append(dict(validation_dates=block, training_rows=int(train.sum()),
                            training_label_known_max=max(known[train]), validation_rows=int(val.sum())))
    trials = []
    for penalty in LAMBDAS:
        losses = []
        for tx, ty, tw, vx, vy, vw in folds:
            p = np.clip(predict(vx, fit_head(tx, ty, tw, penalty)), 1e-12, 1 - 1e-12)
            binary = (vy < 0).astype(float)
            losses.append(float(vw @ (-binary * np.log(p) - (1 - binary) * np.log1p(-p))))
        trials.append(dict(penalty=penalty, loss=float(np.mean(losses)), fold_losses=losses))
    selected = min(trials, key=lambda t: (t['loss'], -t['penalty']))
    x, recipe = design(raw, dates)
    return dict(recipe=recipe, head=fit_head(x, y, weights(dates), selected['penalty']),
                trials=trials, inner_lineage=lineage)
