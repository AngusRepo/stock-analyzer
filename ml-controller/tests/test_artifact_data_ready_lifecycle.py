"""No-network regression for the actual lifecycle route and candidate staging."""
import asyncio
import json
import sys
import types
from pathlib import Path
from datetime import date, timedelta
from unittest.mock import AsyncMock

import pytest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
google_cloud = sys.modules.setdefault("google.cloud", types.ModuleType("google.cloud"))
if not hasattr(google_cloud, "run_v2"):
    google_cloud.run_v2 = types.SimpleNamespace(JobsClient=object, ExecutionsClient=object)
    sys.modules.setdefault("google.cloud.run_v2", google_cloud.run_v2)
from routers import walk_forward as wf
from routers import optuna
import oof_materialize_job_main as job


class Blob:
    def __init__(self, store, name):
        self.store, self.name = store, name

    def exists(self):
        return self.name in self.store

    def download_as_text(self):
        return self.store[self.name]

    def upload_from_string(self, value, **_kwargs):
        self.store[self.name] = value


class Bucket:
    def __init__(self):
        self.store = {}

    def blob(self, name):
        return Blob(self.store, name)


@pytest.fixture
def lifecycle(monkeypatch):
    from services import walk_forward_retrain, modal_client
    days = [(date(2025, 1, 1) + timedelta(days=n)).isoformat() for n in range(230)
            if (date(2025, 1, 1) + timedelta(days=n)).weekday() < 5]
    parent = {"cohort_id": "parent", "start_date": days[0], "end_date": days[139],
              "train_window_days": wf.OOF_TRAIN_SESSIONS, "test_window_days": wf.OOF_TEST_SESSIONS,
              "target_semantic_version": wf._OOF_TARGET_SEMANTIC_VERSION,
              "score_semantic_version": wf.OOF_SCORE_SEMANTIC_VERSION,
              "windows": [{}] * wf.OOF_PROMOTION_MIN_FOLDS}
    bucket = Bucket()
    monkeypatch.setattr(walk_forward_retrain, "_get_bucket", lambda: bucket)
    monkeypatch.setattr(wf, "_latest_ready_oof_manifest", lambda _b: ("parent/manifest.json", parent))
    monkeypatch.setattr(wf, "_latest_canonical_prep_prefix", lambda _b: "immutable/prep")
    monkeypatch.setattr(wf, "_oof_manifest_observed_core_dates", lambda _b, m: ([m["end_date"]], {}))
    monkeypatch.setenv("OOF_MATERIALIZE_JOB_EXECUTION", "1")
    materialize = AsyncMock(return_value={"status": "materialized", "candidate_artifacts": {},
        "full_fit_dispatch": {"status": "completed", "retry_required": False},
        "candidate_forward_evaluation": {"status": "waiting_for_preoutcome_locked_mature_dates"}})
    monkeypatch.setattr(wf, "materialize_walk_forward_oof", materialize)
    extension = AsyncMock(return_value={"status": "ready", "manifest_path": "forward.json",
        "manifest_checksum": "a" * 64, "training_dispatched": False, "promotion_eligible": False})
    monkeypatch.setattr(modal_client, "build_frozen_oof_forward_extension", extension)
    return days, parent, bucket, materialize, extension


@pytest.mark.parametrize("cadence", ["daily", "weekly", "monthly"])
def test_ten_dates_use_identical_factory_without_waiting_for_weekday(monkeypatch, lifecycle, cadence):
    days, parent, _, materialize, _ = lifecycle
    monkeypatch.setattr(wf, "_oof_lifecycle_calendar", lambda *a, **k: (days[:150], {"cutoff": days[154]}))
    plan = AsyncMock(side_effect=lambda req: req.model_dump())
    monkeypatch.setattr(wf, "walk_forward_dry_run", plan)
    result = asyncio.run(wf.run_walk_forward_oof_lifecycle(wf.OofLifecycleRequest(
        cadence=cadence, end_date=days[154], dry_run=True, dispatch_full_fit=True)))
    assert result["status"] == "dry_run"
    request = plan.call_args.args[0]
    assert request.start_date == parent["start_date"]
    assert request.end_date == days[149]
    assert request.resume_manifest_path == "parent/manifest.json"
    assert request.confirm is False
    materialize.assert_not_called()


def test_nine_dates_preserve_formal_parent_and_frozen_shadow(monkeypatch, lifecycle):
    days, parent, _, materialize, extension = lifecycle
    monkeypatch.setattr(wf, "_oof_lifecycle_calendar", lambda *a, **k: (days[:149], {"cutoff": days[154]}))
    train = AsyncMock(side_effect=AssertionError("must not create a cohort"))
    monkeypatch.setattr(wf, "walk_forward_run", train)
    result = asyncio.run(wf.run_walk_forward_oof_lifecycle(wf.OofLifecycleRequest(
        cadence="daily", end_date=days[154], dry_run=False, promote=True, dispatch_full_fit=True)))
    assert result["status"] == "shadow_evaluated"
    assert len(materialize.call_args_list) == 2
    formal, shadow = [call.args[0] for call in materialize.call_args_list]
    assert formal.cohort_id == shadow.cohort_id == parent["cohort_id"]
    assert formal.dispatch_full_fit and not formal.promote and not formal.promote_exact_candidates
    assert shadow.dry_run and not shadow.dispatch_full_fit and not shadow.promote
    assert shadow.promote_exact_candidates
    assert extension.call_args.args[0]["start_date"] == days[140]
    assert result["full_fit_dispatch"]["status"] == "completed"
    train.assert_not_called()


def test_batch_counts_unique_physical_dates_and_preserves_lineage(lifecycle):
    days, parent, *_ = lifecycle
    assert not wf._daily_cohort_batch_ready(parent, days[:149] + [days[148]] * 20, [days[139]])
    assert not wf._daily_cohort_batch_ready({**parent, "score_semantic_version": "wrong"}, days[:150], [days[139]])
    assert not wf._daily_cohort_batch_ready(parent, days[:150], [])


@pytest.mark.parametrize("status", ["spawned", "pending"])
def test_daily_cohort_pending_is_triggered_not_skipped(monkeypatch, status):
    callbacks = []
    async def execute(**_kwargs):
        return {"status": status, "cohort_id": "new-cohort"}
    async def callback(payload):
        callbacks.append(payload)
    monkeypatch.setattr(job, "_execute_lifecycle", execute)
    monkeypatch.setattr(job, "_callback_worker", callback)
    monkeypatch.setenv("OOF_MATERIALIZE_MODE", "oof_lifecycle")
    monkeypatch.setenv("OOF_MATERIALIZE_CADENCE", "daily")
    monkeypatch.setenv("OOF_MATERIALIZE_END_DATE", "2026-09-08")
    monkeypatch.setenv("OOF_MATERIALIZE_CONTINUATION_ATTEMPT", "0")
    asyncio.run(job._run())
    assert callbacks[0]["status"] == "triggered"
    assert callbacks[0]["metadata"]["cohort_id"] == "new-cohort"


def test_failed_source_cannot_be_success():
    result = optuna._run_optuna_sweep_source_inner("signal", lambda: {"status": "failed", "best_params": {"x": 1}})
    assert result["status"] == "error"


def test_partial_staging_keeps_shared_risk_fields_atomic(monkeypatch):
    pushes = []
    def stage(req, rows, **kwargs):
        pushes.append([row["source"] for row in rows])
        return {"status": "staged", "candidate_id": kwargs["run_id"]}
    monkeypatch.setattr(optuna, "_commit_research_sweep_candidate", stage)
    rows = [{"source": source, "status": "success", "candidate_params": {"x": 1}}
            for group in optuna.OPTUNA_CANDIDATE_GROUPS.values() for source in group]
    next(row for row in rows if row["source"] == "risk_params")["status"] = "skipped"
    result = optuna._stage_research_groups(optuna.OptunaResearchSweepReq(), rows, "run")
    assert result["status"] == "partial"
    assert result["groups"]["execution_risk"]["status"] == "blocked"
    assert not any("sltp" in group for group in pushes)
    assert len(pushes) == 2


def test_worker_python_group_contract_matches():
    from pathlib import Path
    import re
    source = (Path(__file__).parents[2] / "worker/src/lib/optunaConfigMerge.ts").read_text(encoding="utf-8")
    for owner, names in optuna.OPTUNA_CANDIDATE_GROUPS.items():
        match = re.search(rf"{owner}: \[(.*?)\]", source)
        assert match and tuple(re.findall(r"'([^']+)'", match[1])) == names


def test_exact_cohort_not_ready_is_retryable_without_switching_parent(monkeypatch, lifecycle):
    def not_ready(*_args):
        raise ValueError("oof_exact_cohort_manifest_missing")
    monkeypatch.setattr(wf, "_exact_ready_oof_manifest", not_ready)
    result = asyncio.run(wf.run_walk_forward_oof_lifecycle(wf.OofLifecycleRequest(
        cadence="daily", continuation_only=True, expected_cohort_id="bound-cohort")))
    assert result["status"] == "pending"
    assert result["cohort_id"] == "bound-cohort"
    assert not result["training_dispatched"] and not result["promotion_attempted"]


def test_optuna_retry_reuses_successful_results(monkeypatch):
    prior = {"source": "signal", "status": "success", "summary": "signal:OK", "candidate_params": {"x": 1}}
    monkeypatch.setattr(optuna, "run_signal", lambda _r: pytest.fail("successful search rerun"))
    for name in ["run_barrier", "run_sltp", "run_screener", "run_conformal", "run_risk_params",
                 "run_rrg", "run_alpha_framework", "run_ga_optimizer"]:
        monkeypatch.setattr(optuna, name, lambda _r: {"status": "skipped"})
    result = optuna.execute_research_sweep(optuna.OptunaResearchSweepReq(dry_run=True, push_kv=False),
                                          successful_results={"signal": prior})
    signal = next(item for item in result["results"] if item["source"] == "signal")
    assert signal["reused_in_run"] is True
    assert result["status"] == "partial" and result["closure_status"] == "partial"


def test_candidate_retry_sql_preserves_status_and_evidence():
    import re
    import sqlite3
    source = (Path(__file__).parents[2] / "worker/src/lib/parameterCandidateRegistry.ts").read_text(encoding="utf-8")
    schema = re.search(r'`(CREATE TABLE IF NOT EXISTS parameter_candidate_registry .*?)`', source, re.S)[1]
    statement = re.search(r'`(INSERT INTO parameter_candidate_registry.*?metadata_json = excluded.metadata_json,.*?updated_at = datetime\(\x27now\x27\))`', source, re.S)[1]
    with sqlite3.connect(":memory:") as conn:
        conn.execute(schema)
        values = ["candidate", "research_sweep", "hash", "sandbox", "weekly", "run", "SHADOW_COLLECTING", "{}"]
        conn.execute(statement, values)
        conn.execute("UPDATE parameter_candidate_registry SET status='PROMOTION_READY', latest_evidence_json='valid', promotion_packet_id='packet'")
        conn.execute(statement, values)
        assert conn.execute("SELECT status,latest_evidence_json,promotion_packet_id FROM parameter_candidate_registry").fetchone() == (
            "PROMOTION_READY", "valid", "packet")


def test_partial_callback_retains_all_materialized_group_candidates(monkeypatch):
    import optuna_job_main as optuna_job
    callbacks = []
    async def sweep(_req):
        return {"status": "partial", "incomplete": ["selection:missing"], "failures": [],
                "staging": {"status": "partial", "groups": {
                    "selection": {"status": "blocked"},
                    "execution_risk": {"status": "staged", "candidate_id": "risk", "composite": {"sandbox_id": "risk-box"}},
                    "label_uncertainty": {"status": "staged", "candidate_id": "label", "composite": {"sandbox_id": "label-box"}},
                }}}, 1
    async def callback(payload):
        callbacks.append(payload)
    monkeypatch.setattr(optuna_job, "_execute_research_sweep_with_bounded_retry", sweep)
    monkeypatch.setattr(optuna_job, "_callback_optuna_with_bounded_retry", callback)
    monkeypatch.setenv("OPTUNA_JOB_MODE", "research_sweep")
    monkeypatch.setenv("OPTUNA_CADENCE", "weekly")
    assert asyncio.run(optuna_job._run()) == 0
    assert callbacks[0]["status"] == "skipped"
    assert callbacks[0]["metadata"]["closure_status"] == "partial"
    assert callbacks[0]["metadata"]["candidate_ids"] == ["risk", "label"]
    assert len(callbacks[0]["metadata"]["push_results"]) == 2


def test_pending_release_does_not_block_daily_forward_evidence(monkeypatch, lifecycle):
    days, _, _, materialize, extension = lifecycle
    monkeypatch.setattr(wf, "_oof_lifecycle_calendar", lambda *a, **k: (days[:149], {"cutoff": days[154]}))
    materialize.side_effect = [
        {"status": "materialized", "full_fit_retry_required": True,
         "full_fit_dispatch": {"status": "spawned", "retry_required": True}},
        {"status": "materialized", "candidate_forward_evaluation": {"status": "evaluated"}},
    ]
    result = asyncio.run(wf.run_walk_forward_oof_lifecycle(wf.OofLifecycleRequest(
        cadence="daily", end_date=days[154], dispatch_full_fit=True)))
    extension.assert_awaited_once()
    assert len(materialize.call_args_list) == 2
    assert result["status"] == "shadow_evaluated"
    assert result["dependency_retry_required"] is True
    assert result["full_fit_dispatch"]["status"] == "spawned"


def test_daily_exact_model_continuation_keeps_latest_prep_watermark(monkeypatch, lifecycle):
    days, parent, _, materialize, extension = lifecycle
    parent["prep_gcs_prefix"] = "old/prep"
    monkeypatch.setattr(wf, "_exact_ready_oof_manifest", lambda *_a: ("parent/manifest.json", parent, "b" * 40))
    def calendar(_end, **kwargs):
        assert kwargs["prep_gcs_prefix"] == "immutable/prep"
        assert kwargs["expected_producer_source_sha"] is None
        return days[:149], {"cutoff": days[154]}
    monkeypatch.setattr(wf, "_oof_lifecycle_calendar", calendar)
    asyncio.run(wf.run_walk_forward_oof_lifecycle(wf.OofLifecycleRequest(
        cadence="daily", end_date=days[154], dispatch_full_fit=True,
        continuation_only=True, expected_cohort_id="parent")))
    assert extension.call_args.args[0]["end_date"] == days[148]
    assert all(call.args[0].expected_producer_source_sha == "b" * 40 for call in materialize.call_args_list)


def test_terminal_fast_path_cannot_hide_new_complete_cohort_batch(monkeypatch, lifecycle):
    days, _, bucket, *_ = lifecycle
    monkeypatch.setattr(wf, "_oof_lifecycle_calendar", lambda *a, **k: (days[:150], {"cutoff": days[154]}))
    monkeypatch.setattr(wf, "_oof_lifecycle_receipt_matches_active_policy",
                        lambda *a, **k: pytest.fail("must plan new cohort before reading terminal receipt"))
    assert wf._pre_dispatch_completed_oof_lifecycle(wf.OofLifecycleRequest(
        cadence="daily", end_date=days[154], dispatch_full_fit=True), cadence="daily", bucket=bucket) is None


def test_daily_exact_continuation_checks_current_prep(monkeypatch):
    from services import active8_prep_lifecycle
    prep = AsyncMock(return_value={"status": "idempotent_ready", "business_date": "2026-09-08"})
    route = AsyncMock(return_value={"status": "shadow_evaluated"})
    monkeypatch.setattr(active8_prep_lifecycle, "ensure_active8_daily_prep", prep)
    monkeypatch.setattr(wf, "run_walk_forward_oof_lifecycle", route)
    asyncio.run(job._execute_lifecycle(cadence="daily", end_date="2026-09-08", promote=False,
        dispatch_full_fit=True, expected_cohort_id="fixed", continuation_attempt=1, continuation_only=True))
    prep.assert_awaited_once()
    assert route.call_args.args[0].expected_cohort_id == "fixed"


@pytest.mark.parametrize("candidate_status,retry", [
    ("offline_admission_blocked", False),
    ("offline_admissible_candidate_missing", True),
    ("waiting_for_preoutcome_locked_mature_dates", False),
])
def test_daily_closes_explicit_admission_rejection_without_promotion(monkeypatch, lifecycle, candidate_status, retry):
    days, parent, bucket, materialize, _ = lifecycle
    monkeypatch.setattr(wf, "_oof_lifecycle_calendar", lambda *a, **k: (days[:149], {"cutoff": days[154]}))
    materialize.return_value["candidate_forward_evaluation"] = {
        "status": candidate_status, "promotion_ready": False,
        "offline_rejections": [{"artifact_id": "l4", "failed_gates": ["pit_sector_alpha_samples_low"]}],
    }
    result = asyncio.run(wf.run_walk_forward_oof_lifecycle(wf.OofLifecycleRequest(
        cadence="daily", end_date=days[154], dry_run=False, promote=True, dispatch_full_fit=True)))
    assert result["dependency_retry_required"] is retry
    assert result["promotion_allowed"] is False
    receipts = [json.loads(v) for k, v in bucket.store.items() if "/lifecycle/" in k]
    assert bool(receipts) is not retry
    if not retry:
        assert receipts[-1]["promoted"] is False
        assert receipts[-1]["evidence_closure"]["candidate_forward_evaluation"]["status"] == candidate_status
    if candidate_status == "offline_admission_blocked":
        assert result["promotion_reason"] == "offline_candidate_admission_blocked"
