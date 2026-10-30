import numpy as np
import pytest
import polars as pl

from services.r33_calibration_job import fit_calibration, load_l2_pool, pool_score_table
from services.r33_isotonic_calibration import MODELS, validate_payload
from services import r33_oof_checks
from services.r33_oof_checks import entry_limit_up_rows, run_checks

DATES = [f"2026-{m:02d}-{d:02d}" for m in (7, 8) for d in range(1, 29)][:48]
SYMBOLS = [str(1000 + i) for i in range(30)]
COST = 0.00585  # trading:config.fees round trip at the 10/30 schedule


def _oof(sign=1.0, seed=3):
    rng = np.random.default_rng(seed)
    rows = []
    for i, day in enumerate(DATES[:-5]):
        target = rng.normal(0, 0.03, len(SYMBOLS))
        for model in (*MODELS, "XGBoost"):
            noise = rng.normal(0, 0.03, len(SYMBOLS))
            for j, symbol in enumerate(SYMBOLS):
                rows.append(dict(prediction_date=day, symbol=symbol, market_segment="LISTED", model_name=model,
                                 raw_score=float(sign * target[j] + noise[j]), target_return=float(target[j]),
                                 label_known_date=DATES[i + 5], fold_id=f"w{i // 11}", entry_limit_up=False))
    return pl.DataFrame(rows)


def _receipts(oof, leak=None):
    out = []
    for fold, group in oof.group_by("fold_id"):
        start = group["prediction_date"].min()
        out.append(dict(fold_id=fold[0], test_start=start,
                        train_label_known_max=start if fold[0] == leak else "2026-01-01"))
    return out


def test_informative_scores_pass_and_inverted_scores_fail():
    oof = _oof()
    report = run_checks(oof=oof, fold_receipts=_receipts(oof), pool_by_date=None, new_fold_from=DATES[30], round_trip_cost=COST)
    assert report["status"] == "pass", report["checks"]
    assert report["scope"]["horizon_sessions"] == 5 and report["new_folds_report"]["days"] > 0
    inverted = _oof(sign=-1.0)
    report = run_checks(oof=inverted, fold_receipts=_receipts(inverted), pool_by_date=None, new_fold_from=None, round_trip_cost=COST)
    assert report["status"] == "fail" and not report["checks"]["inversion"]["passed"]
    assert report["checks"]["tail_guard"]["hard_failures"] == ["PatchTST", "TabM"]


def test_fold_whose_training_labels_reach_its_test_start_fails_leakage():
    oof = _oof()
    report = run_checks(oof=oof, fold_receipts=_receipts(oof, leak="w1"), pool_by_date=None, new_fold_from=None, round_trip_cost=COST)
    leakage = report["checks"]["leakage"]
    assert report["status"] == "fail" and leakage["leaking_folds"] == ["w1"]
    assert leakage["ancestor_influenced_rows"] == oof.filter(pl.col("fold_id") == "w1").height
    missing = [r for r in _receipts(oof) if r["fold_id"] != "w0"]
    assert run_checks(oof=oof, fold_receipts=missing, pool_by_date=None, new_fold_from=None, round_trip_cost=COST)["checks"]["leakage"]["unattested_folds"] == ["w0"]


def test_limit_up_entry_rows_keep_rank_but_leave_fit_and_baseline():
    oof = _oof().with_columns(
        pl.when((pl.col("symbol") == "1000") & (pl.col("prediction_date") == DATES[0]))
        .then(pl.lit(True)).otherwise(pl.col("entry_limit_up")).alias("entry_limit_up"))
    table = pool_score_table(oof, None)
    row = np.flatnonzero((table["dates"] == DATES[0]) & (table["symbols"] == "1000"))[0]
    assert np.isfinite(table["score"][row]) and np.isnan(table["excess"][row])
    assert row not in table["day_rows"][DATES[0]] and table["entry_limit_up_rows"] == 1


def test_pool_restricts_rank_domain_and_excludes_xgboost():
    oof = _oof()
    pool = {d: set(SYMBOLS[:10]) for d in DATES}
    table = pool_score_table(oof, pool)
    assert set(table["symbols"]) == set(SYMBOLS[:10]) and len(table["day_rows"][DATES[0]]) == 10
    payload = fit_calibration(oof=oof, pool_by_date=pool, round_trip_cost=0.00585, inputs={"oof": "fixture"})
    assert validate_payload(payload)["model_order"] == list(MODELS)
    assert payload["inputs"]["round_trip_cost"] == 0.00585


def test_entry_limit_up_uses_next_traded_session_open():
    prices = pl.DataFrame(dict(symbol=["1", "1", "1", "2", "2"], date=["d1", "d2", "d3", "d1", "d2"],
                               open=[10.0, 11.0, 10.5, 50.0, 52.0], close=[10.0, 10.8, 10.4, 50.0, 51.0]))
    assert entry_limit_up_rows(prices).rows() == [("d1", "1")]


def test_l2_pool_keeps_only_the_latest_run_each_day():
    rows = [dict(date="d1", run_id="a", symbol="1", decision="observe", created_at="t1"),
            dict(date="d1", run_id="b", symbol="2", decision="observe", created_at="t2"),
            dict(date="d2", run_id="c", symbol="3", decision="selected", created_at="t3")]
    pool, receipt = load_l2_pool(lambda sql, params: rows, start="d1", end="d2")
    assert pool == {"d1": {"2"}, "d2": {"3"}}
    assert receipt["multi_run_days"] == ["d1"] and receipt["rows"] == 2 and len(receipt["membership_sha256"]) == 64


def _weak(oof):
    """Same ordering, a fifth of the payoff: cross-fitted expected excess tops out near 1.1%."""
    return oof.with_columns(pl.col("target_return") * 0.2)


def _force_picks(monkeypatch, choose):
    """Keep the real top-block edge; the cost-line set is whatever choose(day, excess) marks."""
    real = r33_oof_checks.crossfit_expected_excess

    def crossfit(table):
        predicted, top_edge = real(table)
        forced = np.full(len(predicted), np.nan)
        for i, (day, rows) in enumerate(sorted(table["day_rows"].items())):
            forced[rows[choose(i, table["excess"][rows])]] = 1.0
        return forced, top_edge
    monkeypatch.setattr(r33_oof_checks, "crossfit_expected_excess", crossfit)


def test_cost_line_gates_on_names_whose_crossfit_expected_excess_clears_the_cost():
    oof = _weak(_oof())
    passing = run_checks(oof=oof, fold_receipts=_receipts(oof), pool_by_date=None, new_fold_from=None, round_trip_cost=0.011)
    inv = passing["checks"]["inversion"]
    assert passing["status"] == "pass" and inv["gates"] == dict(daily_ic=True, isotonic_top=True, crossfit_above_cost=True)
    assert inv["crossfit_above_cost"]["round_trip_cost"] == 0.011 and inv["crossfit_above_cost"]["n"] > 1
    # Same scores, a cost no held-out name is expected to clear: IC, isotonic top and the top five
    # are all still positive, and admission fails on the cost line alone.
    failing = run_checks(oof=oof, fold_receipts=_receipts(oof), pool_by_date=None, new_fold_from=None, round_trip_cost=0.012)
    inv = failing["checks"]["inversion"]
    assert failing["status"] == "fail" and inv["passed"] is False
    assert inv["gates"] == dict(daily_ic=True, isotonic_top=True, crossfit_above_cost=False)
    assert inv["crossfit_above_cost"]["days_with_picks"] == 0 and inv["crossfit_above_cost"]["mean"] is None
    assert inv["top_k"]["k"] == 5 and inv["top_k"]["diagnostic_only"] is True
    assert inv["top_k"]["mean"] - inv["top_k"]["se"] > 0


def test_cost_line_needs_mean_minus_se_above_zero(monkeypatch):
    # Day 0 takes its best name, day 1 the mildest loser: mean > 0 but mean - SE = the loser < 0.
    def choose(i, excess):
        if i == 0:
            return [int(np.argmax(excess))]
        if i == 1:
            losers = np.flatnonzero(excess < 0)
            return [int(losers[np.argmax(excess[losers])])]
        return []
    _force_picks(monkeypatch, choose)
    oof = _oof()
    report = run_checks(oof=oof, fold_receipts=_receipts(oof), pool_by_date=None, new_fold_from=None, round_trip_cost=COST)
    above = report["checks"]["inversion"]["crossfit_above_cost"]
    assert above["n"] == 2 and above["mean"] > 0 and above["mean"] - above["se"] < 0
    assert report["checks"]["inversion"]["gates"]["crossfit_above_cost"] is False and report["status"] == "fail"


def test_cost_line_with_a_single_pick_day_fails_closed(monkeypatch):
    # One day with a strong pick has no SE: mean > 0 is not enough.
    _force_picks(monkeypatch, lambda i, excess: [int(np.argmax(excess))] if i == 0 else [])
    oof = _oof()
    report = run_checks(oof=oof, fold_receipts=_receipts(oof), pool_by_date=None, new_fold_from=None, round_trip_cost=COST)
    above = report["checks"]["inversion"]["crossfit_above_cost"]
    assert above["n"] == 1 and above["mean"] > 0 and above["se"] is None
    assert report["checks"]["inversion"]["gates"]["crossfit_above_cost"] is False and report["status"] == "fail"


def test_net_of_cost_is_reported_but_never_gates(monkeypatch):
    # Every day picks its names realizing between 0.05% and 0.3%: positive, but below the 0.585% cost.
    _force_picks(monkeypatch, lambda i, excess: np.flatnonzero((excess > 0.0005) & (excess < 0.003)))
    oof = _weak(_oof())
    report = run_checks(oof=oof, fold_receipts=_receipts(oof), pool_by_date=None, new_fold_from=None, round_trip_cost=COST)
    inv = report["checks"]["inversion"]
    above, net = inv["crossfit_above_cost"], inv["net_of_cost"]
    assert above["mean"] - above["se"] > 0 and net["gate"] is False
    assert net["mean"] == pytest.approx(above["mean"] - COST) and net["se"] == pytest.approx(above["se"])
    assert net["mean"] - net["se"] < 0
    assert report["status"] == "pass" and set(inv["gates"]) == {"daily_ic", "isotonic_top", "crossfit_above_cost"}
