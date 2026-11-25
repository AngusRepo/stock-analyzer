"""Job-side regressions for the 2026-11-24 strategy-mining audit (B3/B4/B9 + run error classes)."""
from __future__ import annotations

import argparse
import json
import os
import signal
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import strategy_mining_job_main as job


def _stub_job(monkeypatch, tmp_path, run):
    calls: list[tuple[str, object]] = []
    monkeypatch.setenv("STRATEGY_MINING_OUTPUT_DIR", str(tmp_path))
    monkeypatch.delenv("GCS_BUCKET_NAME", raising=False)
    monkeypatch.setattr(job, "_assert_runtime_files", lambda: None)
    monkeypatch.setattr(job, "_login_finlab", lambda: None)
    monkeypatch.setattr(job, "_load_alpha_miner", lambda: SimpleNamespace(run=run))
    monkeypatch.setattr(job, "_build_args", lambda *a, **k: SimpleNamespace(pbo_folds=8))
    monkeypatch.setattr(job, "_insert_run", lambda run_id, *a: calls.append(("insert", run_id)) or {"started_at": "t"})
    monkeypatch.setattr(job, "_mark_search_started", lambda run_id, started: calls.append(("search", run_id)) or {**started, "search_started_at": "s"})
    monkeypatch.setattr(job, "_update_run", lambda run_id, **k: calls.append(("update", (run_id, k["status"], k["telemetry"], k.get("started")))))
    monkeypatch.setattr(job, "_callback_worker_scheduler", lambda payload: calls.append(("callback", payload["status"])))
    monkeypatch.setattr(job, "_prior_multiple_testing_runs", lambda **k: [])
    return calls


def test_cloud_run_task_retry_reuses_the_execution_run_id(monkeypatch, tmp_path):
    monkeypatch.delenv("STRATEGY_MINING_RUN_ID", raising=False)
    monkeypatch.setenv("STRATEGY_MINING_RUN_DATE", "2026-12-05")
    monkeypatch.setenv("CLOUD_RUN_EXECUTION", "strategy-mining-job-abc12")
    monkeypatch.setenv("STRATEGY_MINING_BACKEND", "cloud_run")
    calls = _stub_job(monkeypatch, tmp_path, run=lambda args: (_ for _ in ()).throw(RuntimeError("boom")))
    assert job._run_strategy_mining() == 1
    first = calls[0][1]
    monkeypatch.delenv("STRATEGY_MINING_RUN_ID", raising=False)
    calls.clear()
    assert job._run_strategy_mining() == 1
    assert calls[0][1] == first == "strategy-mining-2026-12-05-strategy-mining-job-abc12"


def test_sigterm_during_compute_marks_the_run_error(monkeypatch, tmp_path):
    monkeypatch.setenv("STRATEGY_MINING_RUN_ID", "sigterm-run")
    monkeypatch.setenv("STRATEGY_MINING_BACKEND", "cloud_run")

    def run(args):
        os.kill(os.getpid(), signal.SIGTERM)
        raise AssertionError("SIGTERM handler did not interrupt compute")

    calls = _stub_job(monkeypatch, tmp_path, run=run)
    before = signal.getsignal(signal.SIGTERM)
    assert job._run_strategy_mining() == 1
    update = [item for kind, item in calls if kind == "update"][0]
    assert update[1] == "error"
    assert update[2]["error_type"] == "StrategyMiningTerminated"
    assert signal.getsignal(signal.SIGTERM) == before


def test_non_modal_backend_checks_gcs_credentials_before_compute(monkeypatch, tmp_path):
    monkeypatch.setenv("STRATEGY_MINING_RUN_ID", "cred-run")
    monkeypatch.setenv("STRATEGY_MINING_BACKEND", "cloud_run")
    computed = []
    calls = _stub_job(monkeypatch, tmp_path, run=lambda args: computed.append(1))
    monkeypatch.setenv("GCS_BUCKET_NAME", "bucket")

    def denied():
        raise RuntimeError("DefaultCredentialsError: not found")

    monkeypatch.setattr(job, "_gcs_credentials_preflight", denied)
    assert job._run_strategy_mining() == 1
    assert computed == []
    assert [item for kind, item in calls if kind == "update"][0][1] == "error"


def test_prior_ledger_failure_blocks_promotion_instead_of_undercounting(monkeypatch, tmp_path):
    monkeypatch.setenv("STRATEGY_MINING_RUN_ID", "ledger-run")
    monkeypatch.setenv("STRATEGY_MINING_BACKEND", "cloud_run")
    seen = {}

    def run(args):
        seen["prior"] = args.prior_multiple_testing_runs
        seen["pre_holdout"] = args.pre_holdout_blocking_gates
        return {"rows": [], "blocking_gates": [], "multiple_testing": {}, "research_protocol": {}}

    _stub_job(monkeypatch, tmp_path, run=run)

    def unavailable(**kwargs):
        raise RuntimeError("d1 down")

    monkeypatch.setattr(job, "_prior_multiple_testing_runs", unavailable)
    captured = {}
    monkeypatch.setattr(job, "build_strategy_mining_evidence", lambda rows, **k: captured.update(k) or {"status": "pending"})
    monkeypatch.setattr(job, "_write_artifacts", lambda *a: {"gcs": {"json": "gs://x/y.json"}})
    monkeypatch.setattr(job, "_persist_ledger", lambda *a: {})
    assert job._run_strategy_mining() == 0
    assert seen["prior"] == []
    assert "multiple_testing_prior_ledger_unavailable" in captured["blocking_gates"]
    assert seen["pre_holdout"] == ["multiple_testing_prior_ledger_unavailable"]


def test_prior_ledger_reads_new_and_legacy_runs(monkeypatch):
    legacy_config = {"train_start": "2023-01-01", "holdout_start": "2026-01-01", "holdout_end": "2026-11-07"}
    new_ledger = {"selection_start": "2023-11-01", "selection_end": "2026-09-30", "holdout_start": "2026-11-09",
                  "holdout_end": "2027-03-05", "search_trials_raw": 600, "search_trials_effective": 41.5,
                  "holdout_family_size": 3}
    rows = [
        {"run_id": "legacy", "config_json": json.dumps(legacy_config),
         "telemetry_json": json.dumps({"adaptive_strategy_families": {"evaluated_count": 542}})},
        {"run_id": "new", "config_json": "{}", "telemetry_json": json.dumps({"multiple_testing_ledger": new_ledger})},
    ]
    monkeypatch.setattr(job.d1_client, "query", lambda sql, params, **k: rows)
    rows.append({"run_id": "error-with-ledger", "status": "error", "config_json": "{}",
                 "telemetry_json": json.dumps({"multiple_testing_ledger": new_ledger})})
    rows.append({"run_id": "unknown-legacy", "status": "completed", "config_json": "{}", "telemetry_json": "{}"})
    for row in rows[:2]:
        row["status"] = "completed"
    out = job._prior_multiple_testing_runs(current_run_id="current")
    legacy, new, errored, unknown = out
    assert errored["run_id"] == "error-with-ledger" and errored["holdout_family_size"] == 3
    assert unknown == {"run_id": "unknown-legacy", "incomplete": True}
    assert legacy["search_trials_raw"] == 542 and legacy["selection_end"] == "2026-11-07"
    assert legacy["holdout_family_size"] == 542 and legacy["legacy"] is True
    assert new["search_trials_effective"] == 41.5 and new["holdout_family_size"] == 3


def test_build_args_derives_seed_and_rolling_history_from_run_date(monkeypatch, tmp_path):
    for name in ["STRATEGY_MINING_SEED", "STRATEGY_MINING_START_DATE", "STRATEGY_MINING_END_DATE",
                 "STRATEGY_MINING_TRAIN_START", "STRATEGY_MINING_HOLDOUT_START", "STRATEGY_MINING_WINDOW_MODE"]:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(job, "_load_previous_completed_telemetry", lambda: None)
    alpha = job._load_alpha_miner()
    args = job._build_args(alpha, run_date="2026-12-05", output_dir=tmp_path)
    assert args.seed == alpha._seed_from_date("2026-12-05") and args.seed != 42
    assert args.start_date < "2022-08-01" and args.end_date == "2026-12-05"
    assert args.train_start is None and args.holdout_start is None
    assert args.research_protocol_override == {"window_mode": "rolling"}
    assert not hasattr(args, "fee_tax_cost")
    assert not any(key.startswith("promote_min_") for key in vars(args))


def test_runtime_files_include_strategy_leaf_contract():
    source = Path(job.__file__).read_text(encoding="utf-8")
    required = source.split("def _assert_runtime_files", 1)[1].split("missing =", 1)[0]
    assert "STRATEGY_FEATURE_REF_CONTRACT" in required
    assert job.STRATEGY_FEATURE_REF_CONTRACT.exists()


def test_oversized_d1_parameter_fails_before_any_write(monkeypatch):
    writes = []
    monkeypatch.setattr(job.d1_client, "batch_execute", lambda statements, **k: writes.append(statements))
    report = {"rows": [{"candidate_id": "c1", "status": "ok", "fitness": 1.0, "factor_ids": ["a"],
                        "weights": [1.0], "selection": {"blob": "x" * 400_000}}]}
    with pytest.raises(RuntimeError, match="d1_param_too_large"):
        job._persist_candidates("run", report)
    assert writes == []


def test_completion_telemetry_keeps_the_multiple_testing_ledger():
    telemetry = {
        "artifact_paths": {"gcs": {"json": "gs://x/report.json"}},
        "multiple_testing_ledger": {"selection_start": "2023-11-01", "selection_end": "2026-09-30",
                                    "search_trials_raw": 600, "search_trials_effective": 41.5,
                                    "holdout_family_size": 3, "prior_runs_counted": [{"run_id": "a", "effective_trials": 3.0}]},
        "holdout_seal": {"status": "evaluated", "family_size": 3, "finalists": ["a", "b", "c"]},
        "blocking_gates": ["feature_triage_window_overlaps_evaluation"],
    }
    out = job._compact_completion_telemetry(telemetry)
    assert out["multiple_testing_ledger"]["search_trials_effective"] == 41.5
    assert out["multiple_testing_ledger"]["prior_runs_counted"][0]["run_id"] == "a"
    assert out["holdout_seal"]["family_size"] == 3
    assert out["blocking_gates"] == ["feature_triage_window_overlaps_evaluation"]


def test_retry_overwrites_an_existing_backtest_row_instead_of_duplicating_it(monkeypatch):
    writes = []
    monkeypatch.setattr(job.d1_client, "query", lambda sql, params, **k: [{"candidate_id": "run__c1"}])
    monkeypatch.setattr(job.d1_client, "batch_execute", lambda statements, **k: writes.append(statements))
    report = {"rows": [{"candidate_id": "c1", "factor_ids": ["a"]}],
              "finlab_confirm": [{"id": "alpha_miner_c1", "monthly_sharpe": 1.3}]}
    out = job._persist_backtests("run", report)
    assert out["inserted"] == 0 and out["updated"] == 1
    ((sql, params),) = writes[0]
    # Candidate ids are positional, so the earlier attempt's row is rewritten with this attempt's values.
    assert sql.strip().startswith("UPDATE strategy_backtest_results") and "INSERT" not in sql
    assert params[-2:] == ["run__c1", "run"] and 1.3 in params


def test_retry_after_partial_backtest_write_fills_only_missing_rows(monkeypatch):
    seen = {}
    writes = []

    def query(sql, params, **k):
        seen["sql"], seen["params"] = sql, params
        return [{"candidate_id": "run__c1"}]

    monkeypatch.setattr(job.d1_client, "query", query)
    monkeypatch.setattr(job.d1_client, "batch_execute", lambda statements, **k: writes.append(statements))
    report = {"rows": [{"candidate_id": "c1", "factor_ids": ["a"]}, {"candidate_id": "c2", "factor_ids": ["b"]}],
              "finlab_confirm": [{"id": "alpha_miner_c1", "monthly_sharpe": 1.0},
                                 {"id": "alpha_miner_c2", "monthly_sharpe": 0.8}]}
    out = job._persist_backtests("run", report)
    assert out["inserted"] == 1 and out["updated"] == 1
    kinds = [(sql.strip().split()[0], params) for sql, params in writes[0]]
    assert kinds[0][0] == "UPDATE" and kinds[0][1][-2:] == ["run__c1", "run"]
    assert kinds[1][0] == "INSERT" and kinds[1][1][0] == "run__c2"
    # Indexed lookup by candidate_id (idx_strategy_backtest_results_candidate), not a run_id scan.
    assert "candidate_id IN (?, ?)" in seen["sql"] and seen["params"] == ["run__c1", "run__c2", "run"]


def test_task_retry_keeps_the_previous_attempt_ledger(monkeypatch, tmp_path):
    first_ledger = {"selection_start": "2023-11-01", "selection_end": "2026-09-30", "holdout_start": "2026-11-09",
                    "holdout_end": "2027-03-05", "search_trials_raw": 600, "search_trials_effective": 40.0,
                    "holdout_family_size": 5}
    stored = {"telemetry_json": json.dumps({"failed_at": "x", "multiple_testing_ledger": first_ledger})}
    executed = []

    def query(sql, params, **k):
        assert "WHERE run_id = ?" in sql and params == ["run"]
        return [{"status": "error", "telemetry_json": stored["telemetry_json"]}]

    def execute(sql, params, **k):
        executed.append((sql, params))
        if "INSERT OR REPLACE INTO strategy_mining_runs" in sql:
            stored["telemetry_json"] = params[9]
        elif "UPDATE strategy_mining_runs" in sql:
            stored["telemetry_json"] = params[1]

    monkeypatch.setattr(job.d1_client, "query", query)
    monkeypatch.setattr(job.d1_client, "execute", execute)
    started = job._insert_run("run", "2026-12-05", "monthly", argparse.Namespace(seed=1))
    assert json.loads(stored["telemetry_json"])["previous_attempt_ledgers"] == [first_ledger]
    started = job._mark_search_started("run", started)

    # The status write carries the earlier ledgers in memory; a D1 read failing then cannot drop them.
    def read_fails(sql, params, **k):
        raise RuntimeError("d1 timeout")

    monkeypatch.setattr(job.d1_client, "query", read_fails)
    # The retry dies before its own ledger exists: the first attempt's ledger survives the error update.
    job._update_run("run", status="error", telemetry={"error": "SIGTERM"}, started=started)
    after = json.loads(stored["telemetry_json"])
    assert after["previous_attempt_ledgers"] == [first_ledger] and after["error"] == "SIGTERM"
    assert after["search_started_at"] and after["attempt_protocol"] == job.ATTEMPT_PROTOCOL


def test_prior_ledger_sums_the_families_of_all_attempts(monkeypatch):
    base = {"selection_start": "2023-11-01", "selection_end": "2026-09-30", "holdout_start": "2026-11-09",
            "holdout_end": "2027-03-05"}
    telemetry = {"multiple_testing_ledger": {**base, "search_trials_raw": 600, "search_trials_effective": 30.0,
                                             "holdout_family_size": 2},
                 "previous_attempt_ledgers": [{**base, "search_trials_raw": 600, "search_trials_effective": 41.5,
                                               "holdout_family_size": 6}]}
    rows = [{"run_id": "r", "run_date": "2026-12-05", "status": "completed", "config_json": "{}",
             "telemetry_json": json.dumps(telemetry)}]
    monkeypatch.setattr(job.d1_client, "query", lambda sql, params, **k: rows)
    (out,) = job._prior_multiple_testing_runs(current_run_id="current")
    # Attempts can search different families on the same holdout, so they are summed, not maxed.
    assert out["holdout_family_size"] == 8 and out["search_trials_effective"] == 71.5 and out["attempts"] == 2


def test_adaptive_controller_starts_from_pre_override_values(monkeypatch, tmp_path):
    for name in ["STRATEGY_MINING_PYMOO_POPULATION", "STRATEGY_MINING_PYMOO_GENERATIONS",
                 "STRATEGY_MINING_FINLAB_CONFIRM_TOP_N", "STRATEGY_MINING_PYMOO_LABELER_POPULATION"]:
        monkeypatch.delenv(name, raising=False)
    previous = {
        "run_id": "smoke", "run_date": "2026-12-05", "updated_at": "x",
        "telemetry": {"adaptive_strategy_families": {"eligible_count": 5, "family_count": 4, "evaluated_count": 100},
                      "summary": {}, "runtime_seconds": 100},
        # The smoke run overrode the population to 8 via env; the controller itself had chosen 80.
        "config": {"pymoo_population": 8, "pymoo_generations": 2, "pymoo_labeler_population": 8,
                   "finlab_confirm_top_n": 6,
                   "pre_env_override_params": {"pymoo_population": 80, "pymoo_generations": 7,
                                               "pymoo_labeler_population": 60, "finlab_confirm_top_n": 10}},
    }
    monkeypatch.setattr(job, "_load_previous_completed_telemetry", lambda: previous)
    alpha = job._load_alpha_miner()
    monkeypatch.setenv("STRATEGY_MINING_PYMOO_POPULATION", "9")
    args = job._build_args(alpha, run_date="2027-01-05", output_dir=tmp_path)
    assert args.adaptive_controller_applied is True
    assert args.pre_env_override_params["pymoo_population"] == 80  # previous 80, within target band
    assert args.pymoo_population == 9 and args.env_overrides_applied == ["STRATEGY_MINING_PYMOO_POPULATION"]
    assert args.pre_env_override_params["pymoo_generations"] == 7


def test_every_ledger_batch_is_size_checked_before_the_first_write(monkeypatch):
    writes = []
    monkeypatch.setattr(job.d1_client, "batch_execute", lambda statements, **k: writes.append(statements))
    monkeypatch.setattr(job.d1_client, "query", lambda sql, params, **k: [{"n": 0}])
    report = {
        "rows": [{"candidate_id": "c1", "status": "ok", "fitness": 1.0, "factor_ids": ["a"], "weights": [1.0]}],
        "adaptive_strategy_families": {"families": [{"family_id": "f", "members": ["c1"],
                                                      "representative": {"candidate_id": "c1", "blob": "x" * 400_000}}]},
    }
    with pytest.raises(RuntimeError, match="d1_param_too_large:ledger"):
        job._persist_ledger("run", report)
    assert writes == []


def test_candidate_label_follows_the_finlab_confirm_verdict():
    base ={"status": "ok", "fitness": 1.0, "factor_ids": ["a"], "weights": [1.0]}
    report = {
        "rows": [
            {**base, "candidate_id": "pass", "finlab_confirm_gate": {"status": "pass"}},
            {**base, "candidate_id": "fail", "fitness": 0.9, "finlab_confirm_gate": {"status": "failed"}},
            {**base, "candidate_id": "plain", "fitness": 0.8},
        ],
        "finlab_confirm": [{"id": "alpha_miner_pass"}, {"id": "alpha_miner_fail"}],
    }
    out = job._persist_candidates("run", report, execute=False)
    status = {params[0].split("__", 1)[1]: params[9] for _sql, params in out["statements"]}
    assert status == {"pass": "finlab_confirmed", "fail": "finlab_confirm_failed", "plain": "pymoo_ok"}


def test_prior_ledger_blocks_on_unfinished_non_legacy_runs(monkeypatch):
    seen = {}
    rows = [
        {"run_id": "new-errored", "run_date": "2026-12-05", "status": "error", "config_json": "{}",
         "telemetry_json": json.dumps({"error": "terminated"})},
        {"run_id": "new-orphan", "run_date": "2027-01-04", "status": "running", "config_json": "{}",
         "telemetry_json": "{}"},
        {"run_id": "legacy-orphan", "run_date": "2026-07-04", "status": "running", "config_json": "{}",
         "telemetry_json": "{}"},
        {"run_id": "legacy-errored", "run_date": "2026-10-05", "status": "error", "config_json": "{}",
         "telemetry_json": "{}"},
    ]

    def query(sql, params, **k):
        seen["sql"] = sql
        return rows

    monkeypatch.setattr(job.d1_client, "query", query)
    out = job._prior_multiple_testing_runs(current_run_id="current")
    assert "'running'" in seen["sql"]
    assert out == [{"run_id": "new-errored", "run_date": "2026-12-05", "incomplete": True},
                   {"run_id": "new-orphan", "run_date": "2027-01-04", "incomplete": True}]


def _ledger(family):
    return {"selection_start": "2023-11-01", "selection_end": "2026-09-30", "holdout_start": "2026-11-09",
            "holdout_end": "2027-03-05", "search_trials_raw": 100, "search_trials_effective": 10.0,
            "holdout_family_size": family}


def test_pre_search_failure_counts_earlier_attempts_instead_of_blocking(monkeypatch):
    protocol = job.ATTEMPT_PROTOCOL
    rows = [
        # Retry failed at the preflight (no search marker): the first attempt's ledger counts.
        {"run_id": "retry-pre-search", "run_date": "2026-12-05", "status": "error", "config_json": "{}",
         "telemetry_json": json.dumps({"attempt_protocol": protocol, "previous_attempt_ledgers": [_ledger(6)]})},
        # First attempt failed before searching: tested nothing, nothing to count, nothing blocked.
        {"run_id": "first-pre-search", "run_date": "2027-01-05", "status": "error", "config_json": "{}",
         "telemetry_json": json.dumps({"attempt_protocol": protocol, "error": "preflight"})},
        # Search started and no ledger was written: family unknown, promotion blocked.
        {"run_id": "died-in-search", "run_date": "2027-02-05", "status": "running", "config_json": "{}",
         "telemetry_json": json.dumps({"attempt_protocol": protocol, "search_started_at": "t"})},
    ]
    monkeypatch.setattr(job.d1_client, "query", lambda sql, params, **k: rows)
    out = job._prior_multiple_testing_runs(current_run_id="current")
    assert out[0]["run_id"] == "retry-pre-search" and out[0]["holdout_family_size"] == 6
    assert out[1:] == [{"run_id": "died-in-search", "run_date": "2027-02-05", "incomplete": True}]


def test_search_is_marked_before_the_miner_runs_and_a_failed_mark_stops_it(monkeypatch, tmp_path):
    monkeypatch.setenv("STRATEGY_MINING_RUN_ID", "mark-run")
    monkeypatch.setenv("STRATEGY_MINING_BACKEND", "cloud_run")
    order = []
    calls = _stub_job(monkeypatch, tmp_path, run=lambda args: order.append("run") or (_ for _ in ()).throw(RuntimeError("x")))
    assert job._run_strategy_mining() == 1
    kinds = [kind for kind, _ in calls]
    assert kinds.index("search") < kinds.index("update") and order == ["run"]

    def mark_fails(run_id, started):
        raise RuntimeError("d1 down")

    monkeypatch.setattr(job, "_mark_search_started", mark_fails)
    order.clear()
    assert job._run_strategy_mining() == 1
    assert order == []


def test_adaptive_previous_run_excludes_the_current_run_id(monkeypatch):
    seen = {}

    def query(sql, params=None, **k):
        seen["sql"], seen["params"] = sql, params
        return []

    monkeypatch.setenv("STRATEGY_MINING_RUN_ID", "strategy-mining-2026-12-05-exec")
    monkeypatch.setattr(job.d1_client, "query", query)
    assert job._load_previous_completed_telemetry() is None
    assert "run_id != ?" in seen["sql"] and "run_date >= ?" in seen["sql"]
    assert seen["params"] == [job.MINING_HISTORY_FLOOR_DATE, "strategy-mining-2026-12-05-exec"]


def test_adaptive_controller_takes_no_feedback_from_an_env_overridden_run(monkeypatch, tmp_path):
    for name in ["STRATEGY_MINING_PYMOO_POPULATION", "STRATEGY_MINING_PYMOO_GENERATIONS",
                 "STRATEGY_MINING_FINLAB_CONFIRM_TOP_N", "STRATEGY_MINING_PYMOO_LABELER_POPULATION",
                 "STRATEGY_MINING_MAX_SYMBOLS", "STRATEGY_MINING_START_DATE", "STRATEGY_MINING_TOP_K"]:
        monkeypatch.delenv(name, raising=False)
    previous = {
        "run_id": "smoke", "run_date": "2026-12-05", "updated_at": "x",
        # 0 accepted would normally grow the search; the smoke run's telemetry is not feedback.
        "telemetry": {"adaptive_strategy_families": {"eligible_count": 0, "family_count": 0, "evaluated_count": 9},
                      "summary": {}, "runtime_seconds": 10},
        "config": {"pymoo_population": 8, "pymoo_generations": 2, "pymoo_labeler_population": 8,
                   "finlab_confirm_top_n": 6, "env_overrides_applied": ["STRATEGY_MINING_MAX_SYMBOLS"],
                   "pre_env_override_params": {"pymoo_population": 80, "pymoo_generations": 7,
                                               "pymoo_labeler_population": 60, "finlab_confirm_top_n": 10}},
    }
    monkeypatch.setattr(job, "_load_previous_completed_telemetry", lambda: previous)
    alpha = job._load_alpha_miner()
    monkeypatch.setenv("STRATEGY_MINING_MAX_SYMBOLS", "40")
    args = job._build_args(alpha, run_date="2027-01-05", output_dir=tmp_path)
    assert args.adaptive_controller_reason == "previous_run_env_overridden_no_feedback"
    assert (args.pymoo_population, args.pymoo_generations, args.pymoo_labeler_population,
            args.finlab_confirm_top_n) == (80, 7, 60, 10)
    assert args.env_overrides_applied == ["STRATEGY_MINING_MAX_SYMBOLS"]


def test_completion_telemetry_compacts_the_carried_attempt_ledgers():
    telemetry = {
        "artifact_paths": {"gcs": {"json": "gs://x/report.json"}},
        "previous_attempt_ledgers": [{**_ledger(6), "prior_runs_counted": [{"run_id": "a"}] * 500}],
    }
    out = job._compact_completion_telemetry(telemetry)
    assert out["previous_attempt_ledgers"] == [_ledger(6)]


def test_backtest_lookup_is_chunked_under_the_gateway_param_limit(monkeypatch):
    queries = []
    monkeypatch.setattr(job.d1_client, "query", lambda sql, params, **k: queries.append(params) or [])
    monkeypatch.setattr(job.d1_client, "batch_execute", lambda statements, **k: None)
    n = 51
    report = {"rows": [{"candidate_id": f"c{i}", "factor_ids": [f"f{i}"]} for i in range(n)],
              "finlab_confirm": [{"id": f"alpha_miner_c{i}", "monthly_sharpe": 1.0} for i in range(n)]}
    out = job._persist_backtests("run", report)
    assert out["inserted"] == n and [len(params) for params in queries] == [51, 2]


class _FakeRunsTable:
    """strategy_mining_runs row for one run_id, driven through _insert_run / _mark / _update_run."""

    def __init__(self, monkeypatch):
        self.row = None
        monkeypatch.setattr(job.d1_client, "query", self.query)
        monkeypatch.setattr(job.d1_client, "execute", self.execute)

    def query(self, sql, params=None, **k):
        if "FROM strategy_mining_runs WHERE run_id = ?" in sql:
            return [dict(self.row)] if self.row else []
        if "FROM strategy_mining_runs" in sql:
            return [{"run_id": "r", "run_date": "2027-01-05", "config_json": "{}", **self.row}] if self.row else []
        return []

    def execute(self, sql, params, **k):
        if "INSERT OR REPLACE INTO strategy_mining_runs" in sql:
            self.row = {"status": "running", "telemetry_json": params[9]}
        elif "SET telemetry_json = ?" in sql:
            self.row["telemetry_json"] = params[0]
        elif "SET status = ?" in sql:
            self.row = {"status": params[0], "telemetry_json": params[1]}


def test_retry_keeps_an_earlier_attempt_with_unknown_family_incomplete(monkeypatch):
    table = _FakeRunsTable(monkeypatch)
    args = argparse.Namespace(seed=1)
    # Attempt 1 marks the search, opens the holdout, dies by SIGTERM before any ledger exists.
    started = job._mark_search_started("r", job._insert_run("r", "2027-01-05", "monthly", args))
    job._update_run("r", status="error", telemetry={"error": "SIGTERM"}, started=started)
    # Attempt 2 completes with its own family of 3.
    started = job._insert_run("r", "2027-01-05", "monthly", args)
    assert started["previous_attempt_incomplete"] is True
    started = job._mark_search_started("r", started)
    job._update_run("r", status="error", telemetry={"error": "x", "multiple_testing_ledger": _ledger(3)}, started=started)
    out = job._prior_multiple_testing_runs(current_run_id="later")
    assert out == [{"run_id": "r", "run_date": "2027-01-05", "incomplete": True}]
    # A third attempt that fails at a preflight does not wash it out either.
    started = job._insert_run("r", "2027-01-05", "monthly", args)
    job._update_run("r", status="error", telemetry={"error": "preflight"}, started=started)
    assert job._prior_multiple_testing_runs(current_run_id="later")[0]["incomplete"] is True


def test_retry_counts_its_own_earlier_attempts_and_blocks_on_unknown_ones(monkeypatch, tmp_path):
    monkeypatch.setenv("STRATEGY_MINING_RUN_ID", "retry-run")
    monkeypatch.setenv("STRATEGY_MINING_BACKEND", "cloud_run")
    seen = {}

    def run(args):
        seen["prior"] = args.prior_multiple_testing_runs
        seen["gates"] = args.pre_holdout_blocking_gates
        raise RuntimeError("stop")

    _stub_job(monkeypatch, tmp_path, run=run)
    monkeypatch.setattr(job, "_insert_run", lambda *a: {"started_at": "t", "previous_attempt_ledgers": [_ledger(5), _ledger(7)]})
    assert job._run_strategy_mining() == 1
    (own,) = seen["prior"]
    assert own["run_id"] == "retry-run#earlier_attempts" and own["holdout_family_size"] == 12 and own["attempts"] == 2
    assert seen["gates"] == []
    monkeypatch.setattr(job, "_insert_run", lambda *a: {"started_at": "t", "previous_attempt_incomplete": True})
    assert job._run_strategy_mining() == 1
    assert seen["gates"] == ["multiple_testing_prior_ledger_incomplete"]


def test_post_search_error_update_carries_marker_and_earlier_ledgers(monkeypatch, tmp_path):
    monkeypatch.setenv("STRATEGY_MINING_RUN_ID", "carry-run")
    monkeypatch.setenv("STRATEGY_MINING_BACKEND", "cloud_run")
    calls = _stub_job(monkeypatch, tmp_path, run=lambda args: (_ for _ in ()).throw(RuntimeError("x")))
    monkeypatch.setattr(job, "_insert_run", lambda *a: {"started_at": "t", "previous_attempt_ledgers": [_ledger(5)]})
    assert job._run_strategy_mining() == 1
    (update,) = [item for kind, item in calls if kind == "update"]
    assert update[3]["search_started_at"] and update[3]["previous_attempt_ledgers"] == [_ledger(5)]


def test_sigterm_sends_no_terminal_callback_but_errors_do(monkeypatch, tmp_path):
    monkeypatch.setenv("STRATEGY_MINING_RUN_ID", "cb-run")
    monkeypatch.setenv("STRATEGY_MINING_BACKEND", "cloud_run")

    def sigterm(args):
        os.kill(os.getpid(), signal.SIGTERM)
        raise AssertionError("handler did not fire")

    calls = _stub_job(monkeypatch, tmp_path, run=sigterm)
    monkeypatch.setattr(job, "_TERMINATED_BY_SIGNAL", False)
    assert job.main() == 1
    assert not [item for kind, item in calls if kind == "callback"]
    calls.clear()
    monkeypatch.setattr(job, "_load_alpha_miner", lambda: SimpleNamespace(run=lambda args: (_ for _ in ()).throw(RuntimeError("x"))))
    assert job.main() == 1
    assert [item for kind, item in calls if kind == "callback"] == ["error"]


def test_late_sigterm_after_completion_does_not_flip_the_row_to_error(monkeypatch, tmp_path):
    monkeypatch.setenv("STRATEGY_MINING_RUN_ID", "late-run")
    monkeypatch.setenv("STRATEGY_MINING_BACKEND", "cloud_run")
    calls = _stub_job(monkeypatch, tmp_path, run=lambda args: {"rows": [], "multiple_testing": {}, "research_protocol": {}})
    monkeypatch.setattr(job, "build_strategy_mining_evidence", lambda rows, **k: {})
    monkeypatch.setattr(job, "_write_artifacts", lambda *a: {"gcs": {"json": "gs://x/y.json"}})
    monkeypatch.setattr(job, "_persist_ledger", lambda *a: {})
    seen = {}

    def update(run_id, **k):
        calls.append(("update", k["status"]))
        if k["status"] == "completed":
            seen["handler"] = signal.getsignal(signal.SIGTERM)

    monkeypatch.setattr(job, "_update_run", update)
    real_print = print

    def print_with_sigterm(*a, **k):
        seen["handler_at_print"] = signal.getsignal(signal.SIGTERM)
        real_print(*a, **k)

    monkeypatch.setattr("builtins.print", print_with_sigterm)
    assert job._run_strategy_mining() == 0
    assert [item for kind, item in calls if kind == "update"] == ["completed"]
    # The job's handler was active during the completed write and removed before the print.
    assert seen["handler"] is not seen["handler_at_print"]


def test_retry_marks_rows_only_an_earlier_attempt_wrote_as_superseded(monkeypatch):
    writes = []

    def query(sql, params, **k):
        if "FROM strategy_mining_candidates WHERE run_id = ?" in sql:
            return [{"candidate_id": "run__c1"}, {"candidate_id": "run__c2"}, {"candidate_id": "run__old"}]
        if "FROM strategy_backtest_results" in sql:
            return [{"candidate_id": "run__c1"}, {"candidate_id": "run__old"}]
        if "FROM strategy_promotion_ledger" in sql:
            return [{"ledger_id": "run__old__challenger_packet"}, {"ledger_id": "run__c2__challenger_packet"}]
        return []

    monkeypatch.setattr(job.d1_client, "query", query)
    monkeypatch.setattr(job.d1_client, "batch_execute", lambda statements, **k: writes.append(statements))
    planned = {
        "candidates": {"statements": [("INSERT", ["run__c1"]), ("INSERT", ["run__c2"])]},
        "backtests": {"statements": [("INSERT", ["run__c2"])]},
        "promotion_packets": {"statements": [("INSERT", ["run__c2__challenger_packet"])]},
    }
    out = job._supersede_stale_attempt_rows("run", planned)
    assert out == {"candidates": 1, "backtests": 2, "promotion_packets": 1}
    sqls = [(sql.split()[1], params) for sql, params in writes[0]]
    assert sqls[0] == ("strategy_mining_candidates", ["superseded_by_retry", "run__old"])
    assert sqls[1] == ("strategy_backtest_results", ["superseded_by_retry", "run__c1", "run__old", "run"])
    assert sqls[2] == ("strategy_promotion_ledger", ["superseded_by_retry", "run__old__challenger_packet"])
