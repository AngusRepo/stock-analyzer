import numpy as np
import polars as pl

from services.r33_calibration_job import fit_calibration, load_l2_pool, pool_score_table
from services.r33_isotonic_calibration import MODELS, validate_payload
from services.pit_certification import load_contract
from services.r33_oof_checks import entry_limit_up_rows, run_checks
from pit_certification_fixture import certified, pending

DATES = [f"2026-{m:02d}-{d:02d}" for m in (7, 8) for d in range(1, 29)][:48]
SYMBOLS = [str(1000 + i) for i in range(30)]


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
    attached, contract = certified()
    report = run_checks(oof=oof, fold_receipts=_receipts(oof), pool_by_date=None, new_fold_from=DATES[30],
                        pit_certification=attached, pit_contract=contract)
    assert report["status"] == "pass", report["checks"]
    assert report["checks"]["pit_vintage"]["receipt_sha256"] == attached["receipt_sha256"]
    assert report["scope"]["horizon_sessions"] == 5 and report["new_folds_report"]["days"] > 0
    inverted = _oof(sign=-1.0)
    report = run_checks(oof=inverted, fold_receipts=_receipts(inverted), pool_by_date=None, new_fold_from=None)
    assert report["status"] == "fail" and not report["checks"]["inversion"]["passed"]
    assert report["checks"]["tail_guard"]["hard_failures"] == ["PatchTST", "TabM"]


def test_pit_vintage_fails_closed_without_a_certified_receipt():
    oof = _oof()
    report = run_checks(oof=oof, fold_receipts=_receipts(oof), pool_by_date=None, new_fold_from=None)
    assert report["status"] == "fail" and report["checks"]["pit_vintage"]["reasons"] == ["receipt_missing"]
    assert all(report["checks"][name]["passed"] for name in ("leakage", "inversion", "tail_guard"))
    unapproved, contract = certified(contract=pending(load_contract()))
    report = run_checks(oof=oof, fold_receipts=_receipts(oof), pool_by_date=None, new_fold_from=None,
                        pit_certification=unapproved, pit_contract=contract)
    assert report["status"] == "fail" and report["checks"]["pit_vintage"]["reasons"] == ["contract_not_approved"]
    # A certified receipt that does not bind to this capture/prep fails the same check.
    attached, approved = certified()
    report = run_checks(oof=oof, fold_receipts=_receipts(oof), pool_by_date=None, new_fold_from=None,
                        pit_certification=attached, pit_contract=approved,
                        pit_binding_reasons=["prep_not_built_under_contract:adj"])
    pit = report["checks"]["pit_vintage"]
    assert report["status"] == "fail" and pit["passed"] is False and pit["certified"] is False
    assert pit["reasons"] == ["prep_not_built_under_contract:adj"]


def test_fold_whose_training_labels_reach_its_test_start_fails_leakage():
    oof = _oof()
    report = run_checks(oof=oof, fold_receipts=_receipts(oof, leak="w1"), pool_by_date=None, new_fold_from=None)
    leakage = report["checks"]["leakage"]
    assert report["status"] == "fail" and leakage["leaking_folds"] == ["w1"]
    assert leakage["ancestor_influenced_rows"] == oof.filter(pl.col("fold_id") == "w1").height
    missing = [r for r in _receipts(oof) if r["fold_id"] != "w0"]
    assert run_checks(oof=oof, fold_receipts=missing, pool_by_date=None, new_fold_from=None)["checks"]["leakage"]["unattested_folds"] == ["w0"]


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
