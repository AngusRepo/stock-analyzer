"""Regression tests for the 2026-11-24 pymoo strategy-mining audit (B1-B12).

Every test here fails on origin/main 69aaf527 and passes after the fix. FinLab is not
available in CI, so FinLab-backed pieces are exercised through stubs/synthetic panels.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import sys
import types
from pathlib import Path

import numpy as np
import pandas as pd
import pytest


ROOT = Path(__file__).resolve().parents[2]


def _load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


miner = _load(ROOT / "tools" / "finlab_alpha_miner_bakeoff.py", "stockvision_audit_fix_miner")
CONFIG = json.loads((ROOT / "data" / "feature_registry" / "pymoo_monthly_mining_config_v1.json").read_text(encoding="utf-8"))


# --------------------------------------------------------------------------- B1
def test_b1_declared_low_vol_factor_picks_low_vol_names_through_real_pool_builders(tmp_path):
    """Direction must be applied once: a direction=-1 low-vol factor ranks the LOWEST vol first."""
    overlap = _load(ROOT / "tools" / "feature_strategy_overlap_numeric.py", "stockvision_audit_fix_overlap")
    idx = pd.bdate_range("2025-01-01", periods=40)
    cols = ["1101", "1102", "1103", "1104"]
    close = pd.DataFrame(100.0, index=idx, columns=cols)
    raw = pd.DataFrame(np.tile([0.10, 0.20, 0.30, 0.40], (len(idx), 1)), index=idx, columns=cols)
    base = {key: close.copy() for key in ["open", "high", "low", "close", "volume", "adj_close"]}
    ab_stub = types.SimpleNamespace(
        _build_base_data=lambda universe: base,
        _build_factor_values=lambda b: ({"vola_realized_1m": raw.copy()}, {}),
    )
    spec_stub = types.SimpleNamespace(
        _technical_features=lambda *a: {}, _financial_features=lambda *a: {},
        _chip_features=lambda *a: {}, _sector_features=lambda *a: {},
    )

    def overlap_load(path, name):
        text = str(path)
        if text.endswith("finlab_alphabuilders_factor_backtest.py"):
            return ab_stub
        if text.endswith("finlab_strategy_spec_backtest.py"):
            return spec_stub
        if text.endswith("finlab_alpha_miner_bakeoff.py"):
            return types.SimpleNamespace(_load_strategy_leaf_refs=lambda: [])
        raise RuntimeError(text)

    def miner_load(path, name):
        text = str(path)
        if text.endswith("finlab_alphabuilders_factor_backtest.py"):
            return ab_stub
        if text.endswith("feature_strategy_overlap_numeric.py"):
            return overlap
        if text.endswith("finlab_strategy_spec_backtest.py"):
            return spec_stub
        raise RuntimeError(text)

    overlap._load_module = overlap_load
    overlap._build_ml_feature_pool = lambda **kwargs: ({}, [])
    original_loader = miner._load_module
    miner._load_module = miner_load
    try:
        definitions = json.loads((ROOT / "data" / "feature_registry" / "alphabuilders_factors_fresh.json").read_text(encoding="utf-8-sig"))
        declared = [row for row in definitions if row.get("id") == "vola_realized_1m"][0]
        assert float(declared["direction"]) == -1.0
        factor_json = tmp_path / "factor.json"
        factor_json.write_text(json.dumps([declared]), encoding="utf-8")
        args = argparse.Namespace(
            feature_registry=str(ROOT / "data" / "feature_registry" / "unified_feature_registry_v1.json"),
            similarity_contract=str(ROOT / "data" / "feature_registry" / "formal137_similarity_contract_v1.json"),
            universe="sii", end_date="2025-02-28", start_date="2025-01-01", max_symbols=0,
            factor_json=str(factor_json),
        )
        _pricing, tradable, values, meta, _info = miner._build_unified_registry_factor_universe(args)
    finally:
        miner._load_module = original_loader
    # The pool hands the miner RAW values; the miner applies the declared direction once.
    assert values["vola_realized_1m"].iloc[-1].tolist() == pytest.approx([0.10, 0.20, 0.30, 0.40])
    score = miner._candidate_score(miner.Candidate("x", "pymoo_nsga3_novelty", ["vola_realized_1m"], [1.0]), values, meta)
    top1 = miner._position_from_score(score, 1, tradable).iloc[-1]
    assert top1[top1].index.tolist() == ["1101"]


# --------------------------------------------------------------------------- B2
def test_b2_labeler_objectives_never_include_holdout():
    assert not any("holdout" in name for name in CONFIG["labeler_search_v2"]["objectives"])
    for names in miner.PYMOO_OBJECTIVES.values():
        assert not any("holdout" in name or "full" in name for name in names)
    row = {
        "status": "ok",
        "validation_excess": {"excess_sharpe": 1.2},
        "train_excess": {"excess_sharpe": 0.4},
        "turnover": 0.3,
        "label_matrix_novelty": 0.5,
        "label_matrix_metrics": {"label_entropy": 0.9},
        "holdout": {"sharpe": 9.0},
    }
    base = miner._pymoo_objectives(row, is_labeler_v2=True, max_factors=8)
    row["holdout"] = {"sharpe": -9.0}
    row["holdout_excess"] = {"excess_sharpe": -9.0}
    assert miner._pymoo_objectives(row, is_labeler_v2=True, max_factors=8) == base
    assert base[:2] == [-1.2, -0.4]


# --------------------------------------------------------------------- synthetic panel
def _panel(n_days: int = 340, n_stocks: int = 30, seed: int = 7, holdout_noise: float = 0.0):
    """Factor `alpha` predicts next-day return; `beta_*` are noise; `mkt` is market-level."""
    rng = np.random.default_rng(seed)
    idx = pd.bdate_range("2024-01-01", periods=n_days)
    cols = [f"{1100 + i}" for i in range(n_stocks)]
    alpha = pd.DataFrame(rng.normal(size=(n_days, n_stocks)), index=idx, columns=cols)
    noise = rng.normal(scale=0.01, size=(n_days, n_stocks))
    ret = 0.002 * alpha.shift(1).fillna(0.0).to_numpy() + noise
    if holdout_noise:
        tail = slice(n_days - 60, n_days)
        ret[tail] += np.random.default_rng(seed + 1).normal(scale=holdout_noise, size=ret[tail].shape)
    close = pd.DataFrame(100.0 * np.cumprod(1.0 + ret, axis=0), index=idx, columns=cols)
    values = {"alpha": alpha}
    for k in range(4):
        values[f"beta_{k}"] = pd.DataFrame(rng.normal(size=(n_days, n_stocks)), index=idx, columns=cols)
    values["mkt"] = pd.DataFrame(np.repeat(rng.normal(size=(n_days, 1)), n_stocks, axis=1), index=idx, columns=cols)
    meta = {
        fid: miner.FactorMeta(id=fid, source="synthetic", category=f"cat_{fid}", direction=1.0)
        for fid in values
    }
    return close, close.notna(), values, meta


def _args(**overrides):
    args = argparse.Namespace(
        factor_universe="unified_registry_v1", algorithm="pymoo", start_date="2024-01-01", end_date="2025-04-30",
        universe="sii", top_k=5, min_factors=2, max_factors=3, seed=None, random_trials=0, optuna_trials=0,
        deap_population=0, deap_generations=0, pymoo_population=8, pymoo_generations=2,
        pymoo_search_mode="top_k_v1", pymoo_labeler_population=8, pymoo_labeler_generations=2,
        labeler_min_percentile=0.55, labeler_max_percentile=0.85, finlab_confirm_top_n=3, pbo_folds=8,
        pbo_embargo_sessions=2, promote_family_factor_jaccard=0.5, promote_family_category_jaccard=0.67,
        resample="M", position_limit=0.1, trade_at_price="close", disable_monthly_mining_config=True,
        similarity_pairs=str(ROOT / "output" / "feature_universe_triage" / "formal137_pairwise_similarity_long_20260617.csv"),
        similarity_contract=str(ROOT / "data" / "feature_registry" / "formal137_similarity_contract_v1.json"),
        research_protocol_override={
            "train_sessions": 150, "validation_sessions": 80, "holdout_sessions": 60,
            "purge_sessions": 5, "embargo_sessions": 2, "holdout_not_before": None,
            "min_holdout_sessions_for_gate": 40, "direction_ic_horizon_sessions": 5,
            "feature_triage_window": {"start": "2023-01-01", "end": "2023-12-31"},
            "selection_gate": {
                "min_validation_excess_sharpe": -99.0, "min_train_excess_sharpe": -99.0,
                "min_deflated_sharpe_probability": 0.0, "max_selection_drawdown": 9.0,
                "max_turnover": 9.0, "regime_min_observations": 10_000,
            },
        },
    )
    for key, value in overrides.items():
        setattr(args, key, value)
    return args


def _stub_universe(monkeypatch, panel):
    close, tradable, values, meta = panel

    def build(args):
        return close.copy(), tradable.copy(), {k: v.copy() for k, v in values.items()}, dict(meta), {}

    monkeypatch.setattr(miner, "_build_unified_registry_factor_universe", build)


# --------------------------------------------------------------------------- B3
def test_b3_rolling_windows_are_ordered_purged_and_respect_holdout_not_before():
    index = pd.bdate_range("2022-01-03", "2026-12-04")
    protocol = miner._resolve_research_protocol(argparse.Namespace(disable_monthly_mining_config=True))
    args = argparse.Namespace(end_date="2026-12-04")
    windows = miner._resolve_walk_forward_windows(args, index, protocol)
    sessions = list(index)
    pos = {key: sessions.index(pd.Timestamp(windows[key])) for key in
           ("train_start", "train_end", "validation_start", "validation_end", "holdout_start", "holdout_end")}
    gap = protocol["purge_sessions"] + protocol["embargo_sessions"]
    assert pos["validation_start"] - pos["train_end"] - 1 == gap
    assert pos["holdout_start"] - pos["validation_end"] - 1 == gap
    assert pd.Timestamp(windows["holdout_start"]) > pd.Timestamp("2026-11-08") - pd.Timedelta(days=1)
    assert pos["validation_end"] - pos["validation_start"] + 1 == protocol["validation_sessions"]
    # Fewer than min_holdout_sessions_for_gate fresh sessions -> holdout gate not ready (fail closed).
    assert windows["holdout_sessions"] < protocol["min_holdout_sessions_for_gate"]
    assert windows["holdout_gate_ready"] is False


def test_b3_full_window_triage_overlap_blocks_promotion():
    protocol = miner._resolve_research_protocol(argparse.Namespace(disable_monthly_mining_config=True))
    check = miner._feature_triage_check(protocol, {"train_end": "2025-07-31", "validation_start": "2025-09-01"})
    assert check["overlaps_validation_or_holdout"] is True
    assert check["status"] == "contaminated_promotion_blocked"
    assert "Needs FinLab" in check["regeneration_required"]
    # A triage ending after train_end (inside the purge gap) is still contamination.
    gap_case = miner._feature_triage_check(
        {**protocol, "feature_triage_window": {"start": "2020-01-01", "end": "2025-08-15"}},
        {"train_end": "2025-07-31", "validation_start": "2025-09-01"},
    )
    assert gap_case["overlaps_validation_or_holdout"] is True


def test_b3_fixed_windows_are_validated():
    index = pd.bdate_range("2022-01-03", "2026-12-04")
    protocol = miner._resolve_research_protocol(argparse.Namespace(disable_monthly_mining_config=True))
    protocol["window_mode"] = "fixed"
    good = dict(train_start="2023-01-02", train_end="2024-12-31", validation_start="2025-02-14",
                validation_end="2025-12-31", holdout_start="2026-11-09", holdout_end="2026-12-04")
    windows = miner._resolve_walk_forward_windows(argparse.Namespace(end_date="2026-12-04", **good), index, protocol)
    assert windows["mode"] == "fixed"
    for bad, match in [
        ({**good, "validation_start": "2025-01-02"}, "gap_too_small"),
        ({**good, "holdout_start": "2026-02-02"}, "gap_too_small|not_before"),
        ({**good, "train_end": None}, "fixed_windows_missing"),
    ]:
        with pytest.raises(RuntimeError, match=match):
            miner._resolve_walk_forward_windows(argparse.Namespace(end_date="2026-12-04", **bad), index, protocol)


def test_b3_candidate_evaluation_never_prices_the_holdout(monkeypatch):
    clean = _panel()
    perturbed = _panel(holdout_noise=0.2)
    # Same selection data, wildly different holdout prices.
    pd.testing.assert_frame_equal(clean[0].iloc[:-60], perturbed[0].iloc[:-60])
    candidate = miner.Candidate("c", "pymoo_nsga3_novelty", ["alpha", "beta_0"], [1.0, 0.5])
    results = []
    for panel in (clean, perturbed):
        _stub_universe(monkeypatch, panel)
        ctx, _info, _ids = miner._build_mining_context(_args())
        assert pd.Timestamp(ctx.windows["selection_end"]) < pd.Timestamp(ctx.windows["holdout_start"])
        row = miner._evaluate_candidate(candidate, ctx)
        results.append(row)
    assert "holdout" not in results[0] and "holdout_daily_returns" not in results[0]
    for key in ("train", "validation", "selection", "validation_excess"):
        assert results[0][key] == results[1][key]


def test_b3_holdout_is_sealed_once_per_run(monkeypatch):
    _stub_universe(monkeypatch, _panel())
    ctx, _info, _ids = miner._build_mining_context(_args())
    row = miner._evaluate_candidate(miner.Candidate("c", "pymoo_nsga3_novelty", ["alpha", "beta_0"], [1.0, 0.5]), ctx)
    seal = miner._seal_holdout_evaluation([row], ctx)
    assert seal["status"] == "evaluated" and seal["family_size"] == 1
    assert row["holdout_status"] == "evaluated" and len(row["holdout_daily_returns"]) > 0
    with pytest.raises(RuntimeError, match="holdout_already_evaluated"):
        miner._seal_holdout_evaluation([row], ctx)


def test_b3_fitted_directions_are_rederived_on_the_train_window_only():
    idx = pd.bdate_range("2024-01-01", periods=200)
    cols = [f"S{i}" for i in range(20)]
    rng = np.random.default_rng(3)
    signal = pd.DataFrame(rng.normal(size=(200, 20)), index=idx, columns=cols)
    sign = np.where(np.arange(200) < 120, 1.0, -1.0)[:, None]  # relationship flips after the train window
    ret = 0.01 * signal.to_numpy() * sign + rng.normal(scale=0.001, size=(200, 20))
    close = pd.DataFrame(100 * np.cumprod(1 + np.vstack([np.zeros((1, 20)), ret[:-1]]), axis=0), index=idx, columns=cols)
    values = {"f": signal}
    meta = {"f": miner.FactorMeta("f", "ml106", "x", -1.0, direction_source="full_window_triage")}
    out = miner._derive_train_window_directions(
        values, meta, close, close.notna(),
        train_start=str(idx[0].date()), train_end=str(idx[110].date()), horizon=1,
    )
    assert meta["f"].direction == 1.0 and meta["f"].direction_source == "train_window_rank_ic"
    assert "f" in out["changed_vs_full_window_triage"]


def test_b3_trials_are_counted_across_months():
    rng = np.random.default_rng(0)
    rows = [
        {"status": "ok", "candidate_id": f"c{i}", "fitness": 0.0,
         "_selection_excess_returns": rng.normal(scale=0.01, size=300),
         "sharpe_moments": {"daily_sharpe": 0.05, "skew": 0.0, "kurtosis": 3.0, "sample_count": 300}}
        for i in range(20)
    ]
    windows = {"selection_start": "2024-01-01", "selection_end": "2026-09-30", "holdout_start": "2026-11-09", "holdout_end": "2027-02-01"}
    alone = miner._apply_multiple_testing([dict(r) for r in rows], windows=windows, prior_runs=[])
    prior = [
        {"run_id": "legacy", "selection_start": "2023-01-01", "selection_end": "2026-11-07", "search_trials_raw": 542},
        {"run_id": "new", "selection_start": "2024-01-01", "selection_end": "2026-09-30", "search_trials_effective": 30.0},
        {"run_id": "disjoint", "selection_start": "2019-01-01", "selection_end": "2020-12-31", "search_trials_effective": 99.0},
    ]
    pooled_rows = [dict(r) for r in rows]
    pooled = miner._apply_multiple_testing(pooled_rows, windows=windows, prior_runs=prior)
    assert pooled["total_effective_trials"] > alone["total_effective_trials"] + 30.0
    assert {item["run_id"] for item in pooled["prior_runs_counted"]} == {"legacy", "new"}
    assert all("_selection_excess_returns" not in row for row in pooled_rows)


# --------------------------------------------------------------------------- B4
def test_b4_effective_trials_collapse_for_correlated_candidates():
    rng = np.random.default_rng(1)
    common = rng.normal(size=(500, 1))
    duplicates = common + rng.normal(scale=0.01, size=(500, 40))
    independent = rng.normal(size=(500, 40))
    assert miner._effective_trial_count(duplicates)["effective_trials"] < 3.0
    assert miner._effective_trial_count(independent)["effective_trials"] > 25.0


def test_b4_dsr_gate_is_feasible_but_strict():
    """With ~3y of selection data and N_eff=50 noise trials the hurdle is ~2.25 annualised excess
    Sharpe (strict, but reachable), not the ~4.7-5.6 validation Sharpe the old proxy demanded."""
    moments = {"daily_sharpe": 2.6 / np.sqrt(252), "skew": 0.0, "kurtosis": 3.0, "sample_count": 756}
    noise_std = 1.0 / np.sqrt(756)  # cross-trial dispersion of daily Sharpe when trials are noise
    moderate = miner._deflated_sharpe(moments, effective_trials=50, cross_trial_sharpe_std=noise_std)
    huge = miner._deflated_sharpe(moments, effective_trials=5000, cross_trial_sharpe_std=noise_std)
    weak = miner._deflated_sharpe({**moments, "daily_sharpe": 0.8 / np.sqrt(252)}, effective_trials=50,
                                  cross_trial_sharpe_std=noise_std)
    assert 2.0 < moderate["minimum_annualized_sharpe"] < 2.5
    assert moderate["probability"] > 0.95
    assert huge["probability"] < moderate["probability"]
    assert weak["probability"] < 0.95


def test_b4_adaptive_controller_moves_from_previous_outputs(monkeypatch):
    sys.path.insert(0, str(ROOT / "ml-controller"))
    import strategy_mining_job_main as job

    previous = {
        "run_id": "r", "run_date": "2026-11-07", "updated_at": None,
        "telemetry": {"summary": {}, "adaptive_strategy_families": {"eligible_count": 0, "family_count": 0}, "runtime_seconds": 1000},
        "config": {"pymoo_population": 69, "pymoo_generations": 6, "finlab_confirm_top_n": 8, "pymoo_labeler_population": 32},
    }
    monkeypatch.setattr(job, "_load_previous_completed_telemetry", lambda: previous)
    args = argparse.Namespace(pymoo_population=48, pymoo_generations=6, finlab_confirm_top_n=8, pymoo_labeler_population=32)
    out = job._apply_adaptive_mining_params(args)
    assert out.pymoo_population == 86  # 69 * 1.25, not 48 * 1.25 * ... = 69 again
    previous["config"] = {"pymoo_population": out.pymoo_population, "pymoo_generations": out.pymoo_generations,
                          "finlab_confirm_top_n": out.finlab_confirm_top_n, "pymoo_labeler_population": out.pymoo_labeler_population}
    again = job._apply_adaptive_mining_params(argparse.Namespace(pymoo_population=48, pymoo_generations=6,
                                                                 finlab_confirm_top_n=8, pymoo_labeler_population=32))
    assert again.pymoo_population > out.pymoo_population  # no fixed point under identical telemetry


# --------------------------------------------------------------------------- B5
def test_b5_rebalances_on_last_trading_day_when_month_end_is_a_weekend():
    idx = pd.bdate_range("2026-01-26", "2026-02-27")  # 2026-01-31 is a Saturday
    position = pd.DataFrame(False, index=idx, columns=["A", "B"])
    position.loc["2026-01-30", "A"] = True
    position.loc["2026-02-27", "B"] = True
    rebalanced = miner._rebalance_position(position, "M")
    assert bool(rebalanced.loc["2026-02-02", "A"]) is True
    assert bool(rebalanced.loc["2026-02-26", "A"]) is True
    assert pd.Timestamp("2026-01-30") in miner._rebalance_sessions(idx, "M")


# ----------------------------------------------------------------------- B6 / B7
def test_b6_b7_fill_next_session_and_tw_cost_model():
    idx = pd.bdate_range("2026-03-02", periods=7)
    close = pd.DataFrame({"A": [100.0, 110.0, 121.0, 121.0, 121.0, 121.0, 121.0]}, index=idx)
    position = pd.DataFrame({"A": [True, True, True, True, False, False, False]}, index=idx)
    returns = miner._portfolio_returns(position, close)
    # Signal at close d0 fills at close d1: the d0->d1 +10% is NOT earned; entry pays commission.
    assert returns.iloc[1] == pytest.approx(-0.001425)
    assert returns.iloc[2] == pytest.approx(0.10)
    # Exit signal at d4 fills at d5: commission + 0.3% sell tax.
    assert returns.iloc[5] == pytest.approx(-(0.001425 + 0.003))
    with pytest.raises(ValueError):
        miner._portfolio_returns(position, close, execution_lag=0)


def test_b6_adjusted_close_is_required_and_fails_closed():
    idx = pd.bdate_range("2026-03-02", periods=5)
    close = pd.DataFrame({"A": [100.0] * 5, "B": [50.0] * 5}, index=idx)
    adjusted = miner._adjusted_close({"adj_close": close * 0.9}, close)
    assert adjusted.iloc[0, 0] == pytest.approx(90.0)
    with pytest.raises(RuntimeError, match="adjusted_close_coverage_gap"):
        miner._adjusted_close({"adj_close": close[["A"]]}, close)


# --------------------------------------------------------------------------- B8
def test_b8_novelty_varies_once_archive_covers_every_feature():
    pairs = {miner._pair_key(a, b): 0.1 for a in "abcdef" for b in "abcdef" if a != b}
    archive = [{"a", "b"}, {"c", "d"}, {"e", "f"}]
    candidates = [["a", "b"], ["a", "c"], ["a", "c", "e"]]
    out = [
        miner._similarity_adjusted_novelty(c, archive, pair_map=pairs, feature_meta={}, neighbours=1)["novelty"]
        for c in candidates
    ]
    assert out[0] == pytest.approx(0.0)
    assert len(set(round(v, 6) for v in out)) == 3


# --------------------------------------------------------------------------- B9
def test_b9_seed_is_derived_from_run_date_and_recorded(monkeypatch):
    assert miner._seed_from_date("2026-12-05") == miner._seed_from_date("2026-12-05")
    assert miner._seed_from_date("2026-12-05") != miner._seed_from_date("2027-01-02")
    _stub_universe(monkeypatch, _panel())
    args = _args()
    miner._build_mining_context(args)
    assert args.seed == miner._seed_from_date("2025-04-30") and args.seed != 42
    assert "sha256" in args.seed_source


# -------------------------------------------------------------------------- B10
def test_b10_market_level_features_are_excluded_and_missing_factors_fail_closed(monkeypatch):
    _stub_universe(monkeypatch, _panel())
    ctx, info, factor_ids = miner._build_mining_context(_args())
    assert "mkt" in info["cross_sectional_constant_features"]["excluded"]
    assert "mkt" not in factor_ids
    row = miner._evaluate_candidate(miner.Candidate("c", "pymoo_nsga3_novelty", ["alpha", "mkt"], [1.0, 1.0]), ctx)
    assert row["status"] == "effective_factor_count_dropped"
    assert miner._pymoo_objectives(row, is_labeler_v2=False, max_factors=3) == [miner._WORST_OBJECTIVE] * 5


# -------------------------------------------------------------------------- B11
def test_b11_metrics_are_benchmark_relative_with_beta_and_regimes():
    idx = pd.bdate_range("2026-01-01", periods=200)
    rng = np.random.default_rng(5)
    bench = pd.Series(rng.normal(0.001, 0.01, 200), index=idx)
    leveraged = 1.5 * bench
    regimes = pd.Series(np.where(bench > 0, "bull", "bear"), index=idx)
    out = miner._benchmark_relative_metrics(leveraged, bench, regimes, regime_min_observations=20,
                                            regime_min_excess_return_annualized=-0.15)
    assert out["beta"] == pytest.approx(1.5, rel=1e-6)
    assert out["down_market_excess_annualized"] < 0 < out["up_market_excess_annualized"]
    assert "bear" in out["one_sided_regimes"]


def test_b11_finlab_confirm_is_a_gate():
    protocol = miner._resolve_research_protocol(argparse.Namespace(disable_monthly_mining_config=True))
    assert miner._finlab_confirm_verdict(None, protocol)["status"] == "failed"
    bad = miner._finlab_confirm_verdict({"status": "ok", "monthly_sharpe": 1.2, "benchmark_alpha": -0.01}, protocol)
    assert bad["status"] == "failed" and "finlab_confirm_benchmark_alpha_not_positive" in bad["reasons"]
    good = miner._finlab_confirm_verdict({"status": "ok", "monthly_sharpe": 1.2, "benchmark_alpha": 0.02}, protocol)
    assert good["status"] == "pass"


# -------------------------------------------------------------------------- B12
def test_b12_partial_factor_coverage_and_zero_sharpe_and_full_label_signature():
    idx = pd.bdate_range("2026-01-01", periods=3)
    cols = ["A", "B", "C"]
    f1 = pd.DataFrame([[1.0, 2.0, 3.0]] * 3, index=idx, columns=cols)
    f2 = pd.DataFrame([[3.0, 2.0, np.nan]] * 3, index=idx, columns=cols)
    meta = {fid: miner.FactorMeta(fid, "s", "c", 1.0) for fid in ("f1", "f2")}
    score = miner._candidate_score(miner.Candidate("x", "a", ["f1", "f2"], [0.9, 0.1]), {"f1": f1, "f2": f2}, meta)
    assert score["C"].notna().all()  # 90% of the weight present -> still ranked
    low = miner._candidate_score(miner.Candidate("x", "a", ["f1", "f2"], [0.1, 0.9]), {"f1": f1, "f2": f2}, meta)
    assert low["C"].isna().all()  # only 10% of the weight present -> not ranked

    zero = {"status": "ok", "validation_excess": {"excess_sharpe": 0.0}, "train_excess": {"excess_sharpe": 0.0},
            "turnover": 0.1, "novelty": 0.5, "complexity": 2}
    assert miner._pymoo_objectives(zero, is_labeler_v2=False, max_factors=8)[:2] == [0.0, 0.0]
    assert miner._fitness_key({"fitness": 0.0}) == 0.0

    labels = pd.DataFrame(False, index=pd.bdate_range("2026-01-01", periods=10), columns=[f"S{i:03d}" for i in range(300)])
    other = labels.copy()
    other.iloc[:, 299] = True
    assert not np.array_equal(miner._label_signature(labels), miner._label_signature(other))


# ------------------------------------------------------------------ end-to-end smoke
def test_run_end_to_end_seals_holdout_for_finalists_only(monkeypatch):
    _stub_universe(monkeypatch, _panel())
    confirmed = []

    def fake_confirm(finalists, ctx):
        confirmed.extend(row["candidate_id"] for row in finalists)
        for row in finalists:
            row["finlab_confirm_gate"] = {"status": "pass", "reasons": []}
        return []

    monkeypatch.setattr(miner, "_finlab_confirm", fake_confirm)
    report = miner.run(_args())
    rows = report["rows"]
    finalists = set(report["gate_finalists"])
    assert finalists and set(confirmed) == finalists
    assert {row["candidate_id"] for row in rows if row.get("holdout_status") == "evaluated"} <= finalists
    assert all("holdout" not in row for row in rows if row["candidate_id"] not in finalists)
    assert report["holdout_seal"]["family_size"] == len([r for r in rows if r.get("holdout_status") == "evaluated"])
    assert report["multiple_testing"]["search_trials_raw"] == sum(1 for r in rows if r.get("status") == "ok")
    assert report["blocking_gates"] == []
    assert all(row.get("fitness_contract") == "selection_sample_excess_v3_holdout_sealed" for row in rows if row.get("status") == "ok")
    assert all("_selection_excess_returns" not in row for row in rows)
    ok_rows = [row for row in rows if row.get("status") == "ok"]
    assert all(len(row["factor_directions"]) == len(row["factor_ids"]) for row in ok_rows)
    json.dumps(report, default=miner._json_default)


def test_blocked_run_never_opens_the_holdout(monkeypatch):
    _stub_universe(monkeypatch, _panel())
    monkeypatch.setattr(miner, "_finlab_confirm", lambda finalists, ctx: pytest.fail("holdout priced by FinLab"))
    args = _args()
    args.research_protocol_override["feature_triage_window"] = {"start": "2023-01-01", "end": "2026-06-15"}
    report = miner.run(args)
    assert report["holdout_seal"]["status"] == "withheld_blocked"
    assert report["holdout_seal"]["family_size"] == 0
    assert report["multiple_testing"]["holdout_family_size"] == 0
    assert "feature_triage_window_overlaps_evaluation" in report["blocking_gates"]
    assert not any(row.get("holdout_status") == "evaluated" for row in report["rows"])


def test_turnover_is_measured_on_the_selection_sample_only(monkeypatch):
    _stub_universe(monkeypatch, _panel())
    ctx, _info, _ids = miner._build_mining_context(_args(resample="D"))
    windows = ctx.windows
    assert pd.Timestamp(windows["selection_start"]) > pd.Timestamp(ctx.args.start_date)  # there is a warm-up
    candidate = miner.Candidate("c", "pymoo_nsga3_novelty", ["alpha", "beta_0"], [1.0, 0.5])
    row = miner._evaluate_candidate(candidate, ctx)
    score = miner._candidate_score(candidate, ctx.values, ctx.meta, min_weight_coverage=0.5)
    position = miner._rebalance_position(
        miner._candidate_position(candidate, score, ctx, windows["selection_end"]), "D"
    )
    selection_only = miner._mean_turnover(position.loc[windows["selection_start"]: windows["selection_end"]])
    whole = miner._mean_turnover(position)
    assert selection_only != pytest.approx(whole)
    assert row["turnover"] == pytest.approx(selection_only)
