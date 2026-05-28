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
from datetime import datetime, timedelta, timezone
from pathlib import Path
from app.runtime_env import get_gcs_bucket_name, setup_modal_container_env

# Local code mounted into the Modal image during deploy.
_LOCAL_APP_DIR     = Path(__file__).parent / "app"
_LOCAL_SCRIPTS_DIR = Path(__file__).parent / "scripts"  # optuna routes import scripts/optuna_*.py
_LOCAL_CONTROLLER_OPTUNA_DIR = Path(__file__).parent.parent / "ml-controller" / "optuna_scripts"
_LOCAL_CONTROLLER_ROUTERS_DIR = Path(__file__).parent.parent / "ml-controller" / "routers"
_LOCAL_CONTROLLER_SERVICES_DIR = Path(__file__).parent.parent / "ml-controller" / "services"
_LOCAL_TOOLS_DIR = Path(__file__).parent.parent / "tools"
_LOCAL_REQ         = Path(__file__).parent / "requirements.txt"


def _controller_callback_token() -> str:
    return (
        os.environ.get("ML_CONTROLLER_TOKEN")
        or os.environ.get("INTERNAL_TOKEN")
        or os.environ.get("ML_CONTROLLER_SECRET")
        or os.environ.get("STOCKVISION_AUTH_TOKEN")
        or ""
    )

def _with_common_local_dirs(base_image):
    return (
        base_image
        .add_local_dir(str(_LOCAL_SCRIPTS_DIR), remote_path="/root/scripts")
        .add_local_dir(str(_LOCAL_CONTROLLER_OPTUNA_DIR), remote_path="/root/optuna_scripts")
        .add_local_dir(str(_LOCAL_CONTROLLER_ROUTERS_DIR), remote_path="/root/routers")
        .add_local_dir(str(_LOCAL_CONTROLLER_SERVICES_DIR), remote_path="/root/services")
        .add_local_dir(str(_LOCAL_APP_DIR), remote_path="/root/app")  # must be last
    )


# Modal image built with the v1.x API. Build steps must happen before local dirs.
_base_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("libgomp1", "ocl-icd-libopencl1")  # OpenMP + OpenCL ICD loader (NVIDIA driver provides libOpenCL at runtime)
    .pip_install_from_requirements(str(_LOCAL_REQ))
    .run_commands(
        "python -c \""
        "from chronos import Chronos2Pipeline; "
        "Chronos2Pipeline.from_pretrained('amazon/chronos-2', device_map='cpu')"
        "\" || echo 'Chronos pre-download skipped (not installed)'",
    )
)

image = _with_common_local_dirs(_base_image)

finlab_image = (
    _with_common_local_dirs(_base_image.pip_install("finlab==2.0.7"))
    .add_local_dir(str(_LOCAL_TOOLS_DIR), remote_path="/root/tools")
)

optuna_controller_image = _with_common_local_dirs(_base_image.pip_install("google-cloud-run>=0.10.0"))

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

try:
    finlab_secret = modal.Secret.from_name("stockvision-finlab")
except Exception:
    print("[modal_app] stockvision-finlab secret not found, FinLab backfill will fail until FINLAB_API_KEY is configured")
    finlab_secret = modal.Secret.from_dict({})

runtime_env_secret = modal.Secret.from_dict({
    key: value
    for key, value in {
        "GCS_BUCKET_NAME": os.environ.get("GCS_BUCKET_NAME", "stockvision-models").strip(),
        # Keep D1 reads/writes on the Worker binding instead of stale CF REST tokens.
        "STOCKVISION_WORKER_URL": os.environ.get("STOCKVISION_WORKER_URL", "").strip(),
        "STOCKVISION_AUTH_TOKEN": os.environ.get("STOCKVISION_AUTH_TOKEN", "").strip(),
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


def _post_worker_scheduler_callback(payload: dict) -> dict:
    """Best-effort Worker scheduler callback for detached Modal jobs."""
    worker_url = os.environ.get("STOCKVISION_WORKER_URL", "").strip()
    if not worker_url:
        return {"posted": False, "reason": "missing_STOCKVISION_WORKER_URL"}

    import httpx

    headers = {"Content-Type": "application/json"}
    token = _controller_callback_token()
    if token:
        headers["Authorization"] = f"Bearer {token}"

    url = f"{worker_url.rstrip('/')}/api/admin/scheduler-callback"
    try:
        resp = httpx.post(url, headers=headers, json=payload, timeout=30.0)
        return {
            "posted": resp.status_code == 200,
            "status_code": resp.status_code,
            "body": resp.text[:300],
        }
    except Exception as exc:  # noqa: BLE001
        return {"posted": False, "reason": f"{type(exc).__name__}: {exc}"}


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
    image=image,
    secrets=[gcs_secret, cf_secret, runtime_env_secret],
    cpu=4,
    memory=16384,
    timeout=7200,
    scaledown_window=60,
    max_containers=1,
)
def universal_retrain_pipeline(payload: dict) -> dict:
    """Run universal retrain prep on Modal, then spawn retrain_orchestrator.

    This mirrors the controller /retrain/universal prep owner without changing
    model scope. The controller acquires the lock and only spawns this function.
    """
    _setup_env()
    import sys
    import time
    import traceback
    from dataclasses import asdict
    from datetime import timedelta

    if "/root" not in sys.path:
        sys.path.insert(0, "/root")

    from services import d1_client, retrain_lock  # type: ignore
    from services.payload_builder import (  # type: ignore
        _bulk_load_chips,
        _bulk_load_indicators,
        _bulk_load_prices,
        _bulk_load_sentiment,
        load_market_env,
    )
    from services.training_calendar import monthly_revenue_available_date  # type: ignore
    from services.training_policy import TrainingPolicy  # type: ignore
    from routers.retrain_trigger import (  # type: ignore
        UniversalRetrainTriggerRequest,
        _build_sector_encoding,
        _estimate_cap_bucket,
        _load_training_maps_from_snapshot,
        _universal_prep_concurrency,
        _upsert_retrain_status,
        _volume_bucket,
    )

    def _call_id(call) -> str | None:
        return (
            getattr(call, "object_id", None)
            or getattr(call, "function_call_id", None)
            or getattr(call, "call_id", None)
        )

    def _callback_failure(*, task: str, run_id: str, run_date: str, summary: str, duration_ms: int, error: str) -> dict:
        return _post_worker_scheduler_callback({
            "task": task,
            "status": "error",
            "summary": summary[:1200],
            "duration_ms": duration_ms,
            "run_id": run_id,
            "run_date": run_date,
            "error": error[:1200],
            "metadata": {
                "source": "universal_retrain_pipeline",
                "executor": "modal",
                "trigger_source": payload.get("trigger_source"),
                "trigger_id": payload.get("trigger_id"),
                "quality_contract": payload.get("quality_contract"),
            },
        })

    t0 = time.time()
    tw_now = datetime.now(timezone.utc) + timedelta(hours=8)
    request_payload = payload.get("request") if isinstance(payload.get("request"), dict) else {}
    req = UniversalRetrainTriggerRequest(**request_payload)
    run_date = str(payload.get("run_date") or req.run_date or tw_now.date().isoformat())
    run_id = str(payload.get("run_id") or f"universal-{tw_now.strftime('%Y%m%dT%H%M%S')}")
    lock_key = str(payload.get("lock_key") or f"retrain:{run_date}")
    followup_webhook_url = str(payload.get("followup_webhook_url") or "")
    dataset_snapshot_info: dict | None = None
    is_monthly = False
    scheduler_task = "retrain"

    try:
        stock_rows = d1_client.query(
            "SELECT id, symbol, market FROM stocks "
            "WHERE market IN ('TW','TWO','TWSE','OTC') "
            "ORDER BY id LIMIT ?",
            [req.limit],
        )
        if not stock_rows:
            raise ValueError("No stocks found")

        stock_ids = [r["id"] for r in stock_rows]
        symbols = [r["symbol"] for r in stock_rows]
        id_to_sym = {r["id"]: r["symbol"] for r in stock_rows}

        market_env, _adaptive, barrier_params, _lifecycle, _tc = load_market_env(run_date)
        training_policy = TrainingPolicy.from_env()
        vix = getattr(market_env, "us_vix", 18) or 18
        twii_bias = getattr(market_env, "twii_bias", 0) or 0
        _regime, prices_lookback = training_policy.resolve_regime(vix=float(vix), twii_bias=float(twii_bias))
        is_monthly = training_policy.is_monthly(force_monthly=req.force_monthly, tw_day=tw_now.day)
        scheduler_task = "monthly-retrain" if is_monthly else "retrain"

        d1_chunk = 80
        prices_map: dict = {}
        indicators_map: dict = {}
        chips_map: dict = {}
        sentiment_map: dict = {}
        per_stock_ts_map: dict[int, dict[str, dict]] = {}
        try:
            snapshot_maps = _load_training_maps_from_snapshot(
                stock_ids=stock_ids,
                symbols=symbols,
                prices_lookback=prices_lookback,
                as_of_business_date=run_date,
            )
        except Exception as snapshot_err:  # noqa: BLE001
            print(f"[UniversalRetrainPipeline] GCS snapshot load failed; falling back to D1: {snapshot_err}")
            snapshot_maps = None

        if snapshot_maps:
            prices_map, indicators_map, chips_map, sentiment_map, per_stock_ts_map, dataset_snapshot_info = snapshot_maps

        snapshot_components = set((dataset_snapshot_info or {}).get("components") or [])
        for ci in range(0, len(stock_ids), d1_chunk):
            chunk_ids = stock_ids[ci:ci + d1_chunk]
            chunk_syms = [id_to_sym[sid] for sid in chunk_ids]
            if not dataset_snapshot_info:
                prices_map.update(_bulk_load_prices(chunk_ids, limit=prices_lookback))
                indicators_map.update(_bulk_load_indicators(chunk_ids, limit=prices_lookback))
                chips_map.update(_bulk_load_chips(chunk_syms, limit=252))
            if "sentiment" not in snapshot_components:
                sentiment_map.update(_bulk_load_sentiment(chunk_ids, limit=45))

        rev_rows = []
        if "monthly_revenue" not in snapshot_components:
            rev_rows = d1_client.query(
                "SELECT stock_id, date, revenue_yoy FROM monthly_revenue "
                "WHERE revenue_yoy IS NOT NULL ORDER BY stock_id, date ASC",
                timeout=120.0,
            )
            for row in (rev_rows or []):
                sid = row["stock_id"]
                date_key = monthly_revenue_available_date(row["date"])
                per_stock_ts_map.setdefault(sid, {}).setdefault(date_key, {})["revenue_yoy"] = row.get("revenue_yoy", 0)

        for ci in range(0, len(stock_ids), d1_chunk):
            chunk_ids = stock_ids[ci:ci + d1_chunk]
            placeholders = ",".join("?" * len(chunk_ids))
            if "margin_data" not in snapshot_components:
                margin_rows = d1_client.query(
                    f"SELECT stock_id, date, margin_balance, short_ratio "
                    f"FROM margin_data WHERE stock_id IN ({placeholders}) "
                    f"ORDER BY stock_id, date ASC",
                    list(chunk_ids),
                    timeout=120.0,
                )
                for row in (margin_rows or []):
                    sid = row["stock_id"]
                    date_key = row["date"]
                    bucket = per_stock_ts_map.setdefault(sid, {}).setdefault(date_key, {})
                    if row.get("margin_balance") is not None:
                        bucket["margin_balance"] = row["margin_balance"]
                    if row.get("short_ratio") is not None:
                        bucket["short_ratio"] = row["short_ratio"]
            if "shareholding" not in snapshot_components:
                shareholding_rows = d1_client.query(
                    f"SELECT stock_id, date, retail_pct "
                    f"FROM shareholding WHERE stock_id IN ({placeholders}) "
                    f"ORDER BY stock_id, date ASC",
                    list(chunk_ids),
                    timeout=120.0,
                )
                for row in (shareholding_rows or []):
                    if row.get("retail_pct") is None:
                        continue
                    per_stock_ts_map.setdefault(row["stock_id"], {}).setdefault(row["date"], {})["retail_pct"] = row["retail_pct"]

        sector_enc = _build_sector_encoding()
        tag_rows = d1_client.query("SELECT symbol, tag FROM stock_tags WHERE tag_type='industry'")
        sym_to_sector = {row["symbol"]: row["tag"] for row in tag_rows}

        per_stock_payloads = []
        skipped = []
        for row in stock_rows:
            sid, sym = row["id"], row["symbol"]
            px = prices_map.get(sid, [])
            if len(px) < 60:
                skipped.append(f"{sym}(prices={len(px)}<60)")
                continue
            sector_tag = sym_to_sector.get(sym, "")
            per_stock_payloads.append({
                "stock_id": sid,
                "symbol": sym,
                "market": row.get("market", "TW"),
                "prices": px,
                "indicators": indicators_map.get(sid, []),
                "chips": chips_map.get(sym, []),
                "sentiment_scores": sentiment_map.get(sid, []),
                "market_env": {
                    "risk_score": market_env.risk_score,
                    "risk_level": market_env.risk_level,
                    "us_sox_return": market_env.us_sox_return,
                    "us_vix": market_env.us_vix,
                },
                "stock_meta": {
                    "sector_encoded": sector_enc.get(sector_tag, 0),
                    "market_cap_bucket": _estimate_cap_bucket(px),
                    "avg_volume_bucket": _volume_bucket(px),
                },
            })

        if len(per_stock_payloads) < 10:
            raise ValueError(f"Usable stocks < 10 ({len(per_stock_payloads)})")

        sector_returns: dict[str, list[tuple[float, float]]] = {}
        for item in per_stock_payloads:
            px = item["prices"]
            if len(px) < 6:
                continue
            close_last = float(px[-1].get("close", 0))
            close_1d = float(px[-2].get("close", 0)) if len(px) >= 2 else close_last
            close_5d = float(px[-6].get("close", 0)) if len(px) >= 6 else close_last
            ret_1d = (close_last - close_1d) / close_1d if close_1d > 0 else 0.0
            ret_5d = (close_last - close_5d) / close_5d if close_5d > 0 else 0.0
            tag = sym_to_sector.get(item["symbol"], "")
            if tag:
                sector_returns.setdefault(tag, []).append((ret_1d, ret_5d))
            item["_r5d"] = ret_5d

        sector_avg = {
            tag: (
                sum(value[0] for value in values) / len(values),
                sum(value[1] for value in values) / len(values),
            )
            for tag, values in sector_returns.items()
            if values
        }
        for item in per_stock_payloads:
            avg = sector_avg.get(sym_to_sector.get(item["symbol"], ""), (0.0, 0.0))
            item["stock_meta"]["sector_peer_return_1d"] = round(avg[0], 6)
            item["stock_meta"]["sector_peer_return_5d"] = round(avg[1], 6)
            item["stock_meta"]["stock_vs_sector"] = round(item.pop("_r5d", 0) - avg[1], 6)

        batch_size = 500
        batches = [per_stock_payloads[i:i + batch_size] for i in range(0, len(per_stock_payloads), batch_size)]
        batch_count = len(batches)
        shared_history = asdict(market_env).get("history", {})
        per_stock_ts_str = {str(k): v for k, v in per_stock_ts_map.items()} if per_stock_ts_map else {}
        prep_concurrency = min(_universal_prep_concurrency(), max(1, batch_count))
        prep_results: list[dict] = []

        for start in range(0, batch_count, prep_concurrency):
            handles = []
            for idx in range(start, min(start + prep_concurrency, batch_count)):
                batch_payloads = batches[idx]
                batch_stock_ids = {str(item["stock_id"]) for item in batch_payloads}
                prep_payload = {
                    "payloads": batch_payloads,
                    "barrier_params": barrier_params,
                    "batch_index": idx,
                    "shared_market_history": shared_history,
                    "per_stock_ts_map": {
                        key: value
                        for key, value in per_stock_ts_str.items()
                        if key in batch_stock_ids
                    },
                    "gcs_prefix": "universal",
                }
                handles.append((idx, prep_universal_batch.spawn(prep_payload)))
            for idx, call in handles:
                try:
                    result = call.get()
                    if not isinstance(result, dict):
                        result = {"batch_index": idx, "error": f"invalid prep result type: {type(result).__name__}"}
                except Exception as exc:  # noqa: BLE001
                    result = {"batch_index": idx, "error": str(exc)}
                result.setdefault("batch_index", idx)
                prep_results.append(result)

        total_rows = sum(int(row.get("rows", 0) or 0) for row in prep_results)
        _upsert_retrain_status(
            run_id,
            status="prep_complete",
            summary={
                "lock_key": lock_key,
                "run_date": run_date,
                "is_monthly": is_monthly,
                "batch_count": batch_count,
                "prep_concurrency": prep_concurrency,
                "dataset_snapshot": dataset_snapshot_info,
                "total_prep_rows": total_rows,
                "stocks_sent": len(per_stock_payloads),
                "stocks_skipped": len(skipped),
                "executor": "modal",
            },
            downstream_notes="await_orchestrator_dispatch",
        )
        if total_rows < 10000:
            raise ValueError(f"Total prep rows {total_rows} < 10000, aborting train")

        orchestrator_payload = {
            "batch_count": batch_count,
            "is_monthly": is_monthly,
            "candidate_type": req.candidate_type,
            "drift_target_models": req.drift_target_models,
            "drift_target_families": req.drift_target_families,
            "train_model_groups": req.train_model_groups,
            "selection_params": training_policy.feature_selection_params(),
            "training_policy": training_policy.to_dict(),
            "dataset_snapshot": dataset_snapshot_info,
            "ftt_d_model": req.ftt_d_model,
            "ftt_n_heads": req.ftt_n_heads,
            "ftt_n_layers": req.ftt_n_layers,
            "ftt_dropout": req.ftt_dropout,
            "ftt_max_epochs": req.ftt_max_epochs,
            "ftt_lr": req.ftt_lr,
            "ftt_patience": req.ftt_patience,
            "ftt_batch_size": req.ftt_batch_size,
            "ftt_margin": req.ftt_margin,
            "followup_webhook_url": followup_webhook_url,
            "gcs_prefix": "universal",
            "run_id": run_id,
            "lock_key": lock_key,
            "run_date": run_date,
        }
        orchestrator_call = retrain_orchestrator.spawn(orchestrator_payload)
        orchestrator_call_id = _call_id(orchestrator_call)
        _upsert_retrain_status(
            run_id,
            status="orchestrator_dispatched",
            summary={
                "lock_key": lock_key,
                "run_date": run_date,
                "is_monthly": is_monthly,
                "batch_count": batch_count,
                "prep_concurrency": prep_concurrency,
                "dataset_snapshot": dataset_snapshot_info,
                "total_prep_rows": total_rows,
                "stocks_sent": len(per_stock_payloads),
                "stocks_skipped": len(skipped),
                "orchestrator_function_call_id": orchestrator_call_id,
                "executor": "modal",
            },
            downstream_notes="await_modal_followup",
        )
        return {
            "status": "orchestrator_dispatched",
            "source": "universal_retrain_pipeline",
            "executor": "modal",
            "run_id": run_id,
            "run_date": run_date,
            "lock_key": lock_key,
            "is_monthly": is_monthly,
            "batch_count": batch_count,
            "prep_concurrency": prep_concurrency,
            "total_prep_rows": total_rows,
            "stocks_sent": len(per_stock_payloads),
            "stocks_skipped": len(skipped),
            "orchestrator_function_call_id": orchestrator_call_id,
            "duration_ms": int((time.time() - t0) * 1000),
        }
    except Exception as exc:  # noqa: BLE001
        error = f"{type(exc).__name__}: {exc}"
        duration_ms = int((time.time() - t0) * 1000)
        try:
            retrain_lock.release(lock_key)
        except Exception as release_exc:  # noqa: BLE001
            print(f"[UniversalRetrainPipeline] lock release failed: {release_exc}")
        try:
            _upsert_retrain_status(
                run_id,
                status="prep_failed",
                summary={
                    "lock_key": lock_key,
                    "run_date": run_date,
                    "is_monthly": is_monthly,
                    "dataset_snapshot": dataset_snapshot_info,
                    "error": error,
                    "trace": traceback.format_exc()[:2000],
                    "executor": "modal",
                },
                downstream_notes="modal_retrain_pipeline_failed",
            )
        except Exception as status_exc:  # noqa: BLE001
            print(f"[UniversalRetrainPipeline] status upsert failed: {status_exc}")
        callback = _callback_failure(
            task=scheduler_task,
            run_id=run_id,
            run_date=run_date,
            summary=f"universal retrain prep failed run_id={run_id} error={error}",
            duration_ms=duration_ms,
            error=error,
        )
        return {
            "status": "error",
            "source": "universal_retrain_pipeline",
            "executor": "modal",
            "run_id": run_id,
            "run_date": run_date,
            "lock_key": lock_key,
            "duration_ms": duration_ms,
            "error": error,
            "trace": traceback.format_exc()[:3000],
            "callback": callback,
        }


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


@app.function(
    cpu=4,
    memory=8192,
    timeout=21600,
    scaledown_window=60,
    max_containers=1,
)
def optuna_per_regime_robust(payload: dict) -> dict:
    """Run per-regime robust Optuna on Modal and callback Worker when done.

    Result push remains sandbox/challenger only; production config promotion is
    still handled by the existing Worker promotion gates.
    """
    _setup_env()
    import sys
    import time
    import traceback

    if "/root" not in sys.path:
        sys.path.insert(0, "/root")
    if "/root/optuna_scripts" not in sys.path:
        sys.path.insert(0, "/root/optuna_scripts")

    from optuna_per_regime_robust import run_search  # type: ignore

    t0 = time.time()
    run_id = str(payload.get("run_id") or f"modal-per-regime-{int(t0)}")
    callback_task = str(payload.get("callback_task") or "optuna-queue")
    run_date = payload.get("run_date")
    trigger_source = payload.get("trigger_source") or "queue"
    trigger_id = payload.get("trigger_id")

    result: dict
    status = "error"
    error = None
    summary = ""

    try:
        result = run_search(
            target=str(payload.get("target") or "sltp"),
            n_trials=int(payload.get("n_trials") or 50),
            subset_size=int(payload.get("subset_size") or 400),
            window_days=int(payload.get("window_days") or 365),
            data_mode=payload.get("research_data_source") or "snapshot",
            push_kv=_truthy(payload.get("push_kv")) and not _truthy(payload.get("dry_run")),
        )
        status = "success"
        summary = (
            f"per_regime modal completed robust_sharpe={result.get('robust_sharpe', 'n/a')} "
            f"trigger_source={trigger_source} trigger_id={trigger_id or '-'}"
        )
    except Exception as exc:  # noqa: BLE001
        error = f"{type(exc).__name__}: {exc}"
        result = {
            "error": error,
            "trace": traceback.format_exc()[:3000],
            "type": "optuna_per_regime_robust",
        }
        summary = error[:1200]

    duration_ms = int((time.time() - t0) * 1000)
    callback_payload = {
        "task": callback_task,
        "status": status,
        "summary": summary[:1200],
        "duration_ms": duration_ms,
        "run_id": run_id,
        "metadata": {
            "source": "per_regime_robust",
            "executor": "modal",
            "trigger_source": trigger_source,
            "trigger_id": trigger_id,
            "robust_sharpe": result.get("robust_sharpe"),
            "weighted_sharpe": result.get("weighted_sharpe"),
            "weighted_max_dd": result.get("weighted_max_dd"),
            "best_trial": result.get("best_trial"),
            "kv_push_ok": result.get("kv_push_ok"),
            "n_trials_completed": result.get("n_trials_completed"),
            "n_pareto": result.get("n_pareto"),
            "regimes_with_data": result.get("regimes_with_data"),
            "warnings": result.get("warnings"),
            "window": result.get("window"),
        },
    }
    if run_date:
        callback_payload["run_date"] = run_date
    if error:
        callback_payload["error"] = error[:1200]

    callback = _post_worker_scheduler_callback(callback_payload)
    return {
        "status": status,
        "source": "per_regime_robust",
        "executor": "modal",
        "run_id": run_id,
        "trigger_source": trigger_source,
        "trigger_id": trigger_id,
        "duration_ms": duration_ms,
        "callback": callback,
        **result,
    }


@app.function(
    image=optuna_controller_image,
    secrets=[gcs_secret, cf_secret, runtime_env_secret],
    cpu=4,
    memory=4096,
    timeout=21600,
    scaledown_window=60,
    max_containers=1,
)
def optuna_research_sweep(payload: dict) -> dict:
    """Run weekly/monthly Optuna research sweep on Modal and callback Worker."""
    _setup_env()
    import sys
    import time
    import traceback

    if "/root" not in sys.path:
        sys.path.insert(0, "/root")

    from routers.optuna import OptunaResearchSweepReq, execute_research_sweep  # type: ignore

    t0 = time.time()
    cadence = str(payload.get("cadence") or "weekly")
    run_id = str(payload.get("run_id") or f"optuna-{cadence}-{int(t0)}")
    callback_task = str(payload.get("callback_task") or f"{cadence}-optuna")
    run_date = payload.get("run_date")
    trigger_source = payload.get("trigger_source") or "research_sweep"
    trigger_id = payload.get("trigger_id")
    status = "error"
    error = None
    result: dict

    try:
        req = OptunaResearchSweepReq(
            cadence=cadence,
            n_trials=int(payload.get("n_trials") or 200),
            subset_size=int(payload.get("subset_size") or 1000),
            max_parallel_sources=int(payload.get("max_parallel_sources") or 3),
            ga_population_size=int(payload.get("ga_population_size") or 24),
            ga_generations=int(payload.get("ga_generations") or 8),
            research_data_source=payload.get("research_data_source") or "snapshot",
            run_date=run_date,
            push_kv=_truthy(payload.get("push_kv", True)),
            dry_run=_truthy(payload.get("dry_run", False)),
        )
        result = execute_research_sweep(req)
        status = "success" if result.get("status") == "completed" else "error"
    except Exception as exc:  # noqa: BLE001
        error = f"{type(exc).__name__}: {exc}"
        result = {
            "status": "error",
            "error": error,
            "trace": traceback.format_exc()[:3000],
            "type": "optuna_research_sweep",
        }

    duration_ms = int((time.time() - t0) * 1000)
    failures = result.get("failures") or []
    summary = (
        f"run_id={run_id} cadence={cadence} status={result.get('status')} "
        f"failures={len(failures)} trigger_source={trigger_source} trigger_id={trigger_id or '-'}"
    )
    if error:
        summary = error[:1200]

    callback_payload = {
        "task": callback_task,
        "status": status,
        "summary": summary[:1200],
        "duration_ms": duration_ms,
        "run_id": run_id,
        "metadata": {
            "source": "optuna_research_sweep",
            "executor": "modal",
            "cadence": cadence,
            "trigger_source": trigger_source,
            "trigger_id": trigger_id,
            "n_trials": payload.get("n_trials") or 200,
            "subset_size": payload.get("subset_size") or 1000,
            "max_parallel_sources": payload.get("max_parallel_sources") or 3,
            "ga_population_size": payload.get("ga_population_size") or 24,
            "ga_generations": payload.get("ga_generations") or 8,
            "result_status": result.get("status"),
            "failures": failures,
            "ga": result.get("ga"),
        },
    }
    if run_date:
        callback_payload["run_date"] = run_date
    if error:
        callback_payload["error"] = error[:1200]

    callback = _post_worker_scheduler_callback(callback_payload)
    return {
        "status": status,
        "source": "optuna_research_sweep",
        "executor": "modal",
        "run_id": run_id,
        "duration_ms": duration_ms,
        "callback": callback,
        **result,
    }


@app.function(
    image=optuna_controller_image,
    secrets=[gcs_secret, cf_secret, runtime_env_secret],
    cpu=4,
    memory=4096,
    timeout=7200,
    scaledown_window=60,
    max_containers=1,
)
def backtest_research_bundle(payload: dict) -> dict:
    """Run backtest, Monte Carlo, and PBO as one Modal-owned research bundle."""
    _setup_env()
    import asyncio
    import sys
    import time
    import traceback

    if "/root" not in sys.path:
        sys.path.insert(0, "/root")

    from services.backtest_research_bundle import (  # type: ignore
        build_backtest_research_bundle,
        validate_backtest_research_bundle,
    )
    from services.backtest_service import run_full_backtest  # type: ignore
    from services.monte_carlo_service import run_monte_carlo_mdd  # type: ignore
    from services.pbo_service import run_pbo_analysis  # type: ignore

    async def _run_bundle_steps() -> dict:
        monte_carlo_n = int(payload.get("monte_carlo_n") or 1000)
        pbo_partitions = int(payload.get("pbo_partitions") or 10)
        pbo_source = str(payload.get("pbo_source") or "backtest")
        return {
            "backtest": await run_full_backtest(),
            "monte_carlo_paper": await run_monte_carlo_mdd(
                n_simulations=monte_carlo_n,
                source="paper",
            ),
            "monte_carlo_backtest": await run_monte_carlo_mdd(
                n_simulations=monte_carlo_n,
                source="backtest",
            ),
            "pbo_backtest": await run_pbo_analysis(
                n_partitions=pbo_partitions,
                source=pbo_source,
            ),
        }

    t0 = time.time()
    run_id = str(payload.get("run_id") or f"backtest-bundle-{int(t0)}")
    callback_task = str(payload.get("callback_task") or "weekly-backtest")
    run_date = payload.get("run_date")
    trigger_source = payload.get("trigger_source") or "research_bundle"
    trigger_id = payload.get("trigger_id")
    bundle: dict
    error = None

    try:
        steps = asyncio.run(_run_bundle_steps())
        bundle = build_backtest_research_bundle(
            run_id=run_id,
            steps=steps,
            params={
                "monte_carlo_n": int(payload.get("monte_carlo_n") or 1000),
                "pbo_partitions": int(payload.get("pbo_partitions") or 10),
                "pbo_source": str(payload.get("pbo_source") or "backtest"),
                "trigger_source": trigger_source,
                "trigger_id": trigger_id,
            },
        )
        validation_errors = validate_backtest_research_bundle(bundle)
        if validation_errors:
            error = "bundle_validation_failed:" + ",".join(validation_errors)
            bundle["status"] = "error"
            bundle["validation_errors"] = validation_errors
    except Exception as exc:  # noqa: BLE001
        error = f"{type(exc).__name__}: {exc}"
        bundle = {
            "schema_version": "backtest-research-bundle-v1",
            "run_id": run_id,
            "status": "error",
            "error": error,
            "trace": traceback.format_exc()[:3000],
        }

    duration_ms = int((time.time() - t0) * 1000)
    status = "success" if bundle.get("status") == "success" else "error"
    failed_steps = bundle.get("failed_steps") or []
    summary = (
        f"run_id={run_id} status={bundle.get('status')} "
        f"failed_steps={len(failed_steps)} mc_n={payload.get('monte_carlo_n') or 1000} "
        f"pbo_partitions={payload.get('pbo_partitions') or 10}"
    )
    if error:
        summary = f"{summary} error={str(error)[:240]}"

    callback_payload = {
        "task": callback_task,
        "status": status,
        "summary": summary[:1200],
        "duration_ms": duration_ms,
        "run_id": run_id,
        "metadata": {
            "source": "backtest_research_bundle",
            "executor": "modal",
            "trigger_source": trigger_source,
            "trigger_id": trigger_id,
            "bundle": bundle,
        },
    }
    if run_date:
        callback_payload["run_date"] = run_date
    if error:
        callback_payload["error"] = str(error)[:1200]

    callback = _post_worker_scheduler_callback(callback_payload)
    return {
        "status": status,
        "source": "backtest_research_bundle",
        "executor": "modal",
        "run_id": run_id,
        "duration_ms": duration_ms,
        "callback": callback,
        "bundle": bundle,
    }


@app.function(
    image=optuna_controller_image,
    secrets=[gcs_secret, cf_secret, runtime_env_secret],
    cpu=4,
    memory=4096,
    timeout=7200,
    scaledown_window=60,
    max_containers=1,
)
def backtest_replay(payload: dict) -> dict:
    """Run the existing /backtest/replay implementation on Modal and callback Worker."""
    _setup_env()
    import asyncio
    import sys
    import time
    import traceback

    if "/root" not in sys.path:
        sys.path.insert(0, "/root")

    from routers.backtest import ReplayRequest, trigger_replay  # type: ignore

    t0 = time.time()
    run_id = str(payload.get("run_id") or f"backtest-replay-{int(t0)}")
    callback_task = str(payload.get("callback_task") or "backtest-replay")
    trigger_source = payload.get("trigger_source") or "controller"
    trigger_id = payload.get("trigger_id")
    request_payload = payload.get("request") if isinstance(payload.get("request"), dict) else payload
    result: dict = {}
    error = None

    try:
        req = ReplayRequest(**request_payload)
        result = asyncio.run(trigger_replay(req))
        if result.get("status") == "error":
            error = str(result.get("error") or "backtest replay failed")
    except Exception as exc:  # noqa: BLE001
        error = f"{type(exc).__name__}: {exc}"
        result = {
            "status": "error",
            "error": error,
            "trace": traceback.format_exc()[:3000],
        }

    duration_ms = int((time.time() - t0) * 1000)
    status = "success" if result.get("status") == "ok" else "error"
    summary = (
        f"run_id={run_id} status={result.get('status')} "
        f"timerange={result.get('timerange') or request_payload.get('start_date')}~{request_payload.get('end_date')} "
        f"mode={result.get('mode') or request_payload.get('mode', 'A')} "
        f"trades={result.get('total_trades')} sharpe={result.get('sharpe')}"
    )
    if error:
        summary = f"{summary} error={str(error)[:240]}"

    callback_payload = {
        "task": callback_task,
        "status": status,
        "summary": summary[:1200],
        "duration_ms": duration_ms,
        "run_id": run_id,
        "metadata": {
            "source": "backtest_replay",
            "executor": "modal",
            "trigger_source": trigger_source,
            "trigger_id": trigger_id,
            "request": request_payload,
            "result": result,
        },
    }
    if request_payload.get("end_date"):
        callback_payload["run_date"] = request_payload.get("end_date")
    if error:
        callback_payload["error"] = str(error)[:1200]

    callback = _post_worker_scheduler_callback(callback_payload)
    return {
        "status": status,
        "source": "backtest_replay",
        "executor": "modal",
        "run_id": run_id,
        "duration_ms": duration_ms,
        "callback": callback,
        "result": result,
    }


@app.function(
    image=image,
    secrets=[gcs_secret, cf_secret, runtime_env_secret],
    cpu=4,
    memory=4096,
    timeout=7200,
    scaledown_window=60,
    max_containers=1,
)
def backtest_full_run(payload: dict) -> dict:
    """Run the existing full backtest on Modal and callback Worker."""
    _setup_env()
    import asyncio
    import sys
    import time
    import traceback

    if "/root" not in sys.path:
        sys.path.insert(0, "/root")

    from services.backtest_service import run_full_backtest  # type: ignore

    t0 = time.time()
    run_id = str(payload.get("run_id") or f"backtest-full-{int(t0)}")
    callback_task = str(payload.get("callback_task") or "backtest")
    trigger_source = payload.get("trigger_source") or "controller"
    trigger_id = payload.get("trigger_id")
    result: dict = {}
    error = None

    try:
        result = asyncio.run(run_full_backtest())
        if result.get("status") in {"error", "failed"}:
            error = str(result.get("error") or result.get("status"))
    except Exception as exc:  # noqa: BLE001
        error = f"{type(exc).__name__}: {exc}"
        result = {
            "status": "error",
            "error": error,
            "trace": traceback.format_exc()[:3000],
        }

    duration_ms = int((time.time() - t0) * 1000)
    status = "error" if error else "success"
    summary = (
        f"run_id={run_id} status={result.get('status')} "
        f"trades={result.get('total_trades')} win={result.get('win_rate')} "
        f"sharpe={result.get('sharpe')}"
    )
    if error:
        summary = f"{summary} error={str(error)[:240]}"

    callback_payload = {
        "task": callback_task,
        "status": status,
        "summary": summary[:1200],
        "duration_ms": duration_ms,
        "run_id": run_id,
        "metadata": {
            "source": "backtest_full_run",
            "executor": "modal",
            "trigger_source": trigger_source,
            "trigger_id": trigger_id,
            "result": result,
        },
    }
    if error:
        callback_payload["error"] = str(error)[:1200]

    callback = _post_worker_scheduler_callback(callback_payload)
    return {
        "status": status,
        "source": "backtest_full_run",
        "executor": "modal",
        "run_id": run_id,
        "duration_ms": duration_ms,
        "callback": callback,
        "result": result,
    }


@app.function(
    image=image,
    secrets=[gcs_secret, cf_secret, runtime_env_secret],
    cpu=4,
    memory=4096,
    timeout=7200,
    scaledown_window=60,
    max_containers=1,
)
def backtest_monte_carlo(payload: dict) -> dict:
    """Run Monte Carlo tail-risk analysis on Modal and callback Worker."""
    _setup_env()
    import asyncio
    import sys
    import time
    import traceback

    if "/root" not in sys.path:
        sys.path.insert(0, "/root")

    from services.monte_carlo_service import run_monte_carlo_mdd  # type: ignore

    t0 = time.time()
    run_id = str(payload.get("run_id") or f"backtest-monte-carlo-{int(t0)}")
    callback_task = str(payload.get("callback_task") or "monte-carlo")
    trigger_source = payload.get("trigger_source") or "controller"
    trigger_id = payload.get("trigger_id")
    result: dict = {}
    error = None

    try:
        result = asyncio.run(run_monte_carlo_mdd(
            n_simulations=int(payload.get("n") or 1000),
            source=str(payload.get("source") or "paper"),
            method=payload.get("method"),
            block_size=payload.get("block_size"),
            exclude_symbols=payload.get("exclude_symbols"),
        ))
        if result.get("status") in {"error", "failed"}:
            error = str(result.get("error") or result.get("status"))
    except Exception as exc:  # noqa: BLE001
        error = f"{type(exc).__name__}: {exc}"
        result = {
            "status": "error",
            "error": error,
            "trace": traceback.format_exc()[:3000],
        }

    duration_ms = int((time.time() - t0) * 1000)
    status = "error" if error else "success"
    summary = (
        f"run_id={run_id} source={payload.get('source') or 'paper'} "
        f"n={payload.get('n') or 1000} verdict={result.get('go_live_verdict')} "
        f"mdd95={result.get('mdd_95th')}"
    )
    if error:
        summary = f"{summary} error={str(error)[:240]}"

    callback_payload = {
        "task": callback_task,
        "status": status,
        "summary": summary[:1200],
        "duration_ms": duration_ms,
        "run_id": run_id,
        "metadata": {
            "source": "backtest_monte_carlo",
            "executor": "modal",
            "trigger_source": trigger_source,
            "trigger_id": trigger_id,
            "request": payload,
            "result": result,
        },
    }
    if error:
        callback_payload["error"] = str(error)[:1200]

    callback = _post_worker_scheduler_callback(callback_payload)
    return {
        "status": status,
        "source": "backtest_monte_carlo",
        "executor": "modal",
        "run_id": run_id,
        "duration_ms": duration_ms,
        "callback": callback,
        "result": result,
    }


@app.function(
    image=image,
    secrets=[gcs_secret, cf_secret, runtime_env_secret],
    cpu=4,
    memory=4096,
    timeout=7200,
    scaledown_window=60,
    max_containers=1,
)
def backtest_pbo(payload: dict) -> dict:
    """Run PBO analysis on Modal and callback Worker."""
    _setup_env()
    import asyncio
    import sys
    import time
    import traceback

    if "/root" not in sys.path:
        sys.path.insert(0, "/root")

    from services.pbo_service import run_pbo_analysis  # type: ignore

    t0 = time.time()
    run_id = str(payload.get("run_id") or f"backtest-pbo-{int(t0)}")
    callback_task = str(payload.get("callback_task") or "pbo")
    trigger_source = payload.get("trigger_source") or "controller"
    trigger_id = payload.get("trigger_id")
    result: dict = {}
    error = None

    try:
        result = asyncio.run(run_pbo_analysis(
            n_partitions=int(payload.get("partitions") or 10),
            source=str(payload.get("source") or "backtest"),
        ))
        if result.get("status") in {"error", "failed"}:
            error = str(result.get("error") or result.get("status"))
    except Exception as exc:  # noqa: BLE001
        error = f"{type(exc).__name__}: {exc}"
        result = {
            "status": "error",
            "error": error,
            "trace": traceback.format_exc()[:3000],
        }

    duration_ms = int((time.time() - t0) * 1000)
    status = "error" if error else "success"
    summary = (
        f"run_id={run_id} source={payload.get('source') or 'backtest'} "
        f"partitions={payload.get('partitions') or 10} pbo={result.get('pbo')} "
        f"verdict={result.get('go_live_verdict')}"
    )
    if error:
        summary = f"{summary} error={str(error)[:240]}"

    callback_payload = {
        "task": callback_task,
        "status": status,
        "summary": summary[:1200],
        "duration_ms": duration_ms,
        "run_id": run_id,
        "metadata": {
            "source": "backtest_pbo",
            "executor": "modal",
            "trigger_source": trigger_source,
            "trigger_id": trigger_id,
            "request": payload,
            "result": result,
        },
    }
    if error:
        callback_payload["error"] = str(error)[:1200]

    callback = _post_worker_scheduler_callback(callback_payload)
    return {
        "status": status,
        "source": "backtest_pbo",
        "executor": "modal",
        "run_id": run_id,
        "duration_ms": duration_ms,
        "callback": callback,
        "result": result,
    }


@app.function(
    image=image,
    secrets=[gcs_secret, cf_secret, runtime_env_secret],
    cpu=4,
    memory=4096,
    timeout=7200,
    scaledown_window=60,
    max_containers=1,
)
def dataset_snapshot_export(payload: dict) -> dict:
    """Export daily research snapshots on Modal and callback Worker."""
    _setup_env()
    import sys
    import time
    import traceback
    from datetime import timedelta

    if "/root" not in sys.path:
        sys.path.insert(0, "/root")

    from services.dataset_snapshot_exporter import (  # type: ignore
        DatasetSnapshotExportRequest,
        export_daily_research_snapshots,
    )

    def _default_start_date(end_date: str) -> str:
        lookback_days = int(payload.get("lookback_days") or 504)
        lookback_days = max(30, min(lookback_days, 1600))
        return (datetime.strptime(end_date, "%Y-%m-%d") - timedelta(days=lookback_days)).strftime("%Y-%m-%d")

    t0 = time.time()
    run_date = str(payload.get("run_date") or payload.get("business_date") or "")
    run_id = str(payload.get("run_id") or payload.get("producer_run_id") or f"dataset-snapshot-{int(t0)}")
    callback_task = str(payload.get("callback_task") or "dataset-snapshot-export")
    trigger_source = payload.get("trigger_source") or "modal_dataset_snapshot"
    trigger_id = payload.get("trigger_id")
    status = "error"
    result: dict = {}
    error = None

    try:
        if not run_date:
            raise ValueError("run_date is required")
        request = DatasetSnapshotExportRequest(
            business_date=run_date,
            start_date=str(payload.get("start_date") or _default_start_date(run_date)),
            end_date=str(payload.get("end_date") or run_date),
            producer_run_id=run_id,
            gcs_prefix=payload.get("gcs_prefix"),
            chunk_days=int(payload.get("chunk_days") or 10),
            include_signals=_truthy(payload.get("include_signals", True)),
        )
        result = export_daily_research_snapshots(request)
        status = "success"
    except Exception as exc:  # noqa: BLE001
        error = f"{type(exc).__name__}: {exc}"
        result = {
            "status": "error",
            "error": error,
            "trace": traceback.format_exc()[:3000],
        }

    duration_ms = int((time.time() - t0) * 1000)
    snapshots = result.get("snapshots") if isinstance(result, dict) else {}
    backtest = (((snapshots or {}).get("backtest_dataset") or {}).get("snapshot") or {})
    price = (((snapshots or {}).get("price_history") or {}).get("snapshot") or {})
    summary = (
        f"run_id={run_id} "
        f"backtest={backtest.get('snapshot_id')} rows={backtest.get('row_count')} "
        f"price={price.get('snapshot_id')} rows={price.get('row_count')} "
        f"trigger_source={trigger_source} trigger_id={trigger_id or '-'}"
    )
    if error:
        summary = error[:1200]

    callback_payload = {
        "task": callback_task,
        "status": status,
        "summary": summary[:1200],
        "duration_ms": duration_ms,
        "run_id": run_id,
        "run_date": run_date,
        "metadata": {
            "source": "dataset_snapshot_export",
            "provider": "modal",
            "executor": "modal",
            "job_name": "dataset_snapshot_export",
            "compute_owner": "modal",
            "remote_function": "dataset_snapshot_export",
            "cpu": 4,
            "memory_mb": 4096,
            "trigger_source": trigger_source,
            "trigger_id": trigger_id,
            "snapshots": snapshots,
        },
    }
    if error:
        callback_payload["error"] = error[:1200]

    callback = _post_worker_scheduler_callback(callback_payload)
    return {
        "status": status,
        "source": "dataset_snapshot_export",
        "executor": "modal",
        "run_id": run_id,
        "duration_ms": duration_ms,
        "callback": callback,
        **result,
    }


@app.function(
    image=image,
    secrets=[gcs_secret, cf_secret, runtime_env_secret],
    cpu=4,
    memory=4096,
    timeout=7200,
    scaledown_window=60,
    max_containers=1,
)
def d1_cold_archive_export(payload: dict) -> dict:
    """Export exact D1 cold rows to GCS archive on Modal and callback Worker."""
    _setup_env()
    import sys
    import time
    import traceback

    if "/root" not in sys.path:
        sys.path.insert(0, "/root")

    from services.dataset_snapshot_exporter import (  # type: ignore
        D1ColdArchiveExportRequest,
        export_d1_cold_archive_snapshot,
    )

    t0 = time.time()
    business_date = str(payload.get("business_date") or payload.get("run_date") or "")
    run_id = str(payload.get("run_id") or payload.get("producer_run_id") or f"d1-cold-archive-{int(t0)}")
    callback_task = str(payload.get("callback_task") or "dataset-snapshot-export")
    trigger_source = payload.get("trigger_source") or "modal_d1_cold_archive"
    trigger_id = payload.get("trigger_id")
    status = "error"
    result: dict = {}
    error = None

    try:
        if not business_date:
            raise ValueError("business_date is required")
        request = D1ColdArchiveExportRequest(
            business_date=business_date,
            start_date=str(payload["start_date"]),
            end_date=str(payload["end_date"]),
            tables=tuple(payload.get("tables") or [
                "stock_prices",
                "technical_indicators",
                "chip_data",
                "margin_data",
                "predictions",
            ]),
            gcs_prefix=payload.get("gcs_prefix"),
            producer_run_id=run_id,
            chunk_days=int(payload.get("chunk_days") or 10),
            hot_window_days=int(payload.get("hot_window_days") or 504),
        )
        result = export_d1_cold_archive_snapshot(request)
        status = "success"
    except Exception as exc:  # noqa: BLE001
        error = f"{type(exc).__name__}: {exc}"
        result = {
            "status": "error",
            "error": error,
            "trace": traceback.format_exc()[:3000],
        }

    duration_ms = int((time.time() - t0) * 1000)
    snapshot = result.get("snapshot") if isinstance(result, dict) else {}
    table_coverage = result.get("table_coverage") if isinstance(result, dict) else []
    row_count = snapshot.get("row_count") if isinstance(snapshot, dict) else None
    summary = (
        f"run_id={run_id} kind=d1_cold_archive rows={row_count} "
        f"tables={len(table_coverage or [])} trigger_source={trigger_source} "
        f"trigger_id={trigger_id or '-'}"
    )
    if error:
        summary = error[:1200]

    callback_payload = {
        "task": callback_task,
        "status": status,
        "summary": summary[:1200],
        "duration_ms": duration_ms,
        "run_id": run_id,
        "run_date": business_date,
        "metadata": {
            "source": "d1_cold_archive_export",
            "executor": "modal",
            "trigger_source": trigger_source,
            "trigger_id": trigger_id,
            "snapshot": snapshot,
            "table_coverage": table_coverage,
            "delete_requires_manual_approval": True,
        },
    }
    if error:
        callback_payload["error"] = error[:1200]

    callback = _post_worker_scheduler_callback(callback_payload)
    return {
        "status": status,
        "source": "d1_cold_archive_export",
        "executor": "modal",
        "run_id": run_id,
        "duration_ms": duration_ms,
        "callback": callback,
        **result,
    }


@app.function(
    image=image,
    secrets=[gcs_secret, cf_secret, runtime_env_secret],
    cpu=4,
    memory=16384,
    timeout=1800,
    scaledown_window=60,
    max_containers=1,
)
def regime_compute(payload: dict) -> dict:
    """Compute HMM regime on Modal, push Worker state, and callback scheduler."""
    _setup_env()
    import sys
    import time
    import traceback
    from dataclasses import asdict
    from datetime import timedelta

    if "/root" not in sys.path:
        sys.path.insert(0, "/root")

    from app.regime import (  # type: ignore
        RegimeDetector,
        build_market_feature_matrix,
        get_current_market_features,
    )
    from services.kv_pusher import push_optuna_result  # type: ignore
    from services.market_regime_evidence import build_regime_evidence_pack  # type: ignore
    from services.payload_builder import load_market_env  # type: ignore

    index_to_label = {
        0: "bull_market",
        1: "volatile",
        2: "sideways",
        3: "bear_market",
    }

    def _extract_regime_surface(info: dict) -> dict:
        raw = (
            info.get("regime_surface")
            or info.get("regime_probabilities")
            or info.get("probabilities")
            or info.get("state_probabilities")
            or {}
        )
        if isinstance(raw, list):
            labels = ["bull_market", "volatile", "sideways", "bear_market"]
            raw = {label: raw[idx] for idx, label in enumerate(labels) if idx < len(raw)}
        if not isinstance(raw, dict):
            return {}
        out: dict[str, float] = {}
        for key, value in raw.items():
            try:
                prob = float(value)
            except (TypeError, ValueError):
                continue
            if prob >= 0:
                out[str(key)] = prob
        return out

    t0 = time.time()
    tw_tz = timezone(timedelta(hours=8))
    run_date = str(payload.get("run_date") or datetime.now(tw_tz).strftime("%Y-%m-%d"))
    run_id = str(payload.get("run_id") or f"regime-compute-{run_date}-{int(t0)}")
    callback_task = str(payload.get("callback_task") or "regime-compute")
    trigger_source = payload.get("trigger_source") or "modal_regime_compute"
    trigger_id = payload.get("trigger_id")
    prev_label = payload.get("prev_label")
    status = "error"
    error = None
    response: dict = {}
    kv_push_ok = False

    try:
        market_env_obj, _, _, _, _ = load_market_env(run_date)
        market_env = asdict(market_env_obj)
        market_env["requested_run_date"] = run_date
        if not market_env.get("history"):
            raise ValueError("market_env has empty history")

        force_retrain = _truthy(payload.get("force_retrain"))
        detector = None if force_retrain else RegimeDetector.load_from_gcs()
        if detector is None:
            feat_mat = build_market_feature_matrix(market_env)
            if feat_mat is None or len(feat_mat) < 20:
                raise ValueError("insufficient market_env.history to train HMM (need >=20 days)")
            detector = RegimeDetector().fit(feat_mat)
            if detector._trained:
                detector.save_to_gcs()

        cur_feat = get_current_market_features(market_env)
        if cur_feat is None:
            raise ValueError("market_env missing current features")

        info = detector.predict_regime(cur_feat)
        reg_idx = int(info.get("regime_index", 1))
        label_en = index_to_label.get(reg_idx, "sideways")
        hmm_state = info.get("hmm_state", -1)
        label_zh = info.get("label", "sideways")
        regime_surface = _extract_regime_surface(info)
        evidence_pack = build_regime_evidence_pack(market_env, raw_label=label_en)
        effective_label = evidence_pack["effective_label"]

        push_result = push_optuna_result(
            source="regime",
            params={
                "label": effective_label,
                "raw_label": label_en,
                "regime_index": reg_idx,
                "hmm_state": hmm_state,
                "label_zh": label_zh,
                "regime_surface": regime_surface,
                "consensus_threshold": info.get("consensus_threshold", 0.60),
                "weight_multipliers": info.get("weight_multipliers", {}),
                "regime_evidence": evidence_pack,
                "transition_guard": evidence_pack["transition_guard"],
                "monitors": evidence_pack["monitors"],
            },
            meta={
                "computed_at": datetime.now(tw_tz).isoformat(),
                "run_date": run_date,
                "run_id": run_id,
                "executor": "modal",
            },
        )
        kv_push_ok = bool(push_result.get("success", False))
        response = {
            "regime_label_en": effective_label,
            "raw_regime_label_en": label_en,
            "regime_index": reg_idx,
            "hmm_state": hmm_state,
            "label_zh": label_zh,
            "regime_surface": regime_surface,
            "regime_evidence": evidence_pack,
            "transition_guard": evidence_pack["transition_guard"],
            "monitors": evidence_pack["monitors"],
            "kv_push_ok": kv_push_ok,
            "computed_at": datetime.now(tw_tz).isoformat(),
            "run_date": run_date,
        }
        if kv_push_ok:
            status = "success"
        else:
            error = "regime KV push did not report success"
    except Exception as exc:  # noqa: BLE001
        error = f"{type(exc).__name__}: {exc}"
        response = {
            "error": error,
            "trace": traceback.format_exc()[:3000],
            "type": "regime_compute",
        }

    duration_ms = int((time.time() - t0) * 1000)
    summary = (
        f"run_id={run_id} regime={response.get('regime_label_en', 'unknown')} "
        f"raw={response.get('raw_regime_label_en', 'unknown')} "
        f"idx={response.get('regime_index', 'n/a')} kv={'ok' if kv_push_ok else 'fail'} "
        f"trigger_source={trigger_source} trigger_id={trigger_id or '-'}"
    )
    if error:
        summary = f"{summary} error={str(error)[:300]}"

    callback_payload = {
        "task": callback_task,
        "status": status,
        "summary": summary[:1200],
        "duration_ms": duration_ms,
        "run_id": run_id,
        "run_date": run_date,
        "metadata": {
            "source": "regime_compute",
            "executor": "modal",
            "trigger_source": trigger_source,
            "trigger_id": trigger_id,
            "prev_label": prev_label,
            "regime_label_en": response.get("regime_label_en"),
            "raw_regime_label_en": response.get("raw_regime_label_en"),
            "regime_index": response.get("regime_index"),
            "hmm_state": response.get("hmm_state"),
            "kv_push_ok": kv_push_ok,
            "quality_contract": payload.get("quality_contract"),
        },
    }
    if error:
        callback_payload["error"] = str(error)[:1200]

    callback = _post_worker_scheduler_callback(callback_payload)
    return {
        "status": status,
        "source": "regime_compute",
        "executor": "modal",
        "run_id": run_id,
        "duration_ms": duration_ms,
        "callback": callback,
        **response,
    }


def _date_minus_days(date_text: str, days: int) -> str:
    return (datetime.fromisoformat(str(date_text)[:10]).date() - timedelta(days=max(0, days))).isoformat()


def _finlab_backfill_cli_args(payload: dict) -> list[str]:
    canonical_window_days = int(payload.get("canonical_window_days") or 7)
    args = [
        "--years",
        str(int(payload.get("years") or 3)),
        "--run-id",
        str(payload.get("run_id") or "auto"),
        "--output-dir",
        str(payload.get("output_dir") or "/tmp/finlab_remote_backfill"),
        "--canonical-window-days",
        str(canonical_window_days),
        "--gcs-prefix",
        str(payload.get("gcs_prefix") or "finlab/v4/backfill"),
    ]
    if payload.get("run_date"):
        args.extend(["--run-date", str(payload["run_date"])])
    if payload.get("gcs_bucket"):
        args.extend(["--gcs-bucket", str(payload["gcs_bucket"])])
    if _truthy(payload.get("write_d1", True)):
        args.append("--write-d1")
    if _truthy(payload.get("apply_canonical_d1", True)):
        args.append("--apply-canonical-d1")
    canonical_end = payload.get("canonical_end_date") or payload.get("run_date")
    canonical_start = payload.get("canonical_start_date")
    if canonical_end and not canonical_start:
        canonical_start = _date_minus_days(canonical_end, canonical_window_days)
    if canonical_start:
        args.extend(["--canonical-start-date", str(canonical_start)])
    if canonical_end:
        args.extend(["--canonical-end-date", str(canonical_end)])
    if payload.get("canonical_datasets"):
        args.extend(["--canonical-datasets", str(payload["canonical_datasets"])])
    if payload.get("canonical_limit_per_dataset"):
        args.extend(["--canonical-limit-per-dataset", str(int(payload["canonical_limit_per_dataset"]))])
    if payload.get("canonical_d1_chunk_size"):
        args.extend(["--canonical-d1-chunk-size", str(int(payload["canonical_d1_chunk_size"]))])
    if _truthy(payload.get("canonical_dry_run")):
        args.append("--canonical-dry-run")
    if payload.get("lanes"):
        args.extend(["--lanes", str(payload["lanes"])])
    if _truthy(payload.get("skip_diff_counts")):
        args.append("--skip-diff-counts")
    return args


@app.function(
    image=finlab_image,
    secrets=[gcs_secret, cf_secret, finlab_secret, runtime_env_secret],
    cpu=4,
    memory=16384,
    timeout=7200,
    scaledown_window=60,
    max_containers=1,
)
def finlab_v4_backfill(payload: dict) -> dict:
    """Run the existing FinLab V4 backfill on Modal and callback Worker."""
    _setup_env()
    import contextlib
    import io
    import json
    import sys
    import time
    import traceback

    if "/root" not in sys.path:
        sys.path.insert(0, "/root")

    from tools import finlab_v4_remote_backfill  # type: ignore

    t0 = time.time()
    callback_task = str(payload.get("callback_task") or "finlab-v4-backfill")
    run_date = payload.get("run_date")
    trigger_source = payload.get("trigger_source") or "modal_backfill"
    trigger_id = payload.get("trigger_id")
    cli_args = _finlab_backfill_cli_args(payload)
    result: dict = {}
    status = "error"
    error = None
    stdout = ""

    try:
        old_argv = sys.argv[:]
        sys.argv = ["finlab_v4_remote_backfill.py", *cli_args]
        buf = io.StringIO()
        try:
            with contextlib.redirect_stdout(buf):
                exit_code = finlab_v4_remote_backfill.main()
        finally:
            sys.argv = old_argv
        stdout = buf.getvalue()
        if exit_code != 0:
            raise RuntimeError(f"finlab_v4_remote_backfill exited with code {exit_code}")
        for line in reversed([line.strip() for line in stdout.splitlines() if line.strip()]):
            try:
                parsed = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                result = parsed
                break
        status = "success"
    except Exception as exc:  # noqa: BLE001
        error = f"{type(exc).__name__}: {exc}"
        result = {
            "error": error,
            "trace": traceback.format_exc()[:3000],
            "stdout_tail": stdout[-3000:],
            "type": "finlab_v4_backfill",
        }

    duration_ms = int((time.time() - t0) * 1000)
    run_id = str(result.get("run_id") or payload.get("run_id") or "auto")
    summary = (
        f"run_id={run_id} years={payload.get('years') or 3} "
        f"rows={((result.get('summary') or {}).get('finlab_rows') if isinstance(result.get('summary'), dict) else 'n/a')} "
        f"canonical={((result.get('canonical_d1_apply') or {}).get('status') if isinstance(result.get('canonical_d1_apply'), dict) else 'n/a')} "
        f"trigger_source={trigger_source} trigger_id={trigger_id or '-'}"
    )
    if error:
        summary = error[:1200]

    callback_payload = {
        "task": callback_task,
        "status": status,
        "summary": summary[:1200],
        "duration_ms": duration_ms,
        "run_id": run_id,
        "metadata": {
            "source": "finlab_v4_backfill",
            "executor": "modal",
            "trigger_source": trigger_source,
            "trigger_id": trigger_id,
            "mode": payload.get("mode"),
            "years": payload.get("years") or 3,
            "force": bool(payload.get("force")),
            "continue_evening_chain": bool(payload.get("continue_evening_chain")),
            "lanes": payload.get("lanes"),
            "canonical_datasets": payload.get("canonical_datasets"),
            "gcs_upload": result.get("gcs_upload"),
            "canonical_d1_apply": result.get("canonical_d1_apply"),
            "runtime_table_writeback": result.get("runtime_table_writeback"),
            "summary": result.get("summary"),
        },
    }
    if run_date:
        callback_payload["run_date"] = run_date
    if error:
        callback_payload["error"] = error[:1200]

    callback = _post_worker_scheduler_callback(callback_payload)
    print(
        json.dumps({
            "event": "finlab_v4_backfill_callback",
            "run_id": run_id,
            "status": status,
            "callback": callback,
        }, ensure_ascii=False, sort_keys=True),
        flush=True,
    )
    return {
        "status": status,
        "executor": "modal",
        "source": "finlab_v4_backfill",
        "run_id": run_id,
        "duration_ms": duration_ms,
        "callback": callback,
        **result,
    }


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
