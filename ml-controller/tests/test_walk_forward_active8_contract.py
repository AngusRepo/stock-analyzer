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


def test_oof_automatic_promotion_requires_primary_fusion_and_operational_parity():
    source = (ROOT / "ml-controller" / "routers" / "walk_forward.py").read_text(encoding="utf-8")

    assert 'fusion_tier == "primary"' in source
    assert 'parity.get("decision") == "PASS"' in source
    assert "archive_ev_candidate_artifacts" in source
    assert "purged OOF quality PASS and native operational parity PASS" in source


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
    assert '"schema_version": "active8-oof-cohort-manifest-v3"' in modal_source
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