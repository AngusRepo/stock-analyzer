"""StockVision Modal ML service.

Modal owns heavy ML compute functions such as prediction, retraining, feature
selection, walk-forward validation, and health/audit endpoints. Cloud Run
controllers call Modal functions through `.map()`, `.remote()`, or `.spawn()`.

Common local commands:
  cd ml-service && python -m modal deploy modal_app.py
  cd ml-service && python -m modal serve modal_app.py
"""
import os
import modal
from datetime import datetime, timezone
from pathlib import Path
from app.runtime_env import get_gcs_bucket_name, setup_modal_container_env

# Local code mounted into the Modal image during deploy.
_LOCAL_APP_DIR     = Path(__file__).parent / "app"
_LOCAL_SCRIPTS_DIR = Path(__file__).parent / "scripts"  # optuna routes import scripts/optuna_*.py
_LOCAL_REQ         = Path(__file__).parent / "requirements.txt"


def _controller_callback_token() -> str:
    return (
        os.environ.get("ML_CONTROLLER_TOKEN")
        or os.environ.get("INTERNAL_TOKEN")
        or os.environ.get("ML_CONTROLLER_SECRET")
        or os.environ.get("STOCKVISION_AUTH_TOKEN")
        or ""
    )

# Modal image built with the v1.x API.
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("libgomp1", "ocl-icd-libopencl1")  # OpenMP + OpenCL ICD loader (NVIDIA driver provides libOpenCL at runtime)
    .pip_install_from_requirements(str(_LOCAL_REQ))
    .run_commands(
        "python -c \""
        "from chronos import Chronos2Pipeline; "
        "Chronos2Pipeline.from_pretrained('amazon/chronos-2', device_map='cpu')"
        "\" || echo 'Chronos pre-download skipped (not installed)'",
    )
    .add_local_dir(str(_LOCAL_SCRIPTS_DIR), remote_path="/root/scripts")
    .add_local_dir(str(_LOCAL_APP_DIR), remote_path="/root/app")  # must be last
)

# Chronos baseline note:
# Modal image preloads amazon/chronos-2. Optional LoRA fine-tuned Chronos-2 is
# loaded at runtime via CHRONOS2_LORA_MODEL_ID when configured.

# Secrets: GCS credentials plus Cloudflare D1/KV/API credentials.
gcs_secret = modal.Secret.from_name("gcs-credentials")

# stockvision-cf can be created manually with:
#   modal secret create stockvision-cf \
#     CF_API_TOKEN=<cloudflare-api-token> \
#     CF_ACCOUNT_ID=<cloudflare-account-id> \
#     CF_D1_DB_ID=<cloudflare-d1-db-id> \
#     STOCKVISION_AUTH_TOKEN=<stockvision-auth-token> \
#     STOCKVISION_WORKER_URL=<stockvision-worker-url>
# If the secret is missing, keep deploy importable but Optuna routes will fail.
try:
    cf_secret = modal.Secret.from_name("stockvision-cf")
except Exception:
    print("[modal_app] stockvision-cf secret not found, Optuna routes will fail")
    cf_secret = modal.Secret.from_dict({})

runtime_env_secret = modal.Secret.from_dict({
    key: value
    for key, value in {
        "GCS_BUCKET_NAME": os.environ.get("GCS_BUCKET_NAME", "stockvision-models").strip(),
    }.items()
    if value
})

# Modal application definition.
app = modal.App(
    name="stockvision-ml",
    image=image,
    secrets=[gcs_secret, cf_secret, runtime_env_secret],
)

# Shared container environment setup.
def _setup_env():
    """Set up Modal container environment."""
    return setup_modal_container_env()


def _get_gcs_bucket_name() -> str | None:
    return get_gcs_bucket_name()


def _load_sequence_records_from_gcs(gcs_prefix: str, batch_count: int) -> list[dict]:
    """Load v2 sequence records for universal sequence-model lifecycle training."""
    import io
    import numpy as np
    from google.cloud import storage
    from app.gcs_batch_io import download_existing_blobs

    bucket_name = _get_gcs_bucket_name()
    if not bucket_name:
        raise RuntimeError("GCS bucket not configured")

    bucket = storage.Client().bucket(bucket_name)
    all_records: list[dict] = []
    keys = [f"{gcs_prefix}/prep/batch_{i}.npz" for i in range(batch_count)]
    for key, raw in download_existing_blobs(bucket, keys, max_workers=4):
        if raw is None:
            continue
        buf = io.BytesIO(raw)
        data = np.load(buf, allow_pickle=True)
        if "sequence_records" in data.files:
            batch_records = data["sequence_records"].tolist()
            for row in batch_records:
                if isinstance(row, dict) and row.get("close") and row.get("dates"):
                    all_records.append(row)
            continue
        if "series_close" in data.files:
            batch_series = data["series_close"].tolist()
            for idx, row in enumerate(batch_series):
                if not row:
                    continue
                all_records.append({
                    "symbol": f"legacy_{key.split('/')[-1]}_{idx}",
                    "market_type": "unknown",
                    "close": [float(v) for v in row],
                    "dates": [],
                })
    return all_records


def _load_oos_rank_payload_from_gcs(path: str) -> dict:
    """Load one split-job OOS rank artifact for final stacker training."""
    import io
    import numpy as np
    from google.cloud import storage

    bucket_name = _get_gcs_bucket_name()
    if not bucket_name:
        raise RuntimeError("GCS bucket not configured")

    bucket = storage.Client().bucket(bucket_name)
    blob = bucket.blob(path)
    if not blob.exists():
        raise FileNotFoundError(f"OOS artifact not found: {path}")

    buf = io.BytesIO()
    blob.download_to_file(buf)
    buf.seek(0)
    data = np.load(buf, allow_pickle=True)
    model_names = [str(name) for name in data["model_names"].tolist()]
    pred_matrix = np.asarray(data["pred_matrix"], dtype=float)
    predictions = {
        name: pred_matrix[idx]
        for idx, name in enumerate(model_names)
    }
    return {
        "group": str(data["group"].tolist()),
        "version": str(data["version"].tolist()),
        "predictions": predictions,
        "y_test": np.asarray(data["y_test"], dtype=float),
        "dates_test": np.asarray(data["dates_test"]) if "dates_test" in data.files else np.asarray([], dtype=object),
        "feature_names": (
            np.asarray(data["feature_names"], dtype=object)
            if "feature_names" in data.files
            else np.asarray([], dtype=object)
        ),
        "path": path,
    }


def _truthy(value) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    return str(value).strip().lower() in {"1", "true", "yes", "on", "enabled"}


def _tree_model_split_enabled(payload: dict) -> bool:
    return _truthy(payload.get("tree_model_split")) or _truthy(os.environ.get("UNIVERSAL_TREE_MODEL_SPLIT"))


def _save_oos_rank_payload_to_gcs(path: str, payload: dict) -> dict:
    """Persist a combined OOS rank payload with the same npz contract."""
    import io
    import numpy as np
    from google.cloud import storage

    bucket_name = _get_gcs_bucket_name()
    if not bucket_name:
        raise RuntimeError("GCS bucket not configured")

    model_names = list(payload.get("model_order") or payload.get("predictions", {}).keys())
    pred_matrix = np.vstack([
        np.clip(np.asarray(payload["predictions"][name], dtype=float).reshape(-1), 0.0, 1.0)
        for name in model_names
    ])
    buf = io.BytesIO()
    np.savez_compressed(
        buf,
        group=np.array(payload["group"]),
        version=np.array(payload["version"]),
        model_names=np.asarray(model_names, dtype=object),
        pred_matrix=pred_matrix,
        y_test=np.asarray(payload["y_test"], dtype=float).reshape(-1),
        dates_test=np.asarray(payload.get("dates_test", [])),
        feature_names=np.asarray(payload.get("feature_names", []), dtype=object),
    )
    buf.seek(0)
    storage.Client().bucket(bucket_name).blob(path).upload_from_file(
        buf,
        content_type="application/octet-stream",
    )
    return {
        "path": path,
        "group": str(payload["group"]),
        "version": str(payload["version"]),
        "models": model_names,
        "samples": int(len(payload["y_test"])),
    }


def _combine_tree_child_oos_artifacts(child_results: dict[str, dict], payload: dict) -> tuple[dict | None, str | None]:
    from app.training_finalizer import build_oos_artifact_path, combine_oos_rank_payloads

    try:
        artifact_paths = []
        for partial in (child_results or {}).values():
            if not isinstance(partial, dict):
                continue
            artifact = partial.get("oos_artifact")
            if isinstance(artifact, dict) and artifact.get("path"):
                artifact_paths.append(artifact["path"])
        if not artifact_paths:
            return None, "missing_tree_child_oos_artifacts"
        payloads = [_load_oos_rank_payload_from_gcs(path) for path in artifact_paths]
        version = (
            payload.get("output_model_version")
            or next((p.get("candidate_version") for p in (child_results or {}).values() if p.get("candidate_version")), None)
        )
        if not version:
            return None, "missing_tree_candidate_version"
        gcs_prefix = payload.get("gcs_prefix") or "universal"
        combined = combine_oos_rank_payloads(payloads, group="tree", version=str(version))
        path = build_oos_artifact_path(gcs_prefix, str(version), "tree")
        return _save_oos_rank_payload_to_gcs(path, combined), None
    except Exception as exc:
        return None, str(exc)


# Modal functions called by Cloud Run Controller through `.map()` / `.remote()`.

# Flow B retrain orchestrator: Cloud Run dispatches the Modal chain for prep,
# feature selection, training, and SHAP audit.

@app.function(
    cpu=1,
    memory=1024,
    timeout=18000,              # 300 min: selection, train, SHAP, and regime-history buffer
    scaledown_window=60,
    max_containers=1,
)
def retrain_orchestrator(payload: dict) -> dict:
    """Flow B: prep, optional feature selection, train, then SHAP audit.

    Cloud Run dispatches one Modal orchestration chain.
    Cloud Run does not wait for training completion; followup callback closes the loop.

    payload:
        batch_count: int - number of prep batches.
        is_monthly: bool - whether to run monthly feature selection.
        selection_params: dict - max_rounds, alpha, required_power, icir_weight.
    """
    _setup_env()
    import time
    t0 = time.time()

    batch_count = payload.get("batch_count", 5)
    is_monthly = payload.get("is_monthly", False)
    followup_webhook_url = payload.get("followup_webhook_url")
    gcs_prefix = payload.get("gcs_prefix", "universal")
    window_id = payload.get("window_id")
    run_id = payload.get("run_id")
    lock_key = payload.get("lock_key")
    run_date = payload.get("run_date")
    from app.training_policy import (
        FeatureSelectionPolicy,
        PREDICT_ONLY_MODEL_NOTES,
        UniversalTrainingPolicy,
        build_group_train_payload,
        models_for_training_group,
        training_group_feature_policy,
    )
    training_policy = UniversalTrainingPolicy.from_env()
    selection_params = FeatureSelectionPolicy.from_env().to_selection_params(payload.get("selection_params"))

    # P0-3: Defensive GCS batch count validation.
    # Cloud Run may pass stale/wrong batch_count (e.g. "1" when actual prep wrote 5).
    # Check actual .npz files in GCS and use the larger value.
    try:
        from google.cloud import storage as _gcs_chk
        _bucket_name = _get_gcs_bucket_name()
        if not _bucket_name:
            raise RuntimeError("GCS bucket not configured")
        _bucket_chk = _gcs_chk.Client().bucket(_bucket_name)
        actual_batch_count = sum(
            1 for i in range(20)  # cap at 20 to avoid excessive API calls
            if _bucket_chk.blob(f"{gcs_prefix}/prep/batch_{i}.npz").exists()
        )
        if actual_batch_count > 0 and actual_batch_count != batch_count:
            print(
                f"[Orchestrator] P0-3 batch_count mismatch: "
                f"payload={batch_count} vs GCS={actual_batch_count} -> using max"
            )
            batch_count = max(batch_count, actual_batch_count)
        else:
            print(f"[Orchestrator] GCS batch count verified: {actual_batch_count} batches")
    except Exception as _e:
        print(f"[Orchestrator] GCS batch count check failed (using payload value {batch_count}): {_e}")

    result = {"stages": {}}
    partial_results: dict[str, dict] = {}

    # Stage 1: Feature Selection (monthly only).
    if is_monthly:
        print(f"[Orchestrator] Monthly -> running feature selection (max {selection_params['max_rounds']} rounds)")
        try:
            fs_result = feature_selection_pipeline.remote(selection_params)
            fs_pool = fs_result.get("feature_pool", {}) if isinstance(fs_result.get("feature_pool"), dict) else {}
            fs_target_perm = fs_result.get("target_permutation", {}) if isinstance(fs_result.get("target_permutation"), dict) else {}
            fs_k_sweep = fs_result.get("k_sweep", {}) if isinstance(fs_result.get("k_sweep"), dict) else {}
            result["stages"]["feature_selection"] = {
                "status": "ok" if "error" not in fs_result else "error",
                "active_count": len(fs_pool.get("active", [])),
                "reserve_count": len(fs_pool.get("reserve", [])),
                "tree_active_count": len(fs_pool.get("tree_active", []) or fs_pool.get("active", [])),
                "ft_active_count": len(fs_pool.get("ft_active", [])),
                "target_permutation_n": fs_target_perm.get("n_permutations"),
                "k_sweep_trials": fs_k_sweep.get("actual_trials") or fs_k_sweep.get("n_trials"),
                "objective_cache_hits": fs_k_sweep.get("objective_cache_hits"),
                "elapsed_s": fs_result.get("elapsed_s", 0),
            }
            if "error" in fs_result:
                print(f"[Orchestrator] Feature selection error: {fs_result['error']}")
        except Exception as e:
            print(f"[Orchestrator] Feature selection failed: {e}")
            result["stages"]["feature_selection"] = {"status": "error", "error": str(e)}
    else:
        print("[Orchestrator] Non-monthly -> skip feature selection")
        result["stages"]["feature_selection"] = {"status": "skipped"}

    # Stage 2: Train via two containers in parallel: CPU tree models + GPU FT-T.
    from app.training_finalizer import (
        build_retrain_followup_payload,
        expected_oos_artifact_groups,
        merge_oos_rank_payloads,
        missing_expected_oos_groups,
        reduce_training_group_results,
        summarize_training_stage_status,
    )

    requested_train_groups = training_policy.requested_groups(payload)
    print(f"[Orchestrator] Training from {batch_count} GCS batches (groups={requested_train_groups})...")
    sequence_records = list(payload.get("sequence_records") or [])
    if not sequence_records and any(g in requested_train_groups for g in ("dlinear", "patchtst")):
        try:
            sequence_records = _load_sequence_records_from_gcs(gcs_prefix, batch_count)
            print(f"[Orchestrator] Loaded {len(sequence_records)} sequence records from GCS for DLinear/PatchTST")
        except Exception as e:
            print(f"[Orchestrator] sequence records load failed: {e}")
            sequence_records = []
    sequence_report = {
        "input_series": len(sequence_records),
        "valid_series": sum(
            1
            for row in sequence_records
            if isinstance(row, dict)
            and len(row.get("close") or []) >= training_policy.sequence_min_length(payload)
            and len(row.get("dates") or []) == len(row.get("close") or [])
        ),
        "min_len": training_policy.sequence_min_length(payload),
        "contract": "sequence_records_v2",
    }
    if any(g in requested_train_groups for g in ("dlinear", "patchtst")):
        print(f"[Orchestrator] sequence series validation: {sequence_report}")
    candidate_version = payload.get("candidate_version") or datetime.now(timezone.utc).strftime("v%Y%m%d%H%M%S")
    base_train_payload = training_policy.to_base_train_payload(
        {**payload, "batch_count": batch_count},
        candidate_version=candidate_version,
    )
    train_group_specs = {
        "tree": {
            "spawn": lambda p: train_tree_models.spawn(p),
            "payload": lambda: build_group_train_payload(base_train_payload, "tree"),
            "mergeable": training_group_feature_policy("tree").mergeable_oos,
            "models": models_for_training_group("tree"),
            "note": training_group_feature_policy("tree").note,
        },
        "ftt": {
            "spawn": lambda p: train_ftt_model.spawn(p),
            "payload": lambda: build_group_train_payload(base_train_payload, "ftt"),
            "mergeable": training_group_feature_policy("ftt").mergeable_oos,
            "models": models_for_training_group("ftt"),
            "note": training_group_feature_policy("ftt").note,
        },
        "dlinear": {
            "spawn": lambda p: train_dlinear_universal.spawn(p),
            "payload": lambda: {
                "sequence_records": sequence_records,
                "device": payload.get("sequence_device") or "cuda",
                "version": candidate_version,
            },
            "mergeable": training_group_feature_policy("dlinear").mergeable_oos,
            "models": models_for_training_group("dlinear"),
            "note": training_group_feature_policy("dlinear").note,
        },
        "patchtst": {
            "spawn": lambda p: train_patchtst_universal.spawn(p),
            "payload": lambda: {
                "sequence_records": sequence_records,
                "device": payload.get("sequence_device") or "cuda",
                "version": candidate_version,
            },
            "mergeable": training_group_feature_policy("patchtst").mergeable_oos,
            "models": models_for_training_group("patchtst"),
            "note": training_group_feature_policy("patchtst").note,
        },
    }
    predict_only_models = dict(PREDICT_ONLY_MODEL_NOTES)
    try:
        # Spawn requested training groups in parallel
        handles: dict[str, object] = {}
        coverage: dict[str, dict] = {}
        aux_train = {}
        for group in requested_train_groups:
            spec = train_group_specs.get(group)
            if spec is None:
                coverage[group] = {"status": "unknown_group"}
                print(f"[Orchestrator] Unknown train group skipped: {group}")
                continue
            group_payload = spec["payload"]()
            if group in {"dlinear", "patchtst"} and not group_payload.get("sequence_records"):
                coverage[group] = {
                    "status": "skipped",
                    "models": spec["models"],
                    "reason": "missing_sequence_records_artifact",
                    "sequence_report": sequence_report,
                    "note": spec["note"],
                }
                print(f"[Orchestrator] {group} skipped: missing sequence records artifact")
                continue
            handles[group] = spec["spawn"](group_payload)
            coverage[group] = {
                "status": "running",
                "models": spec["models"],
                "mergeable": spec["mergeable"],
                "note": spec["note"],
            }
            print(f"[Orchestrator] Spawned group={group} models={spec['models']}")

        tree_result = {}
        ftt_result = {}
        aux_train = {}
        if handles.get("tree") is not None:
            tree_result = handles["tree"].get()
            partial_results["tree"] = tree_result
            coverage["tree"] = {
                **coverage.get("tree", {}),
                "status": "error" if tree_result.get("error") else "ok",
                "elapsed_s": tree_result.get("elapsed_s"),
                "error": tree_result.get("error"),
                "gcs_io": tree_result.get("gcs_io"),
            }
        if handles.get("ftt") is not None:
            ftt_result = handles["ftt"].get()
            partial_results["ftt"] = ftt_result
            coverage["ftt"] = {
                **coverage.get("ftt", {}),
                "status": "error" if ftt_result.get("error") else "ok",
                "elapsed_s": ftt_result.get("elapsed_s"),
                "error": ftt_result.get("error"),
                "gcs_io": ftt_result.get("gcs_io"),
            }
        for group in ("dlinear", "patchtst"):
            if handles.get(group) is not None:
                aux_train[group] = handles[group].get()
                partial_results[group] = aux_train[group]
                coverage[group] = {
                    **coverage.get(group, {}),
                    "status": "error" if aux_train[group].get("error") else "ok",
                    "elapsed_s": aux_train[group].get("elapsed_s"),
                    "error": aux_train[group].get("error"),
                }
                if aux_train[group].get("error"):
                    print(f"[Orchestrator] Partial train error ({group}): {aux_train[group]['error']}")

        # Merge results + IC tracking from spawned groups. Kept side-effect free
        # so a detached finalizer can reuse the same contract later.
        reduced_train = reduce_training_group_results(tree_result, ftt_result, aux_train)
        merged_results = reduced_train["merged_results"]
        merged_ic = reduced_train["merged_ic"]
        circuit_breaker = reduced_train["circuit_breaker"]
        total_samples = reduced_train["total_samples"]
        for partial_error in reduced_train["partial_errors"]:
            print(
                f"[Orchestrator] Partial train error ({partial_error.get('group')}): "
                f"{partial_error.get('error')}"
            )

        challenger_registrations = {}
        if payload.get("register_challengers", True):
            from app.model_pool import register_challenger as _register_challenger

            candidate_models = set(reduced_train["candidate_models"])
            for model_name in sorted(candidate_models):
                if model_name in (tree_result.get("challenger_registrations") or {}):
                    continue
                if model_name in (ftt_result.get("challenger_registrations") or {}):
                    continue
                try:
                    version = candidate_version
                    _register_challenger(model_name, version, save=True)
                    group_result = {}
                    if model_name == "DLinear":
                        group_result = aux_train.get("dlinear") or {}
                    elif model_name == "PatchTST":
                        group_result = aux_train.get("patchtst") or {}
                    challenger_registrations[model_name] = {
                        "status": "registered",
                        "version": version,
                        "training_run_id": group_result.get("training_run_id"),
                        "training_manifest_path": group_result.get("training_manifest_path"),
                    }
                except Exception as e:
                    challenger_registrations[model_name] = {
                        "status": "error",
                        "version": candidate_version,
                        "error": str(e),
                    }

        result["stages"]["train"] = {
            "status": summarize_training_stage_status(coverage),
            "requested_groups": requested_train_groups,
            "candidate_version": candidate_version,
            "group_coverage": coverage,
            "predict_only_models": predict_only_models,
            "sequence_report": sequence_report,
            "total_samples": total_samples,
            "ic_tracking": merged_ic,
            "circuit_breaker": circuit_breaker,
            "challenger_registrations": {
                **(tree_result.get("challenger_registrations") or {}),
                **(ftt_result.get("challenger_registrations") or {}),
                **challenger_registrations,
            },
            "tree_elapsed_s": tree_result.get("elapsed_s"),
            "ftt_elapsed_s": ftt_result.get("elapsed_s"),
            "aux_train": {
                k: {
                    "status": "ok" if "error" not in v else "error",
                    "metadata": v.get("metadata"),
                    "ic_tracking": v.get("ic_tracking"),
                    "elapsed_s": v.get("elapsed_s"),
                    "type": v.get("type"),
                }
                for k, v in aux_train.items()
            },
        }
        try:
            from app.stacking import save_meta_learner, train_rank_stacker_oof

            oos_payloads = []
            for group, partial in (("tree", tree_result), ("ftt", ftt_result)):
                artifact = (partial or {}).get("oos_artifact") or {}
                artifact_path = artifact.get("path")
                if not artifact_path:
                    continue
                oos_payload = _load_oos_rank_payload_from_gcs(artifact_path)
                oos_payloads.append(oos_payload)
                print(f"[Orchestrator] Loaded OOS artifact for stacker: {artifact_path}")

            expected_oos_groups = expected_oos_artifact_groups(requested_train_groups)
            missing_oos_groups = missing_expected_oos_groups(expected_oos_groups, oos_payloads)
            if missing_oos_groups:
                result["stages"]["rank_stacker"] = {
                    "status": "skipped",
                    "reason": "missing_oos_artifacts",
                    "missing_groups": missing_oos_groups,
                    "expected_groups": expected_oos_groups,
                    "loaded_groups": [p.get("group") for p in oos_payloads],
                }
            else:
                rows, y_rank, stack_model_order = merge_oos_rank_payloads(oos_payloads)
                if rows:
                    rank_bundle = train_rank_stacker_oof(
                        rows,
                        y_rank,
                        model_order=stack_model_order,
                        min_samples=80,
                    )
                    if rank_bundle:
                        saved = save_meta_learner(rank_bundle, 0)
                        result["stages"]["rank_stacker"] = {
                            "status": "ok" if saved else "error",
                            "saved": bool(saved),
                            "oos_ic": rank_bundle.get("eval_ic"),
                            "eval_rmse": rank_bundle.get("eval_rmse"),
                            "train": rank_bundle.get("train_samples"),
                            "test": rank_bundle.get("eval_samples"),
                            "model_order": stack_model_order,
                            "artifacts": [p.get("path") for p in oos_payloads],
                        }
                        merged_results["StackingRank"] = {
                            "trained": True,
                            "saved": bool(saved),
                            "oos_ic": rank_bundle.get("eval_ic"),
                            "eval_rmse": rank_bundle.get("eval_rmse"),
                        }
                        if rank_bundle.get("eval_ic") is not None:
                            merged_ic["StackingRank"] = {
                                "oos_ic": rank_bundle.get("eval_ic"),
                                "oos_samples": rank_bundle.get("eval_samples"),
                                "passed": float(rank_bundle.get("eval_ic") or 0.0) > 0,
                            }
                    else:
                        result["stages"]["rank_stacker"] = {
                            "status": "skipped",
                            "reason": "insufficient_oos_rank_samples",
                            "model_order": stack_model_order,
                            "samples": int(len(y_rank)),
                        }
                else:
                    result["stages"]["rank_stacker"] = {
                        "status": "skipped",
                        "reason": "missing_oos_artifacts",
                        "expected_groups": expected_oos_groups,
                    }
        except Exception as e:
            result["stages"]["rank_stacker"] = {"status": "error", "error": str(e)}
            print(f"[Orchestrator] Rank stacker finalizer failed: {e}")

        stacker_status = (result["stages"].get("rank_stacker") or {}).get("status")
        if stacker_status != "ok" and result["stages"]["train"].get("status") == "ok":
            result["stages"]["train"]["status"] = "degraded"
            result["stages"]["train"]["degraded_reason"] = f"rank_stacker_{stacker_status or 'missing'}"

        if circuit_breaker:
            print("[Orchestrator] Circuit breaker: weak model IC detected; ensemble will auto-zero-weight affected models")

        # Write merged ic_tracking.json to GCS (both containers skip GCS write when models_filter set)
        try:
            from google.cloud import storage as _gcs
            import json as _json
            from datetime import datetime as _dt, timezone as _tz
            _bucket_name = _get_gcs_bucket_name()
            if not _bucket_name:
                raise RuntimeError("GCS bucket not configured")
            _bucket = _gcs.Client().bucket(_bucket_name)
            _now_utc = _dt.now(_tz.utc)
            _ic_record = {
                "computed_at": _now_utc.isoformat().replace("+00:00", "Z"),
                "models": merged_ic,
                "circuit_breaker": circuit_breaker,
                "total_samples": total_samples,
                "source": "orchestrator_merged",
            }
            _ic_json = _json.dumps(_ic_record, indent=2)
            _bucket.blob(f"{gcs_prefix}/ic_tracking.json").upload_from_string(
                _ic_json, content_type="application/json"
            )
            _month = _now_utc.strftime("%Y-%m")
            _bucket.blob(f"{gcs_prefix}/ic_history/{_month}.json").upload_from_string(
                _ic_json, content_type="application/json"
            )
            print(f"[Orchestrator] IC tracking saved (breaker={'ON' if circuit_breaker else 'OFF'}, {len(merged_ic)} models)")
        except Exception as e:
            print(f"[Orchestrator] IC tracking GCS save failed: {e}")

        # SHAP audit is governance evidence, not a blocker for model artifacts.
        # Default to deferred spawn so monthly retrain callback is not held by
        # a dashboard audit that can be inspected separately.
        try:
            shap_mode = str(
                payload.get("shap_audit_mode")
                or os.environ.get("UNIVERSAL_SHAP_AUDIT_MODE", "deferred")
            ).strip().lower()
            print(f"[Orchestrator] Auto-triggering SHAP audit mode={shap_mode}...")
            shap_t0 = time.time()
            if shap_mode == "inline":
                shap_result = shap_feature_audit.remote({"shap_samples": 10000})
                result["stages"]["shap"] = {
                    "status": "ok",
                    "mode": "inline",
                    "elapsed_s": round(time.time() - shap_t0, 1),
                    "keep_count": shap_result.get("keep_count"),
                }
            else:
                shap_feature_audit.spawn({"shap_samples": 10000})
                result["stages"]["shap"] = {
                    "status": "deferred",
                    "mode": "spawn",
                    "elapsed_s": round(time.time() - shap_t0, 1),
                }
        except Exception as e:
            print(f"[Orchestrator] SHAP failed (non-blocking): {e}")
            result["stages"]["shap"] = {"status": "error", "error": str(e)}

    except Exception as e:
        print(f"[Orchestrator] Train failed: {e}")
        result["stages"]["train"] = {"status": "error", "error": str(e)}

    elapsed = round(time.time() - t0, 1)
    result["total_elapsed_s"] = elapsed
    if followup_webhook_url:
        try:
            import httpx

            payload_out = build_retrain_followup_payload(
                run_id=run_id,
                lock_key=lock_key,
                run_date=run_date,
                is_monthly=bool(is_monthly),
                batch_count=batch_count,
                gcs_prefix=gcs_prefix,
                candidate_version=candidate_version,
                window_id=window_id,
                result=result,
                partial_results=partial_results,
                elapsed_s=elapsed,
            )
            headers = {"Content-Type": "application/json"}
            token = _controller_callback_token()
            if token:
                headers["X-Service-Token"] = token
            resp = httpx.post(
                followup_webhook_url,
                json=payload_out,
                headers=headers,
                timeout=15,
                follow_redirects=True,
            )
            if resp.status_code < 200 or resp.status_code >= 300:
                raise RuntimeError(f"followup webhook returned HTTP {resp.status_code}")
            result["followup"] = {
                "status_code": resp.status_code,
                "url": str(resp.url),
                "payload_status": payload_out["status"],
            }
            print(f"[Orchestrator] followup webhook POST {resp.request.url} -> HTTP {resp.status_code}")
        except Exception as e:
            result["followup"] = {"error": str(e), "url": followup_webhook_url}
            print(f"[Orchestrator] followup webhook failed: {e}")
    print(f"[Orchestrator] Flow B complete in {elapsed}s")
    return result


@app.function(
    cpu=2,
    memory=8192,
    gpu="L4",
    timeout=7200,
    scaledown_window=60,
    max_containers=1,
)
def research_model_benchmark(payload: dict) -> dict:
    """Run research-only model-family benchmark executor.

    This function may use GPU for benchmark adapters, but it must never promote
    models or mutate production artifacts. Results are returned to the
    controller as fold metrics / PBO / cost / data-slice evidence.
    """
    _setup_env()
    from app.research_model_benchmark_runtime import run_research_model_benchmark

    return run_research_model_benchmark(payload)


@app.function(
    cpu=1,
    memory=1024,
    timeout=600,
    scaledown_window=60,
    max_containers=2,
)
def breeze2_research_context(payload: dict) -> dict:
    """Build Breeze2 research-context evidence for debate/screener callers."""
    _setup_env()
    from app.breeze2_context import build_breeze2_research_context

    return build_breeze2_research_context({
        **payload,
        "allowed_use": "research_context_only",
        "mutation_allowed": False,
    })


@app.function(
    cpu=2,
    memory=16384,
    gpu="L4",
    timeout=900,
    scaledown_window=60,
    max_containers=1,
)
def breeze2_reason_generation(payload: dict) -> dict:
    """Generate Breeze2 shadow reasons; never writes trading state."""
    _setup_env()
    from app.breeze2_reason_generation import generate_breeze2_reason_generation

    return generate_breeze2_reason_generation({
        **payload,
        "allowed_use": "reason_shadow_only",
        "mutation_allowed": False,
        "real_trading_allowed": False,
    })


@app.function(
    cpu=1,                       # 1 CPU per prediction container.
    memory=2048,                 # 2GB is sufficient for CPU prediction runtime.
    timeout=300,                 # 5 min buffer for tail inference and cold start.
    min_containers=0,            # Scale to zero outside scheduled warmup windows.
    scaledown_window=900,        # Keep warmup containers alive through the TW 22:00 pipeline.
    max_containers=20,           # Bound fan-out to control Modal concurrency and cost.
)
def predict_single_stock(payload: dict) -> dict:
    """Prediction v2: regression models plus IC-weighted rank-to-signal.
    No v1 fallback: v2 failures must surface as errors for control-plane visibility.
    """
    _setup_env()
    from app.use_cases import predict_stock_v2, PredictRequest
    try:
        req = PredictRequest(**payload)
        return predict_stock_v2(req)
    except Exception as e_v2:
        import traceback
        print(f"[predict_single_stock] v2 failed for {payload.get('symbol', '?')}: {type(e_v2).__name__}: {e_v2}")
        print(traceback.format_exc())
        return {
            "stock_id": payload.get("stock_id", 0),
            "symbol": payload.get("symbol", "?"),
            "error": f"v2: {type(e_v2).__name__}: {e_v2}",
            "signal": "NO_SIGNAL",
            "direction": "neutral",
            "confidence": 0.0,
        }


@app.function(
    cpu=2,
    memory=8192,
    timeout=900,
    min_containers=0,
    scaledown_window=900,
    max_containers=4,
)
def predict_batch_v2(payload: dict) -> dict:
    """Chunked v2 prediction.

    Production controller uses this chunked contract by default. Set
    MODAL_PREDICT_BATCH_V2=0 only as an emergency fallback to single-stock map.
    """
    _setup_env()
    from app.batch_prediction import predict_stock_v2_batch_with_metrics

    payloads = payload.get("payloads") or []
    batch = predict_stock_v2_batch_with_metrics(payloads)
    results = batch["results"]
    return {
        "results": results,
        "n_input": len(payloads),
        "n_error": sum(1 for r in results if r.get("error")),
        "metrics": batch.get("metrics", {}),
    }


@app.function(
    cpu=1,
    memory=2048,
    timeout=300,
    scaledown_window=60,
    max_containers=10,
)
def retrain_single_stock(payload: dict) -> dict:
    """Retrain a single stock in pure compute mode."""
    _setup_env()
    from app.use_cases import retrain_stock, PredictRequest
    try:
        req = PredictRequest(**payload)
        return retrain_stock(req)
    except Exception as e:
        return {
            "stock_id": payload.get("stock_id", 0),
            "symbol": payload.get("symbol", "?"),
            "error": str(e),
        }


@app.function(
    cpu=1,
    memory=2048,                 # prep: build_feature_matrix for batch payloads.
    timeout=600,                 # 10 min per batch
    scaledown_window=60,
    max_containers=3,            # Parallel prep batches.
)
def prep_universal_batch(payload: dict) -> dict:
    """Prepare universal feature batch and persist npz artifacts."""
    _setup_env()
    from app.use_cases import prep_universal_batch as _prep, UniversalPrepRequest
    try:
        req = UniversalPrepRequest(**payload)
        return _prep(req)
    except Exception as e:
        return {"error": str(e), "batch_index": payload.get("batch_index", -1)}


@app.function(
    gpu="L4",                    # FT-Transformer needs GPU; L4 24GB for 631K full samples
    memory=4096,                 # 631K samples x 106 features plus tree training overhead
    timeout=7200,                # 120 min: tree models ~5 min + FT-T GPU full train ~90 min
    scaledown_window=60,
    max_containers=1,
)
def train_universal_from_gcs(payload: dict) -> dict:
    """Train all universal models from prepared GCS batches.

    Compatibility single-container path for Cloud Run direct train calls.
    """
    _setup_env()
    from app.use_cases import train_universal_from_gcs as _train, UniversalTrainRequest
    try:
        req = UniversalTrainRequest(**payload)
        train_result = _train(req)
    except Exception as e:
        return {"error": str(e), "type": "universal"}

    # Auto-trigger SHAP dashboard (Modal internal, no Cloud Run dependency)
    auto_audit = payload.get("auto_audit", True)
    if auto_audit and "error" not in train_result:
        try:
            shap_mode = str(
                payload.get("shap_audit_mode")
                or os.environ.get("UNIVERSAL_SHAP_AUDIT_MODE", "deferred")
            ).strip().lower()
            print(f"[TrainUniversal] Auto-triggering SHAP dashboard audit mode={shap_mode}...")
            if shap_mode == "inline":
                shap_result = shap_feature_audit.remote({"shap_samples": 10000})
                train_result["shap_result"] = shap_result
                print(f"[TrainUniversal] SHAP done: {shap_result.get('keep_count', '?')} features kept")
            else:
                shap_feature_audit.spawn({"shap_samples": 10000})
                train_result["shap_result"] = {"status": "deferred", "mode": "spawn"}
        except Exception as e:
            print(f"[TrainUniversal] SHAP auto-trigger failed (non-blocking): {e}")
            train_result["shap_error"] = str(e)

    return train_result


# Two-container split: tree models on CPU + FT-T on GPU.
# Saves ~30 min GPU idle time + enables parallel training.
# Orchestrator spawns both, waits for both, then merges results for IC gate.

@app.function(
    cpu=2,
    memory=4096,
    timeout=5400,
    scaledown_window=60,
    max_containers=4,
)
def train_tree_model(payload: dict) -> dict:
    """CPU-only: one governed tree ensemble member for opt-in fan-out."""
    _setup_env()
    from app.use_cases import train_universal_from_gcs as _train, UniversalTrainRequest
    try:
        req = UniversalTrainRequest(**payload)
        return _train(req)
    except Exception as e:
        return {
            "error": str(e),
            "type": "tree_model",
            "tree_split_model": payload.get("tree_split_model"),
        }


@app.function(
    cpu=2,
    memory=4096,
    timeout=5400,                # 90 min for four tree models sequentially on CPU.
    scaledown_window=60,
    max_containers=1,
)
def train_tree_models(payload: dict) -> dict:
    """CPU-only: XGBoost + CatBoost + ExtraTrees + LightGBM."""
    _setup_env()
    from app.use_cases import train_universal_from_gcs as _train, UniversalTrainRequest
    from app.training_finalizer import reduce_tree_model_child_results
    from app.training_policy import build_group_train_payload, build_tree_model_child_payloads
    try:
        if _tree_model_split_enabled(payload):
            child_payloads = build_tree_model_child_payloads(payload)
            handles = {
                model_name: train_tree_model.spawn(child_payload)
                for model_name, child_payload in child_payloads.items()
            }
            child_results = {
                model_name: handle.get()
                for model_name, handle in handles.items()
            }
            combined_artifact, artifact_error = _combine_tree_child_oos_artifacts(child_results, payload)
            return reduce_tree_model_child_results(
                child_results,
                combined_oos_artifact=combined_artifact,
                oos_artifact_error=artifact_error,
            )
        req = UniversalTrainRequest(**build_group_train_payload(payload, "tree"))
        return _train(req)
    except Exception as e:
        return {"error": str(e), "type": "tree_models"}


@app.function(
    gpu="L4",
    memory=4096,
    timeout=10800,               # 180 min for FT-T on full samples.
    scaledown_window=60,
    max_containers=1,
)
def train_ftt_model(payload: dict) -> dict:
    """GPU L4: FT-Transformer only (uses all features, skip_feature_pool=True)."""
    _setup_env()
    from app.use_cases import train_universal_from_gcs as _train, UniversalTrainRequest
    from app.training_policy import build_group_train_payload
    try:
        req = UniversalTrainRequest(**build_group_train_payload(payload, "ftt"))
        return _train(req)
    except Exception as e:
        return {"error": str(e), "type": "ftt_model"}


@app.function(
    gpu="L4",
    memory=4096,
    timeout=21600,               # 360 min for architecture search trials plus buffer.
    scaledown_window=60,
    max_containers=1,
)
def ft_transformer_arch_search(payload: dict) -> dict:
    """GPU L4: FT-Transformer architecture Optuna search (#29).

    LOCKED (see feedback_ft_transformer_tuning.md): no warmup / no cosine decay /
    PATIENCE stays 16 in production. Search only varies d_model / n_heads /
    n_layers / dropout with shorter patience=8 for throughput. Winning config is
    manually applied to main.py FTTransformer then re-trained with production
    settings. DO NOT auto-push to KV.

    Payload:
      n_trials     (int, default 20): coarse=20, full=50
      subset_size  (int | null): null = full data, int = subsample X_train
      gcs_prefix   (str, default "universal")
    """
    _setup_env()
    try:
        import json, io
        from datetime import datetime
        import numpy as np
        from google.cloud import storage
        from app.optuna_fttransformer_arch import load_prep_data_from_gcs, run_search

        gcs_prefix  = payload.get("gcs_prefix", "universal")
        n_trials    = int(payload.get("n_trials", 20))
        subset_size = payload.get("subset_size")

        X_tr, y_tr, X_val, y_val = load_prep_data_from_gcs(gcs_prefix)

        if isinstance(subset_size, int) and 0 < subset_size < len(X_tr):
            rng = np.random.RandomState(42)
            idx = np.sort(rng.choice(len(X_tr), subset_size, replace=False))
            X_tr, y_tr = X_tr[idx], y_tr[idx]

        result = run_search(X_tr, y_tr, X_val, y_val, n_trials=n_trials,
                            save_path="/tmp/ft_arch_optuna.json")

        # Audit trail to GCS for traceability
        now_iso = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        gcs_key = f"{gcs_prefix}/ft_arch_optuna_{now_iso}.json"
        bucket_name = _get_gcs_bucket_name()
        if not bucket_name:
            raise RuntimeError("GCS bucket not configured")
        bucket = storage.Client().bucket(bucket_name)
        bucket.blob(gcs_key).upload_from_string(
            json.dumps(result, indent=2), content_type="application/json",
        )
        result["gcs_audit_path"] = f"gs://{bucket.name}/{gcs_key}"
        return result
    except Exception as e:
        return {"error": str(e), "type": "ft_arch_search"}


# Walk-forward Modal functions.

@app.function(
    cpu=2,
    memory=4096,
    timeout=3600,   # 60 min per window for tree models on short train windows.
    scaledown_window=60,
    max_containers=3,   # allow 3 windows in parallel for tree path
)
def train_wf_tree_window(payload: dict) -> dict:
    """CPU-only walk-forward: XGBoost + CatBoost + ExtraTrees + LightGBM for one window.

    payload: window_id, train_start, train_end, test_start, test_end, batch_count,
             feature_pool_path (2026-04-19 N2: per-window pool to eliminate look-ahead)
    """
    _setup_env()
    from app.use_cases import train_universal_from_gcs as _train, UniversalTrainRequest
    try:
        gcs_prefix = f"walk_forward/w{payload['window_id']}"
        # 2026-04-19 N2: default to per-window pool path; orchestrator now writes
        # {gcs_prefix}/feature_pool.json before calling this fn.
        feature_pool_path = payload.get("feature_pool_path") or f"{gcs_prefix}/feature_pool.json"
        req = UniversalTrainRequest(
            batch_count=payload.get("batch_count", 5),
            models_filter=["XGBoost", "CatBoost", "ExtraTrees", "LightGBM"],
            skip_feature_pool=payload.get("skip_feature_pool", False),
            train_start=payload["train_start"],
            train_end=payload["train_end"],
            test_start=payload["test_start"],
            test_end=payload["test_end"],
            gcs_prefix=gcs_prefix,
            window_id=payload["window_id"],
            skip_weekly_backup=True,
            feature_pool_path=feature_pool_path,
        )
        return _train(req)
    except Exception as e:
        import traceback
        return {
            "error": str(e),
            "trace": traceback.format_exc()[:2000],
            "window_id": payload.get("window_id"),
            "type": "wf_tree",
        }


@app.function(
    gpu="L4",
    memory=4096,
    timeout=3600,  # 60 min per window for FT-T on short train windows.
    scaledown_window=60,
    max_containers=2,   # allow 2 windows on GPU in parallel
)
def train_wf_ftt_window(payload: dict) -> dict:
    """GPU walk-forward: FT-Transformer for one window."""
    _setup_env()
    from app.use_cases import train_universal_from_gcs as _train, UniversalTrainRequest
    try:
        gcs_prefix = f"walk_forward/w{payload['window_id']}"
        req = UniversalTrainRequest(
            batch_count=payload.get("batch_count", 5),
            models_filter=["FT-Transformer"],
            skip_feature_pool=True,   # FT-T benefits from full features
            train_start=payload["train_start"],
            train_end=payload["train_end"],
            test_start=payload["test_start"],
            test_end=payload["test_end"],
            gcs_prefix=gcs_prefix,
            window_id=payload["window_id"],
            skip_weekly_backup=True,
        )
        return _train(req)
    except Exception as e:
        import traceback
        return {
            "error": str(e),
            "trace": traceback.format_exc()[:2000],
            "window_id": payload.get("window_id"),
            "type": "wf_ftt",
        }


@app.function(
    cpu=1,
    memory=2048,
    timeout=300,   # 5 min for market-level HMM.
    scaledown_window=60,
    max_containers=3,
)
def train_wf_hmm_window(payload: dict) -> dict:
    """Train HMM on historical window and save snapshot to walk_forward/w{id}/."""
    _setup_env()
    from app.regime import RegimeDetector, build_market_feature_matrix
    try:
        window_id = payload["window_id"]
        train_end = payload["train_end"]
        market_env = payload["market_env"]

        feat_mat = build_market_feature_matrix(market_env)
        if feat_mat is None or len(feat_mat) < 30:
            return {
                "error": f"insufficient history: got {len(feat_mat) if feat_mat is not None else 0}, need >=30",
                "window_id": window_id,
            }

        detector = RegimeDetector().fit(feat_mat)
        if not detector._trained:
            return {"error": "HMM fit did not converge", "window_id": window_id}

        gcs_prefix = f"walk_forward/w{window_id}"
        saved = detector.save_to_gcs(
            gcs_prefix=gcs_prefix,
            extra_metadata={
                "window_id": window_id,
                "train_end": train_end,
                "history_days": len(feat_mat),
            },
        )
        return {
            "window_id": window_id,
            "gcs_prefix": gcs_prefix,
            "n_components": detector.n_components,
            "history_days": len(feat_mat),
            "saved": saved,
        }
    except Exception as e:
        import traceback
        return {"error": str(e), "trace": traceback.format_exc()[:2000], "window_id": payload.get("window_id")}


@app.function(
    cpu=1,
    memory=2048,
    timeout=28800,   # 8 hour cap after adding per-window feature selection.
                     # 14 windows * max(FS/train) / concurrent=2 needs multi-hour headroom.
                     # 8hr gives headroom for FS variance + late SHAP audit
    scaledown_window=60,
    max_containers=1,   # only one orchestrator at a time
)
def walk_forward_orchestrator(payload: dict) -> dict:
    """Walk-forward orchestrator that runs the full pipeline across windows.
    all windows, calling train_wf_tree_window / train_wf_ftt_window / train_wf_hmm_window
    internally. Persists aggregate result to GCS walk_forward/runs/{start}_{end}.json.

    payload:
        windows: list of {window_id, train_start, train_end, test_start, test_end}
        market_env: dict (full history; each window filters locally)
        batch_count: int - number of prep batches.
        models: list[str]
        concurrent_windows: int (default 2)
        start_date: str (for GCS path)
        end_date: str

    Returns: {gcs_path, aggregate}
    Fire-and-forget: ml-controller calls .spawn() and returns immediately.
    """
    _setup_env()
    import time
    import json
    import asyncio

    t0 = time.time()
    windows = payload["windows"]
    market_env = payload["market_env"]
    batch_count = payload.get("batch_count", 5)
    models = payload.get("models") or ["XGBoost", "CatBoost", "ExtraTrees", "LightGBM", "FT-Transformer"]
    concurrent = int(payload.get("concurrent_windows", 2))
    start_date = payload["start_date"]
    end_date = payload["end_date"]

    def _filter_env(end_str: str) -> dict:
        hist = market_env.get("history", {})
        filtered = {d: v for d, v in hist.items() if d <= end_str}
        if not filtered:
            return market_env
        latest_date = max(filtered.keys())
        return {"history": filtered, **filtered[latest_date]}

    # 2026-04-19 N2: per-window FS gates tree training to eliminate look-ahead
    fs_max_rounds = int(payload.get("fs_max_rounds", 60))
    fs_force_refresh = bool(payload.get("fs_force_refresh", False))

    async def _run_one(window: dict) -> dict:
        """Run feature selection, HMM, and tree/FT-T training for one window."""
        wid = window["window_id"]
        gcs_prefix = f"walk_forward/w{wid}"
        result = {
            "window_id": wid,
            "train_range": [window["train_start"], window["train_end"]],
            "test_range": [window["test_start"], window["test_end"]],
            "model_metrics": {},
        }

        # Step 0: per-window feature selection prevents future leakage in the tree path.
        # Tree training waits for this; FT-T (skip_feature_pool=True) does not need pool.
        # On FS error, fallback to running tree without pool (skip_feature_pool=True)
        # so the run does not abort entirely.
        fs_ok = False
        try:
            fs_payload = {
                "window_id": wid,
                "train_end_date": window["train_end"],
                "gcs_prefix": gcs_prefix,
                "max_rounds": fs_max_rounds,
                "force_refresh": fs_force_refresh,
            }
            fs_result = await feature_selection_per_window.remote.aio(fs_payload)
            result["fs_result"] = fs_result
            fs_ok = not bool(fs_result.get("error"))
            if fs_ok:
                pool_summary = (
                    fs_result.get("feature_pool", {}).get("tree_active")
                    or fs_result.get("feature_pool", {}).get("active")
                    or []
                )
                if not pool_summary and fs_result.get("skipped"):
                    pool_summary = [None] * (fs_result.get("tree_active_count") or 0)
                result["fs_tree_active_count"] = len(pool_summary)
            else:
                print(f"[WF-Orchestrator] w{wid} FS failed: {fs_result.get('error')} -> tree will fallback to skip_feature_pool")
        except Exception as e:
            print(f"[WF-Orchestrator] w{wid} FS crashed: {e}")
            result["fs_result"] = {"error": str(e)}

        # Step 1: HMM
        try:
            hmm_payload = {
                "window_id": wid,
                "train_end": window["train_end"],
                "market_env": _filter_env(window["train_end"]),
            }
            result["hmm_result"] = await train_wf_hmm_window.remote.aio(hmm_payload)
        except Exception as e:
            print(f"[WF-Orchestrator] w{wid} HMM crashed: {e}")
            result["hmm_result"] = {"error": str(e)}

        # Step 2+3: tree + ftt in parallel
        train_payload = {
            "window_id": wid,
            "train_start": window["train_start"],
            "train_end": window["train_end"],
            "test_start": window["test_start"],
            "test_end": window["test_end"],
            "batch_count": batch_count,
            "skip_feature_pool": False,
        }

        need_tree = any(m in models for m in ["XGBoost", "CatBoost", "ExtraTrees", "LightGBM"])
        need_ftt = "FT-Transformer" in models
        tasks = []
        if need_tree:
            tree_payload = dict(train_payload)
            if fs_ok:
                # explicit per-window pool path; train_wf_tree_window also defaults
                # to walk_forward/w{id}/feature_pool.json so this is belt-and-suspenders
                tree_payload["feature_pool_path"] = f"{gcs_prefix}/feature_pool.json"
            else:
                # If FS failed, do not use a stale global pool that can leak across windows.
                tree_payload["skip_feature_pool"] = True
            tasks.append(("tree", train_wf_tree_window.remote.aio(tree_payload)))
        if need_ftt:
            ftt_payload = dict(train_payload)
            ftt_payload["skip_feature_pool"] = True
            tasks.append(("ftt", train_wf_ftt_window.remote.aio(ftt_payload)))

        if tasks:
            raw = await asyncio.gather(*[t[1] for t in tasks], return_exceptions=True)
            for (kind, _), r in zip(tasks, raw):
                if isinstance(r, BaseException):
                    print(f"[WF-Orchestrator] w{wid} {kind} crashed: {r}")
                    result[f"{kind}_result"] = {"error": str(r)}
                else:
                    result[f"{kind}_result"] = r

        # Consolidate per-model metrics
        for partial in [result.get("tree_result") or {}, result.get("ftt_result") or {}]:
            if not partial or partial.get("error"):
                continue
            for model_name, m in (partial.get("results") or {}).items():
                if m.get("skipped") or m.get("error"):
                    continue
                result["model_metrics"][model_name] = {
                    "oos_ic": m.get("oos_ic"),
                    "train_samples": m.get("train"),
                    "test_samples": m.get("test"),
                }
        return result

    async def _orchestrate() -> list[dict]:
        sem = asyncio.Semaphore(concurrent)

        async def _bounded(w):
            async with sem:
                print(f"[WF-Orchestrator] Starting window {w['window_id']}")
                r = await _run_one(w)
                print(f"[WF-Orchestrator] Finished window {w['window_id']} "
                      f"(ic={[(k, v.get('oos_ic')) for k, v in r.get('model_metrics',{}).items()]})")
                return r

        return await asyncio.gather(*[_bounded(w) for w in windows])

    all_results = asyncio.run(_orchestrate())

    # Aggregate
    per_model = {}
    n_err = 0
    for wr in all_results:
        if not wr.get("model_metrics"):
            n_err += 1
            continue
        for mname, m in wr["model_metrics"].items():
            if m.get("oos_ic") is None:
                continue
            per_model.setdefault(mname, []).append(float(m["oos_ic"]))

    summary = {}
    for mname, ics in per_model.items():
        import statistics
        if not ics:
            continue
        summary[mname] = {
            "n_windows": len(ics),
            "mean_ic": sum(ics) / len(ics),
            "std_ic": statistics.stdev(ics) if len(ics) >= 2 else 0.0,
            "min_ic": min(ics),
            "max_ic": max(ics),
            "positive_share": sum(1 for ic in ics if ic > 0) / len(ics),
            "ic_per_window": ics,
        }

    # 2026-04-19 N2: aggregate per-window FS stats
    fs_stats = []
    for wr in all_results:
        fs_r = wr.get("fs_result") or {}
        if fs_r.get("error"):
            fs_stats.append({"window_id": wr.get("window_id"), "status": "error", "error": fs_r.get("error")})
        elif fs_r.get("skipped"):
            fs_stats.append({
                "window_id": wr.get("window_id"),
                "status": "cached",
                "tree_active_count": fs_r.get("tree_active_count"),
            })
        elif fs_r:
            pool_active = (
                fs_r.get("feature_pool", {}).get("tree_active")
                or fs_r.get("feature_pool", {}).get("active")
                or []
            )
            fs_stats.append({
                "window_id": wr.get("window_id"),
                "status": "computed",
                "tree_active_count": len(pool_active),
                "elapsed_s": fs_r.get("elapsed_s"),
            })

    aggregate = {
        "n_windows_total": len(all_results),
        "n_windows_errored": n_err,
        "per_model": summary,
        "fs_stats": fs_stats,
        "elapsed_s": round(time.time() - t0, 1),
    }

    # Persist to GCS
    try:
        from google.cloud import storage
        bucket_name = _get_gcs_bucket_name()
        if not bucket_name:
            raise RuntimeError("GCS bucket not configured")
        bucket = storage.Client().bucket(bucket_name)
        gcs_path = f"walk_forward/runs/{start_date}_{end_date}.json"
        bucket.blob(gcs_path).upload_from_string(
            json.dumps({
                "start_date": start_date,
                "end_date": end_date,
                "train_window_days": payload.get("train_window_days", 60),
                "test_window_days": payload.get("test_window_days", 30),
                "windows": all_results,
                "aggregate": aggregate,
            }, indent=2, default=str),
            content_type="application/json",
        )
        print(f"[WF-Orchestrator] Persisted gs://{bucket.name}/{gcs_path}")
    except Exception as e:
        print(f"[WF-Orchestrator] Persist failed: {e}")
        gcs_path = None

    return {
        "gcs_path": gcs_path,
        "aggregate": aggregate,
        "elapsed_s": round(time.time() - t0, 1),
    }


@app.function(
    gpu="L4",
    memory=4096,
    timeout=1800,                # 30 min for SHAP on selected samples.
    scaledown_window=60,
    max_containers=1,
)
def shap_feature_audit(payload: dict) -> dict:
    """Run SHAP feature importance audit."""
    _setup_env()
    from app.use_cases import run_shap_audit
    try:
        shap_samples = payload.get("shap_samples", 5000)
        return run_shap_audit(shap_samples=shap_samples)
    except Exception as e:
        return {"error": str(e), "type": "shap_audit"}


# Feature Selection Pipeline Modal wrapper.

@app.function(
    cpu=4,                       # Target permutation rounds are CPU-bound.
    memory=8192,                 # Spearman corr + LightGBM on full 960K samples
    timeout=7200,                # 120 min for signal gate, clustering, target permutation, K sweep, and diversity guard.
    scaledown_window=60,
    max_containers=1,
)
def feature_selection_pipeline(payload: dict) -> dict:
    """Run feature selection: signal gate, clustering, target permutation,
    IC/ICIR scoring, Optuna K Pareto sweep, and diversity guard.

    Reads prep .npz from GCS, writes feature_pool.json to GCS.
    """
    _setup_env()
    from app.feature_selection import run_feature_selection_pipeline
    from app.training_policy import FeatureSelectionPolicy
    selection_params = FeatureSelectionPolicy.from_env().to_selection_params(payload)
    try:
        return run_feature_selection_pipeline(
            max_rounds=selection_params["max_rounds"],
            alpha=selection_params["alpha"],
            dry_run=payload.get("dry_run", False),
            icir_weight=selection_params["icir_weight"],
            permutation_mode=selection_params["permutation_mode"],
            target_permutation_max_workers=selection_params["target_permutation_max_workers"],
            k_sweep_n_jobs=selection_params["k_sweep_n_jobs"],
            train_end_date=payload.get("train_end_date"),
            gcs_prefix=payload.get("gcs_prefix"),
        )
    except Exception as e:
        import traceback
        return {"error": str(e), "trace": traceback.format_exc(), "type": "feature_selection"}


# 2026-04-19 ML_POOL Stage 0.2: DLinear universal training (one-shot)
@app.function(
    gpu="L4",
    memory=8192,
    timeout=1800,             # 30 min for universal sequence training.
    scaledown_window=60,
    max_containers=1,
)
def train_dlinear_universal(payload: dict) -> dict:
    """One-shot universal DLinear training across all stocks' close series.

    payload:
        series_close: list[list[float]]   raw close per stock
        seq_len/pred_len/kernel/n_epochs/batch_size/lr/val_ratio: hyperparams
        version: GCS save tag (default "v1")
        device: "cuda" (default if GPU avail) or "cpu"

    Returns:
        {"saved": {weights_path, metadata_path}, "metadata": {...}}
    """
    _setup_env()
    from app.dlinear_universal import train_dlinear, save_to_gcs
    try:
        import torch
        device = payload.get("device") or ("cuda" if torch.cuda.is_available() else "cpu")
        result = train_dlinear(
            series_close=payload.get("series_close") or [],
            sequence_records=payload.get("sequence_records") or None,
            seq_len=payload.get("seq_len", 60),
            pred_len=payload.get("pred_len", 5),
            kernel=payload.get("kernel", 25),
            n_epochs=payload.get("n_epochs", 30),
            batch_size=payload.get("batch_size", 256),
            lr=payload.get("lr", 1e-3),
            val_ratio=payload.get("val_ratio", 0.15),
            device=device,
            model_cpcv_policy=payload.get("model_cpcv_policy") or None,
        )
        if result.get("error"):
            return result
        version = payload.get("version", "v1")
        result["metadata"]["version"] = version
        result["metadata"]["model_pool_version"] = version
        saved = save_to_gcs(result["_state_dict_torch"], result["metadata"], version=version)
        return {
            "saved": saved,
            "metadata": result["metadata"],
            "ic_tracking": result.get("ic_tracking", {}),
            "version": version,
            "elapsed_s": result["metadata"].get("elapsed_s"),
            "type": "dlinear_universal",
        }
    except Exception as e:
        import traceback
        return {"error": str(e), "trace": traceback.format_exc()[:2000], "type": "train_dlinear_universal"}


# 2026-04-19 ML_POOL Stage 0.2: DLinear batch predict
@app.function(
    cpu=2,
    memory=2048,             # DLinear is tiny, just linear layers
    timeout=300,             # 5 min cap for whole watchlist
    scaledown_window=300,    # keep model warm 5 min
    max_containers=1,
)
def dlinear_universal_predict(payload: dict) -> dict:
    """Batch DLinear forecast for the watchlist.

    payload:
        series_list: list of {symbol: str, prices: list[float]}
        version: GCS model version (default "v1")
        horizon_used: which pred_len step to report (default 5)

    Returns:
        {"results": [{...}], "n_input": int, "n_success": int}
        If model is not in GCS yet, all rows return "weights not in GCS".
    """
    _setup_env()
    from app.dlinear_universal import dlinear_batch_predict
    try:
        results = dlinear_batch_predict(
            series_list=payload.get("series_list") or [],
            horizon_used=payload.get("horizon_used", 5),
            version=payload.get("version", "v1"),
        )
        return {"results": results, "n_input": len(payload.get("series_list") or []),
                "n_success": sum(1 for r in results if not r.get("error"))}
    except Exception as e:
        import traceback
        return {"error": str(e), "trace": traceback.format_exc()[:2000], "type": "dlinear_universal_predict"}


# 2026-04-19 ML_POOL Stage 0.3: PatchTST universal training
@app.function(
    gpu="L4",
    memory=8192,
    timeout=3600,             # 60 min for ~1500 stocks ? ~330k windows ? 30 epochs
    scaledown_window=60,
    max_containers=1,
)
def train_patchtst_universal(payload: dict) -> dict:
    """One-shot universal PatchTST training across all stocks' close series."""
    _setup_env()
    from app.patchtst_universal import train_patchtst, save_to_gcs
    try:
        import torch
        device = payload.get("device") or ("cuda" if torch.cuda.is_available() else "cpu")
        result = train_patchtst(
            series_close=payload.get("series_close") or [],
            sequence_records=payload.get("sequence_records") or None,
            seq_len=payload.get("seq_len", 60),
            pred_len=payload.get("pred_len", 5),
            patch_len=payload.get("patch_len", 12),
            stride=payload.get("stride", 12),
            d_model=payload.get("d_model", 128),
            n_heads=payload.get("n_heads", 8),
            n_layers=payload.get("n_layers", 3),
            dropout=payload.get("dropout", 0.1),
            n_epochs=payload.get("n_epochs", 30),
            batch_size=payload.get("batch_size", 256),
            lr=payload.get("lr", 5e-4),
            weight_decay=payload.get("weight_decay", 1e-5),
            val_ratio=payload.get("val_ratio", 0.15),
            device=device,
            model_cpcv_policy=payload.get("model_cpcv_policy") or None,
        )
        if result.get("error"):
            return result
        version = payload.get("version", "v1")
        result["metadata"]["version"] = version
        result["metadata"]["model_pool_version"] = version
        saved = save_to_gcs(result["_state_dict_torch"], result["metadata"], version=version)
        return {
            "saved": saved,
            "metadata": result["metadata"],
            "ic_tracking": result.get("ic_tracking", {}),
            "version": version,
            "elapsed_s": result["metadata"].get("elapsed_s"),
            "type": "patchtst_universal",
        }
    except Exception as e:
        import traceback
        return {"error": str(e), "trace": traceback.format_exc()[:2000], "type": "train_patchtst_universal"}


# 2026-04-19 ML_POOL Stage 0.3: PatchTST batch predict
@app.function(
    cpu=2,
    memory=4096,             # PatchTST is small (~1MB weights), but transformer needs torch overhead
    timeout=300,
    scaledown_window=300,
    max_containers=1,
)
def patchtst_universal_predict(payload: dict) -> dict:
    """Batch PatchTST forecast for the watchlist."""
    _setup_env()
    from app.patchtst_universal import patchtst_batch_predict
    try:
        results = patchtst_batch_predict(
            series_list=payload.get("series_list") or [],
            horizon_used=payload.get("horizon_used", 5),
            version=payload.get("version", "v1"),
        )
        return {"results": results, "n_input": len(payload.get("series_list") or []),
                "n_success": sum(1 for r in results if not r.get("error"))}
    except Exception as e:
        import traceback
        return {"error": str(e), "trace": traceback.format_exc()[:2000], "type": "patchtst_universal_predict"}


# 2026-04-20 ML_POOL Stage 6.2: state-space batch predict (KalmanFilter + MarkovSwitching)
@app.function(
    cpu=2,
    memory=2048,
    timeout=600,             # 10 min for per-stock state-space loop.
    scaledown_window=300,    # keep hyperparam cache warm
    max_containers=1,
)
def state_space_universal_predict(payload: dict) -> dict:
    """Batch state-space forecast (KalmanFilter or MarkovSwitching).

    payload:
        model_name: 'KalmanFilter' or 'MarkovSwitching'
        series_list: list of {symbol: str, prices: list[float]}
        horizon: int (default 5)
        version: hyperparams version (default 'v1')

    Returns: {"results": [...], "n_input": int, "n_success": int}
    """
    _setup_env()
    from app.state_space_universal import state_space_batch_predict, state_space_overlays_batch_predict
    try:
        model_names = payload.get("model_names")
        if isinstance(model_names, list) and model_names:
            return state_space_overlays_batch_predict(
                model_names=[str(name) for name in model_names],
                series_list=payload.get("series_list") or [],
                horizon=payload.get("horizon", 5),
                version_by_model=payload.get("version_by_model") or {},
            )
        results = state_space_batch_predict(
            model_name=payload.get("model_name", "KalmanFilter"),
            series_list=payload.get("series_list") or [],
            horizon=payload.get("horizon", 5),
            version=payload.get("version", "v1"),
        )
        return {"results": results, "n_input": len(payload.get("series_list") or []),
                "n_success": sum(1 for r in results if not r.get("error"))}
    except Exception as e:
        import traceback
        return {"error": str(e), "trace": traceback.format_exc()[:2000], "type": "state_space_universal_predict"}


# 2026-04-19 ML_POOL Stage 0.1: Chronos universal batch predictor
@app.function(
    cpu=2,
    memory=8192,              # Chronos-2 production baseline
    timeout=900,              # 15 min cap for CPU Chronos-2 batch inference
    scaledown_window=300,     # keep container warm 5 min for back-to-back calls
    max_containers=1,         # singleton pipeline in module cache, one container fine
)
def chronos_universal_predict(payload: dict) -> dict:
    """Batch Chronos foundation model forecast for the watchlist.

    Replaces per-stock per-call invocation pattern (models.py:run_chronos
    called 33 times with fresh pipeline each) with a single batch call that
    reuses a module-cached pipeline.

    payload:
        series_list: list of {symbol: str, prices: list[float]}
        horizon: int (default 5)
        num_samples: int (default 20)
        model_id: str (optional override; production baseline is amazon/chronos-2)

    Returns:
        {"results": [{symbol, model, forecast_pct, up_prob, confidence,
                      direction, n_samples} | {symbol, error}]}
    """
    _setup_env()
    from app.chronos_universal import chronos_batch_predict
    try:
        results = chronos_batch_predict(
            series_list=payload.get("series_list") or [],
            horizon=payload.get("horizon", 5),
            num_samples=payload.get("num_samples", 20),
            model_id=payload.get("model_id", "amazon/chronos-2"),
        )
        return {"results": results, "n_input": len(payload.get("series_list") or []), "n_success": sum(1 for r in results if not r.get("error"))}
    except Exception as e:
        import traceback
        return {"error": str(e), "trace": traceback.format_exc(), "type": "chronos_universal"}


# 2026-04-19 N2: Walk-forward per-window feature selection
@app.function(
    cpu=4,
    memory=8192,
    timeout=3600,                # 60 min cap for walk-forward window subset.
    scaledown_window=60,
    max_containers=3,            # parallel windows
)
def feature_selection_per_window(payload: dict) -> dict:
    """Walk-forward window-scoped feature selection.

    Filters prep data to train_end_date before running the pipeline,
    so the resulting pool reflects only the train horizon (no look-ahead).
    Writes to {gcs_prefix}/feature_pool.json (no monthly snapshot).

    payload:
        window_id (int)
        train_end_date (str, ISO date)
        gcs_prefix (str, e.g., "walk_forward/w0")
        max_rounds (int, default from FeatureSelectionPolicy window policy)
        force_refresh (bool, default False) - if False and pool already exists, skip
    """
    _setup_env()
    import time
    from app.feature_selection import run_feature_selection_pipeline

    t0 = time.time()
    window_id = payload.get("window_id")
    train_end_date = payload["train_end_date"]
    gcs_prefix = payload["gcs_prefix"].rstrip("/")
    force = bool(payload.get("force_refresh", False))
    from app.training_policy import FeatureSelectionPolicy
    selection_params = FeatureSelectionPolicy.from_env().to_window_selection_params(payload)

    # Idempotency: skip if pool already exists for this window
    if not force:
        try:
            from google.cloud import storage
            bucket_name = _get_gcs_bucket_name()
            if not bucket_name:
                raise RuntimeError("GCS bucket not configured")
            bucket = storage.Client().bucket(bucket_name)
            existing = bucket.blob(f"{gcs_prefix}/feature_pool.json")
            if existing.exists():
                import json as _json
                pool = _json.loads(existing.download_as_text())
                active = pool.get("tree_active") or pool.get("active", [])
                print(f"[FS-Window] w{window_id} skip: pool exists ({len(active)} tree_active)")
                return {
                    "skipped": True,
                    "window_id": window_id,
                    "gcs_prefix": gcs_prefix,
                    "tree_active_count": len(active),
                    "elapsed_s": round(time.time() - t0, 1),
                }
        except Exception as e:
            print(f"[FS-Window] w{window_id} idempotency check failed ({e}) -> proceeding")

    try:
        result = run_feature_selection_pipeline(
            max_rounds=selection_params["max_rounds"],
            alpha=selection_params["alpha"],
            icir_weight=selection_params["icir_weight"],
            train_end_date=train_end_date,
            gcs_prefix=gcs_prefix,
        )
        # Annotate for orchestrator aggregate
        result["window_id"] = window_id
        result["gcs_prefix"] = gcs_prefix
        result["elapsed_s"] = round(time.time() - t0, 1)
        return result
    except Exception as e:
        import traceback
        return {
            "error": str(e),
            "trace": traceback.format_exc()[:2000],
            "window_id": window_id,
            "gcs_prefix": gcs_prefix,
            "type": "feature_selection_per_window",
        }


@app.function(
    cpu=1,
    memory=1024,
    timeout=60,
    scaledown_window=60,
    max_containers=5,
)
def update_arf_reward(payload: dict) -> dict:
    """Update ARF/LinUCB reward state."""
    _setup_env()
    from app.use_cases import update_arf, ARFUpdateRequest
    try:
        req = ARFUpdateRequest(**payload)
        return update_arf(req)
    except Exception as e:
        return {"error": str(e)}


# ASGI web endpoint for warmup, health, IC audit, and Optuna routes.

@app.function(
    cpu=2,            # 2026-04-07 bumped: Optuna 200 trials needs CPU
    memory=4096,      # Optuna routes join paper orders and predictions.
    timeout=1800,     # Optuna signal/SLTP trials can take several minutes.
    scaledown_window=60,
    max_containers=2,
)
@modal.concurrent(max_inputs=4)
@modal.asgi_app()
def fastapi_app():
    """ASGI endpoint for warmup, health, IC audit, and Optuna routes."""
    _setup_env()
    from app.main import app as fastapi_application
    return fastapi_application
