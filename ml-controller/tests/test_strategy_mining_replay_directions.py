"""Replay / downstream tools must score mined rows with the directions they were mined with.

Follow-up to the 2026-11-24 pymoo audit (remaining item 4): replay tools read the row's
factor_directions, fail closed on pre-v3 rows unless the legacy as-mined branch is explicit, and
alpha223 / active12 use the miner's commission + sell-tax cost model and sealed-holdout protocol.
Every test fails on origin/main 69aaf527. FinLab is stubbed (synthetic panels).
"""
from __future__ import annotations

import argparse
import csv
import importlib.util
import json
import sys
import types
from pathlib import Path

import numpy as np
import pandas as pd
import pytest


ROOT = Path(__file__).resolve().parents[2]
SIMILARITY_PAIRS = ROOT / "output" / "feature_universe_triage" / "formal137_pairwise_similarity_long_20260617.csv"
SIMILARITY_CONTRACT = ROOT / "data" / "feature_registry" / "formal137_similarity_contract_v1.json"


def _load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


miner = _load(ROOT / "tools" / "finlab_alpha_miner_bakeoff.py", "stockvision_replay_dir_miner")


def _ladder_panel(n_days: int = 60, n_stocks: int = 8):
    idx = pd.bdate_range("2026-01-01", periods=n_days)
    cols = [f"{2300 + i}" for i in range(n_stocks)]
    close = pd.DataFrame(100.0, index=idx, columns=cols)
    ladder = pd.DataFrame(np.tile(np.arange(n_stocks, dtype=float), (n_days, 1)), index=idx, columns=cols)
    return close, close.notna(), ladder


# ------------------------------------------------------------------ miner primitives
def test_candidate_score_uses_candidate_directions_over_meta():
    close, _tradable, ladder = _ladder_panel()
    meta = {"f": miner.FactorMeta(id="f", source="ml106", category="x", direction=1.0, direction_source="full_window_triage")}
    as_meta = miner._candidate_score(miner.Candidate("c", "a", ["f"], [1.0]), {"f": ladder}, meta)
    flipped = miner._candidate_score(miner.Candidate("c", "a", ["f"], [1.0], directions=[-1.0]), {"f": ladder}, meta)
    last = close.index[-1]
    assert as_meta.loc[last].idxmax() == close.columns[-1]
    assert flipped.loc[last].idxmax() == close.columns[0]
    with pytest.raises(ValueError, match="length_mismatch"):
        miner._candidate_score(miner.Candidate("c", "a", ["f"], [1.0], directions=[1.0, -1.0]), {"f": ladder}, meta)


def test_row_candidate_carries_recorded_directions_from_csv_string():
    row = {"candidate_id": "x", "algorithm": "pymoo_nsga3_novelty", "factor_ids": ["a", "b"], "weights": [0.5, 0.5],
           "factor_directions": "[-1.0, 1.0]"}
    assert miner._row_candidate(row).directions == [-1.0, 1.0]


def test_resolve_directions_recorded_then_fail_closed_then_explicit_legacy():
    meta = {
        "ml": miner.FactorMeta(id="ml", source="ml106", category="x", direction=-1.0, direction_source="full_window_triage"),
        "s_neg": miner.FactorMeta(id="s_neg", source="strategy95", category="y", direction=-1.0),
        "s_pos": miner.FactorMeta(id="s_pos", source="strategy95", category="y", direction=1.0),
    }
    record = {"id": "r", "factor_ids": ["ml", "s_neg", "s_pos"], "factor_directions": [1.0, 1.0, -1.0]}
    assert miner._resolve_candidate_directions(record, meta) == ([1.0, 1.0, -1.0], "recorded_factor_directions")

    legacy = {"id": "r", "factor_ids": ["ml", "s_neg", "s_pos"]}
    with pytest.raises(RuntimeError, match="factor_directions_missing"):
        miner._resolve_candidate_directions(legacy, meta)
    with pytest.raises(RuntimeError, match="factor_directions_missing"):
        miner._resolve_candidate_directions({**legacy, "factor_directions": ""}, meta)

    # unified_registry_v1 pre-B1: declared factors were flipped twice (net +1); fitted ml106 keep triage.
    directions, source = miner._resolve_candidate_directions(legacy, meta, legacy_direction_mode="as_mined")
    assert (directions, source) == ([-1.0, 1.0, 1.0], "legacy_as_mined_current_meta")

    # canonical114 pre-B1: strategy meta came from triage (recorded), values were pre-oriented by the
    # declared direction -> effective = recorded * declared.
    recorded_meta = {"ml": {"direction": -1.0}, "s_neg": {"direction": 1.0}, "s_pos": {"direction": -1.0}}
    directions, source = miner._resolve_candidate_directions(
        legacy, meta, legacy_direction_mode="as_mined", recorded_factor_meta=recorded_meta,
    )
    assert (directions, source) == ([-1.0, -1.0, -1.0], "legacy_as_mined_recorded_factor_meta")
    with pytest.raises(RuntimeError, match="missing_in_recorded_factor_meta"):
        miner._resolve_candidate_directions(legacy, meta, legacy_direction_mode="as_mined", recorded_factor_meta={"ml": {"direction": 1}})


def test_as_mined_matches_the_canonical114_report_for_0187():
    """l1_monthlyRevenueMoM: declared +1, canonical114 meta -1 -> -1 (same as the spec backtest table)."""
    report = ROOT / "output" / "finlab_alpha_miner_canonical114_mresample" / "alpha_miner_bakeoff_canonical114_pymoo_sii_20230101_20260615_seed42.json"
    if not report.exists():
        pytest.skip("canonical114 report not present")
    recorded = miner._load_recorded_factor_meta(report)
    spec = _load(ROOT / "tools" / "finlab_strategy_spec_backtest.py", "stockvision_replay_dir_spec")
    meta = {
        fid: miner.FactorMeta(
            id=fid, source="x", category="x", direction=1.0,
            direction_source="declared" if fid == "l1_monthlyRevenueMoM" else "full_window_triage",
        )
        for fid in spec.ALPHA_MINER_FACTOR_DIRECTIONS
    }
    for config in spec.ALPHA_MINER_SCORE_SPECS.values():
        row = {"id": config["candidate_id"], "factor_ids": config["factor_ids"]}
        directions, _ = miner._resolve_candidate_directions(row, meta, legacy_direction_mode="as_mined", recorded_factor_meta=recorded)
        assert directions == [spec.ALPHA_MINER_FACTOR_DIRECTIONS[fid] for fid in config["factor_ids"]]


# ------------------------------------------------------------------ replay tools
def _write_confirm_csv(path: Path, *, with_directions: bool) -> Path:
    fields = ["id", "algorithm", "factor_ids", "weights", "combine", "cagr", "max_drawdown", "monthly_sharpe", "calmar", "latest_matches"]
    if with_directions:
        fields.append("factor_directions")
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields)
        writer.writeheader()
        row = {"id": "alpha_miner_pymoo_nsga3_novelty_0001", "algorithm": "pymoo_nsga3_novelty", "factor_ids": "['f']",
               "weights": "[1.0]", "combine": "weighted_sum", "cagr": 0.1, "max_drawdown": -0.1, "monthly_sharpe": 1.0,
               "calmar": 1.0, "latest_matches": 2}
        if with_directions:
            row["factor_directions"] = "[-1.0]"
        writer.writerow(row)
    return path


def _replay_with_stubs(monkeypatch, tmp_path, *, with_directions: bool, **arg_overrides):
    replay = _load(ROOT / "tools" / "pymoo_mined_strategy_replay.py", "stockvision_replay_dir_tool")
    alpha = _load(ROOT / "tools" / "finlab_alpha_miner_bakeoff.py", "stockvision_replay_dir_tool_alpha")
    close, tradable, ladder = _ladder_panel()
    meta = {"f": alpha.FactorMeta(id="f", source="ml106", category="x", direction=1.0, direction_source="full_window_triage")}
    alpha._build_unified_registry_factor_universe = lambda args: (close, tradable, {"f": ladder}, dict(meta), {})
    monkeypatch.setattr(replay, "_load_module", lambda path, name: alpha if str(path).endswith("finlab_alpha_miner_bakeoff.py") else types.SimpleNamespace())
    monkeypatch.setattr(replay, "_build_current_strategy_positions", lambda **kwargs: (close.index[-1], {}, {}))
    args = argparse.Namespace(
        confirm_csv=str(_write_confirm_csv(tmp_path / "confirm.csv", with_directions=with_directions)),
        candidate_id=["alpha_miner_pymoo_nsga3_novelty_0001"], factor_json="", feature_registry="",
        factor_start_date=str(close.index[0].date()), run_date=str(close.index[-1].date()), universe="sii",
        max_symbols=0, top_k=2, legacy_direction_mode="fail_closed", legacy_mined_report="",
    )
    for key, value in arg_overrides.items():
        setattr(args, key, value)
    return replay.run(args), close


def test_mined_strategy_replay_uses_recorded_directions(monkeypatch, tmp_path):
    report, close = _replay_with_stubs(monkeypatch, tmp_path, with_directions=True)
    detail = report["mined_strategy_replay"]["selection"]["alpha_miner_pymoo_nsga3_novelty_0001"]
    assert detail["direction_source"] == "recorded_factor_directions"
    assert detail["factor_directions"] == [-1.0]
    assert set(detail["symbols"]) == set(close.columns[:2])  # lowest ladder values


def test_mined_strategy_replay_fails_closed_on_legacy_rows(monkeypatch, tmp_path):
    with pytest.raises(RuntimeError, match="factor_directions_missing"):
        _replay_with_stubs(monkeypatch, tmp_path, with_directions=False)
    report, close = _replay_with_stubs(monkeypatch, tmp_path, with_directions=False, legacy_direction_mode="as_mined")
    detail = report["mined_strategy_replay"]["selection"]["alpha_miner_pymoo_nsga3_novelty_0001"]
    assert detail["direction_source"] == "legacy_as_mined_current_meta"
    assert set(detail["symbols"]) == set(close.columns[-2:])


def test_l0_l4_dry_run_compare_reads_and_requires_directions(tmp_path):
    dry = _load(ROOT / "tools" / "pymoo_l0_l4_dry_run_compare.py", "stockvision_replay_dir_dry")
    rows = dry._load_confirm_candidates(_write_confirm_csv(tmp_path / "c.csv", with_directions=True), ["alpha_miner_pymoo_nsga3_novelty_0001"])
    assert rows[0]["factor_directions"] == "[-1.0]"
    meta = {"f": miner.FactorMeta(id="f", source="ml106", category="x", direction=1.0, direction_source="full_window_triage")}
    args = argparse.Namespace(legacy_direction_mode="fail_closed", legacy_mined_report="")
    assert dry._resolve_directions(miner, rows[0], meta, args, None) == ([-1.0], "recorded_factor_directions")
    legacy = dry._load_confirm_candidates(_write_confirm_csv(tmp_path / "l.csv", with_directions=False), ["alpha_miner_pymoo_nsga3_novelty_0001"])
    with pytest.raises(RuntimeError, match="factor_directions_missing"):
        dry._resolve_directions(miner, legacy[0], meta, args, None)


# ------------------------------------------------------------------ alpha223 / active12
alpha223 = _load(ROOT / "tools" / "finlab_alpha223_recursive_search.py", "stockvision_replay_dir_alpha223")


def test_alpha223_rank_score_ignores_the_holdout():
    row = {"validation_excess": {"excess_sharpe": 1.0}, "train_excess": {"excess_sharpe": 0.5},
           "selection": {"cagr": 0.2, "max_drawdown": -0.1}, "novelty": 0.5, "turnover": 0.1}
    peeked = {**row, "holdout": {"sharpe": 9.0}, "full": {"cagr": 9.0, "sharpe": 9.0}}
    assert alpha223._rank_score(row) == alpha223._rank_score(peeked)


def test_alpha223_position_for_row_fails_closed_without_directions():
    close, tradable, ladder = _ladder_panel()
    meta = {"f": alpha223.miner.FactorMeta(id="f", source="ml106", category="x", direction=1.0, direction_source="full_window_triage")}
    args = argparse.Namespace(start_date=str(close.index[0].date()), end_date=str(close.index[-1].date()), top_k=2, resample="D")
    row = {"candidate_id": "x", "factor_ids": ["f"], "weights": [1.0]}
    with pytest.raises(RuntimeError, match="factor_directions_missing"):
        alpha223._position_for_row(row, values={"f": ladder}, meta=meta, close=close, tradable=tradable, args=args)
    pos = alpha223._position_for_row({**row, "factor_directions": [-1.0]}, values={"f": ladder}, meta=meta, close=close, tradable=tradable, args=args)
    assert set(pos.columns[pos.iloc[-1].to_numpy(dtype=bool)]) == set(close.columns[:2])


def test_alpha223_finlab86_triage_overlap_blocks_promotion():
    args = argparse.Namespace(finlab86_triage_end="2026-06-15")
    assert alpha223._finlab86_triage_blocking_gate(args, {"train_end": "2025-12-31"}, 5) == "finlab86_triage_window_overlaps_evaluation"
    assert alpha223._finlab86_triage_blocking_gate(args, {"train_end": "2026-07-31"}, 5) is None
    assert alpha223._finlab86_triage_blocking_gate(args, {"train_end": "2025-12-31"}, 0) is None


def _synthetic_alpha223(monkeypatch, tmp_path):
    rng = np.random.default_rng(11)
    n_days, n_stocks = 340, 24
    idx = pd.bdate_range("2024-01-01", periods=n_days)
    cols = [f"{1100 + i}" for i in range(n_stocks)]
    signal = pd.DataFrame(rng.normal(size=(n_days, n_stocks)), index=idx, columns=cols)
    ret = 0.002 * signal.shift(1).fillna(0.0).to_numpy() + rng.normal(scale=0.01, size=(n_days, n_stocks))
    close = pd.DataFrame(100.0 * np.cumprod(1.0 + ret, axis=0), index=idx, columns=cols)
    values = {f"noise_{k}": pd.DataFrame(rng.normal(size=(n_days, n_stocks)), index=idx, columns=cols) for k in range(3)}
    meta = {fid: alpha223.miner.FactorMeta(id=fid, source="synthetic", category=f"c_{fid}", direction=1.0) for fid in values}
    monkeypatch.setattr(
        alpha223.miner, "_build_unified_registry_factor_universe",
        lambda args: (close.copy(), close.notna(), {k: v.copy() for k, v in values.items()}, dict(meta), {}),
    )
    # FinLab86 field: predictive signal, triage said "low" (direction -1) on its full window.
    monkeypatch.setattr(alpha223.augment, "_materialize_field", lambda row, **kwargs: (-signal.copy(), {"api_key": row["api_key"]}))
    monkeypatch.setattr(alpha223.compare, "_build_positions", lambda ns, tech: ({}, {}, None, []))
    monkeypatch.setattr(alpha223.compare, "_load_module", lambda path, name: types.SimpleNamespace())
    finlab86_csv = tmp_path / "finlab86.csv"
    finlab86_csv.write_text("api_key,direction_mode,dataset_lane\nfundamental:x,low,fundamental\n", encoding="utf-8")
    argv = [
        "--end-date", str(idx[-1].date()), "--start-date", str(idx[0].date()), "--finlab86-csv", str(finlab86_csv),
        "--similarity-pairs", str(SIMILARITY_PAIRS), "--similarity-contract", str(SIMILARITY_CONTRACT),
        "--top-k", "5", "--min-factors", "1", "--max-factors", "2", "--pymoo-population", "8", "--pymoo-generations", "2",
        "--finlab-confirm-top-n", "2", "--output-dir", str(tmp_path / "out"),
    ]
    args = alpha223.build_arg_parser().parse_args(argv)
    args.disable_monthly_mining_config = True
    args.research_protocol_override = {
        "train_sessions": 150, "validation_sessions": 80, "holdout_sessions": 60,
        "purge_sessions": 5, "embargo_sessions": 2, "holdout_not_before": None,
        "min_holdout_sessions_for_gate": 40, "direction_ic_horizon_sessions": 5,
        "feature_triage_window": {"start": "2023-01-01", "end": "2023-12-31"},
        "selection_gate": {
            "min_validation_excess_sharpe": -99.0, "min_train_excess_sharpe": -99.0,
            "min_deflated_sharpe_probability": 0.0, "max_selection_drawdown": 9.0,
            "max_turnover": 9.0, "regime_min_observations": 10_000,
        },
    }
    return args, idx


def test_alpha223_search_runs_on_the_sealed_holdout_protocol(monkeypatch, tmp_path):
    args, idx = _synthetic_alpha223(monkeypatch, tmp_path)
    args.finlab86_triage_end = str(idx[0].date())  # triage strictly before train_end -> not blocking
    confirmed: list[str] = []

    def fake_confirm(finalists, ctx):
        confirmed.extend(row["candidate_id"] for row in finalists)
        for row in finalists:
            row["finlab_confirm_gate"] = {"status": "pass", "reasons": []}
        return []

    monkeypatch.setattr(alpha223.miner, "_finlab_confirm", fake_confirm)
    report = alpha223.run(args)
    rows = [row for row in report["rows"] if row.get("status") == "ok"]
    assert rows and all(row["fitness_contract"] == "selection_sample_excess_v3_holdout_sealed" for row in rows)
    assert all(len(row["factor_directions"]) == len(row["factor_ids"]) for row in rows)
    assert report["blocking_gates"] == []
    assert set(confirmed) == set(report["gate_finalists"])
    assert all("holdout" not in row for row in report["rows"] if row["candidate_id"] not in set(report["gate_finalists"]))
    # The FinLab86 direction was re-fitted on the train window (-signal is negatively related -> -1).
    finlab_id = report["universe"]["finlab86"]["features"][0]["feature_id"]
    assert report["factor_universe"]["factor_meta"][finlab_id]["direction_source"] == "train_window_rank_ic"
    assert report["factor_universe"]["factor_meta"][finlab_id]["direction"] == -1.0
    json.dumps(report, default=alpha223._json_default)


def test_alpha223_blocks_when_finlab86_triage_overlaps(monkeypatch, tmp_path):
    args, _idx = _synthetic_alpha223(monkeypatch, tmp_path)
    monkeypatch.setattr(alpha223.miner, "_finlab_confirm", lambda finalists, ctx: pytest.fail("holdout opened"))
    report = alpha223.run(args)
    assert "finlab86_triage_window_overlaps_evaluation" in report["blocking_gates"]
    assert report["holdout_seal"]["status"] == "withheld_blocked"


def test_active12_pairwise_returns_use_the_miner_cost_model():
    active12 = _load(ROOT / "tools" / "active12_portfolio_scenario_compare.py", "stockvision_replay_dir_active12")
    idx = pd.bdate_range("2026-01-01", periods=10)
    close = pd.DataFrame({"A": [100, 103, 101, 104, 102, 106, 103, 107, 105, 108],
                          "B": [100, 101, 99, 102, 100, 103, 101, 104, 102, 105]}, index=idx, dtype=float)
    positions = {
        "s1": pd.DataFrame({"A": True, "B": False}, index=idx),
        "s2": pd.DataFrame({"A": False, "B": True}, index=idx),
    }
    miner = active12.robust.alpha223.miner
    calls = []
    real = miner._portfolio_returns

    def spy(position, close_arg, **kwargs):
        calls.append(kwargs)
        return real(position, close_arg, **kwargs)

    miner._portfolio_returns = spy
    try:
        rows = active12._pairwise_rows(["s1", "s2"], positions, close)
    finally:
        miner._portfolio_returns = real
    assert len(rows) == 1
    # Both books are priced by the miner's TW cost model (defaults), never a flat fee_tax_cost.
    assert calls == [{}, {}]
    expected_a = real(positions["s1"], close)
    expected_b = real(positions["s2"], close)
    joined = pd.concat([expected_a, expected_b], axis=1).dropna()
    expected_corr = joined.iloc[:, 0].corr(joined.iloc[:, 1])
    assert rows[0]["return_corr"] == pytest.approx(expected_corr) or (
        rows[0]["return_corr"] is None and not np.isfinite(expected_corr)
    )
