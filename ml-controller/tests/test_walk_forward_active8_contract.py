from pathlib import Path
import asyncio
import sys


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml-controller"))


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


def test_oof_full_fit_plan_only_dispatches_models_with_pass_evidence():
    from routers.walk_forward import build_oof_full_fit_dispatch_plan

    manifest = {
        "schema_version": "active8-oof-cohort-manifest-v3",
        "target_semantic_version": "next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4",
        "prep_manifest": {
            "manifest_checksum": "a" * 64,
            "target_semantic_version": "next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4",
            "roundtrip_cost_bps": 18.0,
            "batch_count": 5,
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
            "full_fit_eligible_models": ["XGBoost", "PatchTST", "GNN"],
            "per_model_promotion_evidence": {
                "XGBoost": {"decision": "PASS", "failed_gates": []},
                "PatchTST": {"decision": "PASS", "failed_gates": []},
                "GNN": {"decision": "FAIL", "failed_gates": ["oos_ic_lcb"]},
            },
            "full_fit_blocked_models": {"GNN": ["oos_ic_lcb"]},
        },
    }

    plan = build_oof_full_fit_dispatch_plan(manifest)

    assert plan["status"] == "ready"
    assert plan["eligible_models"] == ["XGBoost", "PatchTST"]
    assert plan["train_model_groups"] == ["tree"]
    assert plan["artifact_lifecycle_targets"] == ["PatchTST"]
    assert plan["evidence_missing_or_failed"] == ["GNN"]
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

    assert "from app.model_pool import ALPHA_PREDICTION_MODELS" in source
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
    assert '"schema_version": "active8-oof-cohort-manifest-v4"' in modal_source
    assert '"source_prep_manifest_checksum": prep_manifest_checksum' in modal_source
    assert '"source_sequence_manifest_checksum": sequence_manifest_evidence["artifact_checksum"]' in modal_source
    assert "canonical-adjusted-close-net-v4" in modal_source
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

    monkeypatch.setattr(d1_client, "query", fake_query)

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
        lambda _path, bucket: (manifest, b"{}"),
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
    assert '"active8-oof-cohort-manifest-v2"' in source
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

    prefix = "universal/canonical_adjusted_v4/test"
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
        "schema_version": "active8-canonical-adjusted-prep-v1",
        "status": "ready",
        "output_gcs_prefix": prefix,
        "sequence_gcs_prefix": "universal/sequence_long/test",
        "target_semantic_version": walk_forward._OOF_TARGET_SEMANTIC_VERSION,
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
    assert plan["reason"] == "immutable_oof_input_lineage_missing"
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


def test_oof_full_fit_plan_blocks_tree_without_fold_feature_lineage():
    from routers.walk_forward import build_oof_full_fit_dispatch_plan

    target = "next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4"
    plan = build_oof_full_fit_dispatch_plan({
        "schema_version": "active8-oof-cohort-manifest-v3",
        "target_semantic_version": target,
        "prep_manifest": {
            "manifest_checksum": "a" * 64,
            "target_semantic_version": target,
            "roundtrip_cost_bps": 18.0,
            "batch_count": 5,
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
    assert plan["reason"] == "outer_fold_feature_consensus_missing"
    assert plan["feature_lineage_ready"] is False

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
        "promotion_allowed_models": expected_models,
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
    )
    assert rejected["status"] == "rejected"
    assert rejected["reason"] == "callback_lifecycle_identity_mismatch"
    assert len(writes) == 1


def test_dispatch_completed_oof_callback_repairs_registry_without_retraining(monkeypatch):
    from routers import walk_forward
    from services import d1_client

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
        "eligible_models": ["DLinear"],
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
        return [] if owner_queries == 1 else [{"model_name": "DLinear", "state": "offline_strong_pass"}]

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
    monkeypatch.setattr(d1_client, "query", fake_query)
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
    assert result["artifact_states"] == {"DLinear": "offline_strong_pass"}
    assert result["registry_repair"]["status"] == "repaired"
    assert result["release_registry"]["candidate_type"] == "oof_full_fit_release"
    assert uploaded[-1]["value"]["status"] == "completed"
    assert uploaded[-1]["value"]["retry_required"] is False
    assert uploaded[-1]["value"]["missing_models"] == []
    assert uploaded[-1]["value"]["reason"] == "artifact_registry_complete"



def test_dispatch_reuses_completed_full_fit_receipt_across_cadences(monkeypatch):
    import json
    from routers import walk_forward
    from services import d1_client

    receipt = {
        "schema_version": "active8-oof-full-fit-receipt-v1",
        "status": "completed",
        "cohort_id": "cohort-v3",
        "knowledge_cutoff_date": "2026-07-17",
        "run_id": "universal-oof-owner",
        "attempt": 3,
        "eligible_models": ["DLinear"],
        "artifact_states": {"DLinear": "offline_strong_pass"},
        "missing_models": [],
        "failed_models": [],
        "retry_required": False,
        "release_registry": {
            "status": "materialized",
            "candidate_type": "oof_full_fit_release",
            "failed_models": ["DLinear"],
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
        "eligible_models": ["DLinear"],
        "tree_models": [],
        "feature_consensus": {},
        "train_model_groups": ["sequence"],
        "artifact_lifecycle_targets": [],
        "promotion_evidence": {"DLinear": {"decision": "PASS"}},
    }
    monkeypatch.setattr(walk_forward, "build_oof_full_fit_dispatch_plan", lambda _manifest: plan)
    monkeypatch.setattr(
        d1_client,
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

def test_completed_oof_release_alias_preserves_immutable_lineage(monkeypatch):
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
            "schema_version": "active8-oof-cohort-manifest-v3",
            "cohort_id": "active8-oof-v5",
            "manifest_checksum": "a" * 64,
            "target_semantic_version": registry.ACTIVE8_TARGET_SEMANTIC_VERSION,
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
                "schema_version": "active8-oof-base-ranker-release-validation-v2",
                "validation_role": "base_ranker",
                "decision": "PASS",
                "pbo": {
                    "scope": "cohort_model_selection_process",
                    "method": "cscv_rank_logit",
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



def test_completed_oof_release_alias_marks_candidate_pbo_failure(monkeypatch):
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
            "schema_version": "active8-oof-cohort-manifest-v3",
            "cohort_id": "active8-oof-v5",
            "manifest_checksum": "a" * 64,
            "target_semantic_version": registry.ACTIVE8_TARGET_SEMANTIC_VERSION,
            "windows": windows,
        },
        registry_rows=[source_row, existing_alias],
        expected_run_id="oof-owner",
        knowledge_cutoff_date="2026-07-09",
        lifecycle_cadence="weekly",
        eligible_models=["DLinear"],
        release_validation_by_model={
            "DLinear": {
                "schema_version": "active8-oof-base-ranker-release-validation-v2",
                "validation_role": "base_ranker",
                "decision": "FAIL",
                "failed_gates": ["cohort_model_selection_pbo"],
                "pbo": {
                    "scope": "cohort_model_selection_process",
                    "method": "cscv_rank_logit",
                    "go_live_verdict": "PASS",
                    "pbo": 0.25,
                    "max_pbo": 0.22,
                },
            },
        },
    )

    assert result["written"] == 1
    assert result["passed_models"] == []
    assert result["failed_models"] == ["DLinear"]
    assert written[0]["state"] == "offline_failed"
    assert written[0]["offline_gate_decision"] == "FAIL"
    assert json.loads(written[0]["offline_gate_failed_gates"]) == [
        "cohort_model_selection_pbo"
    ]


def test_oof_lifecycle_uses_latest_prep_instead_of_stale_parent_contract():
    source = (ROOT / "ml-controller" / "routers" / "walk_forward.py").read_text(encoding="utf-8")

    latest_lookup = 'prep_gcs_prefix = _latest_canonical_prep_prefix(bucket) or ""'
    stale_parent_lookup = 'prep_gcs_prefix = str(parent_manifest.get("prep_gcs_prefix") or "").strip().rstrip("/")'
    assert source.index(latest_lookup) < source.index(stale_parent_lookup)
    assert '                prep_gcs_prefix = str(parent_manifest.get("prep_gcs_prefix") or "")' not in source.splitlines()
    assert 'calendar_evidence.get("sequence_gcs_prefix")' in source

def test_ev_oof_candidates_use_formal_registry_candidate_types():
    source = (ROOT / "ml-controller" / "services" / "active8_oof_cohort_materializer.py").read_text(encoding="utf-8")

    assert '"l4_alpha_ev_refresh"' in source
    assert '"allocator_ev_fusion_refresh"' in source
    archive_block = source[source.index("def archive_ev_candidate_artifacts"):source.index("def persist_oof_cohort")]
    assert '"candidate_type": "model_family_shadow"' not in archive_block

def test_daily_oof_materialization_reuses_checksum_verified_gcs_indexes():
    router = (ROOT / "ml-controller" / "routers" / "walk_forward.py").read_text(encoding="utf-8")
    materializer = (ROOT / "ml-controller" / "services" / "active8_oof_cohort_materializer.py").read_text(encoding="utf-8")

    assert "load_indexed_oof_ev_rows" in router
    assert 'prediction_storage_mode") == "gcs_indexed_v1"' in router
    assert "len(materialized_indexes) == 2" in router
    assert "OOF_PIT_ELIGIBILITY_POLICY_VERSION" in router
    assert '"source": "checksum_verified_indexed_loader"' in router
    assert "active8_oof_indexed_snapshot_lineage_mismatch" in materializer
    assert '"d1_full_row_tables_required": False' in materializer

def test_oof_lifecycle_receipt_is_bound_to_active_materialization_policy():
    from routers.walk_forward import (
        OOF_LIFECYCLE_RECEIPT_SCHEMA_VERSION,
        _oof_lifecycle_materialization_controls,
        _oof_lifecycle_receipt_path,
        _oof_lifecycle_receipt_matches_active_policy,
    )
    from services.active8_oof_cohort_materializer import (
        OOF_PIT_ELIGIBILITY_POLICY_VERSION,
    )

    current = {
        "schema_version": OOF_LIFECYCLE_RECEIPT_SCHEMA_VERSION,
        "materialization_policy_version": OOF_PIT_ELIGIBILITY_POLICY_VERSION,
        "status": "materialized",
        "cadence": "daily",
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
    assert not _oof_lifecycle_receipt_matches_active_policy({
        **current,
        "materialization_policy_version": "legacy-v1",
    }, cadence="daily", require_full_fit=False)
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
        },
    }
    assert _oof_lifecycle_receipt_matches_active_policy(
        weekly,
        cadence="weekly",
        require_full_fit=True,
    )
    shadow = {
        **current,
        "status": "shadow_evaluated",
        "cadence": "daily",
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
        },
    }
    assert _oof_lifecycle_receipt_matches_active_policy(
        shadow,
        cadence="daily",
        require_full_fit=False,
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
    }
    request_source = (ROOT / "ml-controller" / "routers" / "walk_forward.py").read_text(encoding="utf-8")
    assert "persist_forward_shadow_coverage" in request_source
    assert "forward shadow coverage may only be recorded by the daily durable OOF lifecycle" in request_source
    assert 'materialization_controls["frozen_forward_shadow"] and not req.dry_run' in request_source
    assert '"forward_shadow_coverage": result.get("forward_shadow_coverage")' in request_source
    assert _oof_lifecycle_receipt_path("cohort-1", "2026-07-29", "daily").endswith(
        "/2026-07-29.daily.json"
    )
    assert _oof_lifecycle_receipt_path("cohort-1", "2026-07-29", "weekly").endswith(
        "/2026-07-29.weekly.json"
    )


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

    assert OOF_COHORT_ID_VERSION == "v7-immutable-fold-evidence"
