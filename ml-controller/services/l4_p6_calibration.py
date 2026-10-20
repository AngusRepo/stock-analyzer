"""R16 OOF calibration arithmetic; no model fitting or publication.

The caller supplies the verified full candidate pool, never final-refit outputs.
The empirical-Bayes table is diagnostic in R32; EB is not a registered arm.
"""
import math
import numpy as np
import polars as pl
from services.l4_distribution import digest

Z_EDGES = [-np.inf, -2., -1., 0., 1., 1.5, 2., 2.5, 3., np.inf]

def block_indices(n, block=5, repetitions=5000, seed=20261015):
    if n < 1 or block < 1:
        raise ValueError('invalid_block_sample')
    rng = np.random.default_rng(seed)
    starts = rng.integers(0, n, size=(repetitions, math.ceil(n / block)))
    return ((starts[:, :, None] + np.arange(block)) % n).reshape(repetitions, -1)[:, :n]


def interval(values, block=5):
    values = np.asarray(values, float)
    if values.ndim != 1 or not len(values) or not np.isfinite(values).all():
        raise ValueError('missing_daily_metric')
    draws = values[block_indices(len(values), block)].mean(axis=1)
    return dict(mean=float(values.mean()), lower=float(np.quantile(draws, .025)),
                upper=float(np.quantile(draws, .975)), positive_days=int((values > 0).sum()),
                dates=len(values), block=block, selection_bias_corrected=False)


def empirical_bayes(daily_bin_means):
    """Moment EB with shared-date block sampling covariance.

    P = I - 11'/K. tau^2=max(0, (m'Pm-trace(P C))/(K-1)).
    mu=mean(m); posterior bin mean=mu+tau^2/(tau^2+Cjj)*(mj-mu).
    C is the bootstrap covariance of bin estimators, not stock-row variance.
    Empty/unidentifiable bins stay missing; no fixed effective count or fallback
    hyperparameter. This marginal normal-means approximation is diagnostic.
    """
    daily = np.asarray(daily_bin_means, float)
    if daily.ndim != 2 or len(daily) < 2:
        raise ValueError('insufficient_calibration_dates')
    counts = np.isfinite(daily).sum(axis=0)
    supported = counts >= 2  # A variance estimate requires at least two dates.
    result = dict(supported=supported.tolist(), status='insufficient_bins', tau2=None, mu=None,
                  shrinkage=[None]*daily.shape[1], calibrated=[None]*daily.shape[1], sampling_variance=[None]*daily.shape[1])
    if supported.sum() < 2:
        return result
    selected = daily[:, supported]
    m = np.nansum(selected, axis=0) / np.isfinite(selected).sum(axis=0)
    sampled = selected[block_indices(len(selected))]
    denom = np.isfinite(sampled).sum(axis=1)
    draws = np.divide(np.nansum(sampled, axis=1), denom, out=np.full(denom.shape, np.nan), where=denom > 0)
    complete = draws[np.isfinite(draws).all(axis=1)]
    if len(complete) < 2:
        return result
    covariance = np.cov(complete, rowvar=False, ddof=1)
    k = len(m)
    # Numerically stable trace(P C): centered bootstrap draws give the same
    # quantity without cancellation when every bin moves identically.
    centered_draws = complete - complete.mean(axis=1, keepdims=True)
    noise_dispersion = np.var(centered_draws, axis=0, ddof=1).sum()
    tau2 = max(0., float((((m - m.mean()) ** 2).sum() - noise_dispersion) / (k - 1)))
    mu = float(m.mean()); variance = np.maximum(np.diag(covariance), 0.)
    weight = np.divide(tau2, tau2 + variance, out=np.zeros(k), where=(tau2 + variance) > 0)
    calibrated = mu + weight * (m - mu)
    for index, j in enumerate(np.flatnonzero(supported)):
        result['shrinkage'][j] = float(weight[index])
        result['calibrated'][j] = float(calibrated[index])
        result['sampling_variance'][j] = float(variance[index])
    result.update(status='estimated_inner_diagnostic', tau2=tau2, mu=mu,
                  bootstrap_draws_used=len(complete), bootstrap_draws_total=len(draws),
                  covariance=covariance.tolist(), posterior_approximation='marginal_normal_means',
                  causal_outer_calibration=False)
    return result



def fit_oof(frame, *, source_sha256, cutoff, expected_keys_checksum):
    required={'date','symbol','score','gross_return','label_known_date','prediction_kind'}
    if not required<=set(frame.columns) or frame.is_empty():raise ValueError('p6_calibration_columns_missing')
    frame=frame.sort('date','symbol')
    if (frame.unique(['date','symbol']).height!=frame.height or frame['date'].n_unique()<2
            or frame.select(pl.any_horizontal(pl.all().is_null())).to_series().any()):
        raise ValueError('p6_calibration_rows_invalid')
    if frame['prediction_kind'].unique().to_list()!=['oof']:
        raise ValueError('p6_calibration_oof_only')
    if not frame['score'].is_finite().all() or not frame['gross_return'].is_finite().all():
        raise ValueError('p6_calibration_nonfinite')
    if len(source_sha256)!=64 or any(c not in '0123456789abcdef' for c in source_sha256):
        raise ValueError('p6_calibration_source_checksum_invalid')
    keys=frame.select('date','symbol').to_dicts()
    if digest(keys)!=expected_keys_checksum:raise ValueError('p6_calibration_pool_changed')
    if any(not cutoff.admits(d,k) for d,k in frame.select('date','label_known_date').iter_rows()):
        raise ValueError('p6_calibration_after_cutoff')
    numerator=denominator=0.;bins=[]
    for group in frame.partition_by('date',maintain_order=True):
        score=group['score'].to_numpy();target=group['gross_return'].to_numpy()
        centered=score-score.mean();excess=target-target.mean()
        numerator+=float(np.mean(centered*excess));denominator+=float(np.mean(centered**2))
        std=float(score.std())
        if std<=0:raise ValueError('p6_calibration_zero_dispersion')
        assigned=np.searchsorted(Z_EDGES,centered/std,side='right')-1
        bins.append([float(excess[assigned==b].mean()) if np.any(assigned==b) else np.nan for b in range(9)])
    if denominator<=0:raise ValueError('p6_calibration_zero_denominator')
    eb=empirical_bayes(np.asarray(bins))
    counts=np.isfinite(bins).sum(axis=0)
    realized=np.divide(np.nansum(bins,axis=0),counts,out=np.full(9,np.nan),where=counts>0)
    result=dict(schema_version='p6-frozen-oof-calibration-v1',source_sha256=source_sha256,
        candidate_keys_checksum=expected_keys_checksum,requested_cutoff=cutoff.__dict__,
        dates=sorted(frame['date'].unique()),rows=frame.height,scope='full_classified_candidate_pool',
        label_known_at_max=max(frame['label_known_date']),linear_b=numerator/denominator,
        linear_method='daily_equal_centered_OLS_no_intercept',z_std_ddof=0,
        z_edges=['-inf',*Z_EDGES[1:-1],'inf'],empirical_bayes=eb,
        realized_bins=[dict(bin=b,dates=int(counts[b]),mean=float(realized[b]) if counts[b] else None) for b in range(9)],
        raw_application='center_raw_score_on_current_full_pool',linear_application='linear_b_times_centered_raw_score',
        eb_application='diagnostic_only_not_registered',outer_updates_allowed=False,outer_data_used=False,
        refit_predictions_used=False,production_enabled=False)
    return {**result,'checksum':digest(result)}
