from pathlib import Path
import asyncio
import os
import sys


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml-controller"))

TEST_SOURCE_SHA = "0123456789abcdef0123456789abcdef01234567"
os.environ.setdefault("STOCKVISION_SOURCE_SHA", TEST_SOURCE_SHA)


def test_walk_forward_defaults_to_active8_contract():
    from services.walk_forward_retrain import MODELS_ALL, walk_forward_model_coverage

    expected = [
        "LightGBM",
        "XGBoost",
        "ExtraTrees",
        "TabM",
        "GNN",
        "DLinear",
        "PatchTST",
        "iTransformer",
    ]
    assert MODELS_ALL == expected

    coverage = walk_forward_model_coverage()
    assert coverage["requested_models"] == expected
    assert coverage["native_retrain_models"] == expected
    assert coverage["artifact_lifecycle_required_models"] == []
    assert coverage["coverage_mode"] == "active8_purged_oof_retrain"


def test_ev_candidate_fit_excludes_frozen_forward_rows_and_uses_base_cutoff():
    from routers.walk_forward import _candidate_base_training_rows

    base_rows, trained_until = _candidate_base_training_rows([
        {
            "fold_id": "fold-4",
            "snapshot_date": "2026-08-18",
            "symbol": "2330",
        },
        {
            "fold_id": "frozen_forward",
            "snapshot_date": "2026-08-25",
            "symbol": "2330",
        },
        {
            "fold_id": "frozen_forward",
            "snapshot_date": "2026-08-27",
            "symbol": "2317",
        },
    ])

    assert trained_until == "2026-08-18"
    assert [row["snapshot_date"] for row in base_rows] == ["2026-08-18"]


def test_oof_full_fit_plan_keeps_all_structurally_valid_models_as_ensemble_bases():
    from routers.walk_forward import build_oof_full_fit_dispatch_plan

    models = [
        "LightGBM", "XGBoost", "ExtraTrees", "TabM",
        "GNN", "DLinear", "PatchTST", "iTransformer",
    ]
    evidence_by_model = {
        model: {
            "schema_version": "model-cpcv-evidence-v1",
            "method": "outer_purged_walk_forward_rank_ic",
            "decision": "FAIL" if model == "PatchTST" else "PASS",
            "failed_gates": ["oos_ic_lcb"] if model == "PatchTST" else [],
            "folds": 5,
        }
        for model in models
    }
    manifest = {
        "schema_version": "active8-oof-cohort-manifest-v5",
        "target_semantic_version": "next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4",
        "prep_manifest": {
            "manifest_checksum": "a" * 64,
            "target_semantic_version": "next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4",
            "roundtrip_cost_bps": 18.0,
            "batch_count": 5,
            "schema_version": "active8-canonical-adjusted-prep-v3",
            "feature_semantic_version": "formal137-pit-rolling-rank-and-imputation-v2",
            "feature_imputation_semantic": "prior_252_row_median_then_zero_v2",
            "producer_source_sha": TEST_SOURCE_SHA,
        },
        "sequence_manifest": {
            "artifact_checksum": "b" * 64,
            "contract": "sequence_records_v3",
            "target_semantic_version": "next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4",
            "batch_count": 1,
            "batch_checksums": {"sequence/prep/batch_0.npz": "c" * 64},
        },
        "windows": [
            {
                "window_id": idx,
                "train_range": ["2026-01-01", f"2026-04-{10 + idx:02d}"],
                "test_range": [
                    f"2026-04-{11 + idx * 2:02d}",
                    f"2026-04-{12 + idx * 2:02d}",
                ],
                "fs_result": {
                    "feature_pool": {
                        "tree_active": [f"feature_{feature_idx}" for feature_idx in range(12)]
                    }
                },
            }
            for idx in range(5)
        ],        "aggregate": {
            "oof_ready_folds": 5,
            "full_fit_eligible_models": [model for model in models if model != "PatchTST"],
            "per_model_promotion_evidence": evidence_by_model,
            "full_fit_blocked_models": {"PatchTST": ["oos_ic_lcb"]},
        },
    }

    plan = build_oof_full_fit_dispatch_plan(manifest)

    assert plan["status"] == "ready"
    assert plan["release_models"] == sorted(models)
    assert plan["promotion_eligible_models"] == sorted(model for model in models if model != "PatchTST")
    assert plan["train_model_groups"] == ["tree", "dlinear", "patchtst"]
    assert plan["artifact_lifecycle_targets"] == ["GNN", "TabM", "iTransformer"]
    assert plan["evidence_missing_or_failed"] == []
    assert plan["blocked_models"] == {"PatchTST": ["oos_ic_lcb"]}
    assert plan["promotion_evidence"]["PatchTST"]["decision"] == "FAIL"
    assert plan["promotion_evidence"]["XGBoost"]["validation_design"]["refit_each_fold"] is True
    assert plan["promotion_evidence"]["XGBoost"]["validation_design"]["chronological"] is True


def test_walk_forward_router_exposes_active8_coverage():
    source = (ROOT / "ml-controller" / "routers" / "walk_forward.py").read_text(encoding="utf-8")

    assert "walk_forward_model_coverage" in source
    assert "\"planned_model_evaluations\"" in source
    assert "\"model_coverage\"" in source
    assert "active-8 coverage" in source
    assert "5 models" not in source


def test_walk_forward_train_payload_declares_five_day_label_horizon():
    from services.walk_forward_retrain import WalkForwardWindow, build_walk_forward_train_payload

    window = WalkForwardWindow(
        window_id=7,
        train_start="2026-01-02",
        train_end="2026-03-31",
        test_start="2026-04-01",
        test_end="2026-04-30",
    )

    payload = build_walk_forward_train_payload(window, batch_count=5)

    assert payload["label_horizon_days"] == 5
    assert payload["train_end"] == "2026-03-31"
    assert payload["test_start"] == "2026-04-01"


def test_modal_walk_forward_orchestrator_no_longer_defaults_tree_only():
    source = (ROOT / "ml-service" / "modal_app.py").read_text(encoding="utf-8")

    assert "from app.model_serving_contract import ALPHA_PREDICTION_MODELS" in source
    assert "active8_models = list(ALPHA_PREDICTION_MODELS)" in source
    assert "family_tasks" in source
    assert "oof_fold_ready" in source
    assert "payload.get(\"models\") or active8_models" in source
    assert "payload.get(\"models\") or [\"XGBoost\", \"ExtraTrees\", \"LightGBM\"]" not in source


def test_oof_automatic_promotion_is_owner_specific_and_uses_packet_gate():
    source = (ROOT / "ml-controller" / "routers" / "walk_forward.py").read_text(encoding="utf-8")

    assert 'l4_promotion_allowed = bool(' in source
    assert '(owner_parity.get("l4_alpha_ev") or {}).get("decision") == "PASS"' in source
    assert 'fusion_tier == "primary"' in source
    assert '(owner_parity.get("allocator_ev_fusion") or {}).get("decision") == "PASS"' in source
    assert '"/api/admin/config/expected-return/promote"' in source
    assert '"promoted_by_owner"' in source
    promotion_block = source[source.index("if req.promote and l4_promotion_allowed"):source.index("full_fit_dispatch = full_fit_plan")]
    assert '"/api/admin/config",' not in promotion_block
    assert "archive_ev_candidate_artifacts" in source
    assert "owner-specific purged OOF quality and native operational parity PASS" in source


def test_walk_forward_routes_long_sequence_v3_prep_into_every_oof_fold():
    router_source = (ROOT / "ml-controller" / "routers" / "walk_forward.py").read_text(encoding="utf-8")
    modal_source = (ROOT / "ml-service" / "modal_app.py").read_text(encoding="utf-8")

    assert 'sequence_gcs_prefix: str = "universal/sequence_long/latest"' in router_source
    assert '"sequence_gcs_prefix": req.sequence_gcs_prefix' in router_source
    assert '"prep_gcs_prefix": str(payload.get("prep_gcs_prefix") or "universal")' in modal_source
    assert "prep_gcs_prefix=prep_gcs_prefix" in modal_source
    assert 'gcs_prefix = f"walk_forward/oof_cohorts/{cohort_id}/w{wid}"' in modal_source
    assert '"sequence_batch_count": req.sequence_batch_count' in router_source
    assert "active8_oof_sequence_manifest_contract_invalid" in modal_source
    assert "active8_oof_sequence_v3_records_missing" in modal_source
    assert '"verification": "manifest_bytes_and_all_batch_sha256_v1"' in modal_source
    assert '"schema_version": "active8-oof-cohort-manifest-v5"' in modal_source
    assert '"source_prep_manifest_checksum": prep_manifest_checksum' in modal_source
    assert '"source_sequence_manifest_checksum": sequence_manifest_evidence["artifact_checksum"]' in modal_source
    assert "canonical-adjusted-close-net-v4" in modal_source
    assert "feature_semantic_version" in modal_source
    assert "producer_source_sha" in modal_source
    assert '"version": f"{cohort_id}-w{wid}"' in modal_source
    assert 'version = payload.get("output_model_version") or payload.get("version", "v1")' in modal_source
    assert 'generation_mode=payload.get("generation_mode")' in modal_source
    assert 'cohort_id=payload.get("cohort_id")' in modal_source
    assert 'test_start=payload.get("test_start")' in modal_source


def test_walk_forward_calendar_reader_does_not_hydrate_backtest_dataset(monkeypatch):
    from routers import walk_forward
    from services import d1_client

    captured = {}

    def fake_query(sql, params=None):
        captured["sql"] = sql
        captured["params"] = params
        return [
            {"trading_date": "2026-07-04", "price_rows": 1},
            {"trading_date": "2026-07-06", "price_rows": 2300},
            {"trading_date": "2026-07-07", "price_rows": 2310},
        ]

    monkeypatch.setattr(walk_forward.MARKET_D1_CLIENT, "query", fake_query)

    days, access = walk_forward._load_trading_calendar("2026-07-01", "2026-07-07")

    assert days == ["2026-07-06", "2026-07-07"]
    assert captured["params"] == ["2026-07-01", "2026-07-07"]
    assert "GROUP BY substr(date, 1, 10)" in captured["sql"]
    assert access["mode"] == "d1_stock_prices_grouped"
    assert access["observed_price_rows"] == 4611
    assert access["coverage_reference_rows"] == 2300.0
    assert access["coverage_threshold_rows"] == 460
    assert access["excluded_low_coverage_dates"] == [
        {"date": "2026-07-04", "price_rows": 1}
    ]
    assert access["training_data_source"] == "immutable_gcs_prep"

    source = (ROOT / "ml-controller" / "routers" / "walk_forward.py").read_text(encoding="utf-8")
    assert "BacktestDataset.load_for_research" not in source


def test_walk_forward_dry_run_builds_windows_from_lightweight_calendar(monkeypatch):
    from routers import walk_forward

    trading_days = [f"2026-01-{day:02d}" for day in range(1, 21)]
    monkeypatch.setattr(
        walk_forward,
        "_load_trading_calendar",
        lambda _start, _end: (trading_days, {"mode": "d1_stock_prices_grouped"}),
    )

    result = asyncio.run(walk_forward.walk_forward_dry_run(walk_forward.WalkForwardRequest(
        start_date="2026-01-01",
        end_date="2026-01-20",
        train_window_days=10,
        test_window_days=5,
    )))

    assert result["windows_count"] == 2
    assert result["windows"][0]["train_range"] == ("2026-01-01", "2026-01-10")
    assert result["windows"][0]["test_range"] == ("2026-01-11", "2026-01-15")
    assert result["data_access"]["mode"] == "d1_stock_prices_grouped"


def test_resume_plan_reuses_only_exact_parent_splits(monkeypatch):
    from services import active8_oof_cohort_materializer
    from services import walk_forward_retrain
    from services.backtest_engine import WalkForwardWindow
    from routers import walk_forward

    manifest = {
        "cohort_id": "parent",
        "manifest_checksum": "a" * 64,
        "model_set": [
            "LightGBM", "XGBoost", "ExtraTrees", "TabM",
            "GNN", "DLinear", "PatchTST", "iTransformer",
        ],
        "prep_gcs_prefix": "prep-v3",
        "sequence_gcs_prefix": "sequence-v3",
        "windows": [{
            "window_id": 0,
            "train_range": ["2026-01-01", "2026-03-31"],
            "test_range": ["2026-04-01", "2026-04-14"],
        }],
    }
    monkeypatch.setattr(walk_forward_retrain, "_get_bucket", lambda: object())
    monkeypatch.setattr(
        active8_oof_cohort_materializer,
        "load_verified_oof_manifest",
        lambda _path, bucket, **_kwargs: (manifest, b"{}"),
    )
    windows = [
        WalkForwardWindow(0, "2025-12-15", "2026-03-14", "2026-03-15", "2026-03-31"),
        WalkForwardWindow(1, "2026-01-01", "2026-03-31", "2026-04-01", "2026-04-14"),
    ]

    plan = walk_forward._load_resume_plan(
        "parent/manifest.json",
        windows,
        models=manifest["model_set"],
        prep_gcs_prefix="prep-v3",
        sequence_gcs_prefix="sequence-v3",
    )

    assert plan["reused_window_ids"] == [1]
    assert plan["new_window_ids"] == [0]
    assert plan["parent_manifest_checksum"] == "a" * 64


def test_modal_resume_contract_verifies_artifacts_before_pending_fold_training():
    source = (ROOT / "ml-service" / "modal_app.py").read_text(encoding="utf-8")
    assert "active8_oof_resume_artifact_checksum_mismatch" in source
    assert "active8_oof_resume_artifact_metadata_mismatch" in source
    assert "active8_oof_resume_coverage_missing" in source
    assert "active8_oof_resume_coverage_invalid" in source
    assert "active8_oof_resume_coverage_semantics_missing" in source
    assert "active8_oof_resume_coverage_mode_missing" in source
    assert 'coverage_semantics == "unspecified"' in source
    assert '"coverage_gate_semantics": metrics.get("coverage_gate_semantics")' in source
    assert "parent_window.get(\"source_fold_id\") or f\"w{int(parent_window['window_id'])}\"" in source
    assert 'reused_window["source_fold_id"] = source_fold_id' in source
    assert "pending_windows = [" in source
    assert "asyncio.gather(*[_bounded(w) for w in pending_windows])" in source
    assert '"active8-oof-cohort-manifest-v5"' in source
    assert 'method="outer_purged_walk_forward_rank_ic"' in source
    assert '"full_fit_eligible_models"' in source
    assert 'stage="promotion"' in source

def test_oof_lifecycle_capacity_matches_five_purged_folds():
    from routers import walk_forward
    from services.backtest_engine import walk_forward_windows

    mature_dates = [f"2026-{index // 28 + 1:02d}-{index % 28 + 1:02d}" for index in range(110)]
    windows = walk_forward_windows(
        mature_dates,
        train_window_days=walk_forward.OOF_TRAIN_SESSIONS,
        test_window_days=walk_forward.OOF_TEST_SESSIONS,
    )

    assert len(windows) == walk_forward.OOF_PROMOTION_MIN_FOLDS == 5
    assert walk_forward.OOF_LIFECYCLE_MIN_SESSIONS == 110


def test_oof_lifecycle_calendar_uses_checksum_verified_immutable_prep():
    import hashlib
    import io
    import json

    import numpy as np

    from routers import walk_forward

    prefix = "universal/canonical_adjusted_v6/test"
    batch_path = f"{prefix}/prep/batch_0.npz"
    buffer = io.BytesIO()
    np.savez_compressed(
        buffer,
        dates=np.asarray(["2026-07-08", "2026-07-09", "2026-07-10"], dtype=object),
        markets=np.asarray(["LISTED", "OTC", "LISTED"], dtype=object),
        label_known_dates=np.asarray(["2026-07-15", "2026-07-16", "2026-07-20"], dtype=object),
    )
    batch_raw = buffer.getvalue()
    manifest = {
        "schema_version": "active8-canonical-adjusted-prep-v3",
        "status": "ready",
        "output_gcs_prefix": prefix,
        "sequence_gcs_prefix": "universal/sequence_long/test",
        "target_semantic_version": walk_forward._OOF_TARGET_SEMANTIC_VERSION,
        "feature_semantic_version": walk_forward.OOF_FEATURE_SEMANTIC_VERSION,
        "feature_imputation_semantic": walk_forward.OOF_FEATURE_IMPUTATION_SEMANTIC_VERSION,
        "producer_source_sha": TEST_SOURCE_SHA,
        "roundtrip_cost_bps": 18.0,
        "batch_rows": [3],
        "output_checksums": {batch_path: hashlib.sha256(batch_raw).hexdigest()},
    }
    manifest["manifest_checksum"] = hashlib.sha256(
        json.dumps(manifest, sort_keys=True).encode("utf-8")
    ).hexdigest()

    class Blob:
        def __init__(self, raw: bytes):
            self.raw = raw

        def download_as_bytes(self):
            return self.raw

        def download_as_text(self):
            return self.raw.decode("utf-8")

    class Bucket:
        def __init__(self):
            self.blobs = {
                f"{prefix}/prep/manifest.json": Blob(json.dumps(manifest).encode("utf-8")),
                batch_path: Blob(batch_raw),
            }

        def blob(self, path):
            return self.blobs[path]

    dates, evidence = walk_forward._oof_lifecycle_calendar(
        "2026-07-17",
        bucket=Bucket(),
        prep_gcs_prefix=prefix,
    )

    assert dates == ["2026-07-08", "2026-07-09"]
    assert evidence["calendar_source"] == "immutable_canonical_adjusted_prep"
    assert evidence["mature_rows"] == 2
    assert evidence["prep_manifest_checksum"] == manifest["manifest_checksum"]
    assert evidence["sequence_gcs_prefix"] == "universal/sequence_long/test"

def test_full_fit_plan_blocks_legacy_manifest_without_immutable_prep():
    from routers.walk_forward import build_oof_full_fit_dispatch_plan

    plan = build_oof_full_fit_dispatch_plan({
        "schema_version": "active8-oof-cohort-manifest-v2",
        "aggregate": {
            "oof_ready_folds": 5,
            "full_fit_eligible_models": ["DLinear"],
            "per_model_promotion_evidence": {
                "DLinear": {"decision": "PASS", "failed_gates": []},
            },
        },
    })

    assert plan["status"] == "blocked"
    assert plan["evidence_missing"]
    assert plan["reason"] == "release_model_oof_evidence_missing"
    assert plan["prep_lineage_ready"] is False


def test_oof_full_fit_feature_consensus_uses_outer_fold_majority_vote():
    from routers.walk_forward import build_oof_full_fit_feature_consensus

    manifest = {
        "cohort_id": "cohort-1",
        "manifest_checksum": "a" * 64,
        "target_semantic_version": "target-v4",
        "aggregate": {"oof_ready_folds": 5},
        "windows": [
            {
                "window_id": idx,
                "fs_result": {
                    "feature_pool": {
                        "tree_active": [
                            *[f"stable_{feature_idx}" for feature_idx in range(12)],
                            f"fold_only_{idx}",
                        ]
                    }
                },
            }
            for idx in range(5)
        ],
    }

    first = build_oof_full_fit_feature_consensus(manifest)
    second = build_oof_full_fit_feature_consensus(manifest)

    assert first == second
    assert first["status"] == "ready"
    assert first["selection_method"] == "outer_fold_majority_vote"
    assert first["fold_count"] == 5
    assert first["min_votes"] == 3
    assert first["selected_count"] == 12
    assert first["tree_active"] == sorted(f"stable_{idx}" for idx in range(12))
    assert len(first["artifact_checksum"]) == 64


def test_oof_full_fit_plan_blocks_incomplete_exact_eight_before_feature_lineage():
    from routers.walk_forward import build_oof_full_fit_dispatch_plan

    target = "next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4"
    plan = build_oof_full_fit_dispatch_plan({
        "schema_version": "active8-oof-cohort-manifest-v5",
        "target_semantic_version": target,
        "prep_manifest": {
            "manifest_checksum": "a" * 64,
            "target_semantic_version": target,
            "roundtrip_cost_bps": 18.0,
            "batch_count": 5,
            "schema_version": "active8-canonical-adjusted-prep-v3",
            "feature_semantic_version": "formal137-pit-rolling-rank-and-imputation-v2",
            "feature_imputation_semantic": "prior_252_row_median_then_zero_v2",
            "producer_source_sha": TEST_SOURCE_SHA,
        },
        "sequence_manifest": {
            "artifact_checksum": "b" * 64,
            "contract": "sequence_records_v3",
            "target_semantic_version": target,
            "batch_count": 1,
            "batch_checksums": {"batch": "c" * 64},
        },
        "aggregate": {
            "oof_ready_folds": 5,
            "full_fit_eligible_models": ["XGBoost"],
            "per_model_promotion_evidence": {"XGBoost": {"decision": "PASS"}},
        },
        "windows": [],
    })

    assert plan["status"] == "blocked"
    assert plan["reason"] == "release_model_oof_evidence_missing"
    assert plan["evidence_missing"]

def test_completed_oof_registry_owner_repair_requires_exact_bound_identity(monkeypatch):
    import json

    from routers import walk_forward
    from services import model_artifact_registry

    writes = []
    expected_models = ["DLinear", "XGBoost"]
    payload = {
        "run_id": "universal-oof-owner",
        "status": "completed",
        "candidate_version": "v20260717",
        "promotion_eligible_models": expected_models,
        "oof_lifecycle_resume": {
            "schema_version": "active8-oof-lifecycle-resume-v1",
            "cohort_id": "cohort-v3",
            "source_manifest_checksum": "a" * 64,
            "knowledge_cutoff_date": "2026-07-17",
        },
    }

    monkeypatch.setattr(
        model_artifact_registry,
        "hydrate_retrain_followup_artifact_metadata",
        lambda value: value,
    )
    monkeypatch.setattr(
        model_artifact_registry,
        "build_artifact_records_from_retrain_followup",
        lambda _value: [
            {"model_name": name, "training_run_id": "universal-oof-owner"}
            for name in expected_models
        ],
    )
    monkeypatch.setattr(
        model_artifact_registry,
        "upsert_artifact_records",
        lambda records: writes.append(records) or {
            "attempted": len(records),
            "written": len(records),
            "errors": [],
        },
    )

    result = walk_forward._repair_completed_oof_registry_owner(
        payload_summary=json.dumps(payload),
        expected_run_id="universal-oof-owner",
        expected_cohort_id="cohort-v3",
        expected_manifest_checksum="a" * 64,
        expected_knowledge_cutoff_date="2026-07-17",
        expected_models=expected_models,
        expected_promotion_models=expected_models,
    )

    assert result == {
        "status": "repaired",
        "run_id": "universal-oof-owner",
        "models": expected_models,
        "written": 2,
    }
    assert len(writes) == 1

    rejected = walk_forward._repair_completed_oof_registry_owner(
        payload_summary=json.dumps(payload),
        expected_run_id="universal-oof-owner",
        expected_cohort_id="cohort-v3",
        expected_manifest_checksum="b" * 64,
        expected_knowledge_cutoff_date="2026-07-17",
        expected_models=expected_models,
        expected_promotion_models=expected_models,
    )
    assert rejected["status"] == "rejected"
    assert rejected["reason"] == "callback_lifecycle_identity_mismatch"
    assert len(writes) == 1


def test_full_fit_registry_reads_are_learning_domain_owned():
    source = (
        ROOT / "ml-controller" / "routers" / "walk_forward.py"
    ).read_text(encoding="utf-8")
    dispatcher = source[
        source.index("async def dispatch_oof_full_fit_training("):
        source.index("def _without_frozen_forward_rows(")
    ]

    assert "LEARNING_D1_CLIENT.query(" in dispatcher
    assert "d1_client.query(" not in dispatcher

def test_full_fit_poll_only_bootstraps_first_receipt_without_replacement(monkeypatch):
    from routers import walk_forward
    import json

    uploaded = []

    class Blob:
        def exists(self):
            return False

        def upload_from_string(self, value, content_type=None):
            uploaded.append({"value": json.loads(value), "content_type": content_type})

    class Bucket:
        def blob(self, _path):
            return Blob()

    plan = {
        "status": "ready",
        "release_models": ["DLinear"],
        "promotion_eligible_models": ["DLinear"],
        "tree_models": [],
        "feature_consensus": {},
        "train_model_groups": ["sequence"],
        "artifact_lifecycle_targets": [],
        "promotion_evidence": {"DLinear": {"decision": "PASS"}},
    }
    monkeypatch.setattr(
        walk_forward,
        "build_oof_full_fit_dispatch_plan",
        lambda _manifest: plan,
    )
    dispatched = []

    async def fake_trigger(payload, request=None, **kwargs):
        dispatched.append(payload)
        return {"status": "dispatched", "run_id": "universal-oof-owner"}

    from routers import retrain_trigger
    monkeypatch.setattr(retrain_trigger, "trigger_universal_retrain", fake_trigger)

    result = asyncio.run(walk_forward.dispatch_oof_full_fit_training(
        manifest={"cohort_id": "cohort-v3", "manifest_checksum": "a" * 64},
        knowledge_cutoff_date="2026-07-17",
        bucket=Bucket(),
        lifecycle_cadence="weekly",
        allow_new_dispatch=False,
    ))

    assert result["status"] == "dispatched"
    assert result["run_id"] == "universal-oof-owner"
    assert result["retry_required"] is True
    assert len(dispatched) == 1
    assert uploaded[0]["value"]["status"] == "dispatched"
    assert uploaded[0]["value"]["run_id"] == "universal-oof-owner"

def test_dispatch_completed_oof_callback_repairs_registry_without_retraining(monkeypatch):
    from routers import walk_forward

    receipt = {
        "status": "blocked",
        "run_id": "universal-oof-owner",
        "attempt": 3,
    }
    uploaded = []

    class Blob:
        def exists(self):
            return True

        def download_as_text(self):
            import json
            return json.dumps(receipt)

        def upload_from_string(self, value, content_type=None):
            import json
            uploaded.append({"value": json.loads(value), "content_type": content_type})

    class Bucket:
        def blob(self, path):
            assert path == "walk_forward/oof_cohorts/cohort-v3/full_fit/2026-07-17.json"
            return Blob()

    plan = {
        "status": "ready",
        "release_models": ["DLinear"],
        "promotion_eligible_models": ["DLinear"],
        "tree_models": [],
        "feature_consensus": {},
        "train_model_groups": ["sequence"],
        "artifact_lifecycle_targets": [],
        "promotion_evidence": {"DLinear": {"decision": "PASS"}},
    }
    queries = []

    def fake_query(sql, params=None):
        queries.append(sql)
        if "FROM webhook_log" in sql:
            return [{"status": "completed", "payload_summary": "{}"}]
        owner_queries = sum("FROM model_artifact_registry" in query for query in queries)
        return (
            [{
                "model_name": "DLinear",
                "candidate_type": "weekly_drift",
                "state": "offline_strong_pass",
            }]
            if owner_queries == 1
            else [{
                "model_name": "DLinear",
                "candidate_type": "oof_full_fit_release",
                "state": "offline_failed",
            }]
        )

    monkeypatch.setattr(walk_forward, "build_oof_full_fit_dispatch_plan", lambda _manifest: plan)
    monkeypatch.setattr(
        walk_forward,
        "_repair_completed_oof_registry_owner",
        lambda **_kwargs: {
            "status": "repaired",
            "run_id": "universal-oof-owner",
            "models": ["DLinear"],
            "written": 1,
        },
    )
    monkeypatch.setattr(walk_forward.LEARNING_D1_CLIENT, "query", fake_query)
    monkeypatch.setattr(walk_forward.OPS_D1_CLIENT, "query", fake_query)
    monkeypatch.setattr(
        walk_forward,
        "_materialize_completed_oof_release_aliases",
        lambda **_kwargs: {
            "status": "materialized",
            "candidate_type": "oof_full_fit_release",
            "written": 1,
        },
    )

    result = asyncio.run(walk_forward.dispatch_oof_full_fit_training(
        manifest={"cohort_id": "cohort-v3", "manifest_checksum": "a" * 64},
        knowledge_cutoff_date="2026-07-17",
        bucket=Bucket(),
        lifecycle_cadence="weekly",
    ))

    assert result["status"] == "completed"
    assert result["retry_required"] is False
    assert result["artifact_states"] == {"DLinear": "offline_failed"}
    assert result["registry_repair"]["status"] == "repaired"
    assert result["release_registry"]["candidate_type"] == "oof_full_fit_release"
    assert uploaded[-1]["value"]["status"] == "completed"
    assert uploaded[-1]["value"]["retry_required"] is False
    assert uploaded[-1]["value"]["missing_models"] == []
    assert uploaded[-1]["value"]["reason"] == "artifact_registry_complete"



def test_oof_source_selector_requires_exact_release_alias_even_when_individual_oof_fails():
    from routers import walk_forward

    selected = walk_forward._select_oof_full_fit_source_rows(
        [
            {"model_name": "DLinear", "candidate_type": "oof_full_fit_release", "state": "offline_failed"},
            {"model_name": "DLinear", "candidate_type": "weekly_drift", "state": "offline_strong_pass"},
        ],
        ["DLinear"],
    )

    assert selected["DLinear"]["candidate_type"] == "oof_full_fit_release"
    assert selected["DLinear"]["state"] == "offline_failed"


def test_dispatch_reuses_completed_full_fit_receipt_across_cadences(monkeypatch):
    import json
    from routers import walk_forward

    receipt = {
        "schema_version": "active8-oof-full-fit-receipt-v1",
        "status": "completed",
        "cohort_id": "cohort-v3",
        "knowledge_cutoff_date": "2026-07-17",
        "run_id": "universal-oof-owner",
        "attempt": 3,
        "release_models": ["DLinear"],
        "promotion_eligible_models": ["DLinear"],
        "artifact_states": {"DLinear": "offline_strong_pass"},
        "missing_models": [],
        "failed_models": [],
        "retry_required": False,
        "release_registry": {
            "status": "materialized",
            "candidate_type": "oof_full_fit_release",
            "failed_models": ["DLinear"],
            "validation_schema_version": "active8-oof-ensemble-validation-v1",
            "selection_method": "learned_chronological_oof_ensemble",
            "selection_policy_version": "active8-ensemble-conformal-isotonic-v1",
            "ensemble_candidate": {
                "status": "persisted",
                "artifact_id": "active8-ensemble:cohort-v3:1234",
                "payload_checksum": "c" * 64,
            },
        },
    }

    class Blob:
        def exists(self):
            return True

        def download_as_text(self):
            return json.dumps(receipt)

        def upload_from_string(self, _value, content_type=None):
            raise AssertionError("completed immutable receipt must not be rewritten")

    class Bucket:
        def blob(self, path):
            assert path == "walk_forward/oof_cohorts/cohort-v3/full_fit/2026-07-17.json"
            return Blob()

    plan = {
        "status": "ready",
        "release_models": ["DLinear"],
        "promotion_eligible_models": ["DLinear"],
        "tree_models": [],
        "feature_consensus": {},
        "train_model_groups": ["sequence"],
        "artifact_lifecycle_targets": [],
        "promotion_evidence": {"DLinear": {"decision": "PASS"}},
    }
    monkeypatch.setattr(walk_forward, "build_oof_full_fit_dispatch_plan", lambda _manifest: plan)
    monkeypatch.setattr(
        walk_forward.LEARNING_D1_CLIENT,
        "query",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("completed immutable receipt must not query mutable registry state")
        ),
    )

    result = asyncio.run(walk_forward.dispatch_oof_full_fit_training(
        manifest={"cohort_id": "cohort-v3", "manifest_checksum": "a" * 64},
        knowledge_cutoff_date="2026-07-17",
        bucket=Bucket(),
        lifecycle_cadence="weekly",
    ))

    assert result["status"] == "completed"
    assert result["retry_required"] is False
    assert result["reason"] == "immutable_full_fit_receipt_complete"
    assert result["release_registry"]["failed_models"] == ["DLinear"]


def test_dispatch_reuses_terminal_ensemble_validation_block_and_repairs_projection(monkeypatch):
    import json
    from routers import walk_forward

    receipt = {
        "schema_version": "active8-oof-full-fit-receipt-v1",
        "status": "blocked",
        "reason": "active8_ensemble_validation_failed",
        "cohort_id": "cohort-v3",
        "knowledge_cutoff_date": "2026-07-17",
        "run_id": "universal-oof-owner",
        "release_models": ["DLinear"],
        "promotion_eligible_models": ["DLinear"],
        "artifact_states": {"DLinear": "offline_strong_pass"},
        "missing_models": [],
        "training_failed_models": [],
        "retry_required": False,
        "release_registry": {
            "status": "blocked",
            "reason": "active8_ensemble_validation_failed",
            "retry_required": False,
            "validation_schema_version": "active8-oof-ensemble-validation-v1",
            "validation": {
                "schema_version": "active8-oof-ensemble-validation-v1",
                "decision": "FAIL",
                "failed_gates": ["chronological_validation_equal_date_market_rank_ic_lcb90_non_positive"],
            },
        },
    }

    class Blob:
        def exists(self):
            return True

        def download_as_text(self):
            return json.dumps(receipt)

        def upload_from_string(self, _value, content_type=None):
            raise AssertionError("terminal validation receipt must remain immutable")

    class Bucket:
        def blob(self, path):
            assert path == "walk_forward/oof_cohorts/cohort-v3/full_fit/2026-07-17.json"
            return Blob()

    plan = {
        "status": "ready",
        "release_models": ["DLinear"],
        "promotion_eligible_models": ["DLinear"],
        "tree_models": [],
        "feature_consensus": {},
        "train_model_groups": ["sequence"],
        "artifact_lifecycle_targets": [],
        "promotion_evidence": {"DLinear": {"decision": "PASS"}},
    }
    monkeypatch.setattr(walk_forward, "build_oof_full_fit_dispatch_plan", lambda _manifest: plan)
    artifact_row = {
        "artifact_id": "DLinear:v1:oof_full_fit_release",
        "model_name": "DLinear",
        "version": "v1",
        "checksum": "sha256:" + "b" * 64,
        "artifact_path": "gs://models/dlinear/v1.pt",
        "metadata_path": "gs://models/dlinear/v1.json",
        "candidate_type": "oof_full_fit_release",
        "training_run_id": "universal-oof-owner",
        "state": "offline_strong_pass",
        "offline_evidence_json": "{}",
    }
    monkeypatch.setattr(walk_forward.LEARNING_D1_CLIENT, "query", lambda *_args, **_kwargs: [artifact_row])
    persisted = []
    from services import active8_ensemble_repository
    monkeypatch.setattr(
        active8_ensemble_repository,
        "persist_active8_ensemble_validation_attempt",
        lambda validation, **kwargs: persisted.append((validation, kwargs)) or {
            "status": "persisted",
            "attempt_id": "attempt-v1",
            "validation_decision": "FAIL",
            "production_effect": False,
        },
    )

    result = asyncio.run(walk_forward.dispatch_oof_full_fit_training(
        manifest={"cohort_id": "cohort-v3", "manifest_checksum": "a" * 64},
        knowledge_cutoff_date="2026-07-17",
        bucket=Bucket(),
        lifecycle_cadence="monthly",
        allow_new_dispatch=False,
    ))

    assert result["status"] == "blocked"
    assert result["reason"] == "active8_ensemble_validation_failed"
    assert result["retry_required"] is False
    assert result["release_registry"]["validation"]["decision"] == "FAIL"
    assert result["validation_attempt"]["attempt_id"] == "attempt-v1"
    assert len(persisted) == 1
    assert persisted[0][1]["base_artifacts"] == {"DLinear": artifact_row}
    assert persisted[0][1]["training_run_id"] == "universal-oof-owner"

def test_dispatch_recovers_retry_limit_pollution_from_terminal_evidence(monkeypatch):
    import hashlib
    import json
    from routers import walk_forward

    terminal = json.dumps({"status": "completed", "run_id": "universal-oof-owner"}, sort_keys=True)
    receipt = {
        "schema_version": "active8-oof-full-fit-receipt-v1",
        "status": "blocked",
        "reason": "full_fit_retry_limit_reached",
        "cohort_id": "cohort-v3",
        "knowledge_cutoff_date": "2026-07-17",
        "run_id": "universal-oof-owner",
        "attempt": 3,
        "release_models": ["DLinear"],
        "promotion_eligible_models": ["DLinear"],
        "artifact_states": {"DLinear": "offline_strong_pass"},
        "missing_models": [],
        "failed_models": ["DLinear"],
        "retry_required": True,
        "release_registry": {
            "status": "materialized",
            "failed_models": ["DLinear"],
            "validation_schema_version": "active8-oof-ensemble-validation-v1",
            "selection_method": "learned_chronological_oof_ensemble",
            "selection_policy_version": "active8-ensemble-conformal-isotonic-v1",
            "ensemble_candidate": {
                "status": "persisted",
                "artifact_id": "active8-ensemble:cohort-v3:1234",
                "payload_checksum": "c" * 64,
            },
        },
        "terminal_payload_path": "terminal.json",
        "terminal_payload_checksum": hashlib.sha256(terminal.encode("utf-8")).hexdigest(),
    }
    uploaded = []

    class Blob:
        def __init__(self, value):
            self.value = value

        def exists(self):
            return True

        def download_as_text(self):
            return self.value

        def upload_from_string(self, value, content_type=None):
            uploaded.append({"value": json.loads(value), "content_type": content_type})

    class Bucket:
        def blob(self, path):
            if path == "terminal.json":
                return Blob(terminal)
            assert path == "walk_forward/oof_cohorts/cohort-v3/full_fit/2026-07-17.json"
            return Blob(json.dumps(receipt))

    plan = {
        "status": "ready",
        "release_models": ["DLinear"],
        "promotion_eligible_models": ["DLinear"],
        "tree_models": [],
        "feature_consensus": {},
        "train_model_groups": ["sequence"],
        "artifact_lifecycle_targets": [],
        "promotion_evidence": {"DLinear": {"decision": "PASS"}},
    }
    monkeypatch.setattr(walk_forward, "build_oof_full_fit_dispatch_plan", lambda _manifest: plan)
    monkeypatch.setattr(
        walk_forward.LEARNING_D1_CLIENT,
        "query",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("terminal-evidence recovery must not query mutable registry state")
        ),
    )

    result = asyncio.run(walk_forward.dispatch_oof_full_fit_training(
        manifest={"cohort_id": "cohort-v3", "manifest_checksum": "a" * 64},
        knowledge_cutoff_date="2026-07-17",
        bucket=Bucket(),
        lifecycle_cadence="weekly",
    ))

    assert result["status"] == "completed"
    assert result["retry_required"] is False
    assert result["failed_models"] == ["DLinear"]
    assert uploaded[-1]["value"]["status"] == "completed"
    assert uploaded[-1]["value"]["failed_models"] == ["DLinear"]

def _retired_completed_oof_release_alias_preserves_immutable_lineage(monkeypatch):
    import json
    from routers import walk_forward
    from services import model_artifact_registry as registry

    written = []
    monkeypatch.setattr(registry, "upsert_artifact_record", lambda row: written.append(row))
    windows = [
        {
            "window_id": idx,
            "train_range": ["2026-01-01", f"2026-04-{10 + idx:02d}"],
            "test_range": [
                f"2026-04-{11 + idx * 2:02d}",
                f"2026-04-{12 + idx * 2:02d}",
            ],
        }
        for idx in range(5)
    ]
    evidence = {
        "schema_version": "model-cpcv-evidence-v1",
        "method": "outer_purged_walk_forward_rank_ic",
        "decision": "PASS",
        "passed": True,
        "failed_gates": [],
        "folds": 5,
        "min_test_rows": 100,
        "coverage_mean": 1.0,
    }
    result = walk_forward._materialize_completed_oof_release_aliases(
        manifest={
            "schema_version": "active8-oof-cohort-manifest-v5",
            "cohort_id": "active8-oof-v5",
            "manifest_checksum": "a" * 64,
            "target_semantic_version": registry.ACTIVE8_TARGET_SEMANTIC_VERSION,
            "prep_manifest": {
                "feature_semantic_version": walk_forward.OOF_FEATURE_SEMANTIC_VERSION,
                "feature_imputation_semantic": walk_forward.OOF_FEATURE_IMPUTATION_SEMANTIC_VERSION,
                "producer_source_sha": TEST_SOURCE_SHA,
            },
            "windows": windows,
        },
        registry_rows=[{
            "artifact_id": "XGBoost:vOOF:oof_full_fit_release",
            "model_name": "XGBoost",
            "version": "vOOF",
            "candidate_type": "oof_full_fit_release",
            "state": "offline_strong_pass",
            "artifact_path": "universal/xgboost/vOOF.joblib",
            "checksum": "sha256:verified",
            "training_run_id": "oof-owner",
            "offline_gate_decision": "PASS",
            "offline_evidence_json": json.dumps({
                "registration": {
                    "metadata": {
                        "target_semantic_version": registry.ACTIVE8_TARGET_SEMANTIC_VERSION,
                    },
                    "oof_promotion_evidence": evidence,
                },
            }),
        }],
        expected_run_id="oof-owner",
        knowledge_cutoff_date="2026-07-09",
        lifecycle_cadence="weekly",
        eligible_models=["XGBoost"],
        release_validation_by_model={
            "XGBoost": {
                "schema_version": "active8-oof-base-ranker-release-validation-v3",
                "validation_role": "base_ranker",
                "decision": "PASS",
                "failed_gates": [],
                "base_artifact_authority": {
                    "decision": "PASS",
                    "owner": "individual_outer_purged_oof",
                    "effect": "base_artifact_release_only",
                },
                "selection_authority": {
                    "scope": "cohort_model_selection_process",
                    "method": "label_interval_purged_cscv_rank_logit",
                    "effect": "automatic_champion_selection_and_ensemble_weighting_only",
                    "decision": "PASS",
                },
                "pbo": {
                    "scope": "cohort_model_selection_process",
                    "method": "label_interval_purged_cscv_rank_logit",
                    "go_live_verdict": "PASS",
                    "pbo": 0.2,
                    "max_pbo": 0.3,
                },
            },
        },
    )

    assert result["status"] == "materialized"
    assert result["written"] == 1
    assert result["passed_models"] == ["XGBoost"]
    assert result["failed_models"] == []
    assert result["selection_blocked_models"] == []
    row = written[0]
    assert row["candidate_type"] == "oof_full_fit_release"
    assert row["artifact_id"] == "XGBoost:vOOF:oof_full_fit_release"
    offline = json.loads(row["offline_evidence_json"])
    registration = offline["registration"]
    assert registration["oof_promotion_evidence"]["validation_design"]["chronological"] is True
    assert registration["oof_lifecycle_resume"] == {
        "schema_version": "active8-oof-lifecycle-resume-v1",
        "cohort_id": "active8-oof-v5",
        "source_manifest_checksum": "a" * 64,
        "knowledge_cutoff_date": "2026-07-09",
        "cadence": "weekly",
    }



def _retired_completed_oof_release_alias_keeps_valid_base_when_selection_pbo_fails(monkeypatch):
    import json
    from routers import walk_forward
    from services import model_artifact_registry as registry

    written = []
    monkeypatch.setattr(registry, "upsert_artifact_record", lambda row: written.append(row))
    windows = [
        {
            "window_id": idx,
            "train_range": ["2026-01-01", f"2026-04-{10 + idx:02d}"],
            "test_range": [
                f"2026-04-{11 + idx * 2:02d}",
                f"2026-04-{12 + idx * 2:02d}",
            ],
        }
        for idx in range(5)
    ]
    evidence = {
        "schema_version": "model-cpcv-evidence-v1",
        "method": "outer_purged_walk_forward_rank_ic",
        "decision": "PASS",
        "passed": True,
        "failed_gates": [],
        "folds": 5,
        "min_test_rows": 100,
        "coverage_mean": 1.0,
    }
    source_row = {
        "artifact_id": "DLinear:vOOF:weekly_drift",
        "model_name": "DLinear",
        "version": "vOOF",
        "candidate_type": "weekly_drift",
        "state": "offline_strong_pass",
        "artifact_path": "universal/dlinear/vOOF.pt",
        "checksum": "sha256:verified",
        "training_run_id": "oof-owner",
        "offline_gate_decision": "PASS",
        "offline_evidence_json": json.dumps({
            "registration": {
                "metadata": {
                    "target_semantic_version": registry.ACTIVE8_TARGET_SEMANTIC_VERSION,
                },
                "oof_promotion_evidence": evidence,
            },
        }),
    }
    existing_alias = {
        **source_row,
        "artifact_id": "DLinear:vOOF:oof_full_fit_release",
        "candidate_type": "oof_full_fit_release",
    }
    result = walk_forward._materialize_completed_oof_release_aliases(
        manifest={
            "schema_version": "active8-oof-cohort-manifest-v5",
            "cohort_id": "active8-oof-v5",
            "manifest_checksum": "a" * 64,
            "target_semantic_version": registry.ACTIVE8_TARGET_SEMANTIC_VERSION,
            "prep_manifest": {
                "feature_semantic_version": walk_forward.OOF_FEATURE_SEMANTIC_VERSION,
                "feature_imputation_semantic": walk_forward.OOF_FEATURE_IMPUTATION_SEMANTIC_VERSION,
                "producer_source_sha": TEST_SOURCE_SHA,
            },
            "windows": windows,
        },
        registry_rows=[source_row, existing_alias],
        expected_run_id="oof-owner",
        knowledge_cutoff_date="2026-07-09",
        lifecycle_cadence="weekly",
        eligible_models=["DLinear"],
        release_validation_by_model={
            "DLinear": {
                "schema_version": "active8-oof-base-ranker-release-validation-v3",
                "validation_role": "base_ranker",
                "decision": "PASS",
                "failed_gates": [],
                "base_artifact_authority": {
                    "decision": "PASS",
                    "owner": "individual_outer_purged_oof",
                    "effect": "base_artifact_release_only",
                },
                "selection_authority": {
                    "scope": "cohort_model_selection_process",
                    "method": "label_interval_purged_cscv_rank_logit",
                    "effect": "automatic_champion_selection_and_ensemble_weighting_only",
                    "decision": "FAIL",
                    "failed_gates": ["cohort_model_selection_pbo"],
                },
                "pbo": {
                    "scope": "cohort_model_selection_process",
                    "method": "label_interval_purged_cscv_rank_logit",
                    "go_live_verdict": "FAIL",
                    "pbo": 0.25,
                    "max_pbo": 0.22,
                },
            },
        },
    )

    assert result["written"] == 1
    assert result["passed_models"] == ["DLinear"]
    assert result["failed_models"] == []
    assert result["selection_blocked_models"] == ["DLinear"]
    assert written[0]["state"] == "offline_strong_pass"
    assert written[0]["offline_gate_decision"] == "PASS"
    assert json.loads(written[0]["offline_gate_failed_gates"]) == []
    assert written[0]["promotion_decision"] == "cohort_selection_blocked"


def test_oof_lifecycle_uses_latest_prep_instead_of_stale_parent_contract():
    source = (ROOT / "ml-controller" / "routers" / "walk_forward.py").read_text(encoding="utf-8")

    latest_lookup = '_latest_canonical_prep_prefix(bucket) or ""'
    stale_parent_lookup = 'prep_gcs_prefix = str(parent_manifest.get("prep_gcs_prefix") or "").strip().rstrip("/")'
    assert source.index(latest_lookup) < source.index(stale_parent_lookup)
    assert 'prep_gcs_prefix = "" if exact_producer_source_sha else' in source
    assert "expected_producer_source_sha=exact_producer_source_sha" in source
    assert '                prep_gcs_prefix = str(parent_manifest.get("prep_gcs_prefix") or "")' not in source.splitlines()
    assert 'calendar_evidence.get("sequence_gcs_prefix")' in source

def test_ev_oof_candidates_use_formal_registry_candidate_types():
    source = (ROOT / "ml-controller" / "services" / "active8_oof_cohort_materializer.py").read_text(encoding="utf-8")

    assert '"l4_alpha_ev_refresh"' in source
    assert '"allocator_ev_fusion_refresh"' in source
    archive_block = source[source.index("def archive_ev_candidate_artifacts"):source.index("def persist_oof_cohort")]
    assert '"candidate_type": "model_family_shadow"' not in archive_block
    assert '"identity_schema_version": "expected-return-candidate-identity-v3"' in archive_block
    assert '"artifact_id": f"{model_name}:{model_version}:{checksum}"' in archive_block
    assert '"expected_return_owner": artifact.get("expected_return_owner")' in archive_block
    assert '"model_version": model_version' in archive_block
    assert '"artifact_checksum": checksum' in archive_block
    assert '"cadence": lifecycle_cadence' in archive_block
    router = (ROOT / "ml-controller" / "routers" / "walk_forward.py").read_text(encoding="utf-8")
    assert router.count("lifecycle_cadence=req.lifecycle_cadence") >= 3
    receipt_block = router[router.index("if promoted:"):router.index("full_fit_dispatch = full_fit_plan")]
    assert router.count('"artifact_id": (candidate_artifacts.get(') == 2
    assert "register_candidate=False" in receipt_block
    assert router.count("register_candidate=False") == 1
    assert "and not durable_shadow_base_materialization" in router
    assert "base_trained_until=candidate_trained_until" in router

def test_daily_oof_materialization_reuses_checksum_verified_gcs_indexes():
    from routers.walk_forward import _can_reuse_indexed_oof_base
    from services.active8_oof_cohort_materializer import (
        OOF_PIT_ELIGIBILITY_POLICY_VERSION,
    )

    router = (ROOT / "ml-controller" / "routers" / "walk_forward.py").read_text(encoding="utf-8")
    materializer = (ROOT / "ml-controller" / "services" / "active8_oof_cohort_materializer.py").read_text(encoding="utf-8")
    checksum = "a" * 64
    persisted = [{"status": "ready", "prediction_storage_mode": "gcs_indexed_v1"}]
    indexes = [
        {
            "artifact_kind": artifact_kind,
            "source_manifest_checksum": checksum,
            "eligibility_policy_version": OOF_PIT_ELIGIBILITY_POLICY_VERSION,
        }
        for artifact_kind in ("allocator_ev_snapshots", "l4_predictions")
    ]

    assert _can_reuse_indexed_oof_base(
        persisted,
        indexes,
        manifest_checksum=checksum,
        policy_version=OOF_PIT_ELIGIBILITY_POLICY_VERSION,
    )
    assert not _can_reuse_indexed_oof_base(
        persisted,
        indexes,
        manifest_checksum="b" * 64,
        policy_version=OOF_PIT_ELIGIBILITY_POLICY_VERSION,
    )

    assert "load_indexed_oof_ev_rows" in router
    indexed_call_start = router.index("indexed_base_rows = load_indexed_oof_ev_rows(")
    indexed_call = router[
        indexed_call_start:
        router.index("if reuse_indexed:", indexed_call_start)
    ]
    assert "query_fn=learning_client.query" in indexed_call
    assert "_indexed_oof_base_semantic_evidence" in indexed_call
    assert 'reuse_indexed = indexed_base_semantic_evidence["compatible"] is True' in indexed_call
    assert 'prediction_storage_mode") == "gcs_indexed_v1"' in router
    assert "len(materialized_indexes) == 2" in router
    assert "OOF_PIT_ELIGIBILITY_POLICY_VERSION" in router
    assert '"source": "checksum_verified_indexed_loader"' in router
    assert "*load_oof_prediction_rows(manifest, bucket=bucket)" in router
    assert '"base_materialization_rewritten": False' in router
    assert '"schema_version": "l4-chronological-oof-indexed-base-plus-forward-v1"' in router
    assert "active8_oof_indexed_snapshot_lineage_mismatch" in materializer
    assert '"d1_full_row_tables_required": False' in materializer

def test_oof_lifecycle_receipt_is_bound_to_active_materialization_policy():
    from routers.walk_forward import (
        OOF_LIFECYCLE_RECEIPT_SCHEMA_VERSION,
        _oof_lifecycle_materialization_controls,
        _oof_lifecycle_receipt_path,
        _oof_lifecycle_receipt_matches_active_policy,
        _without_frozen_forward_rows,
    )
    from services.active8_oof_cohort_materializer import (
        OOF_PIT_ELIGIBILITY_POLICY_VERSION,
    )

    current = {
        "schema_version": OOF_LIFECYCLE_RECEIPT_SCHEMA_VERSION,
        "score_semantic_version": "same-market-same-date-average-tie-percentile-rank-v2",
        "materialization_policy_version": OOF_PIT_ELIGIBILITY_POLICY_VERSION,
        "status": "materialized",
        "cadence": "daily",
        "calendar": {
            "cutoff": "2026-08-07",
            "prep_manifest_checksum": "a" * 64,
            "mature_max_date": "2026-07-31",
            "mature_dates": 111,
        },
        "physical_prediction_coverage": {
            "base_max_date": "2026-07-22",
            "max_date": "2026-07-31",
        },
        "evidence_closure": {
            "materialized": True,
            "candidate_artifacts": True,
        },
        "full_fit_dispatch": {
            "status": "ready",
            "retry_required": False,
        },
    }
    assert _oof_lifecycle_receipt_matches_active_policy(
        current,
        cadence="daily",
        require_full_fit=False,
    )
    assert _oof_lifecycle_receipt_matches_active_policy(
        current,
        cadence="daily",
        require_full_fit=False,
        expected_calendar=current["calendar"],
    )
    assert not _oof_lifecycle_receipt_matches_active_policy(
        current,
        cadence="daily",
        require_full_fit=False,
        expected_calendar={
            **current["calendar"],
            "prep_manifest_checksum": "b" * 64,
            "mature_max_date": "2026-08-01",
            "mature_dates": 112,
        },
    )
    assert not _oof_lifecycle_receipt_matches_active_policy({
        **current,
        "materialization_policy_version": "legacy-v1",
    }, cadence="daily", require_full_fit=False)
    assert not _oof_lifecycle_receipt_matches_active_policy({
        **current,
        "score_semantic_version": "same-market-same-date-percentile-rank-v1",
    }, cadence="daily", require_full_fit=False)
    assert not _oof_lifecycle_receipt_matches_active_policy(
        {
            **current,
            "physical_prediction_coverage": {
                "base_max_date": "2026-07-22",
                "max_date": None,
            },
        },
        cadence="daily",
        require_full_fit=False,
        expected_calendar=current["calendar"],
    )
    assert not _oof_lifecycle_receipt_matches_active_policy(
        current,
        cadence="weekly",
        require_full_fit=True,
    )
    weekly = {
        **current,
        "cadence": "weekly",
        "full_fit_dispatch": {
            "status": "completed",
            "retry_required": False,
            "release_registry": {
                "status": "materialized",
                "validation_schema_version": "active8-oof-ensemble-validation-v1",
                "selection_method": "learned_chronological_oof_ensemble",
                "selection_policy_version": "active8-ensemble-conformal-isotonic-v1",
                "ensemble_candidate": {
                    "status": "persisted",
                    "artifact_id": "active8-ensemble:cohort-v3:1234",
                    "payload_checksum": "c" * 64,
                },
            },
        },
    }
    assert _oof_lifecycle_receipt_matches_active_policy(
        weekly,
        cadence="weekly",
        require_full_fit=True,
    )
    assert not _oof_lifecycle_receipt_matches_active_policy(
        {
            **weekly,
            "full_fit_dispatch": {
                "status": "completed",
                "retry_required": False,
                "release_registry": {"status": "materialized"},
            },
        },
        cadence="weekly",
        require_full_fit=True,
    )

    shadow = {
        **current,
        "status": "shadow_evaluated",
        "cadence": "daily",
        "persistence": {
            "status": "ready",
            "prediction_storage_mode": "gcs_indexed_v1",
            "counts": {
                "materialized_artifact_rows": 2,
                "indexed_snapshot_rows": 100,
                "indexed_l4_prediction_rows": 100,
            },
        },
        "evidence_closure": {
            "materialized": False,
            "shadow_evaluated": True,
            "candidate_artifacts": False,
            "daily_forward_extension": {
                "manifest_path": "walk_forward/oof_forward/cohort-1/2026-07-30.json",
                "manifest_checksum": "a" * 64,
                "promotion_eligible": False,
                "training_dispatched": False,
            },
            "forward_shadow_coverage": {
                "status": "verified",
                "promotion_eligible": False,
                "training_dispatched": False,
                "artifacts": {
                    "allocator_ev_snapshots": {"status": "verified"},
                    "l4_predictions": {"status": "verified"},
                },
            },
            "shadow_evaluation_packets": {
                "l4_alpha_ev": {"policy_decision": "shadow_only"},
                "allocator_ev_fusion": {"policy_decision": "shadow_only"},
            },
            "candidate_forward_evaluation": {
                "status": "waiting_for_preoutcome_locked_mature_dates",
                "training_dispatched": False,
            },
        },
    }
    assert _oof_lifecycle_receipt_matches_active_policy(
        shadow,
        cadence="daily",
        require_full_fit=False,
    )
    assert _oof_lifecycle_receipt_matches_active_policy(
        {
            **shadow,
            "persistence": {
                **shadow["persistence"],
                "status": "idempotent_ready",
                "source": "checksum_verified_indexed_loader",
            },
        },
        cadence="daily",
        require_full_fit=False,
    )
    assert not _oof_lifecycle_receipt_matches_active_policy(
        {**shadow, "persistence": {"status": "dry_run"}},
        cadence="daily",
        require_full_fit=False,
    )

    missing_packets = {
        **shadow,
        "evidence_closure": {
            **shadow["evidence_closure"],
            "shadow_evaluation_packets": None,
        },
    }
    assert not _oof_lifecycle_receipt_matches_active_policy(
        missing_packets, cadence="daily", require_full_fit=False
    )
    missing_candidate_forward = {
        **shadow,
        "evidence_closure": {
            **shadow["evidence_closure"],
            "candidate_forward_evaluation": None,
        },
    }
    assert not _oof_lifecycle_receipt_matches_active_policy(
        missing_candidate_forward, cadence="daily", require_full_fit=False
    )
    missing_coverage = {
        **shadow,
        "evidence_closure": {
            **shadow["evidence_closure"],
            "forward_shadow_coverage": None,
        },
    }
    assert not _oof_lifecycle_receipt_matches_active_policy(
        missing_coverage, cadence="daily", require_full_fit=False
    )
    assert not _oof_lifecycle_receipt_matches_active_policy(
        shadow,
        cadence="daily",
        require_full_fit=True,
    )
    controls = _oof_lifecycle_materialization_controls(
        cadence="daily",
        requested_dry_run=False,
        requested_promote=True,
        requested_dispatch_full_fit=True,
        forward_extension_manifest_path="walk_forward/oof_forward/cohort-1/2026-07-30.json",
    )
    assert controls == {
        "dry_run": True,
        "confirm": False,
        "promote": False,
        "dispatch_full_fit": False,
        "frozen_forward_shadow": True,
        "exact_candidate_promotion_requested": True,
    }
    weekly_controls = _oof_lifecycle_materialization_controls(
        cadence="weekly",
        requested_dry_run=False,
        requested_promote=True,
        requested_dispatch_full_fit=True,
        forward_extension_manifest_path=None,
    )
    assert weekly_controls["promote"] is False
    assert weekly_controls["exact_candidate_promotion_requested"] is False
    rows = [
        {"fold_id": "w5", "row_id": "base"},
        {"fold_id": "frozen_forward", "row_id": "shadow"},
    ]
    assert _without_frozen_forward_rows(rows) == [
        {"fold_id": "w5", "row_id": "base"}
    ]
    request_source = (ROOT / "ml-controller" / "routers" / "walk_forward.py").read_text(encoding="utf-8")
    assert "persist_forward_shadow_coverage" in request_source
    assert "durable_shadow_base_materialization" in request_source
    assert "prediction_rows=persistence_prediction_rows" in request_source
    assert "dry_run=req.dry_run and not durable_shadow_base_materialization" in request_source
    assert '"durable_shadow_base_materialization": durable_shadow_base_materialization' in request_source
    assert "forward shadow coverage may only be recorded by the daily durable OOF lifecycle" in request_source
    assert "req.forward_extension_manifest_path and req.promote" in request_source
    assert "and not req.persist_forward_shadow_coverage" in request_source
    assert "non-dry frozen forward extension may only persist isolated shadow" in request_source
    assert 'materialization_controls["frozen_forward_shadow"] and not req.dry_run' in request_source
    assert '"forward_shadow_coverage": result.get("forward_shadow_coverage")' in request_source
    assert _oof_lifecycle_receipt_path("cohort-1", "2026-07-29", "daily").endswith(
        "/2026-07-29.daily.json"
    )
    assert _oof_lifecycle_receipt_path("cohort-1", "2026-07-29", "weekly").endswith(
        "/2026-07-29.weekly.json"
    )


def test_exact_candidate_multi_owner_promotion_requires_every_requested_owner():
    from routers.walk_forward import _candidate_forward_promotion_closure

    requested = {
        "l4_alpha_ev": {"artifact_id": "l4"},
        "allocator_ev_fusion": {"artifact_id": "fusion"},
    }
    partial = _candidate_forward_promotion_closure(requested, {
        "outcomes": {
            "l4_alpha_ev": {"promoted": True},
            "allocator_ev_fusion": {
                "promoted": False,
                "blockers": ["fusion_requires_serving_compatible_l4"],
            },
        },
    })

    assert partial["promoted_any"] is True
    assert partial["complete"] is False
    assert partial["failed_owners"] == ["allocator_ev_fusion"]
    assert partial["errors_by_owner"]["allocator_ev_fusion"] == [
        "fusion_requires_serving_compatible_l4"
    ]

    complete = _candidate_forward_promotion_closure(requested, {
        "outcomes": {
            "l4_alpha_ev": {"promoted": True},
            "allocator_ev_fusion": {"promoted": True},
        },
    })
    assert complete["complete"] is True
    assert complete["failed_owners"] == []


def test_exact_candidate_production_state_retries_opb_without_repromotion():
    from routers.walk_forward import _candidate_forward_opb_retry_owner

    assert _candidate_forward_opb_retry_owner({
        "candidate_states": {
            "l4_alpha_ev": "production",
            "allocator_ev_fusion": "offline_passed",
        }
    }) == "l4_alpha_ev"
    assert _candidate_forward_opb_retry_owner({
        "candidate_states": {
            "l4_alpha_ev": "production",
            "allocator_ev_fusion": "production",
        }
    }) == "allocator_ev_fusion"
    assert _candidate_forward_opb_retry_owner({
        "candidate_states": {
            "l4_alpha_ev": "offline_passed",
            "allocator_ev_fusion": "offline_passed",
        }
    }) is None


def test_oof_dispatch_fence_probes_modal_terminal_state_before_holding_lock():
    router_source = (ROOT / "ml-controller" / "routers" / "walk_forward.py").read_text(encoding="utf-8")
    client_source = (ROOT / "ml-controller" / "services" / "modal_client.py").read_text(encoding="utf-8")

    assert "probe_modal_function_call" in router_source
    assert 'call_state["status"] == "running"' in router_source
    assert "cohort_orchestrator_status_unavailable" in router_source
    assert "terminal_{call_state['status']}" in router_source
    assert "get.aio(timeout=0)" in client_source
    assert '"status": "failed"' in client_source
    assert '"status": "unknown"' in client_source


def test_oof_cohort_version_owns_immutable_fold_evidence_contract():
    from routers.walk_forward import OOF_COHORT_ID_VERSION

    assert OOF_COHORT_ID_VERSION == "v9-feature-semantic-source-attested"


def test_indexed_oof_base_reuse_requires_current_ensemble_semantic():
    import json

    from routers.walk_forward import _indexed_oof_base_semantic_evidence
    from services.ev_lineage_contract import OOF_ENSEMBLE_SEMANTIC_VERSION

    current = [{
        "forecast_data": json.dumps({
            "ensemble_v2": {"semantic_version": OOF_ENSEMBLE_SEMANTIC_VERSION},
        }),
    }]
    compatible = _indexed_oof_base_semantic_evidence(current)
    assert compatible["status"] == "compatible"
    assert compatible["compatible"] is True

    legacy = [{
        "forecast_data": json.dumps({
            "ensemble_v2": {
                "semantic_version": "active8-purged-oof-chronological-ridge-v4",
            },
        }),
    }]
    rebuild = _indexed_oof_base_semantic_evidence(legacy)
    assert rebuild["status"] == "rebuild_required"
    assert rebuild["compatible"] is False
    assert rebuild["observed_ensemble_semantic_counts"] == {
        "active8-purged-oof-chronological-ridge-v4": 1,
    }


def test_indexed_oof_base_reuse_rejects_mixed_or_missing_semantics():
    import json

    from routers.walk_forward import _indexed_oof_base_semantic_evidence
    from services.ev_lineage_contract import OOF_ENSEMBLE_SEMANTIC_VERSION

    evidence = _indexed_oof_base_semantic_evidence([
        {"forecast_data": json.dumps({
            "ensemble_v2": {"semantic_version": OOF_ENSEMBLE_SEMANTIC_VERSION},
        })},
        {"forecast_data": "{}"},
    ])
    assert evidence["status"] == "rebuild_required"
    assert evidence["compatible"] is False
    assert evidence["observed_ensemble_semantic_counts"]["missing"] == 1


def test_oof_materialize_request_rejects_unknown_cadence():
    from pydantic import ValidationError
    from routers.walk_forward import OofMaterializeRequest

    try:
        OofMaterializeRequest(
            cohort_id="cohort-v3",
            knowledge_cutoff_date="2026-08-09",
            lifecycle_cadence="weekyl",
        )
    except ValidationError as exc:
        assert "lifecycle_cadence" in str(exc)
    else:
        raise AssertionError("unknown lifecycle cadence must fail closed")

    manual = OofMaterializeRequest(
        cohort_id="cohort-v3",
        knowledge_cutoff_date="2026-08-09",
        lifecycle_cadence="manual",
    )
    assert manual.lifecycle_cadence == "manual"


def test_oof_lifecycle_request_rejects_partial_scheduler_ticket_identity():
    from fastapi import HTTPException
    from routers.walk_forward import OofLifecycleRequest, run_walk_forward_oof_lifecycle

    request = OofLifecycleRequest(
        cadence="weekly",
        end_date="2026-09-04",
        scheduler_ticket_id="ticket-only",
    )
    try:
        asyncio.run(run_walk_forward_oof_lifecycle(request))
    except HTTPException as exc:
        assert exc.status_code == 400
        assert "scheduler ticket identity must be complete" in str(exc.detail)
    else:
        raise AssertionError("partial scheduler ticket identity must fail closed")

def _canonical_release_dispatch_manifest(*, dlinear_folds: int) -> dict:
    from routers import walk_forward

    target = "next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4"
    models = ["LightGBM", "XGBoost", "ExtraTrees", "TabM", "GNN", "DLinear", "PatchTST", "iTransformer"]
    evidence = {
        model: {
            "schema_version": "model-cpcv-evidence-v1",
            "method": "outer_purged_walk_forward_rank_ic",
            "decision": "PASS",
            "passed": True,
            "failed_gates": [],
            "folds": dlinear_folds if model == "DLinear" else 5,
        }
        for model in models
    }
    return {
        "schema_version": "active8-oof-cohort-manifest-v5",
        "target_semantic_version": target,
        "prep_manifest": {
            "schema_version": "active8-canonical-adjusted-prep-v3",
            "manifest_checksum": "a" * 64,
            "feature_semantic_version": walk_forward.OOF_FEATURE_SEMANTIC_VERSION,
            "feature_imputation_semantic": walk_forward.OOF_FEATURE_IMPUTATION_SEMANTIC_VERSION,
            "producer_source_sha": "1" * 40,
            "target_semantic_version": target,
            "roundtrip_cost_bps": 18.0,
            "batch_count": 1,
        },
        "sequence_manifest": {
            "artifact_checksum": "b" * 64,
            "contract": "sequence_records_v3",
            "target_semantic_version": target,
            "batch_count": 1,
            "batch_checksums": {"sequence/batch_0.json": "c" * 64},
        },
        "windows": [
            {
                "window_id": index,
                "train_range": ["2026-01-01", f"2026-03-{10 + index:02d}"],
                "test_range": [f"2026-04-{1 + index * 2:02d}", f"2026-04-{2 + index * 2:02d}"],
                "fs_result": {"feature_pool": {"tree_active": [f"feature_{i}" for i in range(12)]}},
            }
            for index in range(5)
        ],
        "aggregate": {
            "oof_ready_folds": 5,
            "full_fit_eligible_models": models,
            "per_model_promotion_evidence": evidence,
        },
    }


def test_exact_continuation_accepts_checksum_bound_prior_producer(monkeypatch):
    import json

    from routers import walk_forward

    prior_source = "4" * 40
    cohort_id = "active8-oof-v9-test"
    manifest = {
        "cohort_id": cohort_id,
        "status": "ready",
        "generation_mode": "purged_oof",
        "prep_manifest": {"producer_source_sha": prior_source},
    }
    observed = {}

    class Blob:
        def exists(self):
            return True

        def download_as_text(self):
            return json.dumps(manifest)

    class Bucket:
        def blob(self, path):
            observed["path"] = path
            return Blob()

    def verify(_bucket, candidate, *, expected_producer_source_sha=None):
        observed["source"] = expected_producer_source_sha
        assert candidate == manifest
        return {"ready": True, "reasons": []}

    monkeypatch.setattr(walk_forward, "_oof_forward_parent_contract", verify)
    path, loaded, producer = walk_forward._exact_ready_oof_manifest(Bucket(), cohort_id)

    assert path == f"walk_forward/oof_cohorts/{cohort_id}/manifest.json"
    assert loaded == manifest
    assert producer == prior_source
    assert observed["source"] == prior_source


def test_exact_continuation_rejects_path_injection():
    import pytest

    from routers import walk_forward

    with pytest.raises(ValueError, match="oof_exact_cohort_id_invalid"):
        walk_forward._exact_ready_oof_manifest(object(), "../manifest")


def test_dlinear_requires_five_outer_oof_folds_before_full_fit_dispatch(monkeypatch):
    from routers import walk_forward

    monkeypatch.setattr(walk_forward, "_runtime_source_sha", lambda: "1" * 40)
    one_fold = walk_forward.build_oof_full_fit_dispatch_plan(
        _canonical_release_dispatch_manifest(dlinear_folds=1)
    )
    five_folds = walk_forward.build_oof_full_fit_dispatch_plan(
        _canonical_release_dispatch_manifest(dlinear_folds=5)
    )

    assert one_fold["status"] == "blocked"
    assert one_fold["reason"] == "release_model_outer_oof_invalid"
    assert one_fold["invalid_outer_evidence"] == ["DLinear"]
    assert five_folds["status"] == "ready"
    assert five_folds["invalid_outer_evidence"] == []
    assert five_folds["promotion_evidence"]["DLinear"]["validation_design"]["fold_count"] == 5
