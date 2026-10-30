"""T4 (C28-02, PIT-P0 4): a vendor adj-price rebase multiplies a window by a constant.

Sequence scores (forecast / signal close - 1) must stay within 1e-3 x cross-sectional
score std and rank corr >= 0.9999 (RevIN / use_norm add eps to the variance, so exact
equality only holds as eps -> 0). This is what lets adj prices be level I for them.
"""
import numpy as np
import pytest

torch = pytest.importorskip("torch")

REBASES = (0.5, 0.95, 0.99, 2.0, 10.0)
TOLERANCE = 1e-3
RANK_CORR = 0.9999


def _windows(n_series=48, length=512, seed=11):
    rng = np.random.default_rng(seed)
    # Price levels from 0.4 (heavily back-adjusted) to 1500, daily vol 1-4%.
    levels = np.exp(rng.uniform(np.log(0.4), np.log(1500), n_series))
    vol = rng.uniform(0.01, 0.04, n_series)
    paths = np.exp(np.cumsum(rng.normal(0, vol[:, None], (n_series, length)), axis=1))
    return (levels[:, None] * paths / paths[:, -1:]).astype(np.float32)


def _rank_corr(a, b):
    ra, rb = np.argsort(np.argsort(a)), np.argsort(np.argsort(b))
    return float(np.corrcoef(ra, rb)[0, 1])


def _assert_invariant(score, windows):
    base = score(windows)
    assert np.isfinite(base).all() and base.std() > 0
    for c in REBASES:
        scaled = score(windows * np.float32(c))
        assert np.max(np.abs(scaled - base)) <= TOLERANCE * base.std(), c
        assert _rank_corr(scaled, base) >= RANK_CORR, c


def _nf(model_name, windows):
    pytest.importorskip("neuralforecast", exc_type=ImportError)
    from app.neuralforecast_sequence_runtime import _make_nf_model
    torch.manual_seed(5)
    model = _make_nf_model(model_name, pred_len=5, seq_len=windows.shape[1], max_steps=1, batch_size=8, seed=5,
                           n_series=windows.shape[0])
    model.eval()

    def score(values):
        x = torch.from_numpy(values)
        with torch.no_grad():
            if model_name == "iTransformer":  # one multivariate panel window
                out = model({"insample_y": x.T.unsqueeze(0)})[0, -1, :].numpy()
            else:
                out = model({"insample_y": x.unsqueeze(-1)})[:, -1, 0].numpy()
        return out.astype(np.float64) / values[:, -1].astype(np.float64) - 1.0
    return score


@pytest.mark.parametrize("model_name", ["PatchTST", "iTransformer"])
def test_neuralforecast_sequence_scores_are_rebase_invariant(model_name):
    windows = _windows()
    _assert_invariant(_nf(model_name, windows), windows)


@pytest.mark.parametrize("exogenous", [False, True])
def test_timexer_scores_are_rebase_invariant(exogenous):
    from app.timexer_runtime import ARCHITECTURE, OFFICIAL_COMMIT, causal_input, official_model, predict_inputs
    settings = {**ARCHITECTURE, "official_commit": OFFICIAL_COMMIT}
    torch.manual_seed(5)
    model = official_model(settings, exogenous).eval()
    length = settings["seq_len"]
    dates = np.arange(np.datetime64("2026-01-01"), np.datetime64("2026-01-01") + length).astype(str)
    features = np.random.default_rng(3).normal(size=(length, 137)).astype(np.float32)
    windows = _windows(length=length)

    def score(values):
        inputs = [causal_input((dates, row), (dates, features), dates, dates[-1], settings=settings,
                               exogenous=exogenous) for row in values]
        return predict_inputs(model, inputs)
    _assert_invariant(score, windows)
